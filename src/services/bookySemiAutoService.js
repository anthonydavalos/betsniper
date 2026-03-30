import db, { initDB, writeDBWithRetry } from '../db/database.js';
import altenarClient from '../config/axiosClient.js';
import { getAltenarPublicRequestConfig, maybeAutoRenewWidgetToken } from '../config/altenarPublicConfig.js';
import { refreshOpportunity } from './oddsService.js';
import { placeAutoBet } from './paperTradingService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env');

const LIVE_TICKET_EXPIRY_MS = 30 * 1000;
const PREMATCH_TICKET_EXPIRY_MS = 3 * 60 * 1000;

const parsePositiveNumberFromEnv = (rawValue, fallback) => {
  const n = Number(rawValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const LIVE_MAX_ODD_DRIFT = parsePositiveNumberFromEnv(process.env.BOOKY_LIVE_MAX_ODD_DRIFT, 0.08);
const PREMATCH_MAX_ODD_DRIFT = parsePositiveNumberFromEnv(process.env.BOOKY_PREMATCH_MAX_ODD_DRIFT, 0.2);
const PLACE_WIDGET_URL = 'https://sb2betgateway-altenar2.biahosted.com/api/widget/placeWidget';
const DEFAULT_MIN_TOKEN_MINUTES = 2;
const prepareTicketInFlight = new Map();
const ticketMutationInFlight = new Map();

const nowIso = () => new Date().toISOString();

const isLiveOpportunity = (op = {}) => {
  const type = String(op.type || op.strategy || '').toUpperCase();
  return type.includes('LIVE');
};

const getExpiryMs = (op = {}) => isLiveOpportunity(op) ? LIVE_TICKET_EXPIRY_MS : PREMATCH_TICKET_EXPIRY_MS;
const getMaxDrift = (op = {}) => isLiveOpportunity(op) ? LIVE_MAX_ODD_DRIFT : PREMATCH_MAX_ODD_DRIFT;

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const flattenOddIds = (market = {}) => {
  if (Array.isArray(market.desktopOddIds)) return market.desktopOddIds.flat().filter(Boolean);
  if (Array.isArray(market.oddIds)) return market.oddIds.filter(Boolean);
  return [];
};

const normalizeText = (value = '') => String(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

const normalizeApiMarketLabel = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const normalized = normalizeText(raw).replace(/\s+/g, ' ').trim();
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

const extractLine = (value = '') => {
  const txt = normalizeText(value).replace(',', '.');
  const match = txt.match(/(\d+(?:\.\d+)?)/);
  if (!match) return NaN;
  const line = Number(match[1]);
  return Number.isFinite(line) ? line : NaN;
};

const normalizePick = (obj = {}) => {
  if (obj.pick) return String(obj.pick).toLowerCase();

  const actionStr = (obj.action || '').toUpperCase();
  const selectionStr = (obj.selection || '').toUpperCase();
  const marketStr = (obj.market || '').toUpperCase();
  const combined = `${selectionStr} ${actionStr} ${marketStr}`;

  if (selectionStr === 'HOME' || actionStr.includes('LOCAL')) return 'home';
  if (selectionStr === 'AWAY' || actionStr.includes('VISITA')) return 'away';
  if (selectionStr === 'DRAW' || actionStr.includes('EMPATE')) return 'draw';

  if (combined.includes('BTTS') && (combined.includes('YES') || combined.includes('SI') || combined.includes('SÍ'))) return 'btts_yes';
  if (combined.includes('BTTS') && combined.includes('NO')) return 'btts_no';

  if (combined.includes('OVER') || combined.includes('MÁS') || combined.includes('MAS')) {
    const lineMatch = selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/);
    const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
    return Number.isFinite(line) ? `over_${line}` : 'over';
  }

  if (combined.includes('UNDER') || combined.includes('MENOS')) {
    const lineMatch = selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/);
    const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
    return Number.isFinite(line) ? `under_${line}` : 'under';
  }

  return String(obj.selection || obj.action || obj.market || '').replace(/\s+/g, '_').toLowerCase();
};

const buildTicketKey = (op = {}) => {
  const eventId = String(op.eventId || op.id || 'na');
  return `${eventId}_${normalizePick(op)}`;
};

const findPortfolioMirrorBet = (opportunity = {}) => {
  const portfolio = db.data?.portfolio || {};
  const pick = normalizePick(opportunity);
  const eventId = String(opportunity.eventId || '');

  const matcher = (bet = {}) => {
    if (!bet) return false;
    if (eventId && String(bet.eventId || '') !== eventId) return false;
    if (String(bet.pick || '').toLowerCase() !== pick) return false;
    return true;
  };

  const active = Array.isArray(portfolio.activeBets) ? portfolio.activeBets : [];
  const history = Array.isArray(portfolio.history) ? portfolio.history : [];

  const activeMatch = active.find(matcher);
  if (activeMatch) return activeMatch;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (matcher(history[i])) return history[i];
  }

  return null;
};

const ensureBookyStore = () => {
  if (!db.data.booky) db.data.booky = { pendingTickets: [], history: [] };
  if (!db.data.booky.pendingTickets) db.data.booky.pendingTickets = [];
  if (!db.data.booky.history) db.data.booky.history = [];
};

const cloneForStorage = (value) => JSON.parse(JSON.stringify(value));

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

const isAuthenticatedJwtPayload = (payload = null) => {
  if (!payload || typeof payload !== 'object') return false;
  const personId = String(payload.PersonId || '').trim();
  const loginId = String(payload.LoginId || '').trim();
  const userName = String(payload.UserName || '').trim();
  if (!personId || !loginId || !userName) return false;
  const lowUser = userName.toLowerCase();
  if (lowUser === 'guest' || lowUser.includes('invitado')) return false;
  return true;
};

const getTokenHealth = () => {
  const auth = getActiveAuthHeader();
  if (!auth) {
    return {
      exists: false,
      jwtValid: false,
      authenticated: false,
      tokenIntegration: null,
      tokenUserName: null,
      expIso: null,
      remainingMinutes: null,
      expired: true
    };
  }

  const raw = auth.replace(/^Bearer\s+/i, '').trim();
  const payload = decodeJwtPayload(raw);
  const jwtValid = Boolean(payload);
  const authenticated = isAuthenticatedJwtPayload(payload);
  const expUnix = Number(payload?.exp);

  if (!Number.isFinite(expUnix)) {
    return {
      exists: true,
      jwtValid,
      authenticated,
      tokenIntegration: String(payload?.Integration || '').trim().toLowerCase() || null,
      tokenUserName: String(payload?.UserName || '').trim() || null,
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
    authenticated,
    tokenIntegration: String(payload?.Integration || '').trim().toLowerCase() || null,
    tokenUserName: String(payload?.UserName || '').trim() || null,
    expIso: new Date(expMs).toISOString(),
    remainingMinutes,
    expired: remainingMinutes <= 0
  };
};

const TOKEN_RENEW_COOLDOWN_MS = 15000;
let lastTokenRenewLaunchAt = 0;

const triggerInteractiveTokenRenewal = () => {
  const profile = getRuntimeEnvValue('BOOK_PROFILE', 'doradobet').toLowerCase();
  const scriptPath = path.join(projectRoot, 'scripts', 'extract-booky-auth-token.js');
  const args = ['--headed', '--wait-close', `--require-profile=${profile}`];
  const runtimeEnv = readRuntimeEnv();
  const childEnv = {
    ...process.env,
    ...runtimeEnv,
    BOOK_PROFILE: profile,
    ALTENAR_INTEGRATION: getRuntimeEnvValue('ALTENAR_INTEGRATION', process.env.ALTENAR_INTEGRATION || ''),
    ALTENAR_BOOKY_URL: getRuntimeEnvValue('ALTENAR_BOOKY_URL', process.env.ALTENAR_BOOKY_URL || ''),
    ALTENAR_ORIGIN: getRuntimeEnvValue('ALTENAR_ORIGIN', process.env.ALTENAR_ORIGIN || ''),
    ALTENAR_REFERER: getRuntimeEnvValue('ALTENAR_REFERER', process.env.ALTENAR_REFERER || '')
  };
  try {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: childEnv
    });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
};

