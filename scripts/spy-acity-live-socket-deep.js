import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'data', 'booky');

const args = process.argv.slice(2);

const hasFlag = (name) => args.includes(name);
const getArg = (prefix) => {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? String(hit.slice(prefix.length)) : null;
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const nowIso = () => new Date().toISOString();
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const headless = hasFlag('--headless') ? true : !hasFlag('--headed') ? false : false;
const useSystemChrome = !hasFlag('--no-system-chrome');
const requireProfile = String(getArg('--require-profile=') || 'acity').trim().toLowerCase();
const activeProfile = String(process.env.BOOK_PROFILE || 'doradobet').trim().toLowerCase();

const targetUrl = String(
  getArg('--url=') ||
    process.env.ALTENAR_BOOKY_URL ||
    'https://www.casinoatlanticcity.com/apuestas-deportivas#/live'
).trim();

const profileArg = getArg('--profile=');
const profileDirRaw = profileArg || path.join('data', 'booky', `chrome-profile-${activeProfile}`);
const profileDir = path.isAbsolute(profileDirRaw) ? profileDirRaw : path.join(projectRoot, profileDirRaw);

const captureMs = clamp(Number(getArg('--capture-ms=') || 20 * 60 * 1000), 60_000, 60 * 60 * 1000);
const loginWaitMs = clamp(Number(getArg('--login-wait-ms=') || 4 * 60 * 1000), 0, 20 * 60 * 1000);
const tickMs = clamp(Number(getArg('--tick-ms=') || 30_000), 5000, 120_000);
const correlationWindowMs = clamp(Number(getArg('--corr-window-ms=') || 3000), 500, 15_000);

const maxFrames = clamp(Number(getArg('--max-frames=') || 60_000), 500, 200_000);
const maxRequests = clamp(Number(getArg('--max-requests=') || 30_000), 1000, 200_000);
const maxBodyChars = clamp(Number(getArg('--max-body-chars=') || 120_000), 5000, 2_000_000);
const maxWidgetBodies = clamp(Number(getArg('--max-widget-bodies=') || 4000), 100, 20_000);

const trackedHosts = [
  'casinoatlanticcity.com',
  'api.casinoatlanticcity.com',
  'sb2frontend-altenar2.biahosted.com',
  'biahosted.com'
];

const WIDGET_ENDPOINT_HINTS = [
  '/api/widget/getliveoverview',
  '/api/widget/geteventdetails',
  '/api/widget/geteventresults',
  '/api/widget/getmarkets',
  '/api/widget/getmarketsv2',
  '/api/widget/getmarket',
  '/api/widget/getoverview'
];

const MARKET_KEYWORDS = [
  'odd',
  'odds',
  'price',
  'market',
  'selection',
  'line',
  'eventid',
  'matchup',
  'bettype',
  'totals',
  'double_chance',
  'match_result'
];

const LOGIN_KEYWORDS = ['mis apuestas', 'depositar', 'retiro', 'saldo', 'bono'];

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const asUrl = (raw) => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const isTrackedUrl = (raw = '') => {
  const parsed = asUrl(raw);
  if (!parsed) return false;
  const host = String(parsed.hostname || '').toLowerCase();
  return trackedHosts.some((h) => host.includes(h));
};

const isWidgetCandidateUrl = (raw = '') => {
  const parsed = asUrl(raw);
  if (!parsed) return false;
  const low = String(`${parsed.pathname || ''}${parsed.search || ''}`).toLowerCase();
  return WIDGET_ENDPOINT_HINTS.some((hint) => low.includes(hint));
};

const redactSensitive = (input = '') => {
  let text = String(input || '');
  const loginUser = String(process.env.ALTENAR_LOGIN_USERNAME || '').trim();
  const loginPass = String(process.env.ALTENAR_LOGIN_PASSWORD || '').trim();

  if (loginUser) text = text.split(loginUser).join('[REDACTED_USERNAME]');
  if (loginPass) text = text.split(loginPass).join('[REDACTED_PASSWORD]');

  text = text.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, 'Bearer [REDACTED_TOKEN]');
  text = text.replace(/"session"\s*:\s*"[^"]{12,}"/gi, '"session":"[REDACTED_SESSION]"');
  text = text.replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED_TOKEN]"');
  return text;
};

