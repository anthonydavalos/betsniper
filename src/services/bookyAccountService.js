import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env');

const DEFAULT_BALANCE_REFRESH_MS = 45000;
const DEFAULT_HISTORY_REFRESH_MS = 60000;
const DEFAULT_BOOKY_CURRENCY = 'PEN';
const DEFAULT_HISTORY_RETENTION_DAYS = 30;
const DEFAULT_PROFILE_HISTORY_MAX_ITEMS = 500;
const LEAGUE_MISS_LOG_THROTTLE_MS = 5 * 60 * 1000;

const memoryBalanceCacheByProfile = new Map();
const memoryHistoryCacheByProfile = new Map();
const lastLeagueMissLogByProfile = new Map();

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
  const from = new Date(now.getTime() - (45 * 24 * 60 * 60 * 1000));
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

const mapRemoteHistoryItem = (entry = {}) => {
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
    selections: selections.map(mapRemoteSelection),
    raw: entry
  };
};

const getCachedRemoteHistory = (limit = 60, profileKey = null) => {
  const key = normalizeBookProfile(profileKey || getActiveProfileContext().key);
  const profileStore = getProfileStore(key, false) || {};
  const cache = profileStore.remoteHistory || db.data?.booky?.remoteHistory || {};
  const items = Array.isArray(cache.items) ? cache.items : [];
  const updatedAt = cache.updatedAt || null;
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 60;

  return {
    items: items.slice(0, max),
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
    merged.set(rowKey, row);
  }

  const maxItems = Math.max(100, Number(getRuntimeEnvValue('BOOKY_PROFILE_HISTORY_MAX_ITEMS', String(DEFAULT_PROFILE_HISTORY_MAX_ITEMS))) || DEFAULT_PROFILE_HISTORY_MAX_ITEMS);
  profileStore.history = Array.from(merged.values())
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

const requestRemoteBetHistory = async (auth, limit = 60) => {
  const baseUrl = getBetHistoryBaseUrl();
  const headers = buildProviderHeaders(auth);
  const target = Math.max(10, Math.min(300, Number.isFinite(Number(limit)) ? Number(limit) : 60));
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

    while (pageNumber <= 6 && dedup.size < target) {
      const payload = buildHistoryPayload({
        limit: Math.min(50, target),
        pageNumber,
        statuses
      });

      try {
        const postResp = await altenarClient.post(url, payload, { headers, timeout });
        const body = postResp?.data || {};
        const rows = pickArrayCandidate(body).map(mapRemoteHistoryItem);

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

export const syncRemoteBookyHistory = async ({ forceRefresh = false, limit = 60, profileKey = null } = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();
  const key = normalizeBookProfile(profileKey || ctx.key);

  const refreshMs = getHistoryRefreshMs();
  const now = Date.now();
  const memoryHistoryCache = memoryHistoryCacheByProfile.get(key) || null;

  if (!forceRefresh && memoryHistoryCache?.updatedAtMs && (now - memoryHistoryCache.updatedAtMs) < refreshMs) {
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 60;
    return { ...memoryHistoryCache.value, items: memoryHistoryCache.value.items.slice(0, max), stale: false };
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
    return {
      ...cached,
      source: 'cache-no-token',
      error: 'Sin ALTENAR_BOOKY_AUTH_TOKEN para sincronizar historial remoto.'
    };
  }

  try {
    const remote = await requestRemoteBetHistory(auth, limit);
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

    const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 60;
    return {
      ...normalized,
      items: normalized.items.slice(0, max)
    };
  } catch (error) {
    return {
      ...cached,
      source: cached.items?.length ? 'cache-fallback' : 'unavailable',
      error: error?.message || 'Fallo sincronizando historial remoto de Booky.'
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
  const account = getProfileStore(key, false)?.account || db.data?.booky?.account || {};
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
    return {
      ...(cached || {
        amount: null,
        currency: DEFAULT_BOOKY_CURRENCY,
        updatedAt: null,
        source: 'unavailable',
        stale: true
      }),
      error: 'Sin ALTENAR_BOOKY_AUTH_TOKEN para consultar balance real.'
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
    return {
      ...(cached || {
        amount: null,
        currency: DEFAULT_BOOKY_CURRENCY,
        updatedAt: null,
        source: 'unavailable',
        stale: true
      }),
      error: error?.message || 'Fallo consultando balance real en provider.'
    };
  }
};

const mapBookyHistoryItem = (entry = {}) => {
  const opportunity = entry.opportunity || {};
  const placedAt = entry.realPlacement?.placedAt || entry.confirmedAt || entry.updatedAt || entry.createdAt || null;
  const providerBetId = entry.realPlacement?.response?.bets?.[0]?.id || null;
  const integration = normalizeBookProfile(entry?.payload?.integration || entry?.opportunity?.integration || '');

  return {
    ticketId: entry.id || null,
    status: entry.status || null,
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
    integration: integration || null
  };
};

export const getBookyHistory = async (limit = 60) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const ctx = getActiveProfileContext();

  const max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 60;
  const history = Array.isArray(db.data.booky.history) ? db.data.booky.history : [];
  const localRows = history
    .filter(item => item?.realPlacement)
    .map(mapBookyHistoryItem)
    .filter(row => !row.integration || row.integration === ctx.integration)
    .slice(-max)
    .reverse()
    .map(row => ({ ...row, source: 'local' }));

  const remote = await syncRemoteBookyHistory({ forceRefresh: false, limit: max * 2, profileKey: ctx.key });
  const remoteRows = Array.isArray(remote?.items) ? remote.items : [];

  if (remoteRows.length === 0) {
    return localRows;
  }

  const merged = new Map();

  for (const row of remoteRows) {
    const key = row.providerBetId ? `pb_${row.providerBetId}` : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    merged.set(key, row);
  }

  for (const row of localRows) {
    const key = row.providerBetId ? `pb_${row.providerBetId}` : `${row.match || 'na'}_${row.placedAt || 'na'}_${row.stake || 0}`;
    if (!merged.has(key)) merged.set(key, row);
  }

  const rows = Array.from(merged.values())
    .sort((a, b) => new Date(b.placedAt || 0) - new Date(a.placedAt || 0))
    .slice(0, max);

  upsertProfileHistory(ctx.key, rows);
  await db.write();

  return rows;
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
  const profile = ctx.profile;

  return {
    profile,
    integration: ctx.integration,
    balance,
    history,
    historyCount: history.length,
    fetchedAt: nowIso()
  };
};

export const getKellyBankrollBase = async () => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const real = await fetchBookyBalance({ forceRefresh: false });
  const realAmount = safeNumber(real?.amount, NaN);
  if (Number.isFinite(realAmount) && realAmount > 0) {
    return {
      amount: realAmount,
      source: 'booky-real',
      updatedAt: real?.updatedAt || null
    };
  }

  const portfolioBalance = safeNumber(db.data?.portfolio?.balance, NaN);
  if (Number.isFinite(portfolioBalance) && portfolioBalance > 0) {
    return {
      amount: portfolioBalance,
      source: 'portfolio-fallback',
      updatedAt: null
    };
  }

  const configBankroll = safeNumber(db.data?.config?.bankroll, 100);
  return {
    amount: Number.isFinite(configBankroll) && configBankroll > 0 ? configBankroll : 100,
    source: 'config-fallback',
    updatedAt: null
  };
};