export const requestBookyTokenRenewal = () => {
  const profile = getRuntimeEnvValue('BOOK_PROFILE', 'doradobet').toLowerCase();
  const renewalCommand = `node scripts/extract-booky-auth-token.js --headed --wait-close --require-profile=${profile}`;
  const now = Date.now();
  const elapsed = now - lastTokenRenewLaunchAt;

  if (lastTokenRenewLaunchAt > 0 && elapsed < TOKEN_RENEW_COOLDOWN_MS) {
    const waitSeconds = Math.max(1, Math.ceil((TOKEN_RENEW_COOLDOWN_MS - elapsed) / 1000));
    return {
      started: false,
      busy: true,
      profile,
      renewalCommand,
      retryAfterSeconds: waitSeconds,
      message: `Ya hay una renovación de token en curso o recién iniciada. Reintenta en ${waitSeconds}s.`
    };
  }

  const started = triggerInteractiveTokenRenewal();
  if (started) {
    lastTokenRenewLaunchAt = now;
  }
  return {
    started,
    busy: false,
    profile,
    renewalCommand,
    message: started
      ? 'Se lanzó Chrome para renovar token. Inicia sesión y cierra el navegador al finalizar.'
      : 'No se pudo lanzar Chrome automáticamente. Ejecuta el comando manual.'
  };
};

const ensureTokenFreshOrThrow = () => {
  const enabled = getRuntimeEnvValue('BOOKY_AUTO_TOKEN_REFRESH_ENABLED', '').toLowerCase() === 'true';
  const minMinutes = Number(getRuntimeEnvValue('BOOKY_TOKEN_MIN_REMAINING_MINUTES', String(DEFAULT_MIN_TOKEN_MINUTES)));
  const health = getTokenHealth();
  const expectedIntegration = String(
    getRuntimeEnvValue('ALTENAR_INTEGRATION', altenarClient?.defaults?.params?.integration || '')
  ).trim().toLowerCase();
  const tokenIntegration = String(health?.tokenIntegration || '').trim().toLowerCase();
  const integrationMismatch = Boolean(expectedIntegration && tokenIntegration && expectedIntegration !== tokenIntegration);

  const mustRenew = !health.exists || !health.jwtValid || !health.authenticated || health.expired ||
    (Number.isFinite(health.remainingMinutes) && health.remainingMinutes < (Number.isFinite(minMinutes) ? minMinutes : DEFAULT_MIN_TOKEN_MINUTES)) ||
    integrationMismatch;

  if (!mustRenew) {
    return {
      ok: true,
      health,
      renewalTriggered: false
    };
  }

  let renewalTriggered = false;
  if (enabled) {
    renewalTriggered = triggerInteractiveTokenRenewal();
  }

  const reason = !health.exists
    ? 'No hay token ALTENAR_BOOKY_AUTH_TOKEN en .env.'
    : (!health.jwtValid
      ? 'Token con formato inválido (no JWT) o corrupto.'
      : (!health.authenticated
        ? 'Token no pertenece a una sesión autenticada de usuario.'
        : (health.expired
          ? `Token vencido (exp=${health.expIso || 'n/a'}).`
          : (integrationMismatch
            ? `Token de integración no coincide (token=${tokenIntegration || 'n/a'} env=${expectedIntegration || 'n/a'}).`
            : `Token por vencer en ${health.remainingMinutes} min (exp=${health.expIso || 'n/a'}).`))));

  throw createBookyError(
    `${reason} Renueva token antes de confirmar apuesta real.`,
    {
      statusCode: 428,
      code: 'BOOKY_TOKEN_RENEWAL_REQUIRED',
      diagnostic: {
        ...health,
        expectedIntegration: expectedIntegration || null,
        integrationMismatch,
        minRequiredMinutes: Number.isFinite(minMinutes) ? minMinutes : DEFAULT_MIN_TOKEN_MINUTES,
        autoRefreshEnabled: enabled,
        renewalTriggered,
        renewalCommand: `node scripts/extract-booky-auth-token.js --headed --wait-close --require-profile=${getRuntimeEnvValue('BOOK_PROFILE', 'doradobet').toLowerCase()}`
      }
    }
  );
};

export const getBookyTokenHealth = () => {
  const health = getTokenHealth();
  const profile = getRuntimeEnvValue('BOOK_PROFILE', 'doradobet').toLowerCase();
  const integration = altenarClient?.defaults?.params?.integration || profile;
  const expectedIntegration = String(getRuntimeEnvValue('ALTENAR_INTEGRATION', integration || '')).trim().toLowerCase();
  const tokenIntegration = String(health?.tokenIntegration || '').trim().toLowerCase();
  const realPlacementEnabled = getRuntimeEnvValue('BOOKY_REAL_PLACEMENT_ENABLED', '').toLowerCase() === 'true';
  const renewalCommand = `node scripts/extract-booky-auth-token.js --headed --wait-close --require-profile=${profile}`;
  return {
    profile,
    integration,
    expectedIntegration,
    exists: health.exists,
    jwtValid: health.jwtValid,
    authenticated: health.authenticated,
    tokenIntegration: health.tokenIntegration,
    tokenUserName: health.tokenUserName,
    integrationMismatch: Boolean(expectedIntegration && tokenIntegration && expectedIntegration !== tokenIntegration),
    expIso: health.expIso,
    remainingMinutes: health.remainingMinutes,
    expired: health.expired,
    minRequiredMinutes: Number(getRuntimeEnvValue('BOOKY_TOKEN_MIN_REMAINING_MINUTES', String(DEFAULT_MIN_TOKEN_MINUTES))),
    autoRefreshEnabled: getRuntimeEnvValue('BOOKY_AUTO_TOKEN_REFRESH_ENABLED', '').toLowerCase() === 'true',
    realPlacementEnabled,
    renewalCommand
  };
};

const getTicketById = (ticketId) => {
  const idx = db.data.booky.pendingTickets.findIndex(t => String(t.id) === String(ticketId));
  if (idx < 0) throw new Error('Ticket no encontrado.');
  return { idx, ticket: db.data.booky.pendingTickets[idx] };
};

const findBookyHistoryTicketById = (ticketId) => {
  const history = Array.isArray(db.data?.booky?.history) ? db.data.booky.history : [];
  return history.find((t) => String(t?.id) === String(ticketId)) || null;
};

const withTicketMutationLock = async (ticketId, action) => {
  const lockKey = String(ticketId || 'na');
  const inFlight = ticketMutationInFlight.get(lockKey);
  if (inFlight) return inFlight;

  const run = Promise.resolve()
    .then(() => action())
    .finally(() => {
      ticketMutationInFlight.delete(lockKey);
    });

  ticketMutationInFlight.set(lockKey, run);
  return run;
};

const createBookyError = (message, { statusCode = 400, code = 'BOOKY_ERROR', diagnostic = null } = {}) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (diagnostic) err.diagnostic = diagnostic;
  return err;
};