const sanitizeBody = (raw = '') => {
  const text = redactSensitive(String(raw || ''));
  if (text.length <= maxBodyChars) return text;
  return `${text.slice(0, maxBodyChars)}...[truncated ${text.length - maxBodyChars} chars]`;
};

const sha1 = (raw = '') => crypto.createHash('sha1').update(String(raw)).digest('hex');

const safeJsonParse = (raw = '') => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const pushLimited = (arr, value, max) => {
  if (arr.length >= max) return;
  arr.push(value);
};

const normalizeNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const collectOddsTokensGeneric = (node, out, parentKey = '', depth = 0) => {
  if (depth > 8 || node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) collectOddsTokensGeneric(item, out, parentKey, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  const keys = Object.keys(node);
  const lowKeys = keys.map((k) => k.toLowerCase());
  const hasMarketShape = lowKeys.some((k) => MARKET_KEYWORDS.some((w) => k.includes(w)));

  if (hasMarketShape) {
    const id = node.id ?? node.oddId ?? node.marketId ?? node.eventId ?? node.matchupId ?? '';
    const eventId = node.eventId ?? node.event ?? node.matchupId ?? '';
    const marketId = node.marketId ?? node.market ?? node.betTypeId ?? '';
    const line = node.line ?? node.handicap ?? node.total ?? '';
    const price = node.price ?? node.odd ?? node.odds ?? node.value ?? node.decimal ?? '';

    const normalizedPrice = normalizeNumber(price);
    const normalizedLine = normalizeNumber(line);
    const priceToken = normalizedPrice == null ? String(price || '') : normalizedPrice.toFixed(4);
    const lineToken = normalizedLine == null ? String(line || '') : normalizedLine.toFixed(4);

    out.push(`${parentKey}|${eventId}|${marketId}|${id}|${lineToken}|${priceToken}`);
  }

  for (const key of keys) {
    collectOddsTokensGeneric(node[key], out, key.toLowerCase(), depth + 1);
  }
};

const buildOddsFingerprint = (parsed) => {
  const tokens = [];
  const root = parsed?.data || parsed;

  if (root && typeof root === 'object' && Array.isArray(root.odds)) {
    for (const odd of root.odds) {
      if (!odd || typeof odd !== 'object') continue;
      const id = odd.id ?? odd.oddId ?? '';
      const marketId = odd.marketId ?? odd.mId ?? '';
      const line = normalizeNumber(odd.line ?? odd.handicap ?? odd.total);
      const price = normalizeNumber(odd.price ?? odd.value ?? odd.odd ?? odd.odds);
      const lineToken = line == null ? '' : line.toFixed(4);
      const priceToken = price == null ? '' : price.toFixed(4);
      tokens.push(`odds|${id}|${marketId}|${lineToken}|${priceToken}`);
    }
  }

  if (tokens.length === 0) {
    collectOddsTokensGeneric(root, tokens, 'root', 0);
  }

  const compact = tokens
    .map((t) => String(t))
    .filter(Boolean)
    .sort();

  const joined = compact.join('\n');
  return {
    tokenCount: compact.length,
    hash: sha1(joined || 'empty')
  };
};

const classifyWsPayload = (payloadRaw = '') => {
  const payload = String(payloadRaw || '');
  const low = payload.toLowerCase();

  if (payload === '2') return { kind: 'ping', eventName: null, hasMarketSignals: false, keywordHits: [] };
  if (payload === '3') return { kind: 'pong', eventName: null, hasMarketSignals: false, keywordHits: [] };
  if (payload.startsWith('0{')) return { kind: 'engine-open', eventName: null, hasMarketSignals: false, keywordHits: [] };
  if (payload === '40' || payload.startsWith('40{')) return { kind: 'socket-connect', eventName: null, hasMarketSignals: false, keywordHits: [] };
  if (payload.startsWith('41')) return { kind: 'socket-disconnect', eventName: null, hasMarketSignals: false, keywordHits: [] };

  let eventName = null;
  let kind = 'text-other';

  if (payload.startsWith('42')) {
    kind = 'socket-event';
    const body = payload.slice(2);
    const parsed = safeJsonParse(body);
    if (Array.isArray(parsed) && parsed.length > 0) {
      eventName = String(parsed[0] || '');
    }
  }

  const keywordHits = MARKET_KEYWORDS.filter((kw) => low.includes(kw));
  const hasMarketSignals = keywordHits.length > 0;
  return { kind, eventName, hasMarketSignals, keywordHits };
};

const detectLoginState = async (page) => {
  try {
    return await page.evaluate((loginWords) => {
      const text = String(document.body?.innerText || '').toLowerCase();
      const matched = loginWords.filter((w) => text.includes(String(w || '').toLowerCase()));

      const storageDump = [];
      const pushStore = (name, store) => {
        try {
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i);
            const value = store.getItem(key);
            const row = `${name}:${key}:${String(value || '').slice(0, 120)}`;
            storageDump.push(row.toLowerCase());
          }
        } catch {
          // noop
        }
      };

      pushStore('local', window.localStorage);
      pushStore('session', window.sessionStorage);

      const hasSessionToken = storageDump.some((r) =>
        r.includes('session') || r.includes('token') || r.includes('jwt') || r.includes('auth')
      );

      return {
        loggedInLikely: matched.length >= 2 || hasSessionToken,
        matchedWords: matched,
        hasSessionToken,
        href: location.href,
        title: document.title
      };
    }, LOGIN_KEYWORDS);
  } catch {
    return {
      loggedInLikely: false,
      matchedWords: [],
      hasSessionToken: false,
      href: null,
      title: null
    };
  }
};

