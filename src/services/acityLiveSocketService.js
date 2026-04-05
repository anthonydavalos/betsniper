import WebSocket from 'ws';
import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';

const parseBooleanFromEnv = (rawValue, fallback = false) => {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parsePositiveIntOr = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN > 0 ? intN : fallback;
};

const parseCsvList = (raw, fallback = []) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return Array.isArray(fallback) ? [...fallback] : [];
  }

  const parsed = String(raw)
    .split(',')
    .map((part) => String(part || '').trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : (Array.isArray(fallback) ? [...fallback] : []);
};

const normalizeText = (value = '') => String(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '');

const pickFirstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
};

const safeParseUrl = (raw) => {
  try {
    return new URL(String(raw || '').trim());
  } catch {
    return null;
  }
};

const randomSuffix = (size = 4) => Math.random().toString(36).slice(2, 2 + Math.max(2, Number(size) || 4));

const ACTIVE_PROFILE = String(process.env.BOOK_PROFILE || process.env.ALTENAR_INTEGRATION || '')
  .trim()
  .toLowerCase();

const ACITY_SOCKET_ENABLED = parseBooleanFromEnv(process.env.ACITY_SOCKET_ENABLED, true);
const ACITY_SOCKET_URL = String(
  process.env.ACITY_SOCKET_URL ||
    'wss://api.casinoatlanticcity.com/api/notifications/?EIO=4&transport=websocket'
).trim();
const ACITY_SOCKET_COMPANY = String(process.env.ACITY_SOCKET_COMPANY || 'ACP').trim();
const ACITY_SOCKET_LOGIN_EVENT = String(process.env.ACITY_SOCKET_LOGIN_EVENT || 'server').trim();
const ACITY_SOCKET_LOGIN_TYPE = String(process.env.ACITY_SOCKET_LOGIN_TYPE || 'login').trim();
const ACITY_SOCKET_RECONNECT_BASE_MS = parsePositiveIntOr(process.env.ACITY_SOCKET_RECONNECT_BASE_MS, 3000);
const ACITY_SOCKET_RECONNECT_MAX_MS = parsePositiveIntOr(process.env.ACITY_SOCKET_RECONNECT_MAX_MS, 60000);
const ACITY_SOCKET_EVENT_MAX_BUFFER = parsePositiveIntOr(process.env.ACITY_SOCKET_EVENT_MAX_BUFFER, 200);
const ACITY_SOCKET_DIRTY_EVENT_TTL_MS = parsePositiveIntOr(process.env.ACITY_SOCKET_DIRTY_EVENT_TTL_MS, 90000);
const ACITY_SOCKET_REPORT_PATH = path.resolve('data', 'booky', 'acity-live-socket-analysis.latest.json');
const ACITY_HAYWIRE_SUBSCRIBE_ENABLED = parseBooleanFromEnv(process.env.ACITY_HAYWIRE_SUBSCRIBE_ENABLED, true);
const ACITY_HAYWIRE_TOPICS_EVENT = String(process.env.ACITY_HAYWIRE_TOPICS_EVENT || 'haywire/topics').trim();
const ACITY_HAYWIRE_SPORT_ID = parsePositiveIntOr(process.env.ACITY_HAYWIRE_SPORT_ID || process.env.ALTENAR_SPORT_ID, 66);
const ACITY_HAYWIRE_LIVE_MODE = String(process.env.ACITY_HAYWIRE_LIVE_MODE || 'live_delay')
  .trim()
  .toLowerCase()
  .replace('danger_zone', 'dz')
  .replace('live_delay', 'ld');
const ACITY_HAYWIRE_PAYLOAD_MODES = parseCsvList(
  process.env.ACITY_HAYWIRE_PAYLOAD_MODES,
  ['type', 'action', 'bare']
).map((mode) => String(mode || '').trim().toLowerCase());

const buildDefaultHaywireTopics = (sportId, liveMode = 'ld') => {
  const sid = parsePositiveIntOr(sportId, 66);
  const mode = String(liveMode || 'ld').trim().toLowerCase();
  return [
    `matchups/reg/sp/${sid}/pre`,
    `matchups/reg/sp/${sid}/live/${mode || 'ld'}`,
    `matchups/reg/sp/${sid}/live/both`,
    `matchups/reg/sp/${sid}/highlighted`
  ];
};

const ACITY_HAYWIRE_TOPICS = parseCsvList(
  process.env.ACITY_HAYWIRE_TOPICS,
  buildDefaultHaywireTopics(ACITY_HAYWIRE_SPORT_ID, ACITY_HAYWIRE_LIVE_MODE)
);
const ACITY_HAYWIRE_MQTT_ENABLED = parseBooleanFromEnv(process.env.ACITY_HAYWIRE_MQTT_ENABLED, true);
const ACITY_HAYWIRE_MQTT_CONNECT_TIMEOUT_MS = parsePositiveIntOr(process.env.ACITY_HAYWIRE_MQTT_CONNECT_TIMEOUT_MS, 12000);
const ACITY_HAYWIRE_MQTT_PASSWORD_MODE = String(process.env.ACITY_HAYWIRE_MQTT_PASSWORD_MODE || 'session-random')
  .trim()
  .toLowerCase();
const ACITY_HAYWIRE_MQTT_USERNAME = String(
  process.env.ACITY_HAYWIRE_MQTT_USERNAME || process.env.ALTENAR_LOGIN_USERNAME || ''
).trim();
const ACITY_HAYWIRE_MQTT_API_KEY_ENV = String(
  process.env.ACITY_HAYWIRE_MQTT_API_KEY || process.env.ACITY_HAYWIRE_API_KEY || ''
).trim();
const ACITY_HAYWIRE_MQTT_MAX_ATTEMPTS = parsePositiveIntOr(process.env.ACITY_HAYWIRE_MQTT_MAX_ATTEMPTS, 48);