const maskAuthToken = (token = '') => {
  if (!token || typeof token !== 'string') return null;
  const raw = token.replace(/^Bearer\s+/i, '');
  if (raw.length <= 10) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
};

const pickResponseHeaders = (headers = {}) => {
  if (!headers || typeof headers !== 'object') return {};
  const wanted = [
    'date',
    'server',
    'content-type',
    'content-length',
    'x-request-id',
    'x-correlation-id',
    'cf-ray',
    'via'
  ];
  const out = {};
  for (const key of wanted) {
    if (headers[key] !== undefined) out[key] = headers[key];
  }
  return out;
};

const buildProviderDiagnostic = ({ error, draft, ticketId, authHeader }) => {
  const status = Number(error?.response?.status) || null;
  const data = error?.response?.data ?? null;
  const headers = pickResponseHeaders(error?.response?.headers || {});

  return {
    provider: 'altenar_placeWidget',
    ticketId,
    endpoint: draft?.endpoint || PLACE_WIDGET_URL,
    requestId: draft?.payload?.requestId || null,
    eventId: draft?.payload?.betMarkets?.[0]?.id || null,
    marketId: draft?.payload?.betMarkets?.[0]?.odds?.[0]?.marketId || null,
    oddId: draft?.payload?.betMarkets?.[0]?.odds?.[0]?.id || null,
    sentPrice: draft?.payload?.betMarkets?.[0]?.odds?.[0]?.price || null,
    sentStake: draft?.payload?.stakes?.[0] || null,
    integration: draft?.payload?.integration || altenarClient?.defaults?.params?.integration || null,
    auth: {
      configured: Boolean(authHeader),
      preview: maskAuthToken(authHeader || '')
    },
    providerStatus: status,
    providerCode: error?.code || null,
    providerMessage: error?.message || 'Provider request failed',
    providerHeaders: headers,
    providerBody: data,
    observedAt: nowIso()
  };
};

const getValueGuardConfig = () => {
  const minEvPercent = Number(getRuntimeEnvValue('BOOKY_MIN_EV_PERCENT', '0'));
  const maxOddDrop = Number(
    getRuntimeEnvValue('BOOKY_MAX_ODD_DROP', getRuntimeEnvValue('BOOKY_MIN_ODD_DROP', '0'))
  );

  return {
    minEvPercent: Number.isFinite(minEvPercent) ? minEvPercent : 0,
    maxOddDrop: Number.isFinite(maxOddDrop) ? maxOddDrop : 0
  };
};

const enforceValueGuardsOrThrow = ({ ticket, draft }) => {
  const { minEvPercent, maxOddDrop } = getValueGuardConfig();
  if (minEvPercent <= 0 && maxOddDrop <= 0) return;

  const oldOdd = safeNumber(ticket?.opportunity?.price ?? ticket?.opportunity?.odd);
  const finalOdd = safeNumber(
    draft?.payload?.betMarkets?.[0]?.odds?.[0]?.price ?? draft?.refreshed?.price ?? draft?.refreshed?.odd
  );
  const oddDrop = oldOdd - finalOdd;

  const realProbPct = safeNumber(draft?.refreshed?.realProb, NaN);
  const evPercent = Number.isFinite(realProbPct)
    ? (((realProbPct / 100) * finalOdd) - 1) * 100
    : NaN;

  if (maxOddDrop > 0 && Number.isFinite(oddDrop) && oddDrop > maxOddDrop) {
    throw createBookyError(
      `Guard de cuota: caída excesiva (${oldOdd.toFixed(2)} -> ${finalOdd.toFixed(2)}).`,
      {
        statusCode: 409,
        code: 'BOOKY_VALUE_GUARD_REJECTED',
        diagnostic: {
          reason: 'ODD_DROP',
          oldOdd,
          finalOdd,
          oddDrop,
          maxAllowedOddDrop: maxOddDrop,
          minEvPercent,
          computedEvPercent: Number.isFinite(evPercent) ? Number(evPercent.toFixed(2)) : null,
          requestId: draft?.payload?.requestId || null,
          observedAt: nowIso()
        }
      }
    );
  }

  if (minEvPercent > 0 && Number.isFinite(evPercent) && evPercent < minEvPercent) {
    throw createBookyError(
      `Guard de valor: EV insuficiente (${evPercent.toFixed(2)}% < ${minEvPercent.toFixed(2)}%).`,
      {
        statusCode: 409,
        code: 'BOOKY_VALUE_GUARD_REJECTED',
        diagnostic: {
          reason: 'LOW_EV',
          oldOdd,
          finalOdd,
          oddDrop: Number.isFinite(oddDrop) ? oddDrop : null,
          maxAllowedOddDrop: maxOddDrop,
          minEvPercent,
          computedEvPercent: Number(evPercent.toFixed(2)),
          requestId: draft?.payload?.requestId || null,
          observedAt: nowIso()
        }
      }
    );
  }
};

const isTransientProviderError = (error) => {
  const status = Number(error?.response?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  if (status >= 500) return true;
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ERR_NETWORK'
  ) return true;
  return false;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getProviderErrorTypeMeta = (rawErrorType) => {
  const errorType = Number(rawErrorType);
  if (!Number.isFinite(errorType)) {
    return {
      code: null,
      reason: null,
      isRequote: false,
      message: 'Provider devolvió error sin errorType numérico.'
    };
  }

  if (errorType === 4) {
    return {
      code: 4,
      reason: 'selection_changed_or_unavailable',
      isRequote: true,
      message: 'Provider indicó re-quote/selección no vigente (errorType=4).'
    };
  }

  return {
    code: errorType,
    reason: 'provider_rejected',
    isRequote: false,
    message: `Provider rechazó la selección (errorType=${errorType}).`
  };
};

const postPlaceWidgetWithRetry = async ({ draft, auth, ticketId, fastMode = false }) => {
  const attempts = fastMode ? 2 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await altenarClient.post(draft.endpoint, draft.payload, {
        timeout: 20000,
        headers: {
          Authorization: auth,
          Referer: altenarClient.defaults.headers?.Referer || altenarClient.defaults.headers?.common?.Referer,
          Origin: altenarClient.defaults.headers?.Origin || altenarClient.defaults.headers?.common?.Origin
        }
      });
      const body = response?.data || {};
      const hasAcceptedBets = Array.isArray(body?.bets) && body.bets.length > 0;

      if (!hasAcceptedBets) {
        const statusCode = Number(response?.status) || 409;
        const providerError = body?.error || null;
        const headers = pickResponseHeaders(response?.headers || {});
        const errorTypeMeta = getProviderErrorTypeMeta(providerError?.errorType);
        const providerCode = errorTypeMeta.code;
        const providerMessage = providerError
          ? errorTypeMeta.message
          : 'Response without accepted bets.';
        const rejectCode = errorTypeMeta.isRequote
          ? 'BOOKY_PLACEWIDGET_REQUOTE_REQUIRED'
          : 'BOOKY_PLACEWIDGET_REJECTED';

        throw createBookyError(
          providerError
            ? `placeWidget rechazó la apuesta (provider error)${fastMode ? ' [fast]' : ''}.`
            : `placeWidget respondió sin confirmar apuesta (sin bets)${fastMode ? ' [fast]' : ''}.`,
          {
            statusCode,
            code: rejectCode,
            diagnostic: {
              ticketId,
              requestId: draft?.payload?.requestId || null,
              endpoint: draft?.endpoint || null,
              fastMode,
              providerStatus: statusCode,
              providerCode,
              providerReason: errorTypeMeta.reason,
              providerMessage,
              providerHeaders: headers,
              providerBody: body,
              providerError,
              responseHasBets: hasAcceptedBets,
              observedAt: nowIso()
            }
          }
        );
      }

      return body;
    } catch (error) {
      lastError = error;
      const transient = isTransientProviderError(error);
      if (!transient || attempt >= attempts) break;
      await delay(350);
    }
  }

  const diagnostic = lastError?.diagnostic
    ? {
        ...lastError.diagnostic,
        provider: lastError?.diagnostic?.provider || 'altenar_placeWidget',
        ticketId: lastError?.diagnostic?.ticketId || ticketId,
        endpoint: lastError?.diagnostic?.endpoint || draft?.endpoint || PLACE_WIDGET_URL,
        requestId: lastError?.diagnostic?.requestId || draft?.payload?.requestId || null,
        observedAt: lastError?.diagnostic?.observedAt || nowIso()
      }
    : buildProviderDiagnostic({ error: lastError, draft, ticketId, authHeader: auth });
  const transientFailure = isTransientProviderError(lastError);
  diagnostic.transientFailure = transientFailure;
  diagnostic.acceptanceUnknown = transientFailure;
  const statusCode = Number(lastError?.response?.status) || 502;

  if (transientFailure) {
    throw createBookyError(
      `placeWidget sin confirmación definitiva (HTTP ${statusCode})${fastMode ? ' [fast]' : ''}.`,
      {
        statusCode: 202,
        code: 'BOOKY_PLACEWIDGET_UNCERTAIN',
        diagnostic
      }
    );
  }

  if (lastError?.code === 'BOOKY_PLACEWIDGET_REQUOTE_REQUIRED') {
    throw createBookyError(
      `placeWidget requiere re-quote (HTTP ${statusCode})${fastMode ? ' [fast]' : ''}.`,
      {
        statusCode,
        code: 'BOOKY_PLACEWIDGET_REQUOTE_REQUIRED',
        diagnostic
      }
    );
  }

  throw createBookyError(
    `placeWidget rechazó la apuesta (HTTP ${statusCode})${fastMode ? ' [fast]' : ''}.`,
    {
      statusCode,
      code: 'BOOKY_PLACEWIDGET_REJECTED',
      diagnostic
    }
  );
};