const run = async () => {
  if (requireProfile && activeProfile !== requireProfile) {
    console.error(`❌ Perfil inválido. Requerido=${requireProfile} Actual=${activeProfile}`);
    process.exit(1);
  }

  ensureDir(outputDir);
  ensureDir(profileDir);

  const startedAt = nowIso();

  console.log('🔬 Deep Spy ACity LIVE iniciado');
  console.log(`   URL=${targetUrl}`);
  console.log(`   BOOK_PROFILE=${activeProfile}`);
  console.log(`   MODO=${headless ? 'headless' : 'headed'}`);
  console.log(`   LOGIN_WAIT_MS=${loginWaitMs}`);
  console.log(`   CAPTURE_MS=${captureMs}`);

  const launchOptions = {
    headless,
    defaultViewport: null,
    userDataDir: profileDir,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--lang=es-ES'
    ]
  };

  if (useSystemChrome) launchOptions.channel = 'chrome';

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();

  await cdp.send('Network.enable', {
    maxResourceBufferSize: 4 * 1024 * 1024,
    maxTotalBufferSize: 64 * 1024 * 1024
  });

  const requestMap = new Map();
  const wsCreated = [];
  const wsHandshakes = [];
  const wsFrames = [];
  const wsErrors = [];
  const wsClosed = [];
  const pageErrors = [];
  const consoleLogs = [];
  const widgetResponses = [];
  const widgetSnapshots = [];

  const snapshotByEndpoint = new Map();

  const counters = {
    wsMarketFramesRecv: 0,
    wsMarketFramesSent: 0,
    wsPing: 0,
    wsPong: 0,
    wsSocketEvents: 0,
    wsAuthEvents: 0,
    widgetBodiesCaptured: 0,
    widgetChangesDetected: 0,
    widgetNoChange: 0
  };

  const ensureRequest = (requestId, seed = {}) => {
    if (!requestMap.has(requestId)) {
      if (requestMap.size >= maxRequests) return null;
      requestMap.set(requestId, {
        requestId,
        url: seed.url || null,
        method: seed.method || null,
        type: seed.type || null,
        startedAt: nowIso(),
        responseStatus: null,
        failed: null
      });
    }
    return requestMap.get(requestId);
  };

  page.on('console', (msg) => {
    pushLimited(
      consoleLogs,
      {
        at: nowIso(),
        type: msg.type(),
        text: sanitizeBody(msg.text())
      },
      1000
    );
  });

  page.on('pageerror', (err) => {
    pushLimited(pageErrors, { at: nowIso(), message: String(err?.message || err) }, 200);
  });

  cdp.on('Network.requestWillBeSent', (evt) => {
    try {
      const req = evt?.request || {};
      const url = String(req.url || '');
      if (!isTrackedUrl(url)) return;
      const rec = ensureRequest(evt.requestId, {
        url,
        method: req.method || null,
        type: evt.type || null
      });
      if (!rec) return;
      rec.url = url;
      rec.method = req.method || rec.method;
      rec.type = evt.type || rec.type;
    } catch {
      // noop
    }
  });

  cdp.on('Network.responseReceived', (evt) => {
    try {
      const res = evt?.response || {};
      const url = String(res.url || '');
      if (!isTrackedUrl(url)) return;
      const rec = ensureRequest(evt.requestId, { url, type: evt.type || null });
      if (!rec) return;
      rec.responseStatus = Number(res.status || 0);
    } catch {
      // noop
    }
  });

  cdp.on('Network.loadingFailed', (evt) => {
    try {
      const rec = ensureRequest(evt.requestId);
      if (!rec) return;
      rec.failed = {
        errorText: evt.errorText || null,
        blockedReason: evt.blockedReason || null,
        canceled: Boolean(evt.canceled)
      };
    } catch {
      // noop
    }
  });

  cdp.on('Network.loadingFinished', async (evt) => {
    try {
      const rec = requestMap.get(evt.requestId);
      if (!rec || !rec.url) return;
      if (!isWidgetCandidateUrl(rec.url)) return;
      if (counters.widgetBodiesCaptured >= maxWidgetBodies) return;

      const bodyObj = await cdp.send('Network.getResponseBody', { requestId: evt.requestId }).catch(() => null);
      if (!bodyObj) return;

      const raw = bodyObj.base64Encoded
        ? Buffer.from(bodyObj.body || '', 'base64').toString('utf8')
        : String(bodyObj.body || '');

      counters.widgetBodiesCaptured += 1;

      const parsed = safeJsonParse(raw);
      const endpoint = (() => {
        const parsedUrl = asUrl(rec.url);
        if (!parsedUrl) return rec.url;
        return `${parsedUrl.hostname}${parsedUrl.pathname}`;
      })();

      const fingerprint = buildOddsFingerprint(parsed);
      const prev = snapshotByEndpoint.get(endpoint);
      const changed = Boolean(prev && prev.hash !== fingerprint.hash);

      if (changed) counters.widgetChangesDetected += 1;
      else if (prev) counters.widgetNoChange += 1;

      snapshotByEndpoint.set(endpoint, {
        hash: fingerprint.hash,
        tokenCount: fingerprint.tokenCount,
        atMs: Date.now()
      });

      const snippet = sanitizeBody(raw);
      pushLimited(
        widgetResponses,
        {
          at: nowIso(),
          endpoint,
          url: rec.url,
          status: rec.responseStatus,
          bodyHash: sha1(raw),
          bodySize: raw.length,
          bodySnippet: snippet
        },
        maxWidgetBodies
      );

      pushLimited(
        widgetSnapshots,
        {
          at: nowIso(),
          atMs: Date.now(),
          endpoint,
          tokenCount: fingerprint.tokenCount,
          oddsHash: fingerprint.hash,
          changed
        },
        maxWidgetBodies
      );
    } catch {
      // noop
    }
  });

  cdp.on('Network.webSocketCreated', (evt) => {
    const url = String(evt?.url || '');
    if (!isTrackedUrl(url)) return;
    pushLimited(
      wsCreated,
      {
        at: nowIso(),
        requestId: evt?.requestId || null,
        url
      },
      500
    );
  });

  cdp.on('Network.webSocketWillSendHandshakeRequest', (evt) => {
    const req = evt?.request || {};
    const url = String(req?.url || '');
    if (!isTrackedUrl(url)) return;

    pushLimited(
      wsHandshakes,
      {
        at: nowIso(),
        type: 'request',
        requestId: evt?.requestId || null,
        url,
        headers: {
          Origin: req?.headers?.Origin || req?.headers?.origin || null,
          Host: req?.headers?.Host || req?.headers?.host || null,
          Upgrade: req?.headers?.Upgrade || req?.headers?.upgrade || null,
          Connection: req?.headers?.Connection || req?.headers?.connection || null
        }
      },
      1000
    );
  });

  cdp.on('Network.webSocketHandshakeResponseReceived', (evt) => {
    const res = evt?.response || {};
    pushLimited(
      wsHandshakes,
      {
        at: nowIso(),
        type: 'response',
        requestId: evt?.requestId || null,
        status: Number(res.status || 0),
        statusText: String(res.statusText || ''),
        headers: {
          Upgrade: res?.headers?.Upgrade || res?.headers?.upgrade || null,
          Connection: res?.headers?.Connection || res?.headers?.connection || null,
          Server: res?.headers?.Server || res?.headers?.server || null
        }
      },
      1000
    );
  });

  const pushWsFrame = (direction, evt) => {
    if (wsFrames.length >= maxFrames) return;

    const response = evt?.response || {};
    const payload = String(response.payloadData || '');
    const opcode = Number(response.opcode || 0);

    let payloadSnippet = '';
    let cls = { kind: 'binary', eventName: null, hasMarketSignals: false, keywordHits: [] };

    if (opcode === 1) {
      payloadSnippet = sanitizeBody(payload);
      cls = classifyWsPayload(payloadSnippet);
      if (cls.kind === 'ping') counters.wsPing += 1;
      else if (cls.kind === 'pong') counters.wsPong += 1;
      else if (cls.kind === 'socket-event') counters.wsSocketEvents += 1;

      if (payloadSnippet.includes('"type":"login"') || payloadSnippet.includes('"result":"OK"')) {
        counters.wsAuthEvents += 1;
      }

      if (cls.hasMarketSignals) {
        if (direction === 'received') counters.wsMarketFramesRecv += 1;
        if (direction === 'sent') counters.wsMarketFramesSent += 1;
      }
    } else {
      payloadSnippet = `[binary:${payload.length}]`;
    }

    wsFrames.push({
      at: nowIso(),
      atMs: Date.now(),
      direction,
      requestId: evt?.requestId || null,
      opcode,
      payloadLength: payload.length,
      payloadHash: sha1(payload),
      payloadSnippet,
      classifiedAs: cls.kind,
      eventName: cls.eventName,
      hasMarketSignals: cls.hasMarketSignals,
      keywordHits: cls.keywordHits
    });
  };

  cdp.on('Network.webSocketFrameReceived', (evt) => pushWsFrame('received', evt));
  cdp.on('Network.webSocketFrameSent', (evt) => pushWsFrame('sent', evt));

  cdp.on('Network.webSocketFrameError', (evt) => {
    pushLimited(
      wsErrors,
      {
        at: nowIso(),
        requestId: evt?.requestId || null,
        errorMessage: String(evt?.errorMessage || '')
      },
      500
    );
  });

  cdp.on('Network.webSocketClosed', (evt) => {
    pushLimited(
      wsClosed,
      {
        at: nowIso(),
        requestId: evt?.requestId || null,
        timestamp: evt?.timestamp || null
      },
      500
    );
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  } catch (error) {
    console.warn(`⚠️ Navegación inicial con warning: ${error.message}`);
  }

  console.log('🔐 Esperando login manual en ACity...');
  console.log('   Inicia sesión en la ventana Chrome abierta.');

  const loginPollingStartedMs = Date.now();
  let loginState = await detectLoginState(page);
  let loginDetectedAt = null;

  while (Date.now() - loginPollingStartedMs < loginWaitMs) {
    if (loginState.loggedInLikely) {
      loginDetectedAt = nowIso();
      break;
    }
    await wait(5000);
    loginState = await detectLoginState(page);
  }

  if (loginDetectedAt) {
    console.log(`✅ Login detectado en ${loginDetectedAt}`);
  } else {
    console.warn('⚠️ No se detectó login inequívoco dentro de la ventana de espera. Se captura de todos modos.');
  }

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  } catch (error) {
    console.warn(`⚠️ Reentrada a LIVE con warning: ${error.message}`);
  }

  const captureStartMs = Date.now();
  const captureEndsAt = captureStartMs + captureMs;

  while (Date.now() < captureEndsAt) {
    const remaining = captureEndsAt - Date.now();
    console.log(
      `⏱️ Deep capture en curso. Restante=${Math.max(0, Math.round(remaining / 1000))}s ` +
        `wsFrames=${wsFrames.length} widgetSnapshots=${widgetSnapshots.length}`
    );
    await wait(Math.min(tickMs, remaining));
  }

  try {
    await browser.close();
  } catch {
    // Si la ventana se cerró manualmente o Chrome se desconectó, persistimos igual.
  }

  const finishedAt = nowIso();
  const requestRows = Array.from(requestMap.values()).filter((r) => isTrackedUrl(r.url || ''));

  const wsFramesRecv = wsFrames.filter((f) => f.direction === 'received');
  const wsFramesRecvMarket = wsFramesRecv.filter((f) => f.hasMarketSignals);
  const widgetChanges = widgetSnapshots.filter((s) => s.changed);

  const correlatedChanges = [];
  for (const change of widgetChanges) {
    const nearby = wsFramesRecvMarket
      .filter((f) => Math.abs(Number(f.atMs || 0) - Number(change.atMs || 0)) <= correlationWindowMs)
      .slice(0, 5)
      .map((f) => ({
        at: f.at,
        requestId: f.requestId,
        classifiedAs: f.classifiedAs,
        eventName: f.eventName,
        keywordHits: f.keywordHits,
        payloadSnippet: f.payloadSnippet
      }));

    correlatedChanges.push({
      at: change.at,
      endpoint: change.endpoint,
      oddsHash: change.oddsHash,
      correlatedWsFrames: nearby,
      hasCorrelation: nearby.length > 0
    });
  }

  const totalCorrelated = correlatedChanges.filter((row) => row.hasCorrelation).length;

  const wsOnlyHeartbeat = wsFramesRecv.every((f) => f.classifiedAs === 'ping' || f.classifiedAs === 'pong');
  const wsHasAnyMarketPayload = wsFramesRecvMarket.length > 0;

  const conclusion = {
    websocketConnected: wsCreated.length > 0,
    websocketAuthSeen: counters.wsAuthEvents > 0,
    websocketOnlyHeartbeat: wsOnlyHeartbeat,
    websocketAnyMarketPayload: wsHasAnyMarketPayload,
    widgetChangesDetected: widgetChanges.length,
    correlatedWidgetChangesWithWsMarketFrames: totalCorrelated,
    likelySourceOfLiveOddsUpdates:
      widgetChanges.length === 0
        ? 'no-odds-change-detected'
        : wsHasAnyMarketPayload && totalCorrelated > 0
          ? 'mixed-or-websocket-supporting'
          : 'http-polling-dominant'
  };

  const summary = {
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    captureMs,
    loginWaitMs,
    activeProfile,
    targetUrl,
    loginDetectedAt,
    loginState,
    requestCount: requestRows.length,
    wsCreated: wsCreated.length,
    wsHandshakes: wsHandshakes.length,
    wsFrames: wsFrames.length,
    wsFramesRecv: wsFramesRecv.length,
    wsFramesRecvMarket: wsFramesRecvMarket.length,
    wsPing: counters.wsPing,
    wsPong: counters.wsPong,
    wsSocketEvents: counters.wsSocketEvents,
    wsAuthEvents: counters.wsAuthEvents,
    widgetBodiesCaptured: counters.widgetBodiesCaptured,
    widgetSnapshots: widgetSnapshots.length,
    widgetChangesDetected: counters.widgetChangesDetected,
    widgetNoChange: counters.widgetNoChange,
    correlationWindowMs,
    correlatedWidgetChanges: totalCorrelated,
    conclusion
  };

  const report = {
    meta: {
      script: 'spy-acity-live-socket-deep.js',
      startedAt,
      finishedAt,
      options: {
        headless,
        useSystemChrome,
        requireProfile,
        activeProfile,
        targetUrl,
        profileDir,
        captureMs,
        loginWaitMs,
        tickMs,
        correlationWindowMs,
        maxFrames,
        maxRequests,
        maxBodyChars,
        maxWidgetBodies
      }
    },
    summary,
    websocket: {
      created: wsCreated,
      handshakes: wsHandshakes,
      errors: wsErrors,
      closed: wsClosed,
      frames: wsFrames
    },
    widget: {
      responses: widgetResponses,
      snapshots: widgetSnapshots,
      correlations: correlatedChanges
    },
    requests: requestRows,
    diagnostics: {
      pageErrors,
      consoleLogs
    }
  };

  const stamp = nowIso().replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `acity-live-socket-deep-spy-${stamp}.json`);
  const latestJsonPath = path.join(outputDir, 'acity-live-socket-deep-spy.latest.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(latestJsonPath, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '# ACity Deep Spy (LIVE Socket)',
    '',
    `- GeneratedAt: ${finishedAt}`,
    `- TargetUrl: ${targetUrl}`,
    `- BOOK_PROFILE: ${activeProfile}`,
    `- LoginDetectedAt: ${loginDetectedAt || 'not-detected'}`,
    '',
    '## Summary',
    '',
    `- wsCreated: ${summary.wsCreated}`,
    `- wsFramesRecv: ${summary.wsFramesRecv}`,
    `- wsFramesRecvMarket: ${summary.wsFramesRecvMarket}`,
    `- wsAuthEvents: ${summary.wsAuthEvents}`,
    `- widgetSnapshots: ${summary.widgetSnapshots}`,
    `- widgetChangesDetected: ${summary.widgetChangesDetected}`,
    `- correlatedWidgetChanges: ${summary.correlatedWidgetChanges}`,
    `- likelySourceOfLiveOddsUpdates: ${summary.conclusion.likelySourceOfLiveOddsUpdates}`,
    ''
  ].join('\n');

  const mdPath = path.join(outputDir, `acity-live-socket-deep-spy-${stamp}.md`);
  const latestMdPath = path.join(outputDir, 'acity-live-socket-deep-spy.latest.md');
  fs.writeFileSync(mdPath, `${md}\n`, 'utf8');
  fs.writeFileSync(latestMdPath, `${md}\n`, 'utf8');

  console.log('✅ Deep Spy completado');
  console.log(`   JSON:  ${jsonPath}`);
  console.log(`   JSON*: ${latestJsonPath}`);
  console.log(`   MD:    ${mdPath}`);
  console.log(`   MD*:   ${latestMdPath}`);
  console.log(`   Conclusion: ${summary.conclusion.likelySourceOfLiveOddsUpdates}`);
};

run().catch((error) => {
  console.error(`❌ Error en deep spy: ${error.message}`);
  process.exit(1);
});