const extractUrlsFromText = (value = '') => {
  const out = [];
  const text = String(value || '');
  if (!text) return out;

  const regex = /(https?:\/\/[^\s"'<>]+)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = String(match[1] || '').trim();
    if (raw) out.push(raw);
  }
  return out;
};

const getRuntimeHostsFromLatestReport = () => {
  try {
    if (!fs.existsSync(ACITY_SOCKET_REPORT_PATH)) return [];
    const raw = fs.readFileSync(ACITY_SOCKET_REPORT_PATH, 'utf8');
    const json = parseJsonSafe(raw);
    const hosts = new Set();

    const requests = Array.isArray(json?.requests) ? json.requests : [];
    for (const row of requests) {
      const parsed = safeParseUrl(row?.url || '');
      const host = String(parsed?.host || '').toLowerCase().trim();
      if (host) hosts.add(host);
    }

    const localStorageRows = Array.isArray(json?.browserState?.storageSnapshot?.localStorage)
      ? json.browserState.storageSnapshot.localStorage
      : [];
    const sessionStorageRows = Array.isArray(json?.browserState?.storageSnapshot?.sessionStorage)
      ? json.browserState.storageSnapshot.sessionStorage
      : [];

    for (const row of [...localStorageRows, ...sessionStorageRows]) {
      const keyUrls = extractUrlsFromText(row?.key || '');
      const valueUrls = extractUrlsFromText(row?.value || '');
      for (const rawUrl of [...keyUrls, ...valueUrls]) {
        const parsed = safeParseUrl(rawUrl);
        const host = String(parsed?.host || '').toLowerCase().trim();
        if (host) hosts.add(host);
      }
    }

    return Array.from(hosts).filter((host) =>
      host.includes('acity.com.pe') ||
      host.includes('casinoatlanticcity.com') ||
      host.includes('biahosted.com')
    );
  } catch {
    return [];
  }
};

const getWsapiSocketsEnabledFromLatestReport = () => {
  try {
    if (!fs.existsSync(ACITY_SOCKET_REPORT_PATH)) return null;
    const raw = fs.readFileSync(ACITY_SOCKET_REPORT_PATH, 'utf8');
    const json = parseJsonSafe(raw);
    const requests = Array.isArray(json?.requests) ? json.requests : [];

    for (const row of requests) {
      const body = String(row?.bodySnippet || '');
      if (!body || !body.includes('wsapiSocketsEnabled')) continue;

      const asJson = parseJsonSafe(body);
      if (asJson && Array.isArray(asJson.wsapiSocketsEnabled)) {
        return asJson.wsapiSocketsEnabled.map((value) => String(value || '').trim()).filter(Boolean);
      }

      const byRegex = body.match(/"wsapiSocketsEnabled"\s*:\s*(\[[^\]]*\])/i);
      if (byRegex?.[1]) {
        const arr = parseJsonSafe(byRegex[1]);
        if (Array.isArray(arr)) {
          return arr.map((value) => String(value || '').trim()).filter(Boolean);
        }
      }
    }

    return null;
  } catch {
    return null;
  }
};

const deriveHaywireMqttUrls = () => {
  const explicit = parseCsvList(process.env.ACITY_HAYWIRE_MQTT_URLS || process.env.ACITY_HAYWIRE_MQTT_URL, []);
  if (explicit.length > 0) return explicit;

  const socketUrl = safeParseUrl(ACITY_SOCKET_URL);
  const host = socketUrl?.host || '';
  const runtimeHosts = getRuntimeHostsFromLatestReport();

  const hosts = new Set([
    host,
    'api.casinoatlanticcity.com',
    'api-comunicaciones-web.acity.com.pe',
    'sb2frontend-altenar2.biahosted.com',
    'sb2integration-altenar2.biahosted.com',
    'push-api-common-altenar2.biahosted.com',
    ...runtimeHosts
  ].filter(Boolean));

  const urls = [];
  for (const h of hosts) {
    urls.push(
      `wss://${h}/mqtt`,
      `wss://${h}/api/mqtt`,
      `wss://${h}/haywire/mqtt`,
      `wss://${h}/ws/mqtt`,
      `wss://${h}/socket/mqtt`,
      `wss://${h}/api/socket/mqtt`,
      `wss://${h}/notifications/mqtt`
    );
  }

  return Array.from(new Set(urls));
};

const ACITY_HAYWIRE_MQTT_URLS = deriveHaywireMqttUrls();

const MARKET_FAMILIES = {
  MATCH_RESULT: 'match_result',
  TOTALS: 'totals',
  DOUBLE_CHANCE: 'double_chance',
  UNKNOWN: 'unknown'
};

const SIGNAL_SCOPES = {
  LIVE: 'live',
  PREMATCH: 'prematch',
  UNKNOWN: 'unknown'
};

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopping = false;
let started = false;
let startReason = 'idle';
let haywireSubscribed = false;
let haywireMqttClient = null;
let haywireMqttConnecting = false;
let haywireMqttConnected = false;
let haywireMqttReconnectTimer = null;
let haywireMqttUrlIndex = 0;
let lastAuthUser = '';

// eventId -> { seenAt, families:[], scopes:[], eventNames:[] }
const dirtySignalMap = new Map();
const recentDecodedEvents = [];

const stats = {
  startedAt: null,
  connectedAt: null,
  disconnectedAt: null,
  closeCode: null,
  closeReason: null,
  openPackets: 0,
  pingPackets: 0,
  pongPackets: 0,
  sioConnectRequests: 0,
  sioConnectPackets: 0,
  sioEventPackets: 0,
  authSent: 0,
  authOk: 0,
  haywireSubscribeAttempts: 0,
  haywireSubscribePackets: 0,
  haywireSubscribeAcks: 0,
  haywireSubscribeRejected: 0,
  haywireSubscribeErrors: 0,
  haywireMqttConnectAttempts: 0,
  haywireMqttConnectOk: 0,
  haywireMqttConnectFailed: 0,
  haywireMqttMessages: 0,
  haywireMqttDirtySignals: 0,
  haywireMqttSubscribedTopics: 0,
  dirtySignalsDetected: 0,
  dirtyEventIdsDetected: 0,
  dirtyFamilyCounts: {
    [MARKET_FAMILIES.MATCH_RESULT]: 0,
    [MARKET_FAMILIES.TOTALS]: 0,
    [MARKET_FAMILIES.DOUBLE_CHANCE]: 0,
    [MARKET_FAMILIES.UNKNOWN]: 0
  },
  rawMessages: 0,
  decodeErrors: 0,
  lastError: null
};

const nowIso = () => new Date().toISOString();