const getPlaceWidgetTemplateFromCapture = (captureJson) => {
  const captures = Array.isArray(captureJson?.captures) ? captureJson.captures : [];
  const placeReq = [...captures].reverse().find(c =>
    String(c?.url || '').toLowerCase().includes('/api/widget/placewidget') && c?.postDataJson
  );
  return placeReq?.postDataJson || null;
};

const resolveSelectionTypeHint = (opportunity = {}) => {
  const selection = normalizeText(opportunity.selection || opportunity.action || '');

  if (selection.includes('home') || selection.includes('local') || selection === '1') return 1;
  if (selection.includes('draw') || selection.includes('empate') || selection === 'x') return 2;
  if (selection.includes('away') || selection.includes('visita') || selection === '2') return 3;
  if (selection.includes('over') || selection.includes('mas') || selection.includes('más')) return 12;
  if (selection.includes('under') || selection.includes('menos')) return 13;
  return null;
};

const resolveTargetOddFromDetails = (opportunity = {}, details = {}) => {
  const markets = Array.isArray(details.markets) ? details.markets : [];
  const odds = Array.isArray(details.odds) ? details.odds : [];
  const oddsMap = new Map(odds.map(o => [o.id, o]));

  if (markets.length === 0 || odds.length === 0) return null;

  const marketName = normalizeText(opportunity.market || '');
  const selectionTypeHint = resolveSelectionTypeHint(opportunity);

  // 1) 1x2 (compatible con label legacy Match Winner)
  if (marketName.includes('winner') || marketName.includes('1x2') || marketName.includes('match result')) {
    const market = markets.find(m => m.typeId === 1 || normalizeText(m.name).includes('1x2'));
    if (!market || !selectionTypeHint) return null;

    const odd = flattenOddIds(market)
      .map(id => oddsMap.get(id))
      .find(o => o && Number(o.typeId) === Number(selectionTypeHint));

    if (!odd) return null;
    return { market, odd };
  }

  // 2) Totales
  if (marketName.includes('total')) {
    const lineFromMarketName = extractLine(opportunity.market || '');
    const overUnderType = selectionTypeHint;
    if (!overUnderType) return null;

    const totalMarkets = markets.filter(m => Number(m.typeId) === 18);
    for (const market of totalMarkets) {
      const marketOdds = flattenOddIds(market).map(id => oddsMap.get(id)).filter(Boolean);
      const candidate = marketOdds.find(o => {
        if (Number(o.typeId) !== Number(overUnderType)) return false;

        const oddLine = Number.isFinite(Number(o.line)) ? Number(o.line) : extractLine(o.name || '');
        if (Number.isFinite(lineFromMarketName) && Number.isFinite(oddLine)) {
          return Math.abs(oddLine - lineFromMarketName) < 0.11;
        }
        return true;
      });

      if (candidate) return { market, odd: candidate };
    }
  }

  return null;
};

