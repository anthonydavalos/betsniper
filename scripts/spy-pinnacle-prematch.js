import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'data', 'pinnacle');
const defaultProfileDir = path.join(projectRoot, 'data', 'pinnacle', 'chrome-profile');

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const timeoutArg = args.find((a) => a.startsWith('--timeout='));
const captureMsArg = args.find((a) => a.startsWith('--capture-ms='));
const urlsArg = args.find((a) => a.startsWith('--urls='));
const useSystemChrome = !args.includes('--no-system-chrome');
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitCloseArg = args.includes('--no-wait-close');
const includeAllHeaders = !args.includes('--safe-headers') || args.includes('--all-headers');
const maxBodyChars = Number((args.find((a) => a.startsWith('--max-body-chars=')) || '--max-body-chars=16000').split('=')[1]);
const maxFrames = Number((args.find((a) => a.startsWith('--max-frames=')) || '--max-frames=220').split('=')[1]);
const maxRequests = Number((args.find((a) => a.startsWith('--max-requests=')) || '--max-requests=5000').split('=')[1]);
const profileArg = args.find((a) => a.startsWith('--profile='));

const timeoutMsRaw = Number((timeoutArg || captureMsArg || '--timeout=45000').split('=')[1]);
const waitUntilClose = explicitNoWaitCloseArg ? false : (waitCloseArg || !headless);
const timeoutMs = waitUntilClose ? 0 : (Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 45000);
const profileDirRaw = profileArg ? profileArg.replace('--profile=', '') : process.env.PINNACLE_CHROME_PROFILE_DIR;
const profileDir = profileDirRaw
  ? (path.isAbsolute(profileDirRaw) ? profileDirRaw : path.join(projectRoot, profileDirRaw))
  : defaultProfileDir;

const defaultUrls = [
  'https://www.pinnacle.com/es/soccer/matchups/highlights/',
  'https://www.pinnacle.com/es/soccer/germany-bundesliga/matchups/#all',
  'https://www.pinnacle.com/es/soccer/uefa-champions-league/matchups/#all'
];

const targetUrls = urlsArg
  ? urlsArg
      .replace('--urls=', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : defaultUrls;

const asUrl = (raw) => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const redactHeaders = (headers = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k || '').toLowerCase();
    if (['cookie', 'set-cookie', 'authorization'].includes(key)) {
      out[key] = v ? '[present]' : '[absent]';
      continue;
    }
    out[key] = v;
  }
  return out;
};