const pushRecentEvent = (row = {}) => {
  recentDecodedEvents.push({ at: nowIso(), ...row });
  if (recentDecodedEvents.length > ACITY_SOCKET_EVENT_MAX_BUFFER) {
    recentDecodedEvents.splice(0, recentDecodedEvents.length - ACITY_SOCKET_EVENT_MAX_BUFFER);
  }
};

const parseJsonSafe = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const extractSessionFromLoginPacket = (payload = '') => {
  const match = String(payload || '').match(/"session"\s*:\s*"([^"]+)"/i);
  return match ? String(match[1] || '').trim() : '';
};

const getSessionFromLatestReport = () => {
  try {
    if (!fs.existsSync(ACITY_SOCKET_REPORT_PATH)) return '';
    const raw = fs.readFileSync(ACITY_SOCKET_REPORT_PATH, 'utf8');
    const json = parseJsonSafe(raw);
    const frames = Array.isArray(json?.websocket?.framesSample) ? json.websocket.framesSample : [];

    for (const frame of frames) {
      const snippet = String(frame?.payloadSnippet || '');
      if (!snippet.includes('"type":"login"')) continue;
      const session = extractSessionFromLoginPacket(snippet);
      if (session) return session;
    }

    return '';
  } catch {
    return '';
  }
};

const getSessionForLogin = () => {
  const fromEnv = String(process.env.ACITY_SOCKET_SESSION || '').trim();
  if (fromEnv) return fromEnv;

  const fromReport = getSessionFromLatestReport();
  if (fromReport) return fromReport;

  return '';
};

const getHaywireApiKeyFromLatestReport = () => {
  if (ACITY_HAYWIRE_MQTT_API_KEY_ENV) return ACITY_HAYWIRE_MQTT_API_KEY_ENV;

  try {
    if (!fs.existsSync(ACITY_SOCKET_REPORT_PATH)) return '';
    const raw = fs.readFileSync(ACITY_SOCKET_REPORT_PATH, 'utf8');
    const json = parseJsonSafe(raw);
    const requests = Array.isArray(json?.requests) ? json.requests : [];

    for (const row of requests) {
      const h1 = row?.requestHeaders || {};
      const h2 = row?.requestHeadersExtra || {};
      const candidate = pickFirstNonEmpty(h1['x-api-key'], h1['X-API-Key'], h2['x-api-key'], h2['X-API-Key']);
      if (candidate) return String(candidate).trim();
    }

    return '';
  } catch {
    return '';
  }
};

const getAuthUserFromLatestReport = () => {
  try {
    if (!fs.existsSync(ACITY_SOCKET_REPORT_PATH)) return '';
    const raw = fs.readFileSync(ACITY_SOCKET_REPORT_PATH, 'utf8');
    const json = parseJsonSafe(raw);
    const requests = Array.isArray(json?.requests) ? json.requests : [];

    for (const row of requests) {
      const url = String(row?.url || '');
      const byNotifications = url.match(/\/api\/notificaciones\/(\d+)/i);
      if (byNotifications?.[1]) return String(byNotifications[1]).trim();

      const body = String(row?.bodySnippet || '');
      const byBody = body.match(/"user"\s*:\s*"?([a-zA-Z0-9_-]{3,})"?/i);
      if (byBody?.[1]) return String(byBody[1]).trim();
    }

    return '';
  } catch {
    return '';
  }
};

const resolveAuthUserFromPayload = (payloadObj) => {
  const user = payloadObj?.user;
  if (!user) {
    return getAuthUserFromLatestReport();
  }
  if (typeof user === 'string' || typeof user === 'number') {
    return String(user).trim();
  }
  if (typeof user === 'object') {
    return pickFirstNonEmpty(user.username, user.userName, user.login, user.name, user.id, user.customerId);
  }

  const fallback = getAuthUserFromLatestReport();
  if (fallback) return fallback;

  return '';
};

const buildHaywireMqttPasswordCandidates = (session, apiKey) => {
  const s = String(session || '').trim();
  const key = String(apiKey || '').trim();
  const mode = String(ACITY_HAYWIRE_MQTT_PASSWORD_MODE || 'auto').trim().toLowerCase();
  const out = [];

  if (mode === 'session') {
    if (s) out.push({ value: s, source: 'session' });
  } else if (mode === 'session-random') {
    if (s) out.push({ value: `${s}|${randomSuffix(4)}`, source: 'session-random' });
  } else if (mode === 'api-key') {
    if (key) out.push({ value: key, source: 'api-key' });
  } else if (mode === 'empty') {
    out.push({ value: '', source: 'empty' });
  } else {
    // Modo auto: intenta variantes observadas en runtime para maximizar probabilidad de handshake.
    if (s) out.push({ value: s, source: 'session' });
    if (s) out.push({ value: `${s}|${randomSuffix(4)}`, source: 'session-random' });
    if (key) out.push({ value: key, source: 'api-key' });
    if (s && key) out.push({ value: `${s}|${key.slice(0, 8)}`, source: 'session-apiKey' });
    out.push({ value: '', source: 'empty' });
  }

  const dedup = new Map();
  for (const row of out) {
    const keyId = `${row.value}__${row.source}`;
    if (!dedup.has(keyId)) dedup.set(keyId, row);
  }
  return Array.from(dedup.values());
};

const parseMqttPayload = (payload) => {
  try {
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || '');
    const parsed = parseJsonSafe(text);
    return parsed !== null ? parsed : text;
  } catch {
    return String(payload || '');
  }
};

const buildHaywireMqttWsHeaders = (session, apiKey) => {
  const headers = {
    Origin: String(process.env.ALTENAR_ORIGIN || 'https://www.casinoatlanticcity.com'),
    Referer: String(process.env.ALTENAR_REFERER || 'https://www.casinoatlanticcity.com/apuestas-deportivas'),
    'User-Agent': String(
      process.env.ALTENAR_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
    )
  };

  if (apiKey) headers['X-API-Key'] = apiKey;
  if (session) headers['X-Session'] = session;

  return headers;
};

const mergeUnique = (base = [], extra = []) => {
  const out = new Set(base || []);
  for (const val of extra || []) {
    if (!val) continue;
    out.add(String(val));
  }
  return Array.from(out);
};