const buildPlaceWidgetPayload = ({ template, refreshedOpportunity, details, market, odd }) => {
  const defaults = altenarClient?.defaults?.params || {};
  const templateMarket = template?.betMarkets?.[0] || {};
  const templateOdd = templateMarket?.odds?.[0] || {};
  const stake = Math.max(1, safeNumber(refreshedOpportunity.kellyStake));

  return {
    culture: defaults.culture || template?.culture || 'es-ES',
    timezoneOffset: Number(defaults.timezoneOffset ?? template?.timezoneOffset ?? 300),
    integration: defaults.integration || template?.integration || 'acity',
    deviceType: Number(defaults.deviceType ?? template?.deviceType ?? 1),
    numFormat: defaults.numFormat || template?.numFormat || 'en-GB',
    countryCode: defaults.countryCode || template?.countryCode || 'PE',
    betType: Number(template?.betType ?? 0),
    isAutoCharge: Boolean(template?.isAutoCharge ?? false),
    stakes: [stake],
    oddsChangeAction: Number(template?.oddsChangeAction ?? 3),
    betMarkets: [
      {
        id: Number(details?.id || refreshedOpportunity.eventId),
        isBanker: false,
        dbId: Number(templateMarket?.dbId ?? 10),
        sportName: templateMarket?.sportName || 'Fútbol',
        rC: Boolean(details?.rC ?? templateMarket?.rC ?? false),
        eventName: details?.name || refreshedOpportunity.match || templateMarket?.eventName || '',
        catName: templateMarket?.catName || 'Mundo',
        champName: refreshedOpportunity.league || templateMarket?.champName || '',
        sportTypeId: Number(templateMarket?.sportTypeId ?? 1),
        odds: [
          {
            id: Number(odd.id),
            marketId: Number(odd.marketId || market.id),
            price: safeNumber(odd.price),
            marketName: normalizeApiMarketLabel(market.name || templateOdd?.marketName || refreshedOpportunity.market || '1x2'),
            marketTypeId: Number(market.typeId || templateOdd?.marketTypeId || 1),
            mostBalanced: Boolean(templateOdd?.mostBalanced ?? false),
            selectionTypeId: Number(odd.typeId),
            selectionName: odd.name || refreshedOpportunity.selection || templateOdd?.selectionName || '',
            widgetInfo: templateOdd?.widgetInfo || {
              widget: 43,
              page: 2,
              tabIndex: null,
              tipsterId: null,
              suggestionType: null
            }
          }
        ]
      }
    ],
    eachWays: [false],
    requestId: `bs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    confirmedByClient: false,
    device: Number(template?.device ?? 0)
  };
};

const prepareRealPlacementDraftInternal = async (ticketId, options = {}) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const { ticket } = getTicketById(ticketId);
  if (ticket.status !== 'DRAFT') throw new Error(`Ticket en estado no válido: ${ticket.status}`);

  const now = Date.now();
  const exp = new Date(ticket.expiresAt).getTime();
  if (!Number.isFinite(exp) || now > exp) throw new Error('Ticket expirado. Preparar nuevamente.');

  const refreshed = await refreshOpportunity(ticket.opportunity);
  if (!refreshed) throw new Error('No se pudo refrescar oportunidad para real placement.');

  if (!options.skipTicketDrift) {
    const oldOdd = safeNumber(ticket.opportunity.price ?? ticket.opportunity.odd);
    const newOdd = safeNumber(refreshed.price ?? refreshed.odd);
    const drift = Math.abs(newOdd - oldOdd);
    const maxDrift = getMaxDrift(ticket.opportunity);
    if (drift > maxDrift) {
      throw new Error(`Cuota cambió demasiado para real placement (${oldOdd} -> ${newOdd}).`);
    }
  }

  const capture = await getLatestBookyCaptureRaw();
  if (!capture) {
    const profile = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
    const hint = getCaptureCommandForProfile(profile);
    throw new Error(`No hay captura latest disponible para perfil ${profile}. Ejecuta: ${hint}`);
  }

  const template = getPlaceWidgetTemplateFromCapture(capture);
  if (!template) throw new Error('No se encontró template placeWidget en la captura latest.');

  let details = null;
  try {
    const detailsResp = await altenarClient.get(
      '/GetEventDetails',
      getAltenarPublicRequestConfig({ eventId: refreshed.eventId, _: Date.now() })
    );
    details = detailsResp?.data;
  } catch (error) {
    const renewal = maybeAutoRenewWidgetToken(error, `bookyRealPlacement.GetEventDetails:${refreshed.eventId}`);
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403) {
      throw createBookyError(
        'No se pudo preparar apuesta real: GetEventDetails rechazó autenticación del widget (401/403). Renueva token widget y reintenta.',
        {
          statusCode: 428,
          code: 'BOOKY_WIDGET_TOKEN_RENEWAL_REQUIRED',
          diagnostic: {
            source: 'GetEventDetails',
            eventId: refreshed.eventId,
            providerStatus: status,
            autoRenewTriggered: Boolean(renewal?.triggered),
            autoRenewBusy: Boolean(renewal?.busy),
            retryAfterSeconds: renewal?.retryAfterSeconds || null,
            observedAt: nowIso()
          }
        }
      );
    }
    throw error;
  }

  if (!details) throw new Error('No se pudo obtener GetEventDetails para armar payload real.');

  const target = resolveTargetOddFromDetails(refreshed, details);
  if (!target) {
    throw new Error('No se pudo mapear odd/market actual para esta oportunidad.');
  }

  const payload = buildPlaceWidgetPayload({
    template,
    refreshedOpportunity: refreshed,
    details,
    market: target.market,
    odd: target.odd
  });

  return {
    ticket,
    refreshed,
    endpoint: PLACE_WIDGET_URL,
    payload,
    authConfigured: Boolean(getActiveAuthHeader())
  };
};

const buildPayload = (opportunity, phase = 'draft') => ({
  phase,
  integration: altenarClient?.defaults?.params?.integration || 'unknown',
  eventId: opportunity.eventId,
  pinnacleId: opportunity.pinnacleId,
  match: opportunity.match,
  market: normalizeApiMarketLabel(opportunity.market),
  selection: opportunity.selection,
  pick: normalizePick(opportunity),
  odd: safeNumber(opportunity.price ?? opportunity.odd),
  stake: safeNumber(opportunity.kellyStake),
  type: opportunity.type || opportunity.strategy || 'UNKNOWN',
  score: opportunity.score || null,
  time: opportunity.time || opportunity.liveTime || null,
  builtAt: nowIso()
});

export const prepareSemiAutoTicket = async (opportunity) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  if (!opportunity || !opportunity.eventId) {
    throw new Error('Oportunidad inválida para preparar ticket.');
  }

  const refreshed = await refreshOpportunity(opportunity);
  if (!refreshed) throw new Error('No se pudo refrescar la oportunidad.');

  if (safeNumber(refreshed.ev) <= 0) {
    throw new Error(`El valor desapareció tras refresh (EV=${safeNumber(refreshed.ev).toFixed(2)}%).`);
  }

  const ticketKey = buildTicketKey(refreshed);
  const expiresAt = new Date(Date.now() + getExpiryMs(refreshed)).toISOString();

  const inFlightPrepare = prepareTicketInFlight.get(ticketKey);
  if (inFlightPrepare) {
    return inFlightPrepare;
  }

  const preparePromise = (async () => {
    const existingIdx = db.data.booky.pendingTickets.findIndex(t => t.ticketKey === ticketKey && t.status === 'DRAFT');

    const ticket = {
      id: `bk_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      ticketKey,
      status: 'DRAFT',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt,
      opportunity: cloneForStorage(refreshed),
      payload: buildPayload(refreshed, 'draft')
    };

    if (existingIdx >= 0) {
      const old = db.data.booky.pendingTickets[existingIdx];
      ticket.id = old.id;
      ticket.createdAt = old.createdAt;
      db.data.booky.pendingTickets[existingIdx] = ticket;
    } else {
      db.data.booky.pendingTickets.push(ticket);
    }

    await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
    return ticket;
  })().finally(() => {
    prepareTicketInFlight.delete(ticketKey);
  });

  prepareTicketInFlight.set(ticketKey, preparePromise);
  return preparePromise;
};

export const confirmSemiAutoTicket = async (ticketId) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const idx = db.data.booky.pendingTickets.findIndex(t => String(t.id) === String(ticketId));
  if (idx < 0) throw new Error('Ticket no encontrado.');

  const ticket = db.data.booky.pendingTickets[idx];
  if (ticket.status !== 'DRAFT') {
    throw new Error(`Ticket en estado no confirmable: ${ticket.status}`);
  }

  const now = Date.now();
  const exp = new Date(ticket.expiresAt).getTime();
  if (!Number.isFinite(exp) || now > exp) {
    ticket.status = 'EXPIRED';
    ticket.updatedAt = nowIso();
    db.data.booky.history.push(ticket);
    db.data.booky.pendingTickets.splice(idx, 1);
    await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
    throw new Error('Ticket expirado. Preparar nuevamente.');
  }

  const baseOpportunity = ticket.opportunity;
  const refreshed = await refreshOpportunity(baseOpportunity);

  const oldOdd = safeNumber(baseOpportunity.price ?? baseOpportunity.odd);
  const newOdd = safeNumber(refreshed.price ?? refreshed.odd);
  const drift = Math.abs(newOdd - oldOdd);
  const maxDrift = getMaxDrift(baseOpportunity);

  if (drift > maxDrift) {
    ticket.status = 'REQUOTE_REQUIRED';
    ticket.updatedAt = nowIso();
    ticket.requote = {
      oldOdd,
      newOdd,
      drift,
      maxAllowedDrift: maxDrift,
      detectedAt: nowIso()
    };
    db.data.booky.history.push(ticket);
    db.data.booky.pendingTickets.splice(idx, 1);
    await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
    throw new Error(`Cuota cambió demasiado (${oldOdd} -> ${newOdd}). Re-quote requerido.`);
  }

  // Confirmación manual + espejo en portfolio (fase 1)
  const placedBet = await placeAutoBet(withBookyMirrorMetadata(refreshed));
  if (!placedBet) {
    throw new Error('No se pudo registrar la apuesta (duplicada o sin liquidez).');
  }

  ticket.status = 'CONFIRMED';
  ticket.updatedAt = nowIso();
  ticket.confirmedAt = nowIso();
  ticket.opportunity = cloneForStorage(refreshed);
  ticket.payload = buildPayload(refreshed, 'confirmed');
  ticket.portfolioBetId = placedBet.id;

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

  return { ticket, bet: placedBet };
};