const normalizeHeaders = (headers = {}) => {
  if (!headers || typeof headers !== 'object') return {};
  return includeAllHeaders ? headers : redactHeaders(headers);
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const toPathKey = (urlRaw = '') => {
  const parsed = asUrl(urlRaw);
  if (!parsed) return 'invalid-url';
  return `${parsed.hostname}${parsed.pathname}`;
};

const maybePinnacleHost = (urlRaw = '') => {
  const parsed = asUrl(urlRaw);
  if (!parsed) return false;
  const host = String(parsed.hostname || '').toLowerCase();
  return host.includes('pinnacle.com') || host.includes('arcadia.pinnacle.com') || host.includes('haywire');
};

const getExecutablePath = () => {
  if (!useSystemChrome) return null;
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const analyzeIntervals = (hits = []) => {
  if (!Array.isArray(hits) || hits.length < 3) return null;
  const sorted = [...hits].sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < sorted.length; i += 1) {
    deltas.push(sorted[i] - sorted[i - 1]);
  }
  if (deltas.length === 0) return null;
  const avg = deltas.reduce((acc, n) => acc + n, 0) / deltas.length;
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  return {
    samples: deltas.length,
    avgMs: Math.round(avg),
    minMs: Math.round(min),
    maxMs: Math.round(max)
  };
};

const detectJsonContent = (headers = {}) => {
  const entries = Object.entries(headers || {});
  for (const [k, v] of entries) {
    if (String(k || '').toLowerCase() === 'content-type') {
      return String(v || '').toLowerCase().includes('application/json')
        || String(v || '').toLowerCase().includes('application/problem+json');
    }
  }
  return false;
};

const trimBody = (raw = '') => {
  const text = String(raw || '');
  if (text.length <= maxBodyChars) return text;
  return `${text.slice(0, maxBodyChars)}...[truncated ${text.length - maxBodyChars} chars]`;
};

const createSessionRecorder = async ({ browser, initialUrl }) => {
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable', {
    maxResourceBufferSize: 1024 * 1024,
    maxTotalBufferSize: 12 * 1024 * 1024
  });

  const requestMap = new Map();
  const endpointHitsByPath = new Map();
  const endpointMethodsByPath = new Map();
  const endpointTypesByPath = new Map();
  const websocket = {
    created: [],
    handshakes: [],
    frames: [],
    errors: []
  };
  const eventSources = [];
  const navigation = [];

  const registerEndpointHit = ({ url, method, resourceType }) => {
    const key = toPathKey(url);
    if (!endpointHitsByPath.has(key)) endpointHitsByPath.set(key, []);
    endpointHitsByPath.get(key).push(Date.now());

    if (!endpointMethodsByPath.has(key)) endpointMethodsByPath.set(key, new Set());
    endpointMethodsByPath.get(key).add(String(method || '').toUpperCase());

    if (!endpointTypesByPath.has(key)) endpointTypesByPath.set(key, new Set());
    endpointTypesByPath.get(key).add(String(resourceType || '').toLowerCase());
  };

  const ensureRecord = (requestId, fallback = {}) => {
    if (!requestMap.has(requestId)) {
      if (requestMap.size >= maxRequests) return null;
      requestMap.set(requestId, {
        requestId,
        startedAt: new Date().toISOString(),
        url: fallback.url || null,
        method: fallback.method || null,
        resourceType: fallback.resourceType || null,
        initiatorType: fallback.initiatorType || null,
        requestHeaders: {},
        requestHeadersExtra: {},
        responseStatus: null,
        responseHeaders: {},
        responseHeadersExtra: {},
        protocol: null,
        mimeType: null,
        failed: null,
        body: null
      });
    }
    return requestMap.get(requestId);
  };

  cdp.on('Network.requestWillBeSent', (evt) => {
    try {
      const req = evt?.request || {};
      const url = req?.url || '';
      if (!maybePinnacleHost(url)) return;

      const record = ensureRecord(evt.requestId, {
        url,
        method: req?.method || null,
        resourceType: evt?.type || null,
        initiatorType: evt?.initiator?.type || null
      });
      if (!record) return;

      record.url = url;
      record.method = req?.method || record.method;
      record.resourceType = evt?.type || record.resourceType;
      record.initiatorType = evt?.initiator?.type || record.initiatorType;
      record.requestHeaders = normalizeHeaders(req?.headers || {});

      registerEndpointHit({
        url,
        method: req?.method || '',
        resourceType: evt?.type || ''
      });

      if (String(evt?.type || '').toLowerCase() === 'eventsource') {
        eventSources.push({
          at: new Date().toISOString(),
          url,
          method: req?.method || 'GET'
        });
      }
    } catch {
      // noop
    }
  });

  cdp.on('Network.requestWillBeSentExtraInfo', (evt) => {
    try {
      const record = ensureRecord(evt.requestId);
      if (!record) return;
      record.requestHeadersExtra = normalizeHeaders(evt?.headers || {});
    } catch {
      // noop
    }
  });

  cdp.on('Network.responseReceived', (evt) => {
    try {
      const res = evt?.response || {};
      const url = res?.url || '';
      if (!maybePinnacleHost(url)) return;

      const record = ensureRecord(evt.requestId, {
        url,
        method: null,
        resourceType: evt?.type || null
      });
      if (!record) return;

      record.url = url;
      record.resourceType = evt?.type || record.resourceType;
      record.responseStatus = Number(res?.status || 0);
      record.responseHeaders = normalizeHeaders(res?.headers || {});
      record.protocol = res?.protocol || null;
      record.mimeType = res?.mimeType || null;
    } catch {
      // noop
    }
  });

  cdp.on('Network.responseReceivedExtraInfo', (evt) => {
    try {
      const record = ensureRecord(evt.requestId);
      if (!record) return;
      record.responseHeadersExtra = normalizeHeaders(evt?.headers || {});
    } catch {
      // noop
    }
  });

  cdp.on('Network.loadingFailed', (evt) => {
    try {
      const record = ensureRecord(evt.requestId);
      if (!record) return;
      record.failed = {
        canceled: Boolean(evt?.canceled),
        errorText: evt?.errorText || null,
        blockedReason: evt?.blockedReason || null
      };
    } catch {
      // noop
    }
  });

  cdp.on('Network.loadingFinished', async (evt) => {
    try {
      const record = requestMap.get(evt.requestId);
      if (!record || record.body !== null) return;

      const status = Number(record.responseStatus || 0);
      const isJson = detectJsonContent(record.responseHeaders)
        || detectJsonContent(record.responseHeadersExtra)
        || String(record.mimeType || '').toLowerCase().includes('json');

      if (!isJson) return;
      if (!(status >= 200 && status < 500)) return;

      const response = await cdp.send('Network.getResponseBody', { requestId: evt.requestId });
      const payload = response?.base64Encoded
        ? Buffer.from(String(response?.body || ''), 'base64').toString('utf8')
        : String(response?.body || '');
      record.body = trimBody(payload);
    } catch {
      // noop
    }
  });

  cdp.on('Network.webSocketCreated', (evt) => {
    const url = evt?.url || '';
    if (!url) return;
    websocket.created.push({ at: new Date().toISOString(), requestId: evt?.requestId || null, url });
    console.log(`[WS] created ${url}`);
  });

  cdp.on('Network.webSocketWillSendHandshakeRequest', (evt) => {
    const req = evt?.request || {};
    const url = req?.url || '';
    if (!url) return;
    websocket.handshakes.push({
      at: new Date().toISOString(),
      phase: 'request',
      requestId: evt?.requestId || null,
      url,
      headers: normalizeHeaders(req?.headers || {})
    });
    console.log(`[WS] handshake request ${url}`);
  });

  cdp.on('Network.webSocketHandshakeResponseReceived', (evt) => {
    const res = evt?.response || {};
    websocket.handshakes.push({
      at: new Date().toISOString(),
      phase: 'response',
      requestId: evt?.requestId || null,
      status: Number(res?.status || 0),
      statusText: res?.statusText || null,
      headers: normalizeHeaders(res?.headers || {})
    });
    console.log(`[WS] handshake response status=${Number(res?.status || 0)}`);
  });

  cdp.on('Network.webSocketFrameSent', (evt) => {
    if (websocket.frames.length >= maxFrames) return;
    const payload = String(evt?.response?.payloadData || '');
    websocket.frames.push({
      at: new Date().toISOString(),
      direction: 'sent',
      requestId: evt?.requestId || null,
      opcode: Number(evt?.response?.opcode || 0),
      len: payload.length,
      sample: trimBody(payload)
    });
  });

  cdp.on('Network.webSocketFrameReceived', (evt) => {
    if (websocket.frames.length >= maxFrames) return;
    const payload = String(evt?.response?.payloadData || '');
    websocket.frames.push({
      at: new Date().toISOString(),
      direction: 'received',
      requestId: evt?.requestId || null,
      opcode: Number(evt?.response?.opcode || 0),
      len: payload.length,
      sample: trimBody(payload)
    });
  });

  cdp.on('Network.webSocketFrameError', (evt) => {
    websocket.errors.push({
      at: new Date().toISOString(),
      requestId: evt?.requestId || null,
      errorMessage: evt?.errorMessage || null
    });
  });

  page.on('framenavigated', (frame) => {
    try {
      if (frame !== page.mainFrame()) return;
      navigation.push({ at: new Date().toISOString(), url: frame.url() });
      console.log(`[NAV] ${frame.url()}`);
    } catch {
      // noop
    }
  });

  const close = async () => {
    const endpointStats = [];
    for (const [pathKey, times] of endpointHitsByPath.entries()) {
      endpointStats.push({
        endpoint: pathKey,
        hits: times.length,
        methods: Array.from(endpointMethodsByPath.get(pathKey) || []),
        resourceTypes: Array.from(endpointTypesByPath.get(pathKey) || []),
        interval: analyzeIntervals(times)
      });
    }
    endpointStats.sort((a, b) => b.hits - a.hits);

    const requests = Array.from(requestMap.values())
      .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));

    try {
      if (!page.isClosed()) await page.close();
    } catch {
      // noop
    }

    return {
      targetUrl: initialUrl,
      navigation,
      websocket: {
        createdCount: websocket.created.length,
        handshakeCount: websocket.handshakes.length,
        frameCount: websocket.frames.length,
        created: websocket.created,
        handshakes: websocket.handshakes,
        framesSample: websocket.frames,
        errors: websocket.errors
      },
      eventSource: {
        count: eventSources.length,
        items: eventSources
      },
      endpoints: endpointStats,
      requests
    };
  };

  return { page, close };
};