const pruneDirtySignals = ({ maxAgeMs = ACITY_SOCKET_DIRTY_EVENT_TTL_MS } = {}) => {
  const now = Date.now();
  for (const [eventId, signal] of dirtySignalMap.entries()) {
    if ((now - Number(signal?.seenAt || 0)) > maxAgeMs) {
      dirtySignalMap.delete(eventId);
    }
  }
};

const addFamilyCounter = (families = []) => {
  for (const family of families) {
    const key = String(family || MARKET_FAMILIES.UNKNOWN);
    if (!Object.prototype.hasOwnProperty.call(stats.dirtyFamilyCounts, key)) {
      stats.dirtyFamilyCounts[key] = 0;
    }
    stats.dirtyFamilyCounts[key] += 1;
  }
};

const noteDirtySignal = ({ eventId, families = [], scopes = [], eventName = '' } = {}) => {
  const numeric = Number(eventId);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;

  const key = String(Math.floor(numeric));
  const normalizedFamilies = families.length > 0 ? families : [MARKET_FAMILIES.UNKNOWN];
  const normalizedScopes = scopes.length > 0 ? scopes : [SIGNAL_SCOPES.UNKNOWN];

  const prev = dirtySignalMap.get(key);
  const next = {
    seenAt: Date.now(),
    families: mergeUnique(prev?.families || [], normalizedFamilies),
    scopes: mergeUnique(prev?.scopes || [], normalizedScopes),
    eventNames: mergeUnique(prev?.eventNames || [], eventName ? [eventName] : []).slice(-12)
  };

  const isNew = !dirtySignalMap.has(key);
  dirtySignalMap.set(key, next);
  if (isNew) stats.dirtyEventIdsDetected += 1;
  addFamilyCounter(normalizedFamilies);
  return true;
};

const detectFamiliesFromText = (value = '') => {
  const out = new Set();
  const low = normalizeText(value);
  if (!low) return out;

  const compact = low.replace(/[^a-z0-9]+/g, '');
  const hasOverUnderToken = /\b(over|under)\b/.test(low) || /\bo\/u\b/.test(low) || /\bu\/o\b/.test(low);

  if (
    low.includes('double chance') ||
    low.includes('doble oportunidad') ||
    compact.includes('1x') ||
    compact.includes('x2') ||
    compact.includes('12')
  ) {
    out.add(MARKET_FAMILIES.DOUBLE_CHANCE);
  }

  if (
    low.includes('total') ||
    hasOverUnderToken ||
    low.includes('mas') ||
    low.includes('menos')
  ) {
    out.add(MARKET_FAMILIES.TOTALS);
  }

  if (
    low.includes('1x2') ||
    low.includes('resultado') ||
    low.includes('match winner') ||
    low.includes('match result') ||
    low.includes('moneyline') ||
    low.includes('home') ||
    low.includes('away') ||
    low.includes('draw') ||
    low.includes('local') ||
    low.includes('visita') ||
    low.includes('empate')
  ) {
    out.add(MARKET_FAMILIES.MATCH_RESULT);
  }

  return out;
};

const detectFamiliesFromTypeIds = (node = {}) => {
  const out = new Set();

  const toNumber = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n) : NaN;
  };

  const applyType = (typeId) => {
    if (!Number.isFinite(typeId)) return;

    if ([1, 2, 3].includes(typeId)) {
      out.add(MARKET_FAMILIES.MATCH_RESULT);
      return;
    }

    if ([9, 10, 11].includes(typeId)) {
      out.add(MARKET_FAMILIES.DOUBLE_CHANCE);
      return;
    }

    if ([12, 13, 18].includes(typeId)) {
      out.add(MARKET_FAMILIES.TOTALS);
    }
  };

  applyType(toNumber(node.typeId));
  applyType(toNumber(node.marketTypeId));
  applyType(toNumber(node.oddTypeId));
  applyType(toNumber(node.selectionTypeId));

  return out;
};

const detectScopeHints = (node = {}, eventName = '') => {
  const out = new Set();
  const eventLow = normalizeText(eventName);

  if (eventLow.includes('live') || eventLow.includes('inplay')) out.add(SIGNAL_SCOPES.LIVE);
  if (eventLow.includes('prematch') || eventLow.includes('upcoming') || eventLow.includes('pre')) out.add(SIGNAL_SCOPES.PREMATCH);

  if (String(node.liveTime || '').trim() !== '') out.add(SIGNAL_SCOPES.LIVE);

  if (typeof node.inPlay === 'boolean') out.add(node.inPlay ? SIGNAL_SCOPES.LIVE : SIGNAL_SCOPES.PREMATCH);
  if (typeof node.isLive === 'boolean') out.add(node.isLive ? SIGNAL_SCOPES.LIVE : SIGNAL_SCOPES.PREMATCH);

  if (out.size === 0) out.add(SIGNAL_SCOPES.UNKNOWN);
  return out;
};

const isLikelyOddsRelatedKey = (key = '') => {
  const low = String(key || '').toLowerCase();
  return (
    low.includes('odd') ||
    low.includes('price') ||
    low.includes('market') ||
    low.includes('line') ||
    low.includes('selection') ||
    low.includes('outcome') ||
    low.includes('event')
  );
};

