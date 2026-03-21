import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env');
const bookyDataDir = path.join(projectRoot, 'data', 'booky');

const DEFAULT_BALANCE_REFRESH_MS = 45000;
const DEFAULT_HISTORY_REFRESH_MS = 60000;
const DEFAULT_BOOKY_CURRENCY = 'PEN';
const DEFAULT_HISTORY_RETENTION_DAYS = 30;
const DEFAULT_PROFILE_HISTORY_MAX_ITEMS = 500;
const LEAGUE_MISS_LOG_THROTTLE_MS = 5 * 60 * 1000;
const BOOKY_SETTLED_PROVIDER_STATUSES = new Set([1, 2, 4, 8, 18]);
const DEFAULT_ORPHAN_ACTIVE_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_ORPHAN_ACTIVE_HARD_MAX_MS = 20 * 60 * 1000;
const TOKEN_RENEW_COOLDOWN_MS = 15000;

const memoryBalanceCacheByProfile = new Map();
const memoryHistoryCacheByProfile = new Map();
const lastLeagueMissLogByProfile = new Map();
let lastSyncTokenRenewLaunchAt = 0;

const nowIso = () => new Date().toISOString();

const safeNumber = (value, fallback = NaN) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const readRuntimeEnv = () => {
  try {
    if (!fs.existsSync(envPath)) return {};
    const raw = fs.readFileSync(envPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const out = {};

    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sepIdx = trimmed.indexOf('=');
      if (sepIdx <= 0) continue;
      const key = trimmed.slice(0, sepIdx).trim();
      const value = trimmed.slice(sepIdx + 1).trim();
      if (!key) continue;
      out[key] = value;
    }

    return out;
  } catch (_) {
    return {};
  }
};

const getRuntimeEnvValue = (key, fallback = '') => {
  const runtime = readRuntimeEnv();
  if (runtime[key] !== undefined && runtime[key] !== null && String(runtime[key]).trim() !== '') {
    return String(runtime[key]).trim();
  }
  const processValue = process.env[key];
  if (processValue !== undefined && processValue !== null && String(processValue).trim() !== '') {
    return String(processValue).trim();
  }
  return fallback;
};

const getConfiguredCashflowFromDate = () => {
  const value = String(getRuntimeEnvValue('BOOKY_CASHFLOW_FROM_DATE', '') || '').trim();
  return value || null;
};

const getConfiguredFinishedFromDate = () => {
  const explicit = String(getRuntimeEnvValue('BOOKY_FINISHED_FROM_DATE', '') || '').trim();
  if (explicit) return explicit;
  return getConfiguredCashflowFromDate();
};