export const cancelSemiAutoTicket = async (ticketId) => {
  await initDB();
  await db.read();
  ensureBookyStore();

  const idx = db.data.booky.pendingTickets.findIndex(t => String(t.id) === String(ticketId));
  if (idx < 0) throw new Error('Ticket no encontrado.');

  const ticket = db.data.booky.pendingTickets[idx];
  ticket.status = 'CANCELLED';
  ticket.updatedAt = nowIso();

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

  return ticket;
};

export const getSemiAutoTickets = async () => {
  await initDB();
  await db.read();
  ensureBookyStore();

  return {
    pending: db.data.booky.pendingTickets,
    history: db.data.booky.history.slice(-50).reverse()
  };
};

export const getLatestBookyCapture = async () => {
  const profile = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
  const latestPath = path.join(projectRoot, 'data', 'booky', `capture-${profile}.latest.json`);

  if (!fs.existsSync(latestPath)) {
    return {
      found: false,
      profile,
      path: latestPath,
      message: 'No existe captura latest para el perfil activo.'
    };
  }

  const raw = fs.readFileSync(latestPath, 'utf8');
  const json = JSON.parse(raw);
  const captures = Array.isArray(json.captures) ? json.captures : [];

  return {
    found: true,
    profile,
    path: latestPath,
    generatedAt: json.generatedAt,
    totalCaptured: captures.length,
    sample: captures.slice(-5)
  };
};

const getLatestBookyCaptureRaw = async () => {
  const profile = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
  const latestPath = path.join(projectRoot, 'data', 'booky', `capture-${profile}.latest.json`);
  if (!fs.existsSync(latestPath)) return null;
  return JSON.parse(fs.readFileSync(latestPath, 'utf8'));
};

const getCaptureCommandForProfile = (profile = '') => {
  const normalized = String(profile || '').toLowerCase();
  if (normalized === 'acity') return 'npm run capture:booky:acity';
  if (normalized === 'doradobet' || normalized === 'dorado') return 'npm run capture:booky:dorado';
  return 'npm run capture:booky';
};

const archiveUncertainRealPlacement = async ({ idx, ticket, draft, fastMode = false, error }) => {
  ticket.status = fastMode ? 'REAL_CONFIRMATION_UNKNOWN_FAST' : 'REAL_CONFIRMATION_UNKNOWN';
  ticket.updatedAt = nowIso();
  ticket.realPlacement = {
    placedAt: nowIso(),
    endpoint: draft?.endpoint || PLACE_WIDGET_URL,
    requestId: draft?.payload?.requestId || null,
    fastMode,
    uncertain: true,
    diagnostic: error?.diagnostic || null
  };

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
};

const archiveRejectedRealPlacement = async ({ idx, ticket, draft, fastMode = false, error }) => {
  ticket.status = fastMode ? 'REAL_REJECTED_FAST' : 'REAL_REJECTED';
  ticket.updatedAt = nowIso();
  ticket.realPlacement = {
    placedAt: nowIso(),
    endpoint: draft?.endpoint || PLACE_WIDGET_URL,
    requestId: draft?.payload?.requestId || null,
    fastMode,
    rejected: true,
    diagnostic: error?.diagnostic || {
      providerMessage: error?.message || null,
      providerCode: error?.code || null,
      observedAt: nowIso()
    }
  };

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
};

const archiveRequoteRealPlacement = async ({ idx, ticket, draft, fastMode = false, error }) => {
  ticket.status = fastMode ? 'REAL_REQUOTE_REQUIRED_FAST' : 'REAL_REQUOTE_REQUIRED';
  ticket.updatedAt = nowIso();
  ticket.realPlacement = {
    placedAt: nowIso(),
    endpoint: draft?.endpoint || PLACE_WIDGET_URL,
    requestId: draft?.payload?.requestId || null,
    fastMode,
    requote: true,
    diagnostic: error?.diagnostic || {
      providerMessage: error?.message || null,
      providerCode: error?.code || null,
      observedAt: nowIso()
    }
  };

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
};

const extractAcceptedPlacementMeta = (providerResponse = {}) => {
  const bet = Array.isArray(providerResponse?.bets) ? providerResponse.bets[0] : null;
  const selection = Array.isArray(bet?.selections) ? bet.selections[0] : null;

  const acceptedOdd = Number.isFinite(Number(selection?.price))
    ? Number(selection.price)
    : (Number.isFinite(Number(bet?.totalOdds)) ? Number(bet.totalOdds) : null);

  return {
    providerBetId: bet?.id ?? null,
    acceptedOdd,
    acceptedStake: Number.isFinite(Number(bet?.finalStake))
      ? Number(bet.finalStake)
      : (Number.isFinite(Number(bet?.totalStake)) ? Number(bet.totalStake) : null),
    potentialReturn: Number.isFinite(Number(bet?.totalWin)) ? Number(bet.totalWin) : null,
    currency: bet?.currency || null,
    selectionId: selection?.id ?? null,
    selectionName: selection?.name || null,
    selectionTypeId: selection?.selectionTypeId ?? null,
    marketId: selection?.marketId ?? null,
    marketName: selection?.marketName || null,
    eventId: selection?.eventId ?? null,
    eventName: selection?.eventName || null,
    eventDate: selection?.eventDate || null,
    rawSelection: selection || null
  };
};

const withBookyMirrorMetadata = (opportunity = {}) => {
  const integration = String(
    getRuntimeEnvValue('ALTENAR_INTEGRATION', altenarClient?.defaults?.params?.integration || '')
  ).trim().toLowerCase() || null;

  return {
    ...(opportunity || {}),
    provider: 'booky',
    placementProvider: 'booky',
    integration
  };
};