const findEventIdCandidate = (obj = {}) => {
  const keys = ['eventId', 'eventID', 'event_id', 'matchId', 'matchID', 'fixtureId', 'gameId', 'id'];
  for (const key of keys) {
    if (!(key in obj)) continue;
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
};

const collectDirtySignalsFromPayload = (eventName, payload) => {
  const byEvent = new Map();
  const eventNameLow = normalizeText(eventName);

  const eventNameSuggestsOdds =
    eventNameLow.includes('odd') ||
    eventNameLow.includes('price') ||
    eventNameLow.includes('market') ||
    eventNameLow.includes('event') ||
    eventNameLow.includes('line') ||
    eventNameLow.includes('live') ||
    eventNameLow.includes('update') ||
    eventNameLow.includes('change');

  const baseFamilies = detectFamiliesFromText(eventName);

  const ensureEventRow = (eventId) => {
    const key = String(Math.floor(Number(eventId)));
    if (!byEvent.has(key)) {
      byEvent.set(key, {
        eventId: key,
        families: new Set(),
        scopes: new Set(),
        eventName: String(eventName || '').trim()
      });
    }
    return byEvent.get(key);
  };

  const walk = (node, depth = 0, context = { eventIds: [] }) => {
    if (depth > 7 || node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, context);
      return;
    }

    if (typeof node !== 'object') return;

    const contextEventIds = Array.isArray(context?.eventIds) ? context.eventIds : [];
    const nextEventIds = [...contextEventIds];

    const eventIdCandidate = findEventIdCandidate(node);
    if (Number.isFinite(eventIdCandidate) && eventIdCandidate > 0) {
      nextEventIds.push(String(Math.floor(eventIdCandidate)));
    }

    const payloadEventIds = Array.isArray(node.eventIds) ? node.eventIds : [];
    for (const rawId of payloadEventIds) {
      const n = Number(rawId);
      if (Number.isFinite(n) && n > 0) nextEventIds.push(String(Math.floor(n)));
    }

    const dedupEventIds = Array.from(new Set(nextEventIds.filter(Boolean)));
    const keys = Object.keys(node || {});
    const hasOddsLikeKeys = keys.some((k) => isLikelyOddsRelatedKey(k));

    const localFamilies = new Set([
      ...Array.from(baseFamilies),
      ...Array.from(detectFamiliesFromTypeIds(node)),
      ...Array.from(detectFamiliesFromText(node.market || node.marketName || '')),
      ...Array.from(detectFamiliesFromText(node.selection || node.selectionName || node.name || '')),
      ...Array.from(detectFamiliesFromText(node.type || node.kind || '')),
      ...Array.from(detectFamiliesFromText(node.action || ''))
    ]);

    const localScopes = detectScopeHints(node, eventName);
    const qualifies = hasOddsLikeKeys || eventNameSuggestsOdds || localFamilies.size > 0;

    if (qualifies && dedupEventIds.length > 0) {
      for (const eventId of dedupEventIds) {
        const row = ensureEventRow(eventId);
        for (const family of localFamilies) row.families.add(family || MARKET_FAMILIES.UNKNOWN);
        for (const scope of localScopes) row.scopes.add(scope || SIGNAL_SCOPES.UNKNOWN);
      }
    }

    for (const value of Object.values(node)) {
      walk(value, depth + 1, { eventIds: dedupEventIds });
    }
  };

  walk(payload, 0, { eventIds: [] });

  return Array.from(byEvent.values()).map((row) => ({
    eventId: row.eventId,
    families: Array.from(row.families.size > 0 ? row.families : [MARKET_FAMILIES.UNKNOWN]),
    scopes: Array.from(row.scopes.size > 0 ? row.scopes : [SIGNAL_SCOPES.UNKNOWN]),
    eventName: row.eventName
  }));
};

const parseSocketIoPacket = (packet = '') => {
  const raw = String(packet || '');
  if (!raw) return { type: 'unknown', raw };

  const type = raw[0];
  const body = raw.slice(1);

  if (type === '0') {
    return {
      type: 'connect',
      payload: body ? parseJsonSafe(body) : null,
      raw
    };
  }

  if (type === '1') {
    return { type: 'disconnect', raw };
  }

  if (type !== '2') {
    return { type: `packet-${type}`, raw };
  }

  let rest = body;
  let namespace = '/';

  if (rest.startsWith('/')) {
    const commaIdx = rest.indexOf(',');
    if (commaIdx > 0) {
      namespace = rest.slice(0, commaIdx);
      rest = rest.slice(commaIdx + 1);
    }
  }

  const jsonStartIdx = rest.indexOf('[');
  const jsonSlice = jsonStartIdx >= 0 ? rest.slice(jsonStartIdx) : '';
  const arr = parseJsonSafe(jsonSlice);

  if (!Array.isArray(arr) || arr.length === 0) {
    return {
      type: 'event',
      namespace,
      event: null,
      payload: null,
      raw
    };
  }

  return {
    type: 'event',
    namespace,
    event: String(arr[0] || ''),
    payload: arr.length > 1 ? arr[1] : null,
    raw
  };
};

const sendFrame = (frame) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(frame);
    return true;
  } catch (error) {
    stats.lastError = error?.message || String(error);
    return false;
  }
};

const sendSocketIoEvent = (eventName, payload) => {
  const packet = `42${JSON.stringify([eventName, payload])}`;
  return sendFrame(packet);
};

const buildHaywireSubscribePayloads = (topics = []) => {
  const uniqueTopics = Array.from(new Set((Array.isArray(topics) ? topics : [])
    .map((topic) => String(topic || '').trim())
    .filter(Boolean)));
  if (uniqueTopics.length === 0) return [];

  const payloads = [];
  const modes = new Set(ACITY_HAYWIRE_PAYLOAD_MODES);

  if (modes.has('type')) {
    payloads.push({ type: 'subscribe', topics: uniqueTopics, company: ACITY_SOCKET_COMPANY });
  }
  if (modes.has('action')) {
    payloads.push({ action: 'subscribe', topics: uniqueTopics, company: ACITY_SOCKET_COMPANY });
  }
  if (modes.has('op')) {
    payloads.push({ op: 'subscribe', topics: uniqueTopics, company: ACITY_SOCKET_COMPANY });
  }
  if (modes.has('bare')) {
    payloads.push({ topics: uniqueTopics, company: ACITY_SOCKET_COMPANY });
  }

  const dedup = new Map();
  for (const payload of payloads) {
    dedup.set(JSON.stringify(payload), payload);
  }

  return Array.from(dedup.values());
};

const sendHaywireTopicSubscriptions = (reason = 'auth-ok') => {
  if (!ACITY_HAYWIRE_SUBSCRIBE_ENABLED) return;
  if (haywireSubscribed) return;

  const payloads = buildHaywireSubscribePayloads(ACITY_HAYWIRE_TOPICS);
  if (payloads.length === 0) {
    pushRecentEvent({
      engine: 'message',
      socketIo: 'haywire-subscribe-skipped',
      reason: 'empty-topics'
    });
    return;
  }

  stats.haywireSubscribeAttempts += 1;

  let sent = 0;
  for (const payload of payloads) {
    const ok = sendSocketIoEvent(ACITY_HAYWIRE_TOPICS_EVENT, payload);
    if (ok) {
      sent += 1;
    } else {
      stats.haywireSubscribeErrors += 1;
    }
  }

  if (sent > 0) {
    haywireSubscribed = true;
    stats.haywireSubscribePackets += sent;
  }

  pushRecentEvent({
    engine: 'message',
    socketIo: 'haywire-subscribe-sent',
    reason,
    event: ACITY_HAYWIRE_TOPICS_EVENT,
    payloadCount: payloads.length,
    packetsSent: sent,
    topics: ACITY_HAYWIRE_TOPICS
  });
};