const parseEnvDateStartIso = (rawValue = null) => {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00.000Z`
    : raw;

  const ts = new Date(normalized).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
};

const filterRowsFromIsoDate = (rows = [], fromIso = null) => {
  if (!fromIso) return Array.isArray(rows) ? rows : [];
  const fromMs = new Date(fromIso).getTime();
  if (!Number.isFinite(fromMs)) return Array.isArray(rows) ? rows : [];

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const ts = getEntryTimestampMs(row);
    return Number.isFinite(ts) && ts >= fromMs;
  });
};

const getKellyBaseMode = () => {
  const raw = String(
    getRuntimeEnvValue('KELLY_BASE_MODE', getRuntimeEnvValue('BOOKY_KELLY_BASE_MODE', 'NAV'))
  ).trim().toUpperCase();
  if (raw === 'PORTFOLIO') return 'PORTFOLIO';
  if (raw === 'CONFIG') return 'CONFIG';
  if (raw === 'BALANCE') return 'BALANCE';
  return 'NAV';
};

const getProfileOpenExposureStake = (profileKey = '') => {
  const store = getProfileStore(profileKey, false);
  const rows = Array.isArray(store?.history) ? store.history : [];
  let exposure = 0;

  for (const row of rows) {
    const status = Number(row?.status);
    if (!Number.isFinite(status)) continue;
    if (BOOKY_SETTLED_PROVIDER_STATUSES.has(status)) continue;

    const stake = safeNumber(row?.stake, NaN);
    if (!Number.isFinite(stake) || stake <= 0) continue;
    exposure += stake;
  }

  return Number(exposure.toFixed(2));
};

const getPortfolioOpenExposureStake = (integration = null) => {
  const activeBets = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : [];
  let exposure = 0;

  for (const bet of activeBets) {
    if (!bet || typeof bet !== 'object') continue;
    if (integration) {
      const betIntegration = normalizeBookProfile(String(bet?.integration || '').trim());
      if (betIntegration && betIntegration !== normalizeBookProfile(integration)) continue;
    }

    const stake = safeNumber(bet?.stake ?? bet?.kellyStake, NaN);
    if (!Number.isFinite(stake) || stake <= 0) continue;
    exposure += stake;
  }

  return Number(exposure.toFixed(2));
};

const getPnlBaseCapital = (profileKey = '') => {
  const profile = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const profileUpper = String(profile).trim().toUpperCase();

  const candidates = [
    `BOOKY_PNL_BASE_CAPITAL_${profileUpper}`,
    `BOOKY_INITIAL_CAPITAL_${profileUpper}`,
    `BOOKY_INITIAL_BALANCE_${profileUpper}`,
    'BOOKY_PNL_BASE_CAPITAL',
    'BOOKY_INITIAL_CAPITAL',
    'BOOKY_INITIAL_BALANCE'
  ];

  for (const key of candidates) {
    const raw = getRuntimeEnvValue(key, '');
    const value = safeNumber(raw, NaN);
    if (Number.isFinite(value) && value > 0) {
      return {
        amount: value,
        source: key,
        updatedAt: null,
        profile
      };
    }
  }

  const store = getProfileStore(profile, false);
  const dbAmount = safeNumber(store?.pnlBase?.amount, NaN);
  if (Number.isFinite(dbAmount) && dbAmount > 0) {
    return {
      amount: Number(dbAmount.toFixed(2)),
      source: store?.pnlBase?.source || 'db-pnl-base',
      updatedAt: store?.pnlBase?.updatedAt || null,
      profile
    };
  }

  return {
    amount: NaN,
    source: null,
    updatedAt: null,
    profile
  };
};

const readSpyCashflowSummaryFromDisk = ({ profileKey = null, filePath = null } = {}) => {
  const profile = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const safePath = filePath
    ? path.resolve(filePath)
    : path.join(bookyDataDir, `spy-cashflow-${profile}.latest.json`);

  if (!fs.existsSync(safePath)) {
    return {
      ok: false,
      reason: 'spy-file-not-found',
      profile,
      filePath: safePath,
      summary: null
    };
  }

  try {
    const raw = fs.readFileSync(safePath, 'utf8');
    const summary = JSON.parse(raw || '{}');
    return {
      ok: true,
      reason: null,
      profile,
      filePath: safePath,
      summary
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'spy-file-invalid-json',
      profile,
      filePath: safePath,
      summary: null,
      error: error?.message || 'No se pudo parsear spy-cashflow.'
    };
  }
};

const extractPnlBaseFromSpySummary = (summary = {}) => {
  const direct = safeNumber(summary?.cashflowStats?.suggestionBaseCapital, NaN);
  if (Number.isFinite(direct) && direct > 0) {
    return Number(direct.toFixed(2));
  }

  const deposits = safeNumber(summary?.cashflowStats?.deposits, NaN);
  const withdrawals = safeNumber(summary?.cashflowStats?.withdrawals, NaN);
  if (Number.isFinite(deposits) && Number.isFinite(withdrawals)) {
    const net = Number((deposits - withdrawals).toFixed(2));
    if (net > 0) return net;
  }

  return NaN;
};

const normalizeBookProfile = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'doradobet';
  if (normalized === 'acity') return 'acity';
  if (normalized === 'altenar' || normalized === 'dorado' || normalized === 'doradobet') return 'doradobet';
  return normalized;
};

const getActiveProfileContext = () => {
  const profile = normalizeBookProfile(getRuntimeEnvValue('BOOK_PROFILE', 'doradobet'));
  const integration = normalizeBookProfile(
    getRuntimeEnvValue('ALTENAR_INTEGRATION', altenarClient?.defaults?.params?.integration || profile)
  );
  return {
    profile,
    integration,
    key: profile
  };
};

const buildRuntimeProviderParams = ({ withTimestamp = false } = {}) => {
  const defaults = altenarClient.defaults.params || {};
  const params = {
    culture: getRuntimeEnvValue('ALTENAR_CULTURE', defaults.culture || 'es-ES'),
    timezoneOffset: Number(getRuntimeEnvValue('ALTENAR_TIMEZONE_OFFSET', String(defaults.timezoneOffset ?? 300))),
    integration: getRuntimeEnvValue('ALTENAR_INTEGRATION', defaults.integration || getActiveProfileContext().integration),
    deviceType: Number(getRuntimeEnvValue('ALTENAR_DEVICE_TYPE', String(defaults.deviceType ?? 1))),
    numFormat: getRuntimeEnvValue('ALTENAR_NUM_FORMAT', defaults.numFormat || 'en-GB'),
    countryCode: getRuntimeEnvValue('ALTENAR_COUNTRY_CODE', defaults.countryCode || 'PE')
  };

  if (withTimestamp) params._ = Date.now();
  return params;
};

const ensureProfileStoreShape = (store = {}) => {
  if (!store.account || typeof store.account !== 'object') store.account = {};
  if (!store.pnlBase || typeof store.pnlBase !== 'object') store.pnlBase = {};
  if (!store.remoteHistory || typeof store.remoteHistory !== 'object') {
    store.remoteHistory = { items: [], updatedAt: null, source: 'cache' };
  }
  if (!Array.isArray(store.remoteHistory.items)) store.remoteHistory.items = [];
  if (!Array.isArray(store.history)) store.history = [];
  return store;
};

const getProfileStore = (profileKey, createIfMissing = true) => {
  if (!db.data?.booky?.byProfile || typeof db.data.booky.byProfile !== 'object') {
    if (!createIfMissing) return null;
    db.data.booky.byProfile = {};
  }

  if (!db.data.booky.byProfile[profileKey]) {
    if (!createIfMissing) return null;
    db.data.booky.byProfile[profileKey] = {
      profile: profileKey,
      integration: profileKey,
      account: {},
      pnlBase: {},
      remoteHistory: { items: [], updatedAt: null, source: 'cache' },
      history: [],
      updatedAt: null
    };
  }

  return ensureProfileStoreShape(db.data.booky.byProfile[profileKey]);
};

const getActiveAuthHeader = () => {
  const token = getRuntimeEnvValue('ALTENAR_BOOKY_AUTH_TOKEN', '');
  if (!token) return null;
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
};

const decodeJwtPayload = (jwt = '') => {
  const parts = String(jwt).split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
};

const getSyncTokenHealth = () => {
  const auth = getActiveAuthHeader();
  if (!auth) {
    return {
      exists: false,
      jwtValid: false,
      expIso: null,
      remainingMinutes: null,
      expired: true
    };
  }

  const raw = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = decodeJwtPayload(raw);
  const jwtValid = Boolean(payload);
  const expUnix = Number(payload?.exp);

  if (!Number.isFinite(expUnix)) {
    return {
      exists: true,
      jwtValid,
      expIso: null,
      remainingMinutes: null,
      expired: true
    };
  }

  const expMs = expUnix * 1000;
  const remainingMinutes = Number(((expMs - Date.now()) / 60000).toFixed(2));
  return {
    exists: true,
    jwtValid,
    expIso: new Date(expMs).toISOString(),
    remainingMinutes,
    expired: remainingMinutes <= 0
  };
};

const isSyncTokenAutoRefreshEnabled = () => {
  return getRuntimeEnvValue('BOOKY_AUTO_TOKEN_REFRESH_SYNC_ENABLED', 'false').toLowerCase() === 'true';
};

const getSyncTokenMinRemainingMinutes = () => {
  const raw = Number(
    getRuntimeEnvValue(
      'BOOKY_SYNC_TOKEN_MIN_REMAINING_MINUTES',
      getRuntimeEnvValue('BOOKY_TOKEN_MIN_REMAINING_MINUTES', '2')
    )
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
};

const triggerSyncTokenRenewal = () => {
  const now = Date.now();
  const elapsed = now - lastSyncTokenRenewLaunchAt;
  const profile = getRuntimeEnvValue('BOOK_PROFILE', 'doradobet').toLowerCase();
  const renewalCommand = `node scripts/extract-booky-auth-token.js --headed --wait-close --require-profile=${profile}`;

  if (lastSyncTokenRenewLaunchAt > 0 && elapsed < TOKEN_RENEW_COOLDOWN_MS) {
    return {
      triggered: false,
      busy: true,
      profile,
      renewalCommand,
      retryAfterSeconds: Math.max(1, Math.ceil((TOKEN_RENEW_COOLDOWN_MS - elapsed) / 1000))
    };
  }

  const scriptPath = path.join(projectRoot, 'scripts', 'extract-booky-auth-token.js');
  const args = ['--headed', '--wait-close', `--require-profile=${profile}`];

  try {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        ...process.env,
        ...readRuntimeEnv()
      }
    });
    child.unref();
    lastSyncTokenRenewLaunchAt = now;
    return {
      triggered: true,
      busy: false,
      profile,
      renewalCommand,
      retryAfterSeconds: 0
    };
  } catch (_) {
    return {
      triggered: false,
      busy: false,
      profile,
      renewalCommand,
      retryAfterSeconds: 0
    };
  }
};

const maybeAutoRefreshSyncToken = ({ reason = 'unknown' } = {}) => {
  const enabled = isSyncTokenAutoRefreshEnabled();
  const health = getSyncTokenHealth();
  const minRemaining = getSyncTokenMinRemainingMinutes();
  const lowRemaining = Number.isFinite(health.remainingMinutes) && health.remainingMinutes < minRemaining;
  const mustRenew = !health.exists || !health.jwtValid || health.expired || lowRemaining || reason === 'provider-401-403';

  if (!enabled || !mustRenew) {
    return {
      enabled,
      mustRenew,
      triggered: false,
      health,
      reason,
      minRemaining,
      renewalCommand: null
    };
  }

  const renewal = triggerSyncTokenRenewal();
  return {
    enabled,
    mustRenew,
    triggered: renewal.triggered,
    busy: renewal.busy,
    health,
    reason,
    minRemaining,
    renewalCommand: renewal.renewalCommand,
    retryAfterSeconds: renewal.retryAfterSeconds
  };
};

const ensureBookyStore = () => {
  if (!db.data.booky) {
    db.data.booky = {
      pendingTickets: [],
      history: [],
      account: {},
      remoteHistory: { items: [], updatedAt: null, source: 'cache' },
      byProfile: {}
    };
  }
  if (!db.data.booky.pendingTickets) db.data.booky.pendingTickets = [];
  if (!db.data.booky.history) db.data.booky.history = [];
  if (!db.data.booky.account || typeof db.data.booky.account !== 'object') db.data.booky.account = {};
  if (!db.data.booky.remoteHistory || typeof db.data.booky.remoteHistory !== 'object') {
    db.data.booky.remoteHistory = { items: [], updatedAt: null, source: 'cache' };
  }
  if (!Array.isArray(db.data.booky.remoteHistory.items)) db.data.booky.remoteHistory.items = [];

  const byProfile = db.data.booky.byProfile;
  if (!byProfile || typeof byProfile !== 'object') db.data.booky.byProfile = {};
  getProfileStore('acity', true);
  getProfileStore('doradobet', true);

  if (!db.data.booky.migratedLegacyToProfiles) {
    const ctx = getActiveProfileContext();
    const activeStore = getProfileStore(ctx.key, true);

    const legacyAccountHasData = Number.isFinite(Number(db.data.booky.account?.amount));
    const legacyHistoryHasData = Array.isArray(db.data.booky.remoteHistory?.items) && db.data.booky.remoteHistory.items.length > 0;

    if (legacyAccountHasData && !Number.isFinite(Number(activeStore.account?.amount))) {
      activeStore.account = {
        ...activeStore.account,
        ...db.data.booky.account
      };
    }

    if (legacyHistoryHasData && (!Array.isArray(activeStore.remoteHistory?.items) || activeStore.remoteHistory.items.length === 0)) {
      activeStore.remoteHistory = {
        ...activeStore.remoteHistory,
        ...db.data.booky.remoteHistory
      };
    }

    db.data.booky.migratedLegacyToProfiles = true;
  }
};

const getBalanceRefreshMs = () => {
  const ms = Number(getRuntimeEnvValue('BOOKY_BALANCE_REFRESH_MS', String(DEFAULT_BALANCE_REFRESH_MS)));
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_BALANCE_REFRESH_MS;
};

const getHistoryRefreshMs = () => {
  const ms = Number(getRuntimeEnvValue('BOOKY_HISTORY_REFRESH_MS', String(DEFAULT_HISTORY_REFRESH_MS)));
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_HISTORY_REFRESH_MS;
};

const getPlatformOperationsBaseUrl = () => {
  return getRuntimeEnvValue(
    'ALTENAR_PLATFORM_OPERATIONS_BASE_URL',
    'https://sb2platformoperations-altenar2.biahosted.com/api/'
  ).replace(/\/?$/, '/');
};

const getBetHistoryBaseUrl = () => {
  return getRuntimeEnvValue(
    'ALTENAR_BETHISTORY_BASE_URL',
    'https://sb2bethistory-gateway-altenar2.biahosted.com/api/'
  ).replace(/\/?$/, '/');
};

const extractBalancePayload = (data) => {
  if (data === null || data === undefined) return null;

  if (Number.isFinite(Number(data))) {
    return {
      amount: Number(data),
      currency: DEFAULT_BOOKY_CURRENCY,
      raw: data
    };
  }

  const candidates = [
    data,
    data?.data,
    data?.result,
    data?.Result,
    data?.balance,
    data?.Balance
  ].filter(Boolean);

  for (const candidate of candidates) {
    const amount = safeNumber(candidate?.amount ?? candidate?.Amount ?? candidate?.balance ?? candidate?.Balance, NaN);
    if (!Number.isFinite(amount)) continue;
    const currency = String(
      candidate?.currency || candidate?.Currency || data?.currency || data?.Currency || DEFAULT_BOOKY_CURRENCY
    ).toUpperCase();
    return {
      amount,
      currency,
      raw: data
    };
  }

  return null;
};

const buildProviderHeaders = (auth) => ({
  Authorization: auth,
  Referer: getRuntimeEnvValue(
    'ALTENAR_REFERER',
    altenarClient.defaults.headers?.Referer || altenarClient.defaults.headers?.common?.Referer || 'https://doradobet.com/'
  ),
  Origin: getRuntimeEnvValue(
    'ALTENAR_ORIGIN',
    altenarClient.defaults.headers?.Origin || altenarClient.defaults.headers?.common?.Origin || 'https://doradobet.com'
  ),
  'User-Agent': getRuntimeEnvValue(
    'ALTENAR_USER_AGENT',
    altenarClient.defaults.headers?.['User-Agent'] || altenarClient.defaults.headers?.common?.['User-Agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  )
});

const buildHistoryPayload = ({ limit = 60, pageNumber = 1, statuses = [] } = {}) => {
  const defaults = buildRuntimeProviderParams();
  const pageSize = Math.max(10, Math.min(100, Number.isFinite(Number(limit)) ? Number(limit) : 60));
  const now = new Date();
  const lookbackDays = Number(getRuntimeEnvValue('BOOKY_HISTORY_LOOKBACK_DAYS', '3650'));
  const safeLookbackDays = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : 3650;
  const from = new Date(now.getTime() - (safeLookbackDays * 24 * 60 * 60 * 1000));
  const normalizedStatuses = Array.isArray(statuses)
    ? statuses.filter(status => Number.isFinite(Number(status))).map(Number)
    : [];

  return {
    culture: defaults.culture,
    timezoneOffset: defaults.timezoneOffset,
    integration: defaults.integration,
    deviceType: defaults.deviceType,
    numFormat: defaults.numFormat,
    countryCode: defaults.countryCode,
    liveOnly: false,
    pageNumber,
    pageSize,
    dateFrom: from.toISOString(),
    dateTo: now.toISOString(),
    statuses: normalizedStatuses
  };
};

const pickArrayCandidate = (data) => {
  if (Array.isArray(data)) return data;
  const candidates = [
    data?.bets,
    data?.items,
    data?.data?.bets,
    data?.data?.items,
    data?.result?.bets,
    data?.result?.items,
    data?.Result?.bets,
    data?.Result?.items,
    data?.data,
    data?.result,
    data?.Result
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
};

const safeIso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const normalizeApiMarketLabel = (value = null) => {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  if (!raw) return raw;

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    normalized === 'match winner' ||
    normalized === 'match result' ||
    normalized === 'moneyline' ||
    normalized === '1x2' ||
    normalized === '1 x 2'
  ) {
    return '1x2';
  }

  return raw;
};

const mapRemoteSelection = (selection = {}) => {
  return {
    selectionId: selection?.id ?? null,
    eventId: selection?.eventId ?? null,
    marketId: selection?.marketId ?? null,
    selectionTypeId: selection?.selectionTypeId ?? null,
    market: normalizeApiMarketLabel(selection?.marketName || null),
    selection: selection?.name || null,
    odd: Number.isFinite(Number(selection?.price)) ? Number(selection.price) : null,
    eventName: selection?.eventName || null,
    eventDate: safeIso(selection?.eventDate),
    status: selection?.status ?? null,
    raw: selection
  };
};

const normalizeLeagueValue = (value) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim()) {
    return value.name.trim();
  }
  return null;
};

const extractLineFromSelection = (selection = {}) => {
  const fromSelectionText = String(selection?.selection || selection?.name || selection?.raw?.name || '').replace(',', '.');
  const textMatch = fromSelectionText.match(/(\d+(?:\.\d+)?)/);
  if (textMatch) {
    const line = Number(textMatch[1]);
    if (Number.isFinite(line)) return Number(line.toFixed(2));
  }

  const specRaw = selection?.raw?.spec;
  if (typeof specRaw === 'string' && specRaw.trim()) {
    try {
      const parsed = JSON.parse(specRaw);
      const candidates = [parsed?.['1'], parsed?.line, parsed?.value];
      for (const candidate of candidates) {
        const line = Number(String(candidate).replace(',', '.'));
        if (Number.isFinite(line)) return Number(line.toFixed(2));
      }
    } catch (_) {}
  }

  return NaN;
};

const selectionTypeIdToPick = (selectionTypeId, selection = null) => {
  const id = Number(selectionTypeId);
  if (!Number.isFinite(id)) return null;
  if (id === 1) return 'home';
  if (id === 2) return 'draw';
  if (id === 3) return 'away';
  if (id === 74) return 'btts_yes';
  if (id === 76) return 'btts_no';
  if (id === 12 || id === 13) {
    const line = extractLineFromSelection(selection || {});
    if (!Number.isFinite(line)) return null;
    return `${id === 12 ? 'over' : 'under'}_${line}`;
  }
  return null;
};

const getOrphanActiveGraceMs = () => {
  const value = Number(getRuntimeEnvValue('BOOKY_ORPHAN_ACTIVE_GRACE_MS', String(DEFAULT_ORPHAN_ACTIVE_GRACE_MS)));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ORPHAN_ACTIVE_GRACE_MS;
};

const getOrphanActiveHardMaxMs = () => {
  const value = Number(getRuntimeEnvValue('BOOKY_ORPHAN_ACTIVE_HARD_MAX_MS', String(DEFAULT_ORPHAN_ACTIVE_HARD_MAX_MS)));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ORPHAN_ACTIVE_HARD_MAX_MS;
};

const getBetFreshnessMs = (bet = {}) => {
  const ts = new Date(
    bet?.providerAcceptedAt || bet?.lastUpdate || bet?.createdAt || bet?.matchDate || 0
  ).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - ts);
};

const buildBookyHistoryByPortfolioBetId = () => {
  const out = new Map();
  const legacyRows = Array.isArray(db.data?.booky?.history) ? db.data.booky.history : [];
  const profileStores = db.data?.booky?.byProfile && typeof db.data.booky.byProfile === 'object'
    ? Object.values(db.data.booky.byProfile)
    : [];

  const ingestRows = (rows = []) => {
    for (const ticket of rows) {
      const betId = String(ticket?.portfolioBetId || '').trim();
      if (!betId) continue;
      out.set(betId, ticket);
    }
  };

  ingestRows(legacyRows);

  for (const store of profileStores) {
    const rows = Array.isArray(store?.history) ? store.history : [];
    ingestRows(rows);
  }

  return out;
};

const hasTicketConfirmationIssue = (ticket = null) => {
  if (!ticket || typeof ticket !== 'object') return false;
  const status = String(ticket?.status || '').toUpperCase();
  if (status.includes('UNKNOWN') || status.includes('UNCERTAIN') || status.includes('REJECT')) return true;
  const acceptedProviderBetId = ticket?.realPlacement?.accepted?.providerBetId;
  if (acceptedProviderBetId === null || acceptedProviderBetId === undefined || acceptedProviderBetId === '') {
    const hasProviderError = Boolean(ticket?.realPlacement?.response?.error);
    if (hasProviderError) return true;
  }
  return false;
};

const archiveRemovedOrphanActiveBet = (bet = {}, reason = '') => {
  if (!db.data?.portfolio) return;
  if (!Array.isArray(db.data.portfolio.history)) db.data.portfolio.history = [];

  const archiveRow = {
    ...bet,
    status: 'CANCELLED_UNCONFIRMED',
    settlementReason: reason || 'orphan_active_not_found_remote_open',
    settledAt: nowIso(),
    orphanCleanedAt: nowIso()
  };

  db.data.portfolio.history.unshift(archiveRow);
};

const reconcilePortfolioActiveBetsFromRemote = (remoteRows = [], { integration = null } = {}) => {
  const rows = Array.isArray(remoteRows) ? remoteRows : [];
  const activeBets = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : [];
  if (activeBets.length === 0) {
    return {
      touchedCount: 0,
      patchedCount: 0,
      removedCount: 0,
      removedIds: []
    };
  }

  const byProviderBetId = new Map();
  const byEventPick = new Map();
  const historyByPortfolioBetId = buildBookyHistoryByPortfolioBetId();
  const orphanGraceMs = getOrphanActiveGraceMs();
  const orphanHardMaxMs = getOrphanActiveHardMaxMs();

  for (const row of rows) {
    const status = Number(row?.status);
    if (status !== 0) continue;

    const providerBetId = row?.providerBetId;
    if (providerBetId !== null && providerBetId !== undefined && providerBetId !== '') {
      byProviderBetId.set(String(providerBetId), row);
    }

    const eventId = Number(row?.eventId);
    const firstSelection = Array.isArray(row?.selections) ? row.selections[0] : null;
    const pick = selectionTypeIdToPick(firstSelection?.selectionTypeId, firstSelection);
    if (Number.isFinite(eventId) && pick) {
      byEventPick.set(`${eventId}_${pick}`, row);
    }
  }

  let patchedCount = 0;
  const removeIndexes = [];
  const removedIds = [];

  for (let idx = 0; idx < activeBets.length; idx += 1) {
    const bet = activeBets[idx];
    if (!bet || typeof bet !== 'object') continue;

    if (integration) {
      const rawBetIntegration = String(bet?.integration || '').trim();
      if (rawBetIntegration) {
        const betIntegration = normalizeBookProfile(rawBetIntegration);
        if (betIntegration !== normalizeBookProfile(integration)) continue;
      }
    }

    const localProviderBetId = bet?.providerBetId;
    const providerKey = (localProviderBetId !== null && localProviderBetId !== undefined && localProviderBetId !== '')
      ? String(localProviderBetId)
      : null;

    let remote = providerKey ? byProviderBetId.get(providerKey) : null;
    if (!remote) {
      const eventId = Number(bet?.eventId);
      const pick = String(bet?.pick || '').toLowerCase().trim();
      if (Number.isFinite(eventId) && pick) {
        remote = byEventPick.get(`${eventId}_${pick}`) || null;
      }
    }

    if (!remote) {
      const hasProviderId = providerKey !== null;
      if (hasProviderId) continue;

      const pick = String(bet?.pick || '').toLowerCase().trim();
      const betEventId = Number(bet?.eventId);
      const hasEventPick = Number.isFinite(betEventId) && Boolean(pick);
      if (hasEventPick && byEventPick.has(`${betEventId}_${pick}`)) continue;

      const freshnessMs = getBetFreshnessMs(bet);
      if (freshnessMs < orphanGraceMs) continue;

      const relatedTicket = historyByPortfolioBetId.get(String(bet?.id || '')) || null;
      const ticketLooksBroken = hasTicketConfirmationIssue(relatedTicket);
      const isTooOld = freshnessMs >= orphanHardMaxMs;

      if (ticketLooksBroken || isTooOld) {
        const reason = ticketLooksBroken
          ? 'orphan_active_confirmation_issue_no_remote_open'
          : 'orphan_active_stale_no_remote_open';
        archiveRemovedOrphanActiveBet(bet, reason);
        removeIndexes.push(idx);
        removedIds.push(String(bet?.id || ''));
      }
      continue;
    }

    const remoteOdd = Number(remote?.odd);
    const remoteStake = Number(remote?.stake);
    const remoteProviderBetId = remote?.providerBetId;

    let changed = false;

    if (Number.isFinite(remoteOdd) && remoteOdd > 1) {
      if (Number(bet.odd) !== remoteOdd) {
        bet.odd = remoteOdd;
        changed = true;
      }
      if (Number(bet.price) !== remoteOdd) {
        bet.price = remoteOdd;
        changed = true;
      }
    }

    if (Number.isFinite(remoteStake) && remoteStake > 0) {
      if (Number(bet.stake) !== remoteStake) {
        bet.stake = remoteStake;
        changed = true;
      }
      if (Number(bet.kellyStake) !== remoteStake) {
        bet.kellyStake = remoteStake;
        changed = true;
      }
    }

    if (remoteProviderBetId !== null && remoteProviderBetId !== undefined && remoteProviderBetId !== '') {
      if (String(bet.providerBetId || '') !== String(remoteProviderBetId)) {
        bet.providerBetId = remoteProviderBetId;
        changed = true;
      }
    }

    if (changed) {
      bet.providerSyncedAt = nowIso();
      patchedCount += 1;
    }
  }

  const removedCount = removeIndexes.length;
  for (let i = removeIndexes.length - 1; i >= 0; i -= 1) {
    activeBets.splice(removeIndexes[i], 1);
  }

  return {
    touchedCount: patchedCount + removedCount,
    patchedCount,
    removedCount,
    removedIds
  };
};

const resolveRemoteSettlementForPortfolio = (row = {}) => {
  const providerStatus = Number(row?.status);
  if (!BOOKY_SETTLED_PROVIDER_STATUSES.has(providerStatus)) return null;

  const stake = Number(row?.stake);
  const payout = Number(row?.payout);
  const potentialReturn = Number(row?.potentialReturn);
  const safeStake = Number.isFinite(stake) ? stake : 0;

  let localStatus = 'LOST';
  let returnAmt = 0;

  if (providerStatus === 2) {
    localStatus = 'LOST';
    returnAmt = 0;
  } else if (providerStatus === 4 || providerStatus === 18) {
    localStatus = 'VOID';
    returnAmt = safeStake;
  } else if (providerStatus === 8) {
    localStatus = Number.isFinite(payout) && payout >= safeStake ? 'WON' : 'LOST';
    returnAmt = Number.isFinite(payout) ? payout : 0;
  } else if (providerStatus === 1) {
    localStatus = 'WON';
    if (Number.isFinite(payout) && payout > 0) {
      returnAmt = payout;
    } else if (Number.isFinite(potentialReturn) && potentialReturn > 0) {
      returnAmt = potentialReturn;
    }
  } else {
    if (Number.isFinite(payout) && payout > 0) returnAmt = payout;
  }

  const profit = returnAmt - safeStake;

  return {
    providerStatus,
    localStatus,
    stake: safeStake,
    returnAmt,
    profit,
    payout: Number.isFinite(payout) ? payout : null,
    potentialReturn: Number.isFinite(potentialReturn) ? potentialReturn : null
  };
};

const applyRemoteSettlementPatch = (bet = {}, remote = {}, resolved = null) => {
  if (!resolved) return bet;

  const remoteStake = Number(remote?.stake);
  const normalizedStake = Number.isFinite(remoteStake) && remoteStake > 0
    ? remoteStake
    : (Number.isFinite(Number(bet?.stake)) ? Number(bet.stake) : resolved.stake);

  const remoteOdd = Number(remote?.odd);
  const normalizedOdd = Number.isFinite(remoteOdd) && remoteOdd > 1
    ? remoteOdd
    : (Number.isFinite(Number(bet?.odd)) ? Number(bet.odd) : null);

  const placedAt = remote?.placedAt || bet?.createdAt || bet?.date || nowIso();

  return {
    ...bet,
    status: resolved.localStatus,
    stake: normalizedStake,
    kellyStake: normalizedStake,
    odd: normalizedOdd || bet?.odd || null,
    price: normalizedOdd || bet?.price || null,
    payout: resolved.payout,
    potentialReturn: resolved.potentialReturn,
    return: Number(resolved.returnAmt.toFixed(4)),
    profit: Number(resolved.profit.toFixed(4)),
    providerBetId: remote?.providerBetId ?? bet?.providerBetId ?? null,
    providerStatus: resolved.providerStatus,
    providerLastSyncAt: nowIso(),
    providerPotentialReturn: resolved.potentialReturn,
    fullTimeSettlement: true,
    settledFromRemote: true,
    closedAt: bet?.closedAt || nowIso(),
    createdAt: bet?.createdAt || placedAt
  };
};

const reconcilePortfolioSettlementsFromRemote = (remoteRows = [], { integration = null } = {}) => {
  const rows = Array.isArray(remoteRows) ? remoteRows : [];
  if (rows.length === 0) {
    return {
      historyPatched: 0,
      activeSettled: 0,
      movedToHistory: 0,
      touchedCount: 0
    };
  }

  const settledByProviderBetId = new Map();
  for (const row of rows) {
    const providerBetId = row?.providerBetId;
    if (providerBetId === null || providerBetId === undefined || providerBetId === '') continue;

    const resolved = resolveRemoteSettlementForPortfolio(row);
    if (!resolved) continue;

    settledByProviderBetId.set(String(providerBetId), { row, resolved });
  }

  if (settledByProviderBetId.size === 0) {
    return {
      historyPatched: 0,
      activeSettled: 0,
      movedToHistory: 0,
      touchedCount: 0
    };
  }

  const normalizedIntegration = integration ? normalizeBookProfile(integration) : null;
  const historyRows = Array.isArray(db.data?.portfolio?.history) ? db.data.portfolio.history : [];
  const activeRows = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : [];

  let historyPatched = 0;
  let activeSettled = 0;
  let movedToHistory = 0;

  const shouldSkipByIntegration = (bet = {}) => {
    if (!normalizedIntegration) return false;
    const raw = String(bet?.integration || '').trim();
    if (!raw) return false;
    return normalizeBookProfile(raw) !== normalizedIntegration;
  };

  for (let i = 0; i < historyRows.length; i += 1) {
    const bet = historyRows[i];
    if (!bet || typeof bet !== 'object') continue;
    if (shouldSkipByIntegration(bet)) continue;

    const providerBetId = bet?.providerBetId;
    if (providerBetId === null || providerBetId === undefined || providerBetId === '') continue;

    const found = settledByProviderBetId.get(String(providerBetId));
    if (!found) continue;

    historyRows[i] = applyRemoteSettlementPatch(bet, found.row, found.resolved);
    historyPatched += 1;
  }

  const removeActiveIndexes = [];
  for (let i = 0; i < activeRows.length; i += 1) {
    const bet = activeRows[i];
    if (!bet || typeof bet !== 'object') continue;
    if (shouldSkipByIntegration(bet)) continue;

    const providerBetId = bet?.providerBetId;
    if (providerBetId === null || providerBetId === undefined || providerBetId === '') continue;

    const found = settledByProviderBetId.get(String(providerBetId));
    if (!found) continue;

    const patched = applyRemoteSettlementPatch(bet, found.row, found.resolved);
    activeSettled += 1;

    const historyIdx = historyRows.findIndex((h) => String(h?.id || '') === String(patched?.id || ''));
    if (historyIdx >= 0) {
      historyRows[historyIdx] = patched;
    } else {
      historyRows.unshift(patched);
      movedToHistory += 1;
    }

    removeActiveIndexes.push(i);
  }

  for (let i = removeActiveIndexes.length - 1; i >= 0; i -= 1) {
    activeRows.splice(removeActiveIndexes[i], 1);
  }

  return {
    historyPatched,
    activeSettled,
    movedToHistory,
    touchedCount: historyPatched + activeSettled
  };
};

const resolveLeagueNameFromCaches = ({ eventId, champId = null, catId = null, fallbackLeague = null } = {}) => {
  if (fallbackLeague) return fallbackLeague;
  const eventKey = Number(eventId);
  const champKey = Number(champId);
  const catKey = Number(catId);

  const altenarUpcoming = Array.isArray(db.data?.altenarUpcoming) ? db.data.altenarUpcoming : [];
  const upcomingMatches = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];

  if (Number.isFinite(eventKey)) {
    const altenarMatch = altenarUpcoming.find(item => Number(item?.id ?? item?.eventId) === eventKey);
    if (altenarMatch) {
      const leagueValue = normalizeLeagueValue(altenarMatch?.league || altenarMatch?.champName || null);
      if (leagueValue) return leagueValue;
    }

    const upcomingMatch = upcomingMatches.find(item => Number(item?.altenarId ?? item?.eventId) === eventKey);
    if (upcomingMatch) {
      const leagueValue = normalizeLeagueValue(upcomingMatch?.league);
      if (leagueValue) return leagueValue;
    }
  }

  if (Number.isFinite(champKey) || Number.isFinite(catKey)) {
    const altenarByLeagueIds = altenarUpcoming.find((item) => {
      const itemChamp = Number(item?.champId ?? item?.leagueId ?? item?.champ?.id);
      const itemCat = Number(item?.catId ?? item?.countryId ?? item?.country?.id);
      const champMatch = Number.isFinite(champKey) && Number.isFinite(itemChamp) && itemChamp === champKey;
      const catMatch = Number.isFinite(catKey) && Number.isFinite(itemCat) && itemCat === catKey;
      return champMatch || catMatch;
    });

    if (altenarByLeagueIds) {
      const leagueValue = normalizeLeagueValue(altenarByLeagueIds?.league || altenarByLeagueIds?.champName || null);
      if (leagueValue) return leagueValue;
    }

    const upcomingByLeagueIds = upcomingMatches.find((item) => {
      const itemChamp = Number(item?.champId ?? item?.league?.id);
      const itemCat = Number(item?.catId ?? item?.country?.id);
      const champMatch = Number.isFinite(champKey) && Number.isFinite(itemChamp) && itemChamp === champKey;
      const catMatch = Number.isFinite(catKey) && Number.isFinite(itemCat) && itemCat === catKey;
      return champMatch || catMatch;
    });

    if (upcomingByLeagueIds) {
      const leagueValue = normalizeLeagueValue(upcomingByLeagueIds?.league);
      if (leagueValue) return leagueValue;
    }
  }

  return null;
};

const mapRemoteHistoryItem = (entry = {}, integrationKey = null) => {
  const selections = Array.isArray(entry?.selections) ? entry.selections : [];
  const firstSelection = selections[0] || null;
  const selectionMapped = firstSelection ? mapRemoteSelection(firstSelection) : null;
  const eventId = selectionMapped?.eventId || null;
  const champId = firstSelection?.champId ?? null;
  const catId = firstSelection?.catId ?? null;
  const leagueName = resolveLeagueNameFromCaches({ eventId, champId, catId, fallbackLeague: null });

  return {
    source: 'remote',
    ticketId: null,
    providerBetId: entry?.id ?? entry?.betId ?? null,
    requestId: null,
    status: entry?.status ?? null,
    placedAt: safeIso(entry?.createdDate || entry?.createdAt || entry?.date),
    match: selectionMapped?.eventName || null,
    league: leagueName,
    market: normalizeApiMarketLabel(selectionMapped?.market || null),
    selection: selectionMapped?.selection || null,
    odd: Number.isFinite(Number(entry?.totalOdds))
      ? Number(entry.totalOdds)
      : (selectionMapped?.odd ?? null),
    stake: Number.isFinite(Number(entry?.finalStake))
      ? Number(entry.finalStake)
      : (Number.isFinite(Number(entry?.totalStake)) ? Number(entry.totalStake) : null),
    potentialReturn: Number.isFinite(Number(entry?.totalWin)) ? Number(entry.totalWin) : null,
    payout: Number.isFinite(Number(entry?.cashOutValue)) ? Number(entry.cashOutValue) : null,
    currency: entry?.currency || null,
    eventId,
    pinnacleId: null,
    integration: integrationKey ? normalizeBookProfile(integrationKey) : null,
    selections: selections.map(mapRemoteSelection),
    raw: entry
  };
};

const getCachedRemoteHistory = (limit = 60, profileKey = null) => {
  const key = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const profileStore = getProfileStore(key, false) || {};
  const profileCache = profileStore.remoteHistory || {};
  const legacyCache = db.data?.booky?.remoteHistory || {};
  const legacySource = normalizeBookProfile(String(legacyCache?.source || '').trim());

  // Evita mezclar historial de otro perfil cuando no hay token/sync remoto.
  const cache = (Array.isArray(profileCache.items) && profileCache.items.length > 0)
    ? profileCache
    : (legacySource && legacySource === key ? legacyCache : profileCache);
  const items = Array.isArray(cache.items) ? cache.items : [];
  const updatedAt = cache.updatedAt || null;
  const max = Number.isFinite(Number(limit))
    ? (Number(limit) > 0 ? Math.max(1, Number(limit)) : null)
    : 60;

  return {
    items: max === null ? items : items.slice(0, max),
    updatedAt,
    source: cache.source || 'cache',
    stale: true,
    error: cache.error || null,
    endpoint: cache.endpoint || null,
    method: cache.method || null
  };
};

const getEntryTimestampMs = (entry = {}) => {
  const source = entry?.placedAt
    || entry?.confirmedAt
    || entry?.realPlacement?.placedAt
    || entry?.updatedAt
    || entry?.createdAt
    || entry?.remoteUpdatedAt
    || null;
  const ts = new Date(source || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const pickFirstDefined = (...values) => {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

const toFiniteOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const mergeMetaRows = (...rows) => {
  const sources = rows.filter(Boolean);
  if (sources.length === 0) return null;

  return {
    type: pickFirstDefined(...sources.map((m) => m.type)),
    strategy: pickFirstDefined(...sources.map((m) => m.strategy)),
    ev: pickFirstDefined(...sources.map((m) => m.ev)),
    realProb: pickFirstDefined(...sources.map((m) => m.realProb)),
    kellyStake: pickFirstDefined(...sources.map((m) => m.kellyStake)),
    market: pickFirstDefined(...sources.map((m) => m.market)),
    selection: pickFirstDefined(...sources.map((m) => m.selection)),
    pick: pickFirstDefined(...sources.map((m) => m.pick)),
    pinnacleInfo: pickFirstDefined(...sources.map((m) => m.pinnacleInfo)),
    pinnaclePrice: pickFirstDefined(...sources.map((m) => m.pinnaclePrice))
  };
};

const derivePinnacleReferencePrice = ({ pinnacleInfo = null, pick = null, market = null, selection = null } = {}) => {
  const ctx = pinnacleInfo?.prematchContext;
  if (!ctx || typeof ctx !== 'object') return null;

  const pickKey = String(pick || '').trim().toLowerCase();
  const marketLabel = normalizeApiMarketLabel(market || '');
  const selectionText = String(selection || '').toLowerCase();

  let candidate = null;
  if (pickKey === 'home' || selectionText.includes('local') || selectionText.includes('home')) {
    candidate = Number(ctx.home);
  } else if (pickKey === 'draw' || selectionText.includes('empate') || selectionText.includes('draw')) {
    candidate = Number(ctx.draw);
  } else if (pickKey === 'away' || selectionText.includes('visita') || selectionText.includes('away')) {
    candidate = Number(ctx.away);
  } else if (pickKey.startsWith('over_') || selectionText.includes('over') || selectionText.includes('mas ') || selectionText.includes('más ')) {
    candidate = Number(ctx.over25);
  } else if (pickKey.startsWith('under_') || selectionText.includes('under') || selectionText.includes('menos')) {
    candidate = Number(ctx.under25);
  } else if (marketLabel === '1x2' && Number.isFinite(Number(ctx.home)) && Number(ctx.home) > 1) {
    candidate = Number(ctx.home);
  }

  return Number.isFinite(candidate) && candidate > 1 ? candidate : null;
};

const isPrematchTypeLabel = (value = null) => {
  const txt = String(value || '').trim().toUpperCase();
  return txt.includes('PREMATCH');
};

const sanitizePinnaclePriceForType = ({ price = null, pinnacleInfo = null, typeLabel = null } = {}) => {
  const raw = Number(price);
  if (!Number.isFinite(raw) || raw <= 1) return null;

  if (isPrematchTypeLabel(typeLabel)) return raw;

  const prematchPrice = Number(pinnacleInfo?.prematchPrice);
  if (Number.isFinite(prematchPrice) && prematchPrice > 1 && Math.abs(raw - prematchPrice) < 1e-9) {
    return null;
  }

  return raw;
};

const resolveRowPnl = (row = {}) => {
  const status = Number(row?.status);
  if (!Number.isFinite(status)) return 0;

  const stake = Number(row?.stake);
  const payout = Number(row?.payout);
  const potentialReturn = Number(row?.potentialReturn);

  const safeStake = Number.isFinite(stake) ? stake : 0;
  if (status === 2) return -Math.abs(safeStake);
  if (status === 4 || status === 18) return 0;

  if (status === 8) {
    if (Number.isFinite(payout) && payout >= 0) return payout - safeStake;
    return 0;
  }

  // En este feed status=1 corresponde a apuesta liquidada ganadora
  // con retorno informado en potentialReturn.
  if (status === 1) {
    if (Number.isFinite(payout) && payout > 0) return payout - safeStake;
    if (Number.isFinite(potentialReturn) && potentialReturn > 0) return potentialReturn - safeStake;
    return 0;
  }

  if (BOOKY_SETTLED_PROVIDER_STATUSES.has(status)) {
    if (Number.isFinite(payout) && payout > 0) return payout - safeStake;
    if (Number.isFinite(potentialReturn) && potentialReturn > 0 && safeStake > 0) return potentialReturn - safeStake;
  }

  return 0;
};

const computeRealizedPnl = (rows = [], { integration = null, allowedProviderBetIds = null } = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const normalizedIntegration = integration ? normalizeBookProfile(integration) : null;
  const allowedIds = allowedProviderBetIds instanceof Set ? allowedProviderBetIds : null;

  const buildCanonicalKey = (row = {}) => {
    const providerBetId = row?.providerBetId;
    if (providerBetId !== null && providerBetId !== undefined && providerBetId !== '') {
      return `pb_${providerBetId}`;
    }

    const requestId = String(row?.requestId || '').trim();
    if (requestId) return `rq_${requestId}`;

    const match = String(row?.match || '').trim().toLowerCase();
    const market = String(row?.market || '').trim().toLowerCase();
    const selection = String(row?.selection || '').trim().toLowerCase();
    const stake = Number.isFinite(Number(row?.stake)) ? Number(row.stake).toFixed(2) : '0.00';
    const placedTs = Date.parse(row?.placedAt || row?.updatedAt || row?.createdAt || 0);
    const minuteBucket = Number.isFinite(placedTs) ? Math.floor(placedTs / 60000) : 0;
    return `fp_${match}|${market}|${selection}|${stake}|${minuteBucket}`;
  };

  const preferRow = (current = {}, incoming = {}) => {
    const curRemote = String(current?.source || '').toLowerCase() === 'remote';
    const incRemote = String(incoming?.source || '').toLowerCase() === 'remote';
    if (curRemote !== incRemote) return incRemote ? incoming : current;

    const curTs = getEntryTimestampMs(current);
    const incTs = getEntryTimestampMs(incoming);
    return incTs >= curTs ? incoming : current;
  };

  const eligibleRows = [];
  for (const row of rows) {
    if (normalizedIntegration) {
      const raw = String(row?.integration || '').trim();
      if (raw) {
        const rowIntegration = normalizeBookProfile(raw);
        if (rowIntegration !== normalizedIntegration) continue;
      } else if (allowedIds) {
        const providerBetId = row?.providerBetId;
        const providerKey = (providerBetId === null || providerBetId === undefined || providerBetId === '')
          ? null
          : String(providerBetId);
        if (!providerKey || !allowedIds.has(providerKey)) continue;
      }
    }
    eligibleRows.push(row);
  }

  const dedupedMap = new Map();
  for (const row of eligibleRows) {
    const key = buildCanonicalKey(row);
    const existing = dedupedMap.get(key);
    dedupedMap.set(key, existing ? preferRow(existing, row) : row);
  }

  const dedupedRows = Array.from(dedupedMap.values());
  return dedupedRows.reduce((acc, row) => {
    return acc + resolveRowPnl(row);
  }, 0);
};

const computePnlBreakdown = (rows = [], { integration = null, allowedProviderBetIds = null } = {}) => {
  const summary = {
    rowsEvaluated: 0,
    rowsIgnored: 0,
    open: { count: 0, stake: 0, potentialReturn: 0, unrealizedPnl: 0 },
    won: { count: 0, pnl: 0, stake: 0 },
    lost: { count: 0, pnl: 0, stake: 0 },
    voided: { count: 0, pnl: 0, stake: 0 },
    cashout: { count: 0, pnl: 0, stake: 0 },
    otherSettled: { count: 0, pnl: 0, stake: 0 }
  };

  const normalizedIntegration = integration ? normalizeBookProfile(integration) : null;
  const allowedIds = allowedProviderBetIds instanceof Set ? allowedProviderBetIds : null;

  const buildCanonicalKey = (row = {}) => {
    const providerBetId = row?.providerBetId;
    if (providerBetId !== null && providerBetId !== undefined && providerBetId !== '') {
      return `pb_${providerBetId}`;
    }

    const requestId = String(row?.requestId || '').trim();
    if (requestId) return `rq_${requestId}`;

    const match = String(row?.match || '').trim().toLowerCase();
    const market = String(row?.market || '').trim().toLowerCase();
    const selection = String(row?.selection || '').trim().toLowerCase();
    const stake = Number.isFinite(Number(row?.stake)) ? Number(row.stake).toFixed(2) : '0.00';
    const placedTs = Date.parse(row?.placedAt || row?.updatedAt || row?.createdAt || 0);
    const minuteBucket = Number.isFinite(placedTs) ? Math.floor(placedTs / 60000) : 0;
    return `fp_${match}|${market}|${selection}|${stake}|${minuteBucket}`;
  };

  const preferRow = (current = {}, incoming = {}) => {
    const curRemote = String(current?.source || '').toLowerCase() === 'remote';
    const incRemote = String(incoming?.source || '').toLowerCase() === 'remote';
    if (curRemote !== incRemote) return incRemote ? incoming : current;

    const curTs = getEntryTimestampMs(current);
    const incTs = getEntryTimestampMs(incoming);
    return incTs >= curTs ? incoming : current;
  };

  const eligible = (row) => {
    if (!normalizedIntegration) return true;
    const raw = String(row?.integration || '').trim();
    if (raw) {
      return normalizeBookProfile(raw) === normalizedIntegration;
    }
    if (allowedIds) {
      const providerBetId = row?.providerBetId;
      const providerKey = (providerBetId === null || providerBetId === undefined || providerBetId === '')
        ? null
        : String(providerBetId);
      return Boolean(providerKey && allowedIds.has(providerKey));
    }
    return true;
  };

  const candidateRows = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!eligible(row)) continue;
    candidateRows.push(row);
  }

  const dedupedMap = new Map();
  for (const row of candidateRows) {
    const key = buildCanonicalKey(row);
    const existing = dedupedMap.get(key);
    dedupedMap.set(key, existing ? preferRow(existing, row) : row);
  }

  for (const row of dedupedMap.values()) {

    const status = Number(row?.status);
    const stake = Number.isFinite(Number(row?.stake)) ? Number(row.stake) : 0;
    if (!Number.isFinite(status)) {
      summary.rowsIgnored += 1;
      continue;
    }

    summary.rowsEvaluated += 1;

    if (status === 0) {
      summary.open.count += 1;
      summary.open.stake += stake;
      const potentialReturn = Number.isFinite(Number(row?.potentialReturn)) ? Number(row.potentialReturn) : 0;
      summary.open.potentialReturn += potentialReturn;
      summary.open.unrealizedPnl += (potentialReturn - stake);
      continue;
    }

    const pnl = resolveRowPnl(row);

    if (status === 1) {
      summary.won.count += 1;
      summary.won.pnl += pnl;
      summary.won.stake += stake;
      continue;
    }

    if (status === 2) {
      summary.lost.count += 1;
      summary.lost.pnl += pnl;
      summary.lost.stake += stake;
      continue;
    }

    if (status === 4 || status === 18) {
      summary.voided.count += 1;
      summary.voided.pnl += pnl;
      summary.voided.stake += stake;
      continue;
    }

    if (status === 8) {
      summary.cashout.count += 1;
      summary.cashout.pnl += pnl;
      summary.cashout.stake += stake;
      continue;
    }

    if (BOOKY_SETTLED_PROVIDER_STATUSES.has(status)) {
      summary.otherSettled.count += 1;
      summary.otherSettled.pnl += pnl;
      summary.otherSettled.stake += stake;
    }
  }

  for (const key of ['open', 'won', 'lost', 'voided', 'cashout', 'otherSettled']) {
    summary[key].pnl = Number((summary[key].pnl || 0).toFixed(2));
    summary[key].stake = Number((summary[key].stake || 0).toFixed(2));
  }
  summary.open.potentialReturn = Number((summary.open.potentialReturn || 0).toFixed(2));
  summary.open.unrealizedPnl = Number((summary.open.unrealizedPnl || 0).toFixed(2));

  return summary;
};

const isProviderStatusSettled = (status) => {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  return code !== 0;
};

const shouldPromoteHistoryRow = (existing = {}, incoming = {}) => {
  const currentStatus = Number(existing?.status);
  const nextStatus = Number(incoming?.status);
  if (!Number.isFinite(nextStatus)) return false;

  // Solo permitimos actualizar una fila existente si pasa de abierta a liquidada.
  return !isProviderStatusSettled(currentStatus) && isProviderStatusSettled(nextStatus);
};

const upsertProfileHistory = (profileKey, rows = []) => {
  const key = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const profileStore = getProfileStore(key, true);
  const current = Array.isArray(profileStore.history) ? profileStore.history : [];
  const merged = new Map();

  for (const row of current) {
    const rowKey = row.providerBetId
      ? `pb_${row.providerBetId}`
      : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    if (!merged.has(rowKey)) merged.set(rowKey, row);
  }

  for (const row of rows) {
    const rowKey = row.providerBetId
      ? `pb_${row.providerBetId}`
      : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    const existing = merged.get(rowKey);
    if (!existing) {
      merged.set(rowKey, row);
      continue;
    }

    if (shouldPromoteHistoryRow(existing, row)) {
      merged.set(rowKey, { ...existing, ...row });
    }
  }

  const maxItems = Math.max(100, Number(getRuntimeEnvValue('BOOKY_PROFILE_HISTORY_MAX_ITEMS', String(DEFAULT_PROFILE_HISTORY_MAX_ITEMS))) || DEFAULT_PROFILE_HISTORY_MAX_ITEMS);
  profileStore.history = Array.from(merged.values())
    .sort((a, b) => getEntryTimestampMs(b) - getEntryTimestampMs(a))
    .slice(0, maxItems);
  profileStore.updatedAt = nowIso();
};

const replaceProfileHistory = (profileKey, rows = []) => {
  const key = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const profileStore = getProfileStore(key, true);
  const dedup = new Map();

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const rowKey = row.providerBetId
      ? `pb_${row.providerBetId}`
      : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    const current = dedup.get(rowKey);
    if (!current) {
      dedup.set(rowKey, row);
      continue;
    }

    const curTs = getEntryTimestampMs(current);
    const nextTs = getEntryTimestampMs(row);
    dedup.set(rowKey, nextTs >= curTs ? row : current);
  }

  const maxItems = Math.max(100, Number(getRuntimeEnvValue('BOOKY_PROFILE_HISTORY_MAX_ITEMS', String(DEFAULT_PROFILE_HISTORY_MAX_ITEMS))) || DEFAULT_PROFILE_HISTORY_MAX_ITEMS);
  profileStore.history = Array.from(dedup.values())
    .sort((a, b) => getEntryTimestampMs(b) - getEntryTimestampMs(a))
    .slice(0, maxItems);
  profileStore.updatedAt = nowIso();
};

const reconcileLocalTicketHistoryFromRemote = (remoteRows = []) => {
  const rows = Array.isArray(remoteRows) ? remoteRows : [];
  const providerMap = new Map();

  for (const row of rows) {
    const id = row?.providerBetId;
    if (id === null || id === undefined || id === '') continue;
    providerMap.set(String(id), row);
  }

  if (providerMap.size === 0) return 0;
  if (!Array.isArray(db.data?.booky?.history)) return 0;

  let updates = 0;
  for (const ticket of db.data.booky.history) {
    const providerBetId = ticket?.realPlacement?.response?.bets?.[0]?.id;
    if (providerBetId === null || providerBetId === undefined || providerBetId === '') continue;

    const remote = providerMap.get(String(providerBetId));
    if (!remote) continue;

    if (!ticket.realPlacement || typeof ticket.realPlacement !== 'object') ticket.realPlacement = {};
    const currentStatus = ticket.realPlacement.providerStatus;
    const nextStatus = remote.status ?? null;

    if (currentStatus !== nextStatus) {
      ticket.realPlacement.providerStatus = nextStatus;
      ticket.realPlacement.providerLastSyncAt = nowIso();
      ticket.realPlacement.providerSnapshot = {
        status: nextStatus,
        odd: remote.odd ?? null,
        stake: remote.stake ?? null,
        payout: remote.payout ?? null,
        potentialReturn: remote.potentialReturn ?? null,
        currency: remote.currency ?? null
      };
      if (Number(nextStatus) !== 0 && !ticket.realPlacement.settledAt) {
        ticket.realPlacement.settledAt = nowIso();
      }
      updates += 1;
    }
  }

  return updates;
};

const pruneRowsByRetention = (rows = [], retentionDays = DEFAULT_HISTORY_RETENTION_DAYS) => {
  const safeDays = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0
    ? Number(retentionDays)
    : DEFAULT_HISTORY_RETENTION_DAYS;
  const cutoffMs = Date.now() - (safeDays * 24 * 60 * 60 * 1000);
  return (Array.isArray(rows) ? rows : []).filter(item => getEntryTimestampMs(item) >= cutoffMs);
};

const requestRemoteBetHistory = async (auth, limit = 60, integrationKey = null, { fetchAll = false } = {}) => {
  const baseUrl = getBetHistoryBaseUrl();
  const headers = buildProviderHeaders(auth);
  const maxRows = Number(getRuntimeEnvValue('BOOKY_HISTORY_MAX_REMOTE_ROWS', '20000'));
  const safeMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : 20000;
  const requested = Number.isFinite(Number(limit)) ? Number(limit) : 60;
  const target = fetchAll || requested <= 0
    ? safeMaxRows
    : Math.max(10, Math.min(safeMaxRows, requested));
  const maxPages = Number(getRuntimeEnvValue('BOOKY_HISTORY_MAX_PAGES', '120'));
  const safeMaxPages = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 120;
  const pageSize = Math.min(100, Math.max(20, Number(getRuntimeEnvValue('BOOKY_HISTORY_PAGE_SIZE', '100')) || 100));
  const timeout = 20000;
  const endpoint = 'WidgetReports/widgetExpandedBetHistory';
  const url = `${baseUrl}${endpoint}`;
  const statusGroups = [
    [0, 10, 3, 20, 17],
    [1, 8, 2, 4, 18]
  ];

  const dedup = new Map();
  let lastError = null;

  for (const statuses of statusGroups) {
    let pageNumber = 1;

    while (pageNumber <= safeMaxPages && dedup.size < target) {
      const payload = buildHistoryPayload({
        limit: Math.min(pageSize, target),
        pageNumber,
        statuses
      });

      try {
        const postResp = await altenarClient.post(url, payload, { headers, timeout });
        const body = postResp?.data || {};
        const rows = pickArrayCandidate(body).map(item => mapRemoteHistoryItem(item, integrationKey));

        for (const row of rows) {
          const key = row.providerBetId
            ? `pb_${row.providerBetId}`
            : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
          if (!dedup.has(key)) dedup.set(key, row);
        }

        const isLastPage = Boolean(body?.isLastPage);
        if (isLastPage || rows.length === 0 || rows.length < payload.pageSize) break;
        pageNumber += 1;
      } catch (error) {
        lastError = error;
        break;
      }
    }

    if (dedup.size >= target) break;
  }

  if (dedup.size > 0) {
    return {
      rows: Array.from(dedup.values()).slice(0, target),
      endpoint,
      method: 'POST'
    };
  }

  throw lastError || new Error('No se pudo obtener historial remoto de Booky.');
};

const requestRemoteOpenBetsCount = async (auth) => {
  const baseUrl = getBetHistoryBaseUrl();
  const headers = buildProviderHeaders(auth);
  const timeout = 12000;

  const url = `${baseUrl}WidgetReports/GetBetsCountWithEvents`;
  const params = buildRuntimeProviderParams({ withTimestamp: true });

  try {
    const response = await altenarClient.get(url, { headers, timeout, params });
    const body = response?.data || {};
    return {
      open: Number.isFinite(Number(body?.open)) ? Number(body.open) : null,
      events: body?.events && typeof body.events === 'object' ? body.events : {},
      error: body?.error || null
    };
  } catch (_) {
    return {
      open: null,
      events: {},
      error: 'count-fetch-failed'
    };
  }
};

export const syncRemoteBookyHistory = async ({ forceRefresh = false, limit = 60, profileKey = null, fetchAll = false } = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const key = normalizeBookProfile(profileKey || ctx.key);

  const refreshMs = getHistoryRefreshMs();
  const now = Date.now();
  const memoryHistoryCache = memoryHistoryCacheByProfile.get(key) || null;

  if (!forceRefresh && memoryHistoryCache?.updatedAtMs && (now - memoryHistoryCache.updatedAtMs) < refreshMs) {
    const max = Number.isFinite(Number(limit))
      ? (Number(limit) > 0 ? Math.max(1, Number(limit)) : null)
      : 60;
    return {
      ...memoryHistoryCache.value,
      items: max === null ? memoryHistoryCache.value.items : memoryHistoryCache.value.items.slice(0, max),
      stale: false
    };
  }

  const cached = getCachedRemoteHistory(limit, key);
  if (!forceRefresh && cached?.updatedAt) {
    const cachedTs = new Date(cached.updatedAt).getTime();
    if (Number.isFinite(cachedTs) && (now - cachedTs) < refreshMs) {
      memoryHistoryCacheByProfile.set(key, {
        updatedAtMs: now,
        value: { ...cached, stale: false }
      });
      return { ...cached, stale: false };
    }
  }

  const auth = getActiveAuthHeader();
  if (!auth) {
    const renewal = maybeAutoRefreshSyncToken({ reason: 'missing-token' });
    const suffix = renewal.triggered
      ? ' Se lanzó auto-renovación interactiva de token.'
      : '';
    return {
      ...cached,
      source: 'cache-no-token',
      error: `Sin ALTENAR_BOOKY_AUTH_TOKEN para sincronizar historial remoto.${suffix}`,
      tokenRenewal: renewal
    };
  }

  try {
    const remote = await requestRemoteBetHistory(auth, limit, key, { fetchAll });
    const dedup = new Map();
    for (const row of remote.rows) {
      const key = row.providerBetId ? `pb_${row.providerBetId}` : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
      if (!dedup.has(key)) dedup.set(key, row);
    }

    const sorted = Array.from(dedup.values()).sort((a, b) => {
      const ta = new Date(a.placedAt || 0).getTime();
      const tb = new Date(b.placedAt || 0).getTime();
      return tb - ta;
    });

    const missingLeagueRows = sorted.filter(row => !row?.league);
    if (missingLeagueRows.length > 0) {
      const nowMs = Date.now();
      const lastLogAt = Number(lastLeagueMissLogByProfile.get(key) || 0);
      if ((nowMs - lastLogAt) >= LEAGUE_MISS_LOG_THROTTLE_MS) {
        const sample = missingLeagueRows.slice(0, 3).map((row) => {
          const rawSelection = Array.isArray(row?.raw?.selections) ? row.raw.selections[0] : null;
          return {
            providerBetId: row?.providerBetId ?? null,
            eventId: row?.eventId ?? null,
            champId: rawSelection?.champId ?? null,
            catId: rawSelection?.catId ?? null,
            match: row?.match ?? null
          };
        });

        console.warn(
          `[BOOKY][HISTORY][${key}] ${missingLeagueRows.length}/${sorted.length} filas remotas sin league tras fallback.`
        );
        console.warn(`[BOOKY][HISTORY][${key}] muestra sin league: ${JSON.stringify(sample)}`);
        lastLeagueMissLogByProfile.set(key, nowMs);
      }
    }

    const openBets = await requestRemoteOpenBetsCount(auth);

    const normalized = {
      items: sorted,
      updatedAt: nowIso(),
      source: key,
      stale: false,
      endpoint: remote.endpoint,
      method: remote.method,
      error: null,
      openBets
    };

    const reconciledLocalCount = reconcileLocalTicketHistoryFromRemote(sorted);
    if (reconciledLocalCount > 0) normalized.reconciledLocalCount = reconciledLocalCount;

    const profileStore = getProfileStore(key, true);
    profileStore.remoteHistory = {
      ...profileStore.remoteHistory,
      ...normalized
    };
    profileStore.updatedAt = nowIso();

    if (key === ctx.key) {
      db.data.booky.remoteHistory = {
        ...db.data.booky.remoteHistory,
        ...normalized
      };
    }

    await db.write();

    memoryHistoryCacheByProfile.set(key, {
      updatedAtMs: Date.now(),
      value: normalized
    });

    const max = Number.isFinite(Number(limit))
      ? (Number(limit) > 0 ? Math.max(1, Number(limit)) : null)
      : 60;
    return {
      ...normalized,
      items: max === null ? normalized.items : normalized.items.slice(0, max)
    };
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const renewal = (status === 401 || status === 403)
      ? maybeAutoRefreshSyncToken({ reason: 'provider-401-403' })
      : null;
    const suffix = renewal?.triggered ? ' Se lanzó auto-renovación interactiva de token.' : '';
    return {
      ...cached,
      source: cached.items?.length ? 'cache-fallback' : 'unavailable',
      error: `${error?.message || 'Fallo sincronizando historial remoto de Booky.'}${suffix}`,
      tokenRenewal: renewal
    };
  }
};

const requestProviderBalance = async (auth) => {
  const baseUrl = getPlatformOperationsBaseUrl();
  const headers = buildProviderHeaders(auth);
  const timeout = 15000;
  const runtimeParams = buildRuntimeProviderParams();

  const endpoints = [
    'WidgetPlatform/getOwnBalance',
    'WidgetPlatform/getBalance'
  ];

  let lastError = null;

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;

    try {
      const getResp = await altenarClient.get(url, {
        headers,
        timeout,
        params: buildRuntimeProviderParams({ withTimestamp: true })
      });
      const parsed = extractBalancePayload(getResp?.data);
      if (parsed) return { ...parsed, endpoint, method: 'GET' };
    } catch (error) {
      lastError = error;

      const status = Number(error?.response?.status || 0);
      const canFallbackToPost = status === 400 || status === 404 || status === 405;
      if (canFallbackToPost) {
        try {
          const postResp = await altenarClient.post(url, runtimeParams, {
            headers,
            timeout,
            params: buildRuntimeProviderParams({ withTimestamp: true })
          });
          const parsedPost = extractBalancePayload(postResp?.data);
          if (parsedPost) return { ...parsedPost, endpoint, method: 'POST' };
        } catch (postError) {
          lastError = postError;
        }
      }
    }
  }

  throw lastError || new Error('No se pudo obtener balance desde provider Booky.');
};

const getCachedDbBalance = (profileKey = null) => {
  const key = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const profileAccount = getProfileStore(key, false)?.account || {};
  const legacyAccount = db.data?.booky?.account || {};
  const legacySource = normalizeBookProfile(String(legacyAccount?.source || '').trim());

  // Evita usar balance legacy de otro perfil (ej: doradobet mostrado en acity).
  const account = Number.isFinite(Number(profileAccount?.amount))
    ? profileAccount
    : (legacySource && legacySource === key ? legacyAccount : {});
  const amount = safeNumber(account.amount, NaN);
  if (!Number.isFinite(amount)) return null;

  return {
    amount,
    currency: String(account.currency || DEFAULT_BOOKY_CURRENCY).toUpperCase(),
    updatedAt: account.updatedAt || null,
    source: account.source || 'cache',
    stale: true,
    endpoint: account.endpoint || null,
    method: account.method || null
  };
};

export const fetchBookyBalance = async ({ forceRefresh = false, profileKey = null } = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const key = normalizeBookProfile(profileKey || ctx.key);

  const refreshMs = getBalanceRefreshMs();
  const now = Date.now();
  const memoryBalanceCache = memoryBalanceCacheByProfile.get(key) || null;

  if (!forceRefresh && memoryBalanceCache?.updatedAtMs && (now - memoryBalanceCache.updatedAtMs) < refreshMs) {
    return { ...memoryBalanceCache.value, stale: false };
  }

  const cached = getCachedDbBalance(key);
  if (!forceRefresh && cached?.updatedAt) {
    const cachedTs = new Date(cached.updatedAt).getTime();
    if (Number.isFinite(cachedTs) && (now - cachedTs) < refreshMs) {
      memoryBalanceCacheByProfile.set(key, {
        updatedAtMs: now,
        value: { ...cached, stale: false }
      });
      return { ...cached, stale: false };
    }
  }

  const auth = getActiveAuthHeader();
  if (!auth) {
    const renewal = maybeAutoRefreshSyncToken({ reason: 'missing-token' });
    const suffix = renewal.triggered
      ? ' Se lanzó auto-renovación interactiva de token.'
      : '';
    return {
      ...(cached || {
        amount: null,
        currency: DEFAULT_BOOKY_CURRENCY,
        updatedAt: null,
        source: 'unavailable',
        stale: true
      }),
      error: `Sin ALTENAR_BOOKY_AUTH_TOKEN para consultar balance real.${suffix}`,
      tokenRenewal: renewal
    };
  }

  try {
    const provider = await requestProviderBalance(auth);
    const normalized = {
      amount: Number(provider.amount.toFixed(2)),
      currency: String(provider.currency || DEFAULT_BOOKY_CURRENCY).toUpperCase(),
      updatedAt: nowIso(),
      source: key,
      stale: false,
      endpoint: provider.endpoint,
      method: provider.method
    };

    const profileStore = getProfileStore(key, true);
    profileStore.account = {
      ...profileStore.account,
      ...normalized
    };
    profileStore.updatedAt = nowIso();

    if (key === ctx.key) {
      db.data.booky.account = {
        ...db.data.booky.account,
        ...normalized
      };
    }
    await db.write();

    memoryBalanceCacheByProfile.set(key, {
      updatedAtMs: Date.now(),
      value: normalized
    });

    return normalized;
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const renewal = (status === 401 || status === 403)
      ? maybeAutoRefreshSyncToken({ reason: 'provider-401-403' })
      : null;
    const suffix = renewal?.triggered ? ' Se lanzó auto-renovación interactiva de token.' : '';
    return {
      ...(cached || {
        amount: null,
        currency: DEFAULT_BOOKY_CURRENCY,
        updatedAt: null,
        source: 'unavailable',
        stale: true
      }),
      error: `${error?.message || 'Fallo consultando balance real en provider.'}${suffix}`,
      tokenRenewal: renewal
    };
  }
};

const mapBookyHistoryItem = (entry = {}) => {
  const opportunity = entry.opportunity || {};
  const placedAt = entry.realPlacement?.placedAt || entry.confirmedAt || entry.updatedAt || entry.createdAt || null;
  const providerBetId = entry.realPlacement?.response?.bets?.[0]?.id || null;
  const providerStatus = Number(entry?.realPlacement?.providerStatus);
  const integration = normalizeBookProfile(entry?.payload?.integration || entry?.opportunity?.integration || '');

  return {
    ticketId: entry.id || null,
    status: Number.isFinite(providerStatus) ? providerStatus : null,
    placedAt,
    requestId: entry.realPlacement?.requestId || null,
    providerBetId,
    match: opportunity.match || null,
    league: opportunity.league || null,
    market: normalizeApiMarketLabel(opportunity.market || null),
    selection: opportunity.selection || null,
    odd: Number.isFinite(Number(opportunity.price ?? opportunity.odd)) ? Number(opportunity.price ?? opportunity.odd) : null,
    stake: Number.isFinite(Number(opportunity.kellyStake)) ? Number(opportunity.kellyStake) : null,
    eventId: opportunity.eventId || null,
    pinnacleId: opportunity.pinnacleId || null,
    type: opportunity.type || entry?.payload?.type || null,
    strategy: opportunity.strategy || entry?.payload?.strategy || null,
    integration: integration || null,
    ev: Number.isFinite(Number(opportunity?.ev)) ? Number(opportunity.ev) : null,
    realProb: Number.isFinite(Number(opportunity?.realProb)) ? Number(opportunity.realProb) : null,
    kellyStake: Number.isFinite(Number(opportunity?.kellyStake)) ? Number(opportunity.kellyStake) : null,
    pick: opportunity?.pick || entry?.payload?.pick || null,
    pinnacleInfo: opportunity?.pinnacleInfo || entry?.payload?.pinnacleInfo || null,
    pinnaclePrice: Number.isFinite(Number(opportunity?.pinnaclePrice))
      ? Number(opportunity.pinnaclePrice)
      : (Number.isFinite(Number(opportunity?.pinnacleInfo?.price)) ? Number(opportunity.pinnacleInfo.price) : null),
    opportunitySnapshot: opportunity || null
  };
};

export const getBookyHistory = async (limit = 60) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();

  const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 60;
  const history = Array.isArray(db.data.booky.history) ? db.data.booky.history : [];
  const localRowsAll = history
    .filter(item => item?.realPlacement)
    .map(mapBookyHistoryItem)
    .filter(row => row?.providerBetId)
    .filter(row => !row.integration || row.integration === ctx.integration)
    .reverse()
    .map(row => ({ ...row, source: 'local' }));

  const remote = await syncRemoteBookyHistory({ forceRefresh: false, limit: 0, profileKey: ctx.key, fetchAll: true });
  const remoteRows = Array.isArray(remote?.items) ? remote.items : [];

  const reconcileStats = reconcilePortfolioActiveBetsFromRemote(remoteRows, {
    integration: ctx.integration
  });
  const settleStats = reconcilePortfolioSettlementsFromRemote(remoteRows, {
    integration: ctx.integration
  });

  if ((Number(reconcileStats?.touchedCount || 0) + Number(settleStats?.touchedCount || 0)) > 0) {
    await db.write();
  }

  if (remoteRows.length === 0) {
    return localRowsAll.slice(0, max);
  }

  const merged = new Map();

  for (const row of remoteRows) {
    const key = row.providerBetId ? `pb_${row.providerBetId}` : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    merged.set(key, row);
  }

  for (const row of localRowsAll) {
    const key = row.providerBetId ? `pb_${row.providerBetId}` : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    if (!merged.has(key)) {
      merged.set(key, row);
      continue;
    }

    const remoteRow = merged.get(key) || {};
    merged.set(key, {
      ...remoteRow,
      match: remoteRow.match || row.match || null,
      league: remoteRow.league || row.league || null,
      eventId: remoteRow.eventId || row.eventId || null,
      market: remoteRow.market || row.market || null,
      selection: remoteRow.selection || row.selection || null,
      placedAt: remoteRow.placedAt || row.placedAt || null,
      type: remoteRow.type || row.type || null,
      strategy: remoteRow.strategy || row.strategy || null,
      opportunityType: remoteRow.opportunityType || row.opportunityType || null,
      pinnacleInfo: remoteRow.pinnacleInfo || row.pinnacleInfo || null,
      pinnaclePrice: Number.isFinite(Number(remoteRow.pinnaclePrice))
        ? Number(remoteRow.pinnaclePrice)
        : (Number.isFinite(Number(row.pinnaclePrice)) ? Number(row.pinnaclePrice) : null)
    });
  }

  const rows = Array.from(merged.values())
    .sort((a, b) => new Date(b.placedAt || 0) - new Date(a.placedAt || 0));

  const localTypeByProvider = new Map();
  const localTypeByEventPick = new Map();
  const portfolioMetaByProvider = new Map();
  const portfolioMetaByEventPick = new Map();
  const profileStickyByProvider = new Map();
  const profileStickyByEventPick = new Map();

  const profileStore = getProfileStore(ctx.key, false);
  const profileHistoryRows = Array.isArray(profileStore?.history) ? profileStore.history : [];

  for (const row of profileHistoryRows) {
    const providerBetId = row?.providerBetId;
    const eventId = Number(row?.eventId);
    const pick = String(row?.pick || '').toLowerCase().trim();
    const meta = {
      type: row?.type || null,
      strategy: row?.strategy || null,
      ev: Number.isFinite(Number(row?.ev)) ? Number(row.ev) : null,
      realProb: Number.isFinite(Number(row?.realProb)) ? Number(row.realProb) : null,
      kellyStake: Number.isFinite(Number(row?.kellyStake)) ? Number(row.kellyStake) : null,
      market: row?.market || null,
      selection: row?.selection || null,
      pick: pick || null,
      pinnacleInfo: row?.pinnacleInfo || null,
      pinnaclePrice: toFiniteOrNull(row?.pinnaclePrice ?? row?.pinnacleInfo?.price)
    };

    if (providerBetId !== null && providerBetId !== undefined && providerBetId !== '') {
      const key = String(providerBetId);
      const prev = profileStickyByProvider.get(key) || null;
      profileStickyByProvider.set(key, mergeMetaRows(meta, prev));
    }

    if (Number.isFinite(eventId) && pick) {
      const key = `${eventId}_${pick}`;
      const prev = profileStickyByEventPick.get(key) || null;
      profileStickyByEventPick.set(key, mergeMetaRows(meta, prev));
    }
  }

  const portfolioRows = [
    ...(Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : []),
    ...(Array.isArray(db.data?.portfolio?.history) ? db.data.portfolio.history : [])
  ];

  for (const bet of portfolioRows) {
    const providerBetId = bet?.providerBetId;
    const eventId = Number(bet?.eventId);
    const pick = String(bet?.pick || '').toLowerCase().trim();

    const meta = {
      type: bet?.type || null,
      strategy: bet?.strategy || null,
      ev: Number.isFinite(Number(bet?.ev)) ? Number(bet.ev) : null,
      realProb: Number.isFinite(Number(bet?.realProb)) ? Number(bet.realProb) : null,
      kellyStake: Number.isFinite(Number(bet?.kellyStake)) ? Number(bet.kellyStake) : null,
      market: bet?.market || null,
      selection: bet?.selection || null,
      pick: pick || null,
      pinnacleInfo: bet?.pinnacleInfo || null,
      pinnaclePrice: toFiniteOrNull(bet?.pinnaclePrice ?? bet?.pinnacleInfo?.price)
    };

    if (providerBetId !== null && providerBetId !== undefined && providerBetId !== '') {
      const key = String(providerBetId);
      const prev = portfolioMetaByProvider.get(key) || null;
      portfolioMetaByProvider.set(key, mergeMetaRows(meta, prev));
    }

    if (Number.isFinite(eventId) && pick) {
      const key = `${eventId}_${pick}`;
      const prev = portfolioMetaByEventPick.get(key) || null;
      portfolioMetaByEventPick.set(key, mergeMetaRows(meta, prev));
    }
  }

  for (const item of history) {
    const providerBetId = item?.realPlacement?.response?.bets?.[0]?.id;
    const type = item?.opportunity?.type || item?.payload?.type || null;
    const strategy = item?.opportunity?.strategy || item?.payload?.strategy || null;
    const ev = Number.isFinite(Number(item?.opportunity?.ev)) ? Number(item.opportunity.ev) : null;
    const realProb = Number.isFinite(Number(item?.opportunity?.realProb)) ? Number(item.opportunity.realProb) : null;
    const kellyStake = Number.isFinite(Number(item?.opportunity?.kellyStake)) ? Number(item.opportunity.kellyStake) : null;
    const market = item?.opportunity?.market || item?.payload?.market || null;
    const selection = item?.opportunity?.selection || item?.payload?.selection || null;
    const pickDirect = item?.opportunity?.pick || item?.payload?.pick || null;
    const pinnacleInfo = item?.opportunity?.pinnacleInfo || item?.payload?.pinnacleInfo || null;
    const pinnaclePrice = toFiniteOrNull(
      item?.opportunity?.pinnaclePrice ??
      item?.payload?.pinnaclePrice ??
      item?.opportunity?.pinnacleInfo?.price
    );

    const hasPinnacleReference = Boolean(pinnacleInfo) || Number.isFinite(Number(pinnaclePrice));
    if (!type && !strategy && !Number.isFinite(ev) && !Number.isFinite(realProb) && !hasPinnacleReference) continue;

    const meta = { type, strategy, ev, realProb, kellyStake, market, selection, pick: pickDirect, pinnacleInfo, pinnaclePrice };

    if (providerBetId !== null && providerBetId !== undefined && providerBetId !== '') {
      localTypeByProvider.set(String(providerBetId), meta);
    }

    const eventId = Number(item?.opportunity?.eventId || item?.payload?.eventId || item?.realPlacement?.response?.bets?.[0]?.selections?.[0]?.eventId);
    const placementSelection = item?.realPlacement?.response?.bets?.[0]?.selections?.[0] || null;
    const selectionTypeId = Number(placementSelection?.selectionTypeId);
    const pick = selectionTypeIdToPick(selectionTypeId, placementSelection) || pickDirect;
    if (Number.isFinite(eventId) && pick) {
      localTypeByEventPick.set(`${eventId}_${pick}`, meta);
    }
  }

  const enrichedRows = rows.map((row) => {
    const providerBetId = row?.providerBetId;
    let localMeta = (providerBetId === null || providerBetId === undefined || providerBetId === '')
      ? null
      : localTypeByProvider.get(String(providerBetId));

    const providerPortfolioMeta = (providerBetId === null || providerBetId === undefined || providerBetId === '')
      ? null
      : (portfolioMetaByProvider.get(String(providerBetId)) || null);
    const providerStickyMeta = (providerBetId === null || providerBetId === undefined || providerBetId === '')
      ? null
      : (profileStickyByProvider.get(String(providerBetId)) || null);

    const eventId = Number(row?.eventId);
    const firstSelection = row?.selections?.[0] || null;
    const selectionTypeId = Number(firstSelection?.selectionTypeId);
    const pick = selectionTypeIdToPick(selectionTypeId, firstSelection);
    const eventPickKey = Number.isFinite(eventId) && pick ? `${eventId}_${pick}` : null;

    const eventLocalMeta = eventPickKey ? (localTypeByEventPick.get(eventPickKey) || null) : null;
    const eventPortfolioMeta = eventPickKey ? (portfolioMetaByEventPick.get(eventPickKey) || null) : null;
    const eventStickyMeta = eventPickKey ? (profileStickyByEventPick.get(eventPickKey) || null) : null;

    localMeta = mergeMetaRows(localMeta, providerPortfolioMeta, providerStickyMeta, eventLocalMeta, eventPortfolioMeta, eventStickyMeta);
    if (!localMeta) return row;

    return {
      ...row,
      type: row?.type || localMeta.type || null,
      strategy: row?.strategy || localMeta.strategy || null,
      opportunityType: row?.opportunityType || localMeta.type || localMeta.strategy || null,
      ev: Number.isFinite(Number(row?.ev)) ? Number(row.ev) : (Number.isFinite(Number(localMeta?.ev)) ? Number(localMeta.ev) : null),
      realProb: Number.isFinite(Number(row?.realProb)) ? Number(row.realProb) : (Number.isFinite(Number(localMeta?.realProb)) ? Number(localMeta.realProb) : null),
      kellyStake: Number.isFinite(Number(row?.kellyStake)) ? Number(row.kellyStake) : (Number.isFinite(Number(localMeta?.kellyStake)) ? Number(localMeta.kellyStake) : null),
      market: row?.market || localMeta.market || null,
      selection: row?.selection || localMeta.selection || null,
      pick: row?.pick || localMeta.pick || null,
      pinnacleInfo: row?.pinnacleInfo || localMeta.pinnacleInfo || null,
      pinnaclePrice: (() => {
        const typeLabel = row?.type || row?.strategy || row?.opportunityType || localMeta?.type || localMeta?.strategy || null;
        const info = row?.pinnacleInfo || localMeta?.pinnacleInfo || null;
        const direct = Number.isFinite(Number(row?.pinnaclePrice))
          ? Number(row.pinnaclePrice)
          : (Number.isFinite(Number(localMeta?.pinnaclePrice)) ? Number(localMeta.pinnaclePrice) : null);
        const normalizedDirect = sanitizePinnaclePriceForType({ price: direct, pinnacleInfo: info, typeLabel });
        if (Number.isFinite(normalizedDirect)) return normalizedDirect;

        if (!isPrematchTypeLabel(typeLabel)) return null;

        const derived = derivePinnacleReferencePrice({
          pinnacleInfo: info,
          pick: row?.pick || localMeta?.pick || null,
          market: row?.market || localMeta?.market || null,
          selection: row?.selection || localMeta?.selection || null
        });
        return sanitizePinnaclePriceForType({ price: derived, pinnacleInfo: info, typeLabel });
      })()
    };
  });

  replaceProfileHistory(ctx.key, enrichedRows);
  await db.write();

  return enrichedRows.slice(0, max);
};

export const cleanupBookyOrphanActiveBets = async ({
  profileKey = null,
  forceRefresh = true,
  historyLimit = 0,
  fetchAll = true
} = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const key = normalizeBookProfile(profileKey || ctx.key);
  const activeBefore = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets.length : 0;

  const remote = await syncRemoteBookyHistory({
    forceRefresh,
    limit: historyLimit,
    profileKey: key,
    fetchAll
  });

  const remoteRows = Array.isArray(remote?.items) ? remote.items : [];
  const stats = reconcilePortfolioActiveBetsFromRemote(remoteRows, {
    integration: ctx.integration
  });

  if (Number(stats?.touchedCount || 0) > 0) {
    await db.write();
  }

  const activeAfter = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets.length : 0;

  return {
    profile: key,
    integration: ctx.integration,
    remoteRows: remoteRows.length,
    activeBefore,
    activeAfter,
    ...stats,
    fetchedAt: nowIso(),
    source: remote?.source || null,
    remoteError: remote?.error || null
  };
};

export const cleanupBookyHistoricalData = async ({ retentionDays, maxPerProfile } = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const safeRetentionDays = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0
    ? Number(retentionDays)
    : Number(getRuntimeEnvValue('BOOKY_HISTORY_RETENTION_DAYS', String(DEFAULT_HISTORY_RETENTION_DAYS))) || DEFAULT_HISTORY_RETENTION_DAYS;

  const safeMaxPerProfile = Number.isFinite(Number(maxPerProfile)) && Number(maxPerProfile) > 0
    ? Number(maxPerProfile)
    : Number(getRuntimeEnvValue('BOOKY_PROFILE_HISTORY_MAX_ITEMS', String(DEFAULT_PROFILE_HISTORY_MAX_ITEMS))) || DEFAULT_PROFILE_HISTORY_MAX_ITEMS;

  const result = {
    retentionDays: safeRetentionDays,
    maxPerProfile: safeMaxPerProfile,
    localRemoved: 0,
    remoteRemovedByProfile: {},
    mergedRemovedByProfile: {}
  };

  const localHistory = Array.isArray(db.data.booky.history) ? db.data.booky.history : [];
  const localBefore = localHistory.length;
  db.data.booky.history = pruneRowsByRetention(localHistory, safeRetentionDays);
  result.localRemoved = Math.max(0, localBefore - db.data.booky.history.length);

  const byProfile = db.data.booky.byProfile || {};
  for (const [profileName, storeRaw] of Object.entries(byProfile)) {
    const store = ensureProfileStoreShape(storeRaw);

    const remoteBefore = Array.isArray(store.remoteHistory?.items) ? store.remoteHistory.items.length : 0;
    store.remoteHistory.items = pruneRowsByRetention(store.remoteHistory?.items || [], safeRetentionDays)
      .sort((a, b) => getEntryTimestampMs(b) - getEntryTimestampMs(a))
      .slice(0, safeMaxPerProfile);
    result.remoteRemovedByProfile[profileName] = Math.max(0, remoteBefore - store.remoteHistory.items.length);

    const mergedBefore = Array.isArray(store.history) ? store.history.length : 0;
    store.history = pruneRowsByRetention(store.history || [], safeRetentionDays)
      .sort((a, b) => getEntryTimestampMs(b) - getEntryTimestampMs(a))
      .slice(0, safeMaxPerProfile);
    result.mergedRemovedByProfile[profileName] = Math.max(0, mergedBefore - store.history.length);
  }

  const ctx = getActiveProfileContext();
  const activeStore = getProfileStore(ctx.key, false);
  if (activeStore?.remoteHistory) {
    db.data.booky.remoteHistory = {
      ...db.data.booky.remoteHistory,
      ...activeStore.remoteHistory
    };
  }

  await db.write();
  return result;
};

export const importBookyPnlBaseFromSpy = async ({ profileKey = null, filePath = null } = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const profile = normalizeBookProfile(profileKey || ctx.key);
  const readResult = readSpyCashflowSummaryFromDisk({ profileKey: profile, filePath });

  if (!readResult.ok) {
    return {
      success: false,
      profile,
      reason: readResult.reason,
      filePath: readResult.filePath,
      error: readResult.error || null
    };
  }

  const amount = extractPnlBaseFromSpySummary(readResult.summary || {});
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      success: false,
      profile,
      reason: 'no-valid-base-in-spy-summary',
      filePath: readResult.filePath,
      summaryGeneratedAt: readResult.summary?.generatedAt || null
    };
  }

  const configuredFromDate = getConfiguredCashflowFromDate();
  const summaryFromDate = String(readResult.summary?.probeFromDate || '').trim() || null;
  if (configuredFromDate && configuredFromDate !== summaryFromDate) {
    return {
      success: false,
      profile,
      reason: 'probe-from-mismatch',
      filePath: readResult.filePath,
      configuredFromDate,
      summaryFromDate
    };
  }

  const store = getProfileStore(profile, true);
  store.pnlBase = {
    amount: Number(amount.toFixed(2)),
    source: 'spy-cashflow-file',
    updatedAt: nowIso(),
    summaryGeneratedAt: readResult.summary?.generatedAt || null,
    summaryStartedAt: readResult.summary?.startedAt || null,
    probeFromDate: readResult.summary?.probeFromDate || null,
    filePath: readResult.filePath,
    stats: readResult.summary?.cashflowStats || null
  };

  await db.write();

  return {
    success: true,
    profile,
    pnlBase: {
      amount: store.pnlBase.amount,
      source: store.pnlBase.source,
      updatedAt: store.pnlBase.updatedAt,
      probeFromDate: store.pnlBase.probeFromDate,
      filePath: store.pnlBase.filePath,
      configuredFromDate
    }
  };
};

export const getBookyPnlBaseSnapshot = async ({ profileKey = null } = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const profile = normalizeBookProfile(profileKey || ctx.key);
  const resolved = getPnlBaseCapital(profile);
  const store = getProfileStore(profile, false);

  return {
    profile,
    configuredFromDate: getConfiguredCashflowFromDate(),
    resolved: {
      amount: Number.isFinite(resolved?.amount) ? Number(resolved.amount.toFixed(2)) : null,
      source: resolved?.source || null,
      updatedAt: resolved?.updatedAt || null
    },
    dbPnlBase: store?.pnlBase || null,
    fetchedAt: nowIso()
  };
};

export const getBookyAccountSnapshot = async ({ forceRefresh = false, historyLimit = 60, cleanupOld = false, retentionDays = null } = {}) => {
  const ctx = getActiveProfileContext();
  const balance = await fetchBookyBalance({ forceRefresh, profileKey: ctx.key });
  if (forceRefresh) {
    await syncRemoteBookyHistory({ forceRefresh: true, limit: historyLimit, profileKey: ctx.key });
  }
  if (cleanupOld) {
    await cleanupBookyHistoricalData({ retentionDays });
  }
  const history = await getBookyHistory(historyLimit);
  const profileStore = getProfileStore(ctx.key, false);
  const fullProfileHistory = Array.isArray(profileStore?.history) ? profileStore.history : [];
  const finishedFromDateRaw = getConfiguredFinishedFromDate();
  const finishedFromDateIso = parseEnvDateStartIso(finishedFromDateRaw);
  const filteredHistory = filterRowsFromIsoDate(history, finishedFromDateIso);
  const filteredFullProfileHistory = filterRowsFromIsoDate(fullProfileHistory, finishedFromDateIso);
  const localBookyHistory = Array.isArray(db.data?.booky?.history) ? db.data.booky.history : [];
  const allowedProviderBetIds = new Set(
    localBookyHistory
      .filter((ticket) => normalizeBookProfile(String(ticket?.payload?.integration || '').trim()) === ctx.integration)
      .map((ticket) => ticket?.realPlacement?.response?.bets?.[0]?.id)
      .filter((id) => id !== null && id !== undefined && id !== '')
      .map((id) => String(id))
  );
  const pnlRealized = computeRealizedPnl(filteredFullProfileHistory, {
    integration: ctx.integration,
    allowedProviderBetIds
  });
  const pnlBreakdown = computePnlBreakdown(filteredFullProfileHistory, {
    integration: ctx.integration,
    allowedProviderBetIds
  });
  const openStake = Number(pnlBreakdown?.open?.stake || 0);
  const pnlCashAfterOpenStake = Number((pnlRealized - openStake).toFixed(2));
  const pnlHistoryNet = Number(pnlRealized.toFixed(2));
  const pnlBase = getPnlBaseCapital(ctx.key);
  const balanceAmount = safeNumber(balance?.amount, NaN);
  const hasBalanceAnchoredPnl = Number.isFinite(balanceAmount) && Number.isFinite(pnlBase.amount);
  const pnlByBalance = hasBalanceAnchoredPnl
    ? Number((balanceAmount - pnlBase.amount).toFixed(2))
    : null;
  // Si no hay base capital anclada, usamos caja neta del historial (realizado - stake abierto).
  const pnlNetAfterOpenStake = Number.isFinite(pnlByBalance) ? pnlByBalance : pnlCashAfterOpenStake;
  const pnlSource = 'profile-history-extended-db';

  const profile = ctx.profile;

  return {
    profile,
    integration: ctx.integration,
    balance,
    history: filteredHistory,
    historyCount: filteredHistory.length,
    historyTotalCount: filteredFullProfileHistory.length,
    historyFromDate: finishedFromDateIso,
    historyFromDateRaw: finishedFromDateRaw,
    pnl: {
      realized: Number(pnlRealized.toFixed(2)),
      total: pnlNetAfterOpenStake,
      source: pnlSource,
      netAfterOpenStake: pnlNetAfterOpenStake,
      cashAfterOpenStake: pnlCashAfterOpenStake,
      byBalance: Number.isFinite(pnlByBalance) ? pnlByBalance : null,
      baseCapital: Number.isFinite(pnlBase.amount) ? pnlBase.amount : null,
      baseCapitalSource: pnlBase.source,
      rowsCount: filteredFullProfileHistory.length,
      breakdown: pnlBreakdown
    },
    fetchedAt: nowIso()
  };
};

export const getKellyBankrollBase = async ({ skipDbRefresh = false, useCachedOnly = false } = {}) => {
  if (!skipDbRefresh) {
    await initDB();
    await db.read();
  } else if (!db.data) {
    // Si el llamador pide no refrescar, al menos aseguramos estructura cargada.
    await initDB();
  }
  ensureBookyStore();
  const ctx = getActiveProfileContext();
  const baseMode = getKellyBaseMode();

  // Modo manual: usar exclusivamente balance del portfolio (paper/manual capital).
  if (baseMode === 'PORTFOLIO') {
    const portfolioBalance = safeNumber(db.data?.portfolio?.balance, NaN);
    if (Number.isFinite(portfolioBalance) && portfolioBalance > 0) {
      return {
        amount: portfolioBalance,
        source: 'portfolio-manual',
        updatedAt: null,
        openExposure: 0,
        baseMode
      };
    }
  }

  // Modo manual fijo: usar bankroll de config como base rígida.
  if (baseMode === 'CONFIG') {
    const configBankroll = safeNumber(db.data?.config?.bankroll, 100);
    return {
      amount: Number.isFinite(configBankroll) && configBankroll > 0 ? configBankroll : 100,
      source: 'config-manual',
      updatedAt: null,
      openExposure: 0,
      baseMode
    };
  }

  const real = useCachedOnly
    ? getCachedDbBalance(ctx.key)
    : await fetchBookyBalance({ forceRefresh: false });
  const realAmount = safeNumber(real?.amount, NaN);
  if (Number.isFinite(realAmount) && realAmount > 0) {
    if (baseMode === 'NAV') {
      const profileOpenExposure = getProfileOpenExposureStake(ctx.key);
      const portfolioOpenExposure = getPortfolioOpenExposureStake(ctx.integration);
      const openExposure = Number(Math.max(profileOpenExposure, portfolioOpenExposure).toFixed(2));
      const navAmount = Number((realAmount + openExposure).toFixed(2));

      return {
        amount: navAmount,
        source: 'booky-nav',
        updatedAt: real?.updatedAt || null,
        openExposure,
        baseMode
      };
    }

    return {
      amount: realAmount,
      source: 'booky-real',
      updatedAt: real?.updatedAt || null,
      openExposure: 0,
      baseMode
    };
  }

  const portfolioBalance = safeNumber(db.data?.portfolio?.balance, NaN);
  if (Number.isFinite(portfolioBalance) && portfolioBalance > 0) {
    return {
      amount: portfolioBalance,
      source: 'portfolio-fallback',
      updatedAt: null,
      openExposure: 0,
      baseMode
    };
  }

  const configBankroll = safeNumber(db.data?.config?.bankroll, 100);
  return {
    amount: Number.isFinite(configBankroll) && configBankroll > 0 ? configBankroll : 100,
    source: 'config-fallback',
    updatedAt: null,
    openExposure: 0,
    baseMode
  };
};

const computeSimultaneityPeaks = (rows = [], windows = [5, 10, 15, 30, 60]) => {
  const sorted = [...rows]
    .filter((row) => Number.isFinite(new Date(row?.placedAt || row?.createdAt || 0).getTime()))
    .sort((a, b) => new Date(a.placedAt || a.createdAt || 0) - new Date(b.placedAt || b.createdAt || 0));

  return windows.map((windowMin) => {
    let peakCount = 0;
    let peakStake = 0;
    let peakAt = null;

    for (let i = 0; i < sorted.length; i++) {
      const startMs = new Date(sorted[i].placedAt || sorted[i].createdAt || 0).getTime();
      let count = 0;
      let stake = 0;

      for (let k = i; k < sorted.length; k++) {
        const rowMs = new Date(sorted[k].placedAt || sorted[k].createdAt || 0).getTime();
        const diffMin = (rowMs - startMs) / 60000;
        if (diffMin > windowMin) break;
        count += 1;
        stake += Number(sorted[k]?.stake || 0);
      }

      if (count > peakCount || (count === peakCount && stake > peakStake)) {
        peakCount = count;
        peakStake = stake;
        peakAt = new Date(startMs).toISOString();
      }
    }

    return {
      windowMin,
      peakCount,
      peakStake: Number(peakStake.toFixed(2)),
      peakAt
    };
  });
};

const estimateRuinProbability = ({
  bankroll = 0,
  fraction = 0.1,
  returns = [],
  horizonBets = 300,
  simulations = 2000,
  ruinThreshold = 0.2
} = {}) => {
  const initial = Number(bankroll);
  const f = Number(fraction);
  const sample = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  const horizon = Math.max(10, Number(horizonBets) || 300);
  const sims = Math.max(200, Number(simulations) || 2000);
  const threshold = Math.max(0.01, Math.min(0.99, Number(ruinThreshold) || 0.2));

  if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(f) || f <= 0 || sample.length === 0) {
    return {
      probability: null,
      ruinedSimulations: 0,
      simulations: sims,
      horizonBets: horizon,
      ruinThreshold: threshold,
      thresholdAmount: Number((initial * threshold).toFixed(2))
    };
  }

  const thresholdAmount = initial * threshold;
  let ruined = 0;

  for (let s = 0; s < sims; s++) {
    let bankrollNow = initial;

    for (let i = 0; i < horizon; i++) {
      const r = sample[Math.floor(Math.random() * sample.length)];
      const multiplier = 1 + (f * r);
      bankrollNow *= Math.max(0, multiplier);
      if (bankrollNow <= thresholdAmount) {
        ruined += 1;
        break;
      }
    }
  }

  return {
    probability: Number((ruined / sims).toFixed(4)),
    ruinedSimulations: ruined,
    simulations: sims,
    horizonBets: horizon,
    ruinThreshold: threshold,
    thresholdAmount: Number(thresholdAmount.toFixed(2))
  };
};

export const getBookyKellyDiagnostics = async ({
  profileKey = null,
  horizonBets = 300,
  simulations = 2000,
  ruinThreshold = 0.2
} = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const profile = normalizeBookProfile(profileKey || ctx.key);
  const profileStore = getProfileStore(profile, false);
  const historyRows = Array.isArray(profileStore?.history) ? profileStore.history : [];

  const settledRows = historyRows.filter((row) => BOOKY_SETTLED_PROVIDER_STATUSES.has(Number(row?.status)));
  const pnlByRow = settledRows.map((row) => {
    const stake = Number(row?.stake || 0);
    const pnl = resolveRowPnl(row);
    const roi = stake > 0 ? pnl / stake : null;
    return { stake, pnl, roi };
  });

  const roiSample = pnlByRow.map((x) => x.roi).filter((x) => Number.isFinite(x));
  const avgRoi = roiSample.length > 0
    ? Number((roiSample.reduce((a, b) => a + b, 0) / roiSample.length).toFixed(4))
    : null;
  const hitRate = pnlByRow.length > 0
    ? Number((pnlByRow.filter((x) => x.pnl > 0).length / pnlByRow.length).toFixed(4))
    : null;

  const kellyBase = await getKellyBankrollBase();
  const windows = computeSimultaneityPeaks(historyRows, [5, 15, 30, 60]);
  const peak30 = windows.find((w) => w.windowMin === 30) || { peakStake: 0 };
  const exposurePressure = Number.isFinite(Number(kellyBase?.amount)) && Number(kellyBase.amount) > 0
    ? Number((Number(peak30.peakStake || 0) / Number(kellyBase.amount)).toFixed(4))
    : 0;

  const envFractions = {
    PREMATCH_VALUE: Number(getRuntimeEnvValue('KELLY_FRACTION_PREMATCH_VALUE', '0.22')),
    LIVE_VALUE: Number(getRuntimeEnvValue('KELLY_FRACTION_LIVE_VALUE', '0.10')),
    LIVE_SNIPE: Number(getRuntimeEnvValue('KELLY_FRACTION_LIVE_SNIPE', '0.08')),
    DEFAULT: Number(getRuntimeEnvValue('KELLY_FRACTION_DEFAULT', '0.10'))
  };

  const pressureFactor = exposurePressure >= 0.4 ? 0.75 : exposurePressure >= 0.25 ? 0.85 : 1;
  const recommendedFractions = {
    PREMATCH_VALUE: Number((Math.max(0.05, envFractions.PREMATCH_VALUE * pressureFactor)).toFixed(3)),
    LIVE_VALUE: Number((Math.max(0.04, envFractions.LIVE_VALUE * pressureFactor)).toFixed(3)),
    LIVE_SNIPE: Number((Math.max(0.03, envFractions.LIVE_SNIPE * pressureFactor)).toFixed(3)),
    DEFAULT: Number((Math.max(0.04, envFractions.DEFAULT * pressureFactor)).toFixed(3))
  };

  const ruinEstimate = {
    PREMATCH_VALUE: estimateRuinProbability({
      bankroll: Number(kellyBase?.amount || 0),
      fraction: recommendedFractions.PREMATCH_VALUE,
      returns: roiSample,
      horizonBets,
      simulations,
      ruinThreshold
    }),
    LIVE_VALUE: estimateRuinProbability({
      bankroll: Number(kellyBase?.amount || 0),
      fraction: recommendedFractions.LIVE_VALUE,
      returns: roiSample,
      horizonBets,
      simulations,
      ruinThreshold
    }),
    LIVE_SNIPE: estimateRuinProbability({
      bankroll: Number(kellyBase?.amount || 0),
      fraction: recommendedFractions.LIVE_SNIPE,
      returns: roiSample,
      horizonBets,
      simulations,
      ruinThreshold
    })
  };

  return {
    profile,
    fetchedAt: nowIso(),
    bankrollBase: kellyBase,
    sample: {
      totalRows: historyRows.length,
      settledRows: settledRows.length,
      avgRoi,
      hitRate
    },
    simultaneity: {
      windows,
      exposurePressure
    },
    fractions: {
      env: envFractions,
      recommended: recommendedFractions
    },
    riskOfRuin: ruinEstimate,
    notes: [
      'La simulación usa distribución empírica de ROI por apuesta liquidada (bootstrap con reemplazo).',
      'Ruin se define como bankroll <= umbral configurado (por defecto 20% del bankroll inicial).',
      'La recomendación reduce fracciones si la simultaneidad observada es alta (ventana 30 min).'
    ]
  };
};