const reconcileMirroredBetWithAccepted = (mirroredBet, acceptedMeta = {}) => {
  if (!mirroredBet?.id) return mirroredBet;

  const integration = String(
    getRuntimeEnvValue('ALTENAR_INTEGRATION', altenarClient?.defaults?.params?.integration || '')
  ).trim().toLowerCase() || null;

  const acceptedOdd = Number.isFinite(Number(acceptedMeta?.acceptedOdd)) ? Number(acceptedMeta.acceptedOdd) : null;
  const acceptedStake = Number.isFinite(Number(acceptedMeta?.acceptedStake)) ? Number(acceptedMeta.acceptedStake) : null;
  const acceptedPotentialReturn = Number.isFinite(Number(acceptedMeta?.potentialReturn))
    ? Number(acceptedMeta.potentialReturn)
    : null;

  if (!acceptedOdd && !acceptedStake && !acceptedPotentialReturn) return mirroredBet;

  const applyPatch = (bet = {}) => ({
    ...bet,
    odd: acceptedOdd || bet.odd,
    price: acceptedOdd || bet.price,
    acceptedOdd: acceptedOdd || bet.acceptedOdd || null,
    stake: acceptedStake || bet.stake,
    kellyStake: acceptedStake || bet.kellyStake || bet.stake,
    providerBetId: acceptedMeta.providerBetId || bet.providerBetId || null,
    providerSelectionId: acceptedMeta.selectionId || bet.providerSelectionId || null,
    providerMarketId: acceptedMeta.marketId || bet.providerMarketId || null,
    providerSelectionName: acceptedMeta.selectionName || bet.providerSelectionName || null,
    providerEventName: acceptedMeta.eventName || bet.providerEventName || null,
    providerEventDate: acceptedMeta.eventDate || bet.providerEventDate || null,
    provider: 'booky',
    placementProvider: 'booky',
    integration: integration || bet.integration || null,
    providerAcceptedAt: nowIso(),
    providerPotentialReturn: Number.isFinite(Number(acceptedMeta.potentialReturn))
      ? Number(acceptedMeta.potentialReturn)
      : (bet.providerPotentialReturn || null),
    potentialReturn: acceptedPotentialReturn || bet.potentialReturn || null
  });

  const activeBets = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : [];
  const activeIdx = activeBets.findIndex(b => String(b.id) === String(mirroredBet.id));
  if (activeIdx >= 0) {
    const patched = applyPatch(activeBets[activeIdx]);
    db.data.portfolio.activeBets[activeIdx] = patched;
    return patched;
  }

  const historyBets = Array.isArray(db.data?.portfolio?.history) ? db.data.portfolio.history : [];
  const historyIdx = historyBets.findIndex(b => String(b.id) === String(mirroredBet.id));
  if (historyIdx >= 0) {
    const patched = applyPatch(historyBets[historyIdx]);
    db.data.portfolio.history[historyIdx] = patched;
    return patched;
  }

  return applyPatch(mirroredBet);
};

export const getRealPlacementDryRun = async (ticketId) => {
  const draft = await prepareRealPlacementDraftInternal(ticketId);
  return {
    ticketId,
    endpoint: draft.endpoint,
    authConfigured: draft.authConfigured,
    payload: draft.payload,
    preview: {
      eventId: draft.payload?.betMarkets?.[0]?.id,
      selectionOddId: draft.payload?.betMarkets?.[0]?.odds?.[0]?.id,
      selectionName: draft.payload?.betMarkets?.[0]?.odds?.[0]?.selectionName,
      price: draft.payload?.betMarkets?.[0]?.odds?.[0]?.price,
      stake: draft.payload?.stakes?.[0],
      requestId: draft.payload?.requestId
    }
  };
};

export const confirmRealPlacement = async (ticketId) => {
  return withTicketMutationLock(ticketId, async () => {
  const enabled = getRuntimeEnvValue('BOOKY_REAL_PLACEMENT_ENABLED', '').toLowerCase() === 'true';
  if (!enabled) {
    throw new Error('BOOKY_REAL_PLACEMENT_ENABLED=false. Actívalo en .env para enviar apuesta real.');
  }

  await initDB();
  await db.read();
  ensureBookyStore();
  ensureTokenFreshOrThrow();

  let lookup;
  try {
    lookup = getTicketById(ticketId);
  } catch (_) {
    const recovered = findBookyHistoryTicketById(ticketId);
    if (recovered && (
      recovered.status === 'REAL_CONFIRMED' ||
      recovered.status === 'REAL_CONFIRMED_FAST' ||
      recovered.status === 'REAL_REJECTED' ||
      recovered.status === 'REAL_REJECTED_FAST' ||
      recovered.status === 'REAL_CONFIRMATION_UNKNOWN' ||
      recovered.status === 'REAL_CONFIRMATION_UNKNOWN_FAST'
    )) {
      return {
        ticket: recovered,
        mirroredBet: null,
        mirrorResolvedFromExisting: true,
        providerResponse: recovered?.realPlacement?.response || null,
        idempotentReplay: true
      };
    }
    throw _;
  }

  const { idx, ticket } = lookup;
  if (ticket.status !== 'DRAFT') throw new Error(`Ticket en estado no válido: ${ticket.status}`);

  const draft = await prepareRealPlacementDraftInternal(ticketId);
  const auth = getActiveAuthHeader();
  if (!auth) throw new Error('Falta ALTENAR_BOOKY_AUTH_TOKEN en .env para placeWidget real.');
  enforceValueGuardsOrThrow({ ticket, draft });

  let data;
  try {
    data = await postPlaceWidgetWithRetry({ draft, auth, ticketId, fastMode: false });
  } catch (error) {
    const providerStatus = Number(error?.diagnostic?.providerStatus || error?.statusCode || 0);
    if (providerStatus === 401 || providerStatus === 403) {
      const renewal = requestBookyTokenRenewal();
      throw createBookyError(
        'Token de placeWidget rechazado por provider (401/403). Renueva token y reintenta; no se archivó como rechazo definitivo.',
        {
          statusCode: 428,
          code: 'BOOKY_TOKEN_RENEWAL_REQUIRED',
          diagnostic: {
            ...(error?.diagnostic || {}),
            providerStatus,
            ticketId,
            requestId: draft?.payload?.requestId || null,
            autoRenewRequested: Boolean(renewal?.started),
            renewalBusy: Boolean(renewal?.busy),
            renewalMessage: renewal?.message || null,
            renewalCommand: renewal?.renewalCommand || null
          }
        }
      );
    }

    if (error?.code === 'BOOKY_PLACEWIDGET_UNCERTAIN') {
      await archiveUncertainRealPlacement({ idx, ticket, draft, fastMode: false, error });
      throw createBookyError(
        'Estado incierto: la casa pudo aceptar la apuesta aunque no confirmó la respuesta. Verifica Open Bets antes de reintentar.',
        {
          statusCode: 202,
          code: 'BOOKY_REAL_CONFIRMATION_UNCERTAIN',
          diagnostic: {
            ...(error?.diagnostic || {}),
            ticketId,
            requestId: draft?.payload?.requestId || null,
            nextStep: 'VERIFY_OPEN_BETS'
          }
        }
      );
    }

    if (error?.code === 'BOOKY_PLACEWIDGET_REQUOTE_REQUIRED') {
      await archiveRequoteRealPlacement({ idx, ticket, draft, fastMode: false, error });
      throw createBookyError(
        'Re-quote requerido por provider (selección/cuota cambió). Reprepara y confirma de nuevo.',
        {
          statusCode: 409,
          code: 'BOOKY_REAL_REQUOTE_REQUIRED',
          diagnostic: {
            ...(error?.diagnostic || {}),
            ticketId,
            requestId: draft?.payload?.requestId || null,
            archivedStatus: 'REAL_REQUOTE_REQUIRED'
          }
        }
      );
    }

    if (error?.code === 'BOOKY_PLACEWIDGET_REJECTED') {
      await archiveRejectedRealPlacement({ idx, ticket, draft, fastMode: false, error });
      throw createBookyError(
        'Apuesta real rechazada por provider. Se archivó en historial para auditoría.',
        {
          statusCode: Number(error?.statusCode) || 409,
          code: 'BOOKY_REAL_PLACEMENT_REJECTED',
          diagnostic: {
            ...(error?.diagnostic || {}),
            ticketId,
            requestId: draft?.payload?.requestId || null,
            archivedStatus: 'REAL_REJECTED'
          }
        }
      );
    }

    throw error;
  }

  // Espejo en portfolio local solo si placeWidget responde sin throw.
  let mirroredBet = await placeAutoBet(withBookyMirrorMetadata(draft.refreshed));
  if (!mirroredBet) {
    mirroredBet = findPortfolioMirrorBet(draft.refreshed);
  }
  const acceptedMeta = extractAcceptedPlacementMeta(data);
  mirroredBet = reconcileMirroredBetWithAccepted(mirroredBet, acceptedMeta);

  ticket.status = 'REAL_CONFIRMED';
  ticket.updatedAt = nowIso();
  ticket.confirmedAt = nowIso();
  if (acceptedMeta?.acceptedOdd) {
    ticket.opportunity = {
      ...ticket.opportunity,
      acceptedOdd: acceptedMeta.acceptedOdd
    };
  }
  ticket.realPlacement = {
    placedAt: nowIso(),
    endpoint: draft.endpoint,
    requestId: draft.payload.requestId,
    requested: {
      stake: Number(draft?.payload?.stakes?.[0] ?? 0),
      odd: Number(draft?.payload?.betMarkets?.[0]?.odds?.[0]?.price ?? 0)
    },
    accepted: acceptedMeta,
    response: data
  };
  if (mirroredBet?.id) ticket.portfolioBetId = mirroredBet.id;

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

  return {
    ticket,
    mirroredBet,
    mirrorResolvedFromExisting: Boolean(mirroredBet),
    providerResponse: data
  };
  });
};

