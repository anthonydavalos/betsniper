import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'data', 'booky');

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitCloseArg = args.includes('--no-wait-close');
const noLogin = args.includes('--no-login');
const allHeaders = args.includes('--all-headers');
const scanAllHosts = args.includes('--scan-all-hosts');
const useSystemChrome = !args.includes('--no-system-chrome');

const getArg = (prefix) => {
  const matches = args.filter((a) => a.startsWith(prefix));
  return matches.length ? matches[matches.length - 1] : null;
};

const captureMsArg = getArg('--capture-ms=');
const timeoutArg = getArg('--timeout=');
const maxFramesArg = getArg('--max-frames=');
const maxRequestsArg = getArg('--max-requests=');
const maxBodyCharsArg = getArg('--max-body-chars=');
const requireProfileArg = getArg('--require-profile=');
const profileArg = getArg('--profile=');
const targetUrlArg = getArg('--url=');

const requiredProfile = String(requireProfileArg?.split('=')[1] || 'acity').trim().toLowerCase();
const activeProfile = String(process.env.BOOK_PROFILE || 'doradobet').trim().toLowerCase();

const targetUrl = targetUrlArg
  ? String(targetUrlArg.split('=')[1] || '').trim()
  : 'https://www.casinoatlanticcity.com/apuestas-deportivas#/live';

const waitUntilClose = explicitNoWaitCloseArg ? false : (waitCloseArg || !headless);
const timeoutMsRaw = Number(captureMsArg?.split('=')[1] || timeoutArg?.split('=')[1] || 180000);
const timeoutMs = waitUntilClose ? 0 : (Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 180000);
const maxFrames = Math.max(50, Number(maxFramesArg?.split('=')[1] || 500));
const maxRequests = Math.max(500, Number(maxRequestsArg?.split('=')[1] || 5000));
const maxBodyChars = Math.max(2000, Number(maxBodyCharsArg?.split('=')[1] || 14000));

const username = process.env.ALTENAR_LOGIN_USERNAME || '';
const password = process.env.ALTENAR_LOGIN_PASSWORD || '';

const profileDirRaw = profileArg
  ? profileArg.split('=')[1]
  : path.join('data', 'booky', `chrome-profile-${activeProfile}`);
const profileDir = path.isAbsolute(profileDirRaw)
  ? profileDirRaw
  : path.join(projectRoot, profileDirRaw);

const trackedHosts = [
  'www.casinoatlanticcity.com',
  'casinoatlanticcity.com',
  'sb2frontend-altenar2.biahosted.com',
  'biahosted.com'
];

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

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

const isTrackedUrl = (urlRaw = '') => {
  if (scanAllHosts) return true;
  const parsed = asUrl(urlRaw);
  if (!parsed) return false;
  const host = String(parsed.hostname || '').toLowerCase();
  return trackedHosts.some((h) => host.includes(h));
};

const redactSensitiveValue = (value = '') => {
  const text = String(value || '');
  if (!text) return text;

  let next = text;

  if (username) next = next.split(username).join('[REDACTED_USERNAME]');
  if (password) next = next.split(password).join('[REDACTED_PASSWORD]');

  next = next.replace(/Bearer\s+[A-Za-z0-9\-_.]+/gi, 'Bearer [REDACTED_TOKEN]');
  next = next.replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED_TOKEN]"');

  return next;
};

const sanitizeHeaders = (headers = {}, includeAll = false) => {
  const out = {};
  for (const [key, val] of Object.entries(headers || {})) {
    const lower = String(key || '').toLowerCase();
    const isSecret = lower.includes('authorization') || lower.includes('cookie') || lower.includes('token');
    if (!includeAll && isSecret) {
      out[key] = val ? '[present]' : '[absent]';
      continue;
    }
    out[key] = isSecret ? '[REDACTED]' : redactSensitiveValue(val);
  }
  return out;
};

const sanitizeBody = (body = '') => {
  const text = redactSensitiveValue(String(body || ''));
  if (text.length <= maxBodyChars) return text;
  return `${text.slice(0, maxBodyChars)}...[truncated ${text.length - maxBodyChars} chars]`;
};

const summarizeBy = (rows = [], picker = () => 'unknown') => {
  const map = new Map();
  for (const row of rows) {
    const key = picker(row) || 'unknown';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([key, count]) => ({ key, count }));
};

const firstSelector = async (page, selectors = []) => {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) return selector;
  }
  return null;
};