const clearHaywireMqttReconnectTimer = () => {
  if (haywireMqttReconnectTimer) {
    clearTimeout(haywireMqttReconnectTimer);
    haywireMqttReconnectTimer = null;
  }
};

const closeHaywireMqttClient = () => {
  if (!haywireMqttClient) return;

  try {
    haywireMqttClient.end(true);
  } catch (_) {
    // noop
  }
  haywireMqttClient = null;
  haywireMqttConnecting = false;
  haywireMqttConnected = false;
};

const scheduleHaywireMqttReconnect = (reason = 'mqtt-close') => {
  if (stopping) return;
  if (!ACITY_HAYWIRE_MQTT_ENABLED) return;
  if (haywireMqttReconnectTimer) return;

  haywireMqttReconnectTimer = setTimeout(() => {
    haywireMqttReconnectTimer = null;
    startHaywireMqttConnection(reason);
  }, Math.max(1500, ACITY_SOCKET_RECONNECT_BASE_MS));
};

const onHaywireMqttMessage = (topic, payload) => {
  const topicName = String(topic || '').trim();
  if (!topicName) return;

  stats.haywireMqttMessages += 1;

  const payloadObj = parseMqttPayload(payload);
  const dirtySignals = collectDirtySignalsFromPayload(topicName, payloadObj);
  if (dirtySignals.length > 0) {
    stats.haywireMqttDirtySignals += dirtySignals.length;
    stats.dirtySignalsDetected += 1;

    for (const signal of dirtySignals) {
      noteDirtySignal(signal);
    }
  }

  pushRecentEvent({
    engine: 'haywire-mqtt-message',
    topic: topicName,
    dirtySignals: dirtySignals.map((row) => ({
      eventId: row.eventId,
      families: row.families,
      scopes: row.scopes
    })),
    payloadPreview: payloadObj && typeof payloadObj === 'object'
      ? Object.keys(payloadObj).slice(0, 20)
      : String(payloadObj || '').slice(0, 120)
  });
};

function startHaywireMqttConnection(reason = 'auth-ok') {
  if (!ACITY_HAYWIRE_MQTT_ENABLED) return;
  if (haywireMqttConnected || haywireMqttConnecting) return;

  const session = getSessionForLogin();
  if (!session) {
    pushRecentEvent({
      engine: 'haywire-mqtt-skip',
      reason: 'missing-session',
      from: reason
    });
    return;
  }

  const apiKey = getHaywireApiKeyFromLatestReport();
  const reportAuthUser = getAuthUserFromLatestReport();
  const urls = ACITY_HAYWIRE_MQTT_URLS.filter(Boolean);
  const usernameCandidates = Array.from(new Set([
    ACITY_HAYWIRE_MQTT_USERNAME,
    lastAuthUser,
    reportAuthUser,
    ACITY_SOCKET_COMPANY
  ].map((value) => String(value || '').trim()).filter(Boolean)));
  const passwordCandidates = buildHaywireMqttPasswordCandidates(session, apiKey);

  const credentialCandidates = [];
  for (const username of usernameCandidates) {
    for (const passwordRow of passwordCandidates) {
      credentialCandidates.push({
        username,
        password: passwordRow.value,
        passwordSource: passwordRow.source
      });
    }
  }

  if (credentialCandidates.length === 0 || urls.length === 0) {
    pushRecentEvent({
      engine: 'haywire-mqtt-skip',
      reason: credentialCandidates.length === 0 ? 'missing-credentials' : 'missing-url',
      from: reason
    });
    return;
  }

  clearHaywireMqttReconnectTimer();
  haywireMqttConnecting = true;

  const connectionPlan = [];
  for (const url of urls) {
    for (const credential of credentialCandidates) {
      connectionPlan.push({
        url,
        username: credential.username,
        password: credential.password,
        passwordSource: credential.passwordSource
      });
    }
  }

  const maxTries = Math.min(ACITY_HAYWIRE_MQTT_MAX_ATTEMPTS, connectionPlan.length);
  const startIndex = connectionPlan.length > 0 ? (haywireMqttUrlIndex % connectionPlan.length) : 0;

  const tryConnect = (attemptOffset = 0) => {
    if (stopping) {
      haywireMqttConnecting = false;
      return;
    }

    if (attemptOffset >= maxTries) {
      haywireMqttConnecting = false;
      stats.haywireMqttConnectFailed += 1;
      pushRecentEvent({
        engine: 'haywire-mqtt-connect-failed',
        reason,
        tries: maxTries
      });
      return;
    }

    const planIndex = (startIndex + attemptOffset) % connectionPlan.length;
    const plan = connectionPlan[planIndex] || {};
    const url = String(plan.url || '').trim();
    const username = String(plan.username || '').trim();
    const password = String(plan.password || '');
    const passwordSource = String(plan.passwordSource || 'unknown');

    stats.haywireMqttConnectAttempts += 1;

    const client = mqtt.connect(url, {
      protocol: 'wss',
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: ACITY_HAYWIRE_MQTT_CONNECT_TIMEOUT_MS,
      protocolVersion: 4,
      clientId: `sub-${randomSuffix(12)}`,
      username,
      password,
      wsOptions: {
        headers: buildHaywireMqttWsHeaders(session, apiKey)
      }
    });

    let settled = false;

    const failAttempt = (failReason, error = null) => {
      if (settled) return;
      settled = true;

      try {
        client.end(true);
      } catch (_) {
        // noop
      }

      pushRecentEvent({
        engine: 'haywire-mqtt-attempt-failed',
        url,
        username,
        passwordSource,
        failReason,
        error: error?.message || null
      });

      tryConnect(attemptOffset + 1);
    };

    const connectTimeout = setTimeout(() => {
      failAttempt('timeout');
    }, ACITY_HAYWIRE_MQTT_CONNECT_TIMEOUT_MS + 1500);

    client.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimeout);

      haywireMqttClient = client;
      haywireMqttConnecting = false;
      haywireMqttConnected = true;
      haywireMqttUrlIndex = planIndex;
      stats.haywireMqttConnectOk += 1;

      client.subscribe(ACITY_HAYWIRE_TOPICS, { qos: 0 }, (error, granted = []) => {
        if (error) {
          stats.lastError = error?.message || String(error);
          pushRecentEvent({
            engine: 'haywire-mqtt-subscribe-error',
            url,
            error: stats.lastError
          });
          return;
        }

        const grantedTopics = Array.isArray(granted) ? granted.map((g) => g?.topic).filter(Boolean) : [];
        stats.haywireMqttSubscribedTopics = grantedTopics.length;

        pushRecentEvent({
          engine: 'haywire-mqtt-subscribed',
          url,
          grantedTopics
        });
      });

      client.on('message', onHaywireMqttMessage);

      client.on('error', (error) => {
        stats.lastError = error?.message || String(error);
        pushRecentEvent({
          engine: 'haywire-mqtt-error',
          url,
          error: stats.lastError
        });
      });

      client.on('close', () => {
        haywireMqttConnected = false;
        haywireMqttClient = null;
        pushRecentEvent({
          engine: 'haywire-mqtt-close',
          url
        });
        scheduleHaywireMqttReconnect('mqtt-close');
      });

      pushRecentEvent({
        engine: 'haywire-mqtt-connected',
        url,
        username,
        passwordSource,
        reason
      });
    });

    client.once('error', (error) => {
      clearTimeout(connectTimeout);
      failAttempt('error', error);
    });

    client.once('close', () => {
      clearTimeout(connectTimeout);
      failAttempt('close');
    });
  };

  tryConnect(0);
}