export const confirmRealPlacementFast = async (ticketId) => {
  return withTicketMutationLock(ticketId, async () => {
  const enabled = getRuntimeEnvValue('BOOKY_REAL_PLACEMENT_ENABLED', '').toLowerCase() === 'true';
  if (!enabled) {
    throw new Error('BOOKY_REAL_PLACEMENT_ENABLED=false. Actívalo en .env para enviar apuesta real.');
  }

  await initDB();
  await db.read();
  ensureBookyStore();
  ensureTokenFreshOrThrow();

  let lookup;
  try {
    lookup = getTicketById(ticketId);
  } catch (_) {
    const recovered = findBookyHistoryTicketById(ticketId);
    if (recovered && (
      recovered.status === 'REAL_CONFIRMED' ||
      recovered.status === 'REAL_CONFIRMED_FAST' ||
      recovered.status === 'REAL_REJECTED' ||
      recovered.status === 'REAL_REJECTED_FAST' ||
      recovered.status === 'REAL_CONFIRMATION_UNKNOWN' ||
      recovered.status === 'REAL_CONFIRMATION_UNKNOWN_FAST'
    )) {
      return {
        ticket: recovered,
        mirroredBet: null,
        mirrorResolvedFromExisting: true,
        providerResponse: recovered?.realPlacement?.response || null,
        idempotentReplay: true
      };
    }
    throw _;
  }

  const { idx, ticket } = lookup;
  if (ticket.status !== 'DRAFT') throw new Error(`Ticket en estado no válido: ${ticket.status}`);

  const draft = await prepareRealPlacementDraftInternal(ticketId, { skipTicketDrift: true });
  const auth = getActiveAuthHeader();
  if (!auth) throw new Error('Falta ALTENAR_BOOKY_AUTH_TOKEN en .env para placeWidget real.');
  enforceValueGuardsOrThrow({ ticket, draft });

  let data;
  try {
    data = await postPlaceWidgetWithRetry({ draft, auth, ticketId, fastMode: true });
  } catch (error) {
    const providerStatus = Number(error?.diagnostic?.providerStatus || error?.statusCode || 0);
    if (providerStatus === 401 || providerStatus === 403) {
      const renewal = requestBookyTokenRenewal();
      throw createBookyError(
        'Token de placeWidget rechazado por provider (401/403). Renueva token y reintenta; no se archivó como rechazo definitivo.',
        {
          statusCode: 428,
          code: 'BOOKY_TOKEN_RENEWAL_REQUIRED',
          diagnostic: {
            ...(error?.diagnostic || {}),
            providerStatus,
            ticketId,
            requestId: draft?.payload?.requestId || null,
            autoRenewRequested: Boolean(renewal?.started),
            renewalBusy: Boolean(renewal?.busy),
            renewalMessage: renewal?.message || null,
            renewalCommand: renewal?.renewalCommand || null
          }
        }
      );
    }

    if (error?.code === 'BOOKY_PLACEWIDGET_UNCERTAIN') {
      await archiveUncertainRealPlacement({ idx, ticket, draft, fastMode: true, error });
      throw createBookyError(
        'Estado incierto: la casa pudo aceptar la apuesta aunque no confirmó la respuesta. Verifica Open Bets antes de reintentar.',
        {
          statusCode: 202,
          code: 'BOOKY_REAL_CONFIRMATION_UNCERTAIN',
          diagnostic: {
            ...(error?.diagnostic || {}),
            ticketId,
            requestId: draft?.payload?.requestId || null,
            nextStep: 'VERIFY_OPEN_BETS'
          }
        }
      );
    }

    if (error?.code === 'BOOKY_PLACEWIDGET_REQUOTE_REQUIRED') {
      await archiveRequoteRealPlacement({ idx, ticket, draft, fastMode: true, error });
      throw createBookyError(
        'Re-quote requerido por provider (selección/cuota cambió). Reprepara y confirma de nuevo.',
        {
          statusCode: 409,
          code: 'BOOKY_REAL_REQUOTE_REQUIRED',
          diagnostic: {
            ...(error?.diagnostic || {}),
            ticketId,
            requestId: draft?.payload?.requestId || null,
            archivedStatus: 'REAL_REQUOTE_REQUIRED_FAST'
          }
        }
      );
    }

    if (error?.code === 'BOOKY_PLACEWIDGET_REJECTED') {
      await archiveRejectedRealPlacement({ idx, ticket, draft, fastMode: true, error });
      throw createBookyError(
        'Apuesta real rechazada por provider. Se archivó en historial para auditoría.',
        {
          statusCode: Number(error?.statusCode) || 409,
          code: 'BOOKY_REAL_PLACEMENT_REJECTED',
          diagnostic: {
            ...(error?.diagnostic || {}),
            ticketId,
            requestId: draft?.payload?.requestId || null,
            archivedStatus: 'REAL_REJECTED_FAST'
          }
        }
      );
    }

    throw error;
  }

  let mirroredBet = await placeAutoBet(withBookyMirrorMetadata(draft.refreshed));
  if (!mirroredBet) {
    mirroredBet = findPortfolioMirrorBet(draft.refreshed);
  }
  const acceptedMeta = extractAcceptedPlacementMeta(data);
  mirroredBet = reconcileMirroredBetWithAccepted(mirroredBet, acceptedMeta);

  ticket.status = 'REAL_CONFIRMED_FAST';
  ticket.updatedAt = nowIso();
  ticket.confirmedAt = nowIso();
  if (acceptedMeta?.acceptedOdd) {
    ticket.opportunity = {
      ...ticket.opportunity,
      acceptedOdd: acceptedMeta.acceptedOdd
    };
  }
  ticket.realPlacement = {
    placedAt: nowIso(),
    endpoint: draft.endpoint,
    requestId: draft.payload.requestId,
    fastMode: true,
    requested: {
      stake: Number(draft?.payload?.stakes?.[0] ?? 0),
      odd: Number(draft?.payload?.betMarkets?.[0]?.odds?.[0]?.price ?? 0)
    },
    accepted: acceptedMeta,
    response: data
  };
  if (mirroredBet?.id) ticket.portfolioBetId = mirroredBet.id;

  db.data.booky.history.push(ticket);
  db.data.booky.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

  return {
    ticket,
    mirroredBet,
    mirrorResolvedFromExisting: Boolean(mirroredBet),
    providerResponse: data
  };
  });
};