const run = async () => {
  ensureDir(outputDir);
  ensureDir(profileDir);

  const launchOptions = {
    headless,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: profileDir
  };

  const executablePath = getExecutablePath();
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await puppeteer.launch(launchOptions);

  const startedAtMs = Date.now();

  try {
    const results = [];

    if (waitUntilClose) {
      const initialUrl = targetUrls[0] || defaultUrls[0];
      console.log(`[SCAN:interactive] URL inicial: ${initialUrl}`);
      console.log(`[SCAN:interactive] Navega manualmente por estas rutas sugeridas:`);
      for (const u of targetUrls) {
        console.log(` - ${u}`);
      }
      console.log('[SCAN:interactive] Cuando termines, cierra el navegador para finalizar y guardar reporte.');

      const session = await createSessionRecorder({ browser, initialUrl });
      try {
        await session.page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      } catch (error) {
        console.warn(`[WARN] Navegacion inicial fallo: ${error.message}`);
      }

      await new Promise((resolve) => {
        browser.once('disconnected', resolve);
      });

      const snapshot = await session.close();
      results.push({
        ...snapshot,
        captureWindowMs: Date.now() - startedAtMs,
        mode: 'interactive'
      });
    } else {
      for (const targetUrl of targetUrls) {
        console.log(`\n[SCAN:auto] ${targetUrl}`);
        const session = await createSessionRecorder({ browser, initialUrl: targetUrl });

        try {
          await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        } catch (error) {
          console.warn(`[WARN] Navegacion con timeout/fallo en ${targetUrl}: ${error.message}`);
        }

        await new Promise((resolve) => setTimeout(resolve, timeoutMs));

        const row = await session.close();
        results.push({
          ...row,
          captureWindowMs: timeoutMs,
          mode: 'automatic'
        });

        const top = row.endpoints.slice(0, 10).map((e) => ({
          endpoint: e.endpoint,
          hits: e.hits,
          types: e.resourceTypes,
          intervalMs: e.interval?.avgMs || null
        }));

        console.log(`[SCAN:auto] websockets=${row.websocket.createdCount} eventSource=${row.eventSource.count}`);
        console.log(`[SCAN:auto] top endpoints: ${JSON.stringify(top, null, 2)}`);
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      headless,
      waitUntilClose,
      includeAllHeaders,
      timeoutMs,
      profileDir,
      maxBodyChars,
      maxFrames,
      maxRequests,
      targets: targetUrls,
      results
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(outputDir, `prematch-deep-scan-${stamp}.json`);
    const latestPath = path.join(outputDir, 'prematch-deep-scan.latest.json');

    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2), 'utf8');

    console.log(`\n[OK] Reporte guardado:`);
    console.log(` - ${filePath}`);
    console.log(` - ${latestPath}`);
  } finally {
    if (browser.connected) await browser.close();
  }
};

run().catch((error) => {
  console.error(`[ERROR] spy-pinnacle-prematch: ${error.message}`);
  process.exit(1);
});