const tryAutoLogin = async (page) => {
  if (!username || !password) {
    return { attempted: false, success: false, reason: 'missing-credentials' };
  }

  const loginTriggerSelectors = [
    'button#login',
    '#login',
    '[data-test-id="header-login-loginButton"] button'
  ];

  const userSelectors = [
    'input[name="user"]',
    'input[name="username"]',
    'input[name="login"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[id*="user"]',
    'input[id*="login"]'
  ];

  const passSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]'
  ];

  const submitSelectors = [
    'button[type="submit"]',
    'form button.styles_primaryButton__02bqI',
    'form button.styles_baseButton__3ohKA',
    'button[id*="login"]',
    'button[class*="login"]',
    'button[class*="signin"]'
  ];

  try {
    const alreadyLoggedIn = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').toLowerCase();
      return bodyText.includes('mis apuestas') && bodyText.includes('depositar');
    }).catch(() => false);

    if (alreadyLoggedIn) {
      return { attempted: false, success: true, reason: 'already-authenticated' };
    }

    const trigger = await firstSelector(page, loginTriggerSelectors);
    if (trigger) {
      await page.click(trigger).catch(() => {});
      await wait(450);
    }

    const userSelector = await firstSelector(page, userSelectors);
    const passSelector = await firstSelector(page, passSelectors);

    if (!userSelector || !passSelector) {
      return { attempted: true, success: false, reason: 'login-form-not-detected' };
    }

    await page.click(userSelector, { clickCount: 3 }).catch(() => {});
    await page.type(userSelector, username, { delay: 35 }).catch(() => {});
    await page.click(passSelector, { clickCount: 3 }).catch(() => {});
    await page.type(passSelector, password, { delay: 35 }).catch(() => {});

    const submit = await firstSelector(page, submitSelectors);
    if (submit) {
      await page.click(submit).catch(() => {});
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await wait(1800);
    return { attempted: true, success: true, reason: 'submitted' };
  } catch (error) {
    return { attempted: true, success: false, reason: `login-error:${error.message}` };
  }
};