const scheduleReconnect = () => {
  if (stopping || reconnectTimer) return;

  reconnectAttempt += 1;
  const exp = Math.min(6, reconnectAttempt - 1);
  const delay = Math.min(ACITY_SOCKET_RECONNECT_MAX_MS, ACITY_SOCKET_RECONNECT_BASE_MS * (2 ** exp));

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
};

const onEngineMessage = (text) => {
  const payload = String(text || '');
  if (!payload) return;

  stats.rawMessages += 1;
  const packetType = payload[0];

  if (packetType === '0') {
    stats.openPackets += 1;
    const openPayload = parseJsonSafe(payload.slice(1));
    pushRecentEvent({ engine: 'open', payload: openPayload });

    // Engine.IO abre transporte, pero en Socket.IO v4 el cliente debe solicitar namespace con "40".
    const connectRequested = sendFrame('40');
    if (connectRequested) {
      stats.sioConnectRequests += 1;
      pushRecentEvent({ engine: 'message', socketIo: 'connect-request-sent' });
    }
    return;
  }

  if (packetType === '2') {
    stats.pingPackets += 1;
    sendFrame('3');
    return;
  }

  if (packetType === '3') {
    stats.pongPackets += 1;
    return;
  }

  if (packetType !== '4') {
    pushRecentEvent({ engine: `packet-${packetType}`, raw: payload.slice(0, 240) });
    return;
  }

  const sio = parseSocketIoPacket(payload.slice(1));

  if (sio.type === 'connect') {
    stats.sioConnectPackets += 1;
    pushRecentEvent({
      engine: 'message',
      socketIo: 'connect',
      payload: sio.payload || null
    });

    const loginSession = getSessionForLogin();
    if (loginSession) {
      const loginOk = sendSocketIoEvent(ACITY_SOCKET_LOGIN_EVENT, {
        type: ACITY_SOCKET_LOGIN_TYPE,
        company: ACITY_SOCKET_COMPANY,
        session: loginSession
      });
      if (loginOk) stats.authSent += 1;
    } else {
      pushRecentEvent({
        engine: 'message',
        socketIo: 'login-skipped',
        reason: 'missing-session-token'
      });
    }
    return;
  }

  if (sio.type === 'event') {
    stats.sioEventPackets += 1;

    const eventName = String(sio.event || 'unknown');
    const payloadObj = sio.payload;

    if (
      eventName === ACITY_SOCKET_LOGIN_EVENT &&
      payloadObj &&
      payloadObj.type === ACITY_SOCKET_LOGIN_TYPE &&
      payloadObj.result === 'OK'
    ) {
      const authUser = resolveAuthUserFromPayload(payloadObj);
      if (authUser) {
        lastAuthUser = authUser;
      }

      stats.authOk += 1;
      sendHaywireTopicSubscriptions('auth-ok');
      startHaywireMqttConnection('auth-ok');
    }

    if (eventName === ACITY_HAYWIRE_TOPICS_EVENT && payloadObj && typeof payloadObj === 'object') {
      const rawResult = String(payloadObj.result || payloadObj.status || '').trim().toLowerCase();
      const isAck = payloadObj.success === true || rawResult === 'ok' || rawResult === 'success' || rawResult === 'subscribed';
      const isRejected = payloadObj.success === false || rawResult === 'error' || rawResult === 'failed' || Boolean(payloadObj.error);

      if (isAck) stats.haywireSubscribeAcks += 1;
      if (isRejected) stats.haywireSubscribeRejected += 1;

      pushRecentEvent({
        engine: 'message',
        socketIo: 'haywire-subscribe-response',
        ack: isAck,
        rejected: isRejected,
        payloadPreview: Object.keys(payloadObj).slice(0, 20)
      });
    }

    const dirtySignals = collectDirtySignalsFromPayload(eventName, payloadObj);
    if (dirtySignals.length > 0) {
      stats.dirtySignalsDetected += 1;
      for (const signal of dirtySignals) {
        noteDirtySignal(signal);
      }
    }

    pushRecentEvent({
      engine: 'message',
      socketIo: 'event',
      event: eventName,
      namespace: sio.namespace || '/',
      dirtySignals: dirtySignals.map((row) => ({
        eventId: row.eventId,
        families: row.families,
        scopes: row.scopes
      })),
      payloadPreview:
        payloadObj && typeof payloadObj === 'object' ? Object.keys(payloadObj).slice(0, 20) : null
    });
    return;
  }

  pushRecentEvent({ engine: 'message', socketIo: sio.type || 'unknown', raw: payload.slice(0, 240) });
};

const connect = () => {
  if (stopping) return;

  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    socket = new WebSocket(ACITY_SOCKET_URL, {
      headers: {
        Origin: String(process.env.ALTENAR_ORIGIN || 'https://www.casinoatlanticcity.com'),
        Referer: String(process.env.ALTENAR_REFERER || 'https://www.casinoatlanticcity.com/apuestas-deportivas'),
        'User-Agent': String(
          process.env.ALTENAR_USER_AGENT ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
        )
      }
    });
  } catch (error) {
    stats.lastError = error?.message || String(error);
    stats.decodeErrors += 1;
    scheduleReconnect();
    return;
  }

  socket.on('open', () => {
    reconnectAttempt = 0;
    haywireSubscribed = false;
    stats.connectedAt = nowIso();
    stats.disconnectedAt = null;
    stats.closeCode = null;
    stats.closeReason = null;
    pushRecentEvent({ engine: 'transport-open', url: ACITY_SOCKET_URL });
  });

  socket.on('message', (raw) => {
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      onEngineMessage(text);
      pruneDirtySignals();
    } catch (error) {
      stats.decodeErrors += 1;
      stats.lastError = error?.message || String(error);
    }
  });

  socket.on('close', (code, reason) => {
    stats.disconnectedAt = nowIso();
    stats.closeCode = Number(code || 0);
    stats.closeReason = String(reason || '');
    pushRecentEvent({ engine: 'transport-close', code: Number(code || 0), reason: String(reason || '') });
    socket = null;
    scheduleReconnect();
  });

  socket.on('error', (error) => {
    stats.lastError = error?.message || String(error);
    pushRecentEvent({ engine: 'transport-error', error: stats.lastError });
  });
};

export const startAcityLiveSocketService = () => {
  if (started) {
    return { started: true, reason: startReason, alreadyStarted: true };
  }

  if (!ACITY_SOCKET_ENABLED) {
    startReason = 'disabled-by-env';
    started = true;
    return { started: false, reason: startReason };
  }

  if (ACTIVE_PROFILE !== 'acity') {
    startReason = `profile-${ACTIVE_PROFILE || 'unknown'}-not-acity`;
    started = true;
    return { started: false, reason: startReason };
  }

  started = true;
  startReason = 'enabled';
  stopping = false;
  stats.startedAt = nowIso();
  connect();

  return { started: true, reason: startReason };
};

export const stopAcityLiveSocketService = () => {
  stopping = true;

  clearHaywireMqttReconnectTimer();
  closeHaywireMqttClient();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    try {
      socket.close();
    } catch (_) {
      // noop
    }
    socket = null;
  }
};

export const consumeAcitySocketDirtySignals = ({ max = 100, maxAgeMs = ACITY_SOCKET_DIRTY_EVENT_TTL_MS } = {}) => {
  pruneDirtySignals({ maxAgeMs });

  const entries = Array.from(dirtySignalMap.entries())
    .sort((a, b) => Number(a?.[1]?.seenAt || 0) - Number(b?.[1]?.seenAt || 0));

  const limited = entries.slice(0, Math.max(1, Number(max) || 100));
  for (const [eventId] of limited) {
    dirtySignalMap.delete(eventId);
  }

  return limited.map(([eventId, signal]) => ({
    eventId: String(eventId),
    seenAt: Number(signal?.seenAt || 0),
    families: Array.isArray(signal?.families) && signal.families.length > 0
      ? signal.families
      : [MARKET_FAMILIES.UNKNOWN],
    scopes: Array.isArray(signal?.scopes) && signal.scopes.length > 0
      ? signal.scopes
      : [SIGNAL_SCOPES.UNKNOWN],
    eventNames: Array.isArray(signal?.eventNames) ? signal.eventNames : []
  }));
};

export const consumeAcitySocketDirtyEventIds = ({ max = 100, maxAgeMs = ACITY_SOCKET_DIRTY_EVENT_TTL_MS } = {}) => {
  const signals = consumeAcitySocketDirtySignals({ max, maxAgeMs });
  return signals.map((row) => row.eventId);
};

export const getAcityLiveSocketDiagnostics = () => {
  pruneDirtySignals();
  const wsapiSocketsEnabled = getWsapiSocketsEnabledFromLatestReport();
  const reportAuthUser = getAuthUserFromLatestReport();

  const dirtySignalsPreview = Array.from(dirtySignalMap.entries())
    .sort((a, b) => Number(b?.[1]?.seenAt || 0) - Number(a?.[1]?.seenAt || 0))
    .slice(0, 25)
    .map(([eventId, signal]) => ({
      eventId,
      seenAt: Number(signal?.seenAt || 0),
      families: Array.isArray(signal?.families) ? signal.families : [MARKET_FAMILIES.UNKNOWN],
      scopes: Array.isArray(signal?.scopes) ? signal.scopes : [SIGNAL_SCOPES.UNKNOWN],
      eventNames: Array.isArray(signal?.eventNames) ? signal.eventNames : []
    }));

  return {
    enabled: ACITY_SOCKET_ENABLED,
    haywireSubscribeEnabled: ACITY_HAYWIRE_SUBSCRIBE_ENABLED,
    haywireTopicsEvent: ACITY_HAYWIRE_TOPICS_EVENT,
    haywireTopics: ACITY_HAYWIRE_TOPICS,
    haywirePayloadModes: ACITY_HAYWIRE_PAYLOAD_MODES,
    haywireMqttEnabled: ACITY_HAYWIRE_MQTT_ENABLED,
    haywireMqttUrls: ACITY_HAYWIRE_MQTT_URLS,
    haywireMqttConnected,
    haywireMqttConnecting,
    haywireMqttAuthUser: lastAuthUser || reportAuthUser || null,
    wsapiSocketsEnabled,
    activeProfile: ACTIVE_PROFILE,
    startReason,
    started,
    url: ACITY_SOCKET_URL,
    hasSocketSession: Boolean(getSessionForLogin()),
    reconnectAttempt,
    dirtyQueueSize: dirtySignalMap.size,
    dirtySignalsPreview,
    recentDecodedEvents: [...recentDecodedEvents],
    stats: { ...stats }
  };
};