const run = async () => {
  if (requiredProfile && activeProfile !== requiredProfile) {
    console.error(`❌ Perfil inválido. Requerido=${requiredProfile} Actual=${activeProfile}`);
    console.error(`   Ejecuta: npm run book:${requiredProfile === 'acity' ? 'acity' : 'dorado'}`);
    process.exit(1);
  }

  ensureDir(outputDir);
  ensureDir(profileDir);

  const startedAt = new Date().toISOString();

  console.log('🕵️ ANALISIS ACity LIVE iniciado');
  console.log(`   URL=${targetUrl}`);
  console.log(`   BOOK_PROFILE=${activeProfile}`);
  console.log(`   MODO=${headless ? 'headless' : 'headed'}`);
  console.log(`   CAPTURA=${waitUntilClose ? 'wait-close' : `${timeoutMs}ms`}`);
  console.log(`   HOST_SCOPE=${scanAllHosts ? 'all-hosts' : 'acity+biahosted'}`);

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
    maxResourceBufferSize: 2 * 1024 * 1024,
    maxTotalBufferSize: 24 * 1024 * 1024
  });

  const requestMap = new Map();
  const wsCreated = [];
  const wsHandshakes = [];
  const wsFrames = [];
  const wsErrors = [];
  const wsClosed = [];
  const consoleLogs = [];
  const pageErrors = [];

  const ensureRecord = (requestId, seed = {}) => {
    if (!requestMap.has(requestId)) {
      if (requestMap.size >= maxRequests) return null;
      requestMap.set(requestId, {
        requestId,
        startedAt: new Date().toISOString(),
        url: seed.url || null,
        method: seed.method || null,
        resourceType: seed.resourceType || null,
        initiatorType: seed.initiatorType || null,
        requestHeaders: {},
        requestHeadersExtra: {},
        requestPostData: null,
        responseStatus: null,
        responseHeaders: {},
        responseHeadersExtra: {},
        protocol: null,
        mimeType: null,
        bodySnippet: null,
        failed: null
      });
    }
    return requestMap.get(requestId);
  };

  page.on('console', (msg) => {
    if (consoleLogs.length >= 400) return;
    consoleLogs.push({
      at: new Date().toISOString(),
      type: msg.type(),
      text: redactSensitiveValue(msg.text())
    });
  });

  page.on('pageerror', (error) => {
    if (pageErrors.length >= 120) return;
    pageErrors.push({ at: new Date().toISOString(), message: error?.message || String(error) });
  });

  cdp.on('Network.requestWillBeSent', (evt) => {
    try {
      const req = evt?.request || {};
      const url = req?.url || '';
      if (!isTrackedUrl(url)) return;

      const record = ensureRecord(evt.requestId, {
        url,
        method: req.method,
        resourceType: evt.type,
        initiatorType: evt?.initiator?.type || null
      });
      if (!record) return;

      record.url = url;
      record.method = req.method || record.method;
      record.resourceType = evt.type || record.resourceType;
      record.initiatorType = evt?.initiator?.type || record.initiatorType;
      record.requestHeaders = sanitizeHeaders(req.headers || {}, allHeaders);
      record.requestPostData = req.postData ? sanitizeBody(req.postData) : null;
    } catch {
      // noop
    }
  });

  cdp.on('Network.requestWillBeSentExtraInfo', (evt) => {
    try {
      const record = ensureRecord(evt.requestId);
      if (!record) return;
      record.requestHeadersExtra = sanitizeHeaders(evt.headers || {}, allHeaders);
    } catch {
      // noop
    }
  });

  cdp.on('Network.responseReceived', (evt) => {
    try {
      const res = evt?.response || {};
      const url = res.url || '';
      if (!isTrackedUrl(url)) return;

      const record = ensureRecord(evt.requestId, { url, resourceType: evt.type || null });
      if (!record) return;

      record.url = url;
      record.responseStatus = Number(res.status || 0);
      record.responseHeaders = sanitizeHeaders(res.headers || {}, allHeaders);
      record.protocol = res.protocol || null;
      record.mimeType = res.mimeType || null;
    } catch {
      // noop
    }
  });

  cdp.on('Network.responseReceivedExtraInfo', (evt) => {
    try {
      const record = ensureRecord(evt.requestId);
      if (!record) return;
      record.responseHeadersExtra = sanitizeHeaders(evt.headers || {}, allHeaders);
    } catch {
      // noop
    }
  });

  cdp.on('Network.loadingFinished', async (evt) => {
    try {
      const record = requestMap.get(evt.requestId);
      if (!record) return;
      if (!record.url || !isTrackedUrl(record.url)) return;
      if (record.bodySnippet) return;

      const lowUrl = String(record.url || '').toLowerCase();
      const isWidget = lowUrl.includes('/api/widget/');
      const isJson = String(record.mimeType || '').toLowerCase().includes('json');
      const isFetchLike = ['xhr', 'fetch'].includes(String(record.resourceType || '').toLowerCase());
      if (!isWidget && !isJson && !isFetchLike) return;

      const body = await cdp.send('Network.getResponseBody', { requestId: evt.requestId }).catch(() => null);
      if (!body) return;
      const raw = body.base64Encoded
        ? Buffer.from(body.body || '', 'base64').toString('utf8')
        : String(body.body || '');
      record.bodySnippet = sanitizeBody(raw);
    } catch {
      // noop
    }
  });

  cdp.on('Network.loadingFailed', (evt) => {
    try {
      const record = ensureRecord(evt.requestId);
      if (!record) return;
      record.failed = {
        errorText: evt.errorText || null,
        canceled: Boolean(evt.canceled),
        blockedReason: evt.blockedReason || null
      };
    } catch {
      // noop
    }
  });

  cdp.on('Network.webSocketCreated', (evt) => {
    if (wsCreated.length >= 200) return;
    const url = evt?.url || '';
    if (!isTrackedUrl(url)) return;
    wsCreated.push({
      at: new Date().toISOString(),
      requestId: evt?.requestId || null,
      url
    });
  });

  cdp.on('Network.webSocketWillSendHandshakeRequest', (evt) => {
    if (wsHandshakes.length >= 300) return;
    const req = evt?.request || {};
    const url = req?.url || '';
    if (!isTrackedUrl(url)) return;
    wsHandshakes.push({
      at: new Date().toISOString(),
      type: 'request',
      requestId: evt?.requestId || null,
      url,
      headers: sanitizeHeaders(req?.headers || {}, allHeaders)
    });
  });

  cdp.on('Network.webSocketHandshakeResponseReceived', (evt) => {
    if (wsHandshakes.length >= 300) return;
    const res = evt?.response || {};
    wsHandshakes.push({
      at: new Date().toISOString(),
      type: 'response',
      requestId: evt?.requestId || null,
      status: Number(res?.status || 0),
      statusText: res?.statusText || '',
      headers: sanitizeHeaders(res?.headers || {}, allHeaders)
    });
  });

  const pushWsFrame = (direction, evt) => {
    if (wsFrames.length >= maxFrames) return;
    const response = evt?.response || {};
    const payload = String(response.payloadData || '');
    const isText = Number(response.opcode) === 1;
    const snippet = isText
      ? sanitizeBody(payload)
      : `[binary:${payload.length} chars base64-ish]`;

    wsFrames.push({
      at: new Date().toISOString(),
      direction,
      requestId: evt?.requestId || null,
      opcode: Number(response.opcode || 0),
      mask: Boolean(response.mask),
      payloadLength: payload.length,
      payloadSnippet: snippet
    });
  };

  cdp.on('Network.webSocketFrameSent', (evt) => pushWsFrame('sent', evt));
  cdp.on('Network.webSocketFrameReceived', (evt) => pushWsFrame('received', evt));

  cdp.on('Network.webSocketFrameError', (evt) => {
    if (wsErrors.length >= 120) return;
    wsErrors.push({
      at: new Date().toISOString(),
      requestId: evt?.requestId || null,
      errorMessage: evt?.errorMessage || ''
    });
  });

  cdp.on('Network.webSocketClosed', (evt) => {
    if (wsClosed.length >= 120) return;
    wsClosed.push({
      at: new Date().toISOString(),
      requestId: evt?.requestId || null,
      timestamp: evt?.timestamp || null
    });
  });

  let loginStatus = { attempted: false, success: false, reason: 'not-run' };

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (error) {
    console.warn(`⚠️ Navegación inicial con warning: ${error.message}`);
  }

  await wait(1500);

  if (!noLogin) {
    loginStatus = await tryAutoLogin(page);
    if (loginStatus.attempted) {
      console.log(`🔐 Login auto: success=${loginStatus.success} reason=${loginStatus.reason}`);
      await wait(1800);
    }
  }

  // Reafirmar ruta LIVE tras login/cambio de estado.
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (error) {
    console.warn(`⚠️ Navegación LIVE con warning: ${error.message}`);
  }

  if (waitUntilClose) {
    console.log('👀 Modo wait-close: interactúa en LIVE y cierra el navegador para finalizar el reporte.');
    await new Promise((resolve) => browser.once('disconnected', resolve));
  } else {
    console.log(`⏱️ Capturando tráfico por ${timeoutMs}ms...`);
    await wait(timeoutMs);
    await browser.close();
  }

  const finishedAt = new Date().toISOString();
  const requestRows = Array.from(requestMap.values());

  const trackedRows = requestRows.filter((r) => isTrackedUrl(r.url || ''));
  const apiRows = trackedRows.filter((r) => String(r.url || '').includes('/api/'));
  const widgetRows = trackedRows.filter((r) => String(r.url || '').includes('/api/widget/'));
  const liveWidgetRows = widgetRows.filter((r) => {
    const u = String(r.url || '').toLowerCase();
    return u.includes('getlivenow') || u.includes('geteventdetails') || u.includes('getmarket') || u.includes('live');
  });

  const wsRecvCount = wsFrames.filter((f) => f.direction === 'received').length;
  const wsSentCount = wsFrames.filter((f) => f.direction === 'sent').length;

  const likelyTransport = (() => {
    if (wsCreated.length > 0 && wsRecvCount > 10) return 'websocket-dominant';
    if (liveWidgetRows.length > 20) return 'http-polling-dominant';
    if (wsCreated.length > 0) return 'websocket-present-low-frames';
    return 'no-websocket-detected';
  })();

  const cookies = await (async () => {
    try {
      const rows = await page.cookies();
      return rows.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expires: c.expires
      }));
    } catch {
      return [];
    }
  })();

  const storageSnapshot = await page.evaluate(() => {
    const pull = (store) => {
      const out = [];
      try {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          const value = store.getItem(key);
          out.push({ key, value: String(value || '').slice(0, 400) });
        }
      } catch {
        return [];
      }
      return out;
    };

    return {
      href: location.href,
      origin: location.origin,
      title: document.title,
      localStorage: pull(window.localStorage),
      sessionStorage: pull(window.sessionStorage)
    };
  }).catch(() => ({ href: null, origin: null, title: null, localStorage: [], sessionStorage: [] }));

  const report = {
    meta: {
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      targetUrl,
      activeProfile,
      requiredProfile,
      headless,
      waitUntilClose,
      timeoutMs,
      noLogin,
      loginStatus,
      captureLimits: {
        maxFrames,
        maxRequests,
        maxBodyChars
      }
    },
    summary: {
      totalTrackedRequests: trackedRows.length,
      apiRequests: apiRows.length,
      widgetRequests: widgetRows.length,
      liveWidgetRequests: liveWidgetRows.length,
      websocketCreated: wsCreated.length,
      websocketHandshakes: wsHandshakes.length,
      websocketFramesReceived: wsRecvCount,
      websocketFramesSent: wsSentCount,
      websocketErrors: wsErrors.length,
      likelyTransport
    },
    topHosts: summarizeBy(trackedRows, (r) => asUrl(r.url || '')?.hostname || 'unknown-host'),
    topPaths: summarizeBy(trackedRows, (r) => {
      const parsed = asUrl(r.url || '');
      if (!parsed) return 'invalid-url';
      return `${parsed.hostname}${parsed.pathname}`;
    }),
    topStatusCodes: summarizeBy(trackedRows, (r) => String(r.responseStatus || 'n/a')),
    topMethods: summarizeBy(trackedRows, (r) => String(r.method || 'n/a').toUpperCase()),
    websocket: {
      created: wsCreated,
      handshakes: wsHandshakes,
      framesSample: wsFrames,
      errors: wsErrors,
      closed: wsClosed
    },
    requests: trackedRows,
    browserState: {
      cookies,
      storageSnapshot: {
        ...storageSnapshot,
        localStorage: (storageSnapshot.localStorage || []).map((row) => ({
          key: row.key,
          value: redactSensitiveValue(row.value)
        })),
        sessionStorage: (storageSnapshot.sessionStorage || []).map((row) => ({
          key: row.key,
          value: redactSensitiveValue(row.value)
        }))
      }
    },
    diagnostics: {
      consoleLogs,
      pageErrors
    }
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `acity-live-socket-analysis-${stamp}.json`);
  const jsonLatestPath = path.join(outputDir, 'acity-live-socket-analysis.latest.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(jsonLatestPath, JSON.stringify(report, null, 2), 'utf8');

  const mdLines = [
    '# ACity LIVE Socket Analysis',
    '',
    `- GeneratedAt: ${finishedAt}`,
    `- TargetUrl: ${targetUrl}`,
    `- BOOK_PROFILE: ${activeProfile}`,
    `- LoginStatus: attempted=${loginStatus.attempted} success=${loginStatus.success} reason=${loginStatus.reason}`,
    '',
    '## Summary',
    '',
    `- totalTrackedRequests: ${report.summary.totalTrackedRequests}`,
    `- apiRequests: ${report.summary.apiRequests}`,
    `- widgetRequests: ${report.summary.widgetRequests}`,
    `- liveWidgetRequests: ${report.summary.liveWidgetRequests}`,
    `- websocketCreated: ${report.summary.websocketCreated}`,
    `- websocketFramesReceived: ${report.summary.websocketFramesReceived}`,
    `- websocketFramesSent: ${report.summary.websocketFramesSent}`,
    `- websocketErrors: ${report.summary.websocketErrors}`,
    `- likelyTransport: ${report.summary.likelyTransport}`,
    '',
    '## Top Hosts',
    '',
    ...report.topHosts.slice(0, 12).map((row) => `- ${row.key}: ${row.count}`),
    '',
    '## Top Paths',
    '',
    ...report.topPaths.slice(0, 15).map((row) => `- ${row.key}: ${row.count}`),
    ''
  ];

  const mdPath = path.join(outputDir, `acity-live-socket-analysis-${stamp}.md`);
  const mdLatestPath = path.join(outputDir, 'acity-live-socket-analysis.latest.md');
  fs.writeFileSync(mdPath, `${mdLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(mdLatestPath, `${mdLines.join('\n')}\n`, 'utf8');

  console.log('✅ Análisis LIVE ACity completado');
  console.log(`   JSON:   ${jsonPath}`);
  console.log(`   JSON*:  ${jsonLatestPath}`);
  console.log(`   MD:     ${mdPath}`);
  console.log(`   MD*:    ${mdLatestPath}`);
};

run().catch((error) => {
  console.error(`❌ Error en analyze-acity-live-socket: ${error.message}`);
  process.exit(1);
});
