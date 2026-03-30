import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'data', 'pinnacle');

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitArg = args.includes('--no-wait-close');
const captureMsArg = args.find((arg) => arg.startsWith('--capture-ms='));
const maxBodyArg = args.find((arg) => arg.startsWith('--max-body-chars='));
const urlArg = args.find((arg) => arg.startsWith('--url='));
const allArcadiaArg = args.includes('--all-arcadia');
const allXhrArg = args.includes('--all-xhr');
const noGetArg = args.includes('--no-get');
const useSystemChrome = !args.includes('--no-system-chrome');

const rawCaptureMs = Number(captureMsArg?.split('=')[1] || process.env.PINNACLE_ACCOUNT_CAPTURE_MS || 180000);
const waitUntilClose = explicitNoWaitArg ? false : (waitCloseArg || (!headless && !captureMsArg));
const captureMs = waitUntilClose ? 0 : (rawCaptureMs > 0 ? rawCaptureMs : 180000);
const maxBodyChars = Number(maxBodyArg?.split('=')[1] || process.env.PINNACLE_CAPTURE_MAX_BODY_CHARS || 24000);
const includeGet = !noGetArg;

const targetUrl =
  urlArg?.split('=').slice(1).join('=')
  || process.env.PINNACLE_ACCOUNT_CAPTURE_URL
  || 'https://www.pinnacle.com/es/account/';

const DEFAULT_PINNACLE_PROFILE_DIR = path.join(projectRoot, 'data', 'pinnacle', 'chrome-profile');
const profileDir = process.env.PINNACLE_CHROME_PROFILE_DIR
  ? (path.isAbsolute(process.env.PINNACLE_CHROME_PROFILE_DIR)
    ? process.env.PINNACLE_CHROME_PROFILE_DIR
    : path.join(projectRoot, process.env.PINNACLE_CHROME_PROFILE_DIR))
  : DEFAULT_PINNACLE_PROFILE_DIR;

const watchedUrlKeywords = [
  'balance',
  'wallet',
  'account',
  'cash',
  'fund',
  'funds',
  'bankroll',
  'profile',
  'session',
  'statement',
  'open-bets',
  'bet-history',
  'transactions',
  'deposit',
  'withdrawal'
];

const watchedBodyKeywords = [
  'balance',
  'wallet',
  'cash',
  'fund',
  'bankroll',
  'available',
  'currency',
  'account'
];

const candidateResponseKeys = [
  'balance',
  'balances',
  'available',
  'availablebalance',
  'funds',
  'wallet',
  'bankroll',
  'currency',
  'cash'
];

const redactHeaderKeys = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-session',
  'x-xsrf-token',
  'x-csrf-token',
  'x-auth-token',
  'token'
];

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

const toShortPath = (url = '') => {
  const parsed = asUrl(url);
  if (!parsed) return url;
  return `${parsed.origin}${parsed.pathname}${parsed.search || ''}`;
};

const sanitizeHeaders = (headers = {}) => {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (redactHeaderKeys.includes(String(key).toLowerCase())) {
      out[key] = '[REDACTED]';
    }
  }
  return out;
};

const sanitizeBodyText = (raw = null) => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (!Number.isFinite(maxBodyChars) || maxBodyChars <= 0 || text.length <= maxBodyChars) return text;
  return `${text.slice(0, maxBodyChars)} ...[TRUNCATED ${text.length - maxBodyChars} chars]`;
};

const parseJsonIfPossible = (raw = null) => {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseFormIfPossible = (raw = null) => {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw);
  if (!text.includes('=') || text.includes('{') || text.includes('[')) return null;
  const out = {};
  for (const chunk of text.split('&')) {
    if (!chunk) continue;
    const idx = chunk.indexOf('=');
    const keyRaw = idx >= 0 ? chunk.slice(0, idx) : chunk;
    const valRaw = idx >= 0 ? chunk.slice(idx + 1) : '';
    const key = decodeURIComponent(keyRaw || '').trim();
    const value = decodeURIComponent(valRaw || '').trim();
    if (!key) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
};

const isPinnacleHost = (url = '') => {
  const parsed = asUrl(url);
  if (!parsed) return false;
  const host = String(parsed.hostname || '').toLowerCase();
  return host.includes('pinnacle.com') || host.includes('arcadia.pinnacle.com');
};

const isArcadiaApiRequest = (url = '') => {
  const low = String(url || '').toLowerCase();
  return low.includes('api.arcadia.pinnacle.com/') || low.includes('guest.api.arcadia.pinnacle.com/');
};

const getCandidateReasons = ({ url = '', postData = '' }) => {
  const lowUrl = String(url).toLowerCase();
  const lowBody = String(postData).toLowerCase();

  const reasons = [];
  if (watchedUrlKeywords.some((key) => lowUrl.includes(key))) reasons.push('url-keyword');
  if (watchedBodyKeywords.some((key) => lowBody.includes(key))) reasons.push('body-keyword');
  if (allArcadiaArg && isArcadiaApiRequest(url)) reasons.push('all-arcadia');
  if (allXhrArg && isPinnacleHost(url)) reasons.push('all-xhr');

  return reasons;
};

const shouldCaptureRequest = ({ method = '', url = '', resourceType = '', postData = '' }) => {
  const methodUp = String(method || '').toUpperCase();
  const isAllowedMethod = includeGet ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(methodUp) : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(methodUp);
  if (!isAllowedMethod) return null;
  if (!isPinnacleHost(url)) return null;
  if (!['xhr', 'fetch'].includes(String(resourceType || '').toLowerCase())) return null;

  const reasons = getCandidateReasons({ url, postData });
  if (reasons.length === 0) return null;

  return reasons;
};

const deepKeyMatchCount = (node) => {
  let hits = 0;

  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
      const keyNorm = String(key || '').toLowerCase();
      if (candidateResponseKeys.some((k) => keyNorm.includes(k))) hits += 1;
      walk(child);
    }
  };

  walk(node);
  return hits;
};

const buildSummary = ({ requestLogs, startedAt }) => {
  const endpointHits = requestLogs.reduce((acc, item) => {
    const key = item.shortPath;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const responseCandidates = requestLogs
    .map((entry) => {
      const responseJson = entry?.response?.bodyJson || null;
      const keyHits = responseJson ? deepKeyMatchCount(responseJson) : 0;
      return {
        id: entry.id,
        method: entry.method,
        shortPath: entry.shortPath,
        status: entry?.response?.status || null,
        matchedBy: entry.matchedBy,
        responseKeyHits: keyHits
      };
    })
    .filter((row) => row.responseKeyHits > 0)
    .sort((a, b) => b.responseKeyHits - a.responseKeyHits)
    .slice(0, 30);

  return {
    generatedAt: new Date().toISOString(),
    startedAt,
    targetUrl,
    profileDir,
    headless,
    waitUntilClose,
    includeGet,
    allArcadia: allArcadiaArg,
    allXhr: allXhrArg,
    captureMs,
    maxBodyChars,
    watchedUrlKeywords,
    watchedBodyKeywords,
    candidateResponseKeys,
    totalCaptured: requestLogs.length,
    endpointHits,
    responseCandidates,
    captures: requestLogs
  };
};

const saveSummary = (summary) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `capture-account-${stamp}.json`);
  const latestPath = path.join(outputDir, 'capture-account.latest.json');

  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2), 'utf8');

  return { filePath, latestPath };
};

const run = async () => {
  ensureDir(outputDir);
  ensureDir(profileDir);

  console.log('Starting Pinnacle account capture...');
  console.log(`  URL=${targetUrl}`);
  console.log(`  Profile=${profileDir}`);
  console.log(`  Mode=${headless ? 'headless' : 'headed'}`);
  console.log(`  Strategy=${waitUntilClose ? 'wait-close' : `timeout ${captureMs}ms`}`);
  console.log(`  includeGet=${includeGet ? 1 : 0} allArcadia=${allArcadiaArg ? 1 : 0} allXhr=${allXhrArg ? 1 : 0}`);

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

  if (useSystemChrome) {
    launchOptions.channel = 'chrome';
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  const startedAt = new Date().toISOString();
  const requestLogs = [];
  const requestMap = new Map();
  let seq = 0;
  let finalized = false;

  const finalize = async ({ reason = 'normal', closeBrowser = true, exitCode = 0 }) => {
    if (finalized) return;
    finalized = true;

    const summary = buildSummary({ requestLogs, startedAt });
    const { filePath, latestPath } = saveSummary(summary);

    console.log(`\nCapture finished (${reason}).`);
    console.log(`  Captures: ${requestLogs.length}`);
    console.log(`  File:     ${filePath}`);
    console.log(`  Latest:   ${latestPath}`);

    const top = Object.entries(summary.endpointHits || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    if (top.length > 0) {
      console.log('  Top endpoints:');
      for (const [endpoint, count] of top) {
        console.log(`  - (${count}) ${endpoint}`);
      }
    }

    if (Array.isArray(summary.responseCandidates) && summary.responseCandidates.length > 0) {
      console.log('  Candidate endpoints by response keys:');
      for (const c of summary.responseCandidates.slice(0, 10)) {
        console.log(`  - hits=${c.responseKeyHits} ${c.method} ${c.shortPath} [${c.status}]`);
      }
    }

    if (requestLogs.length === 0) {
      console.log('  Warning: no candidate requests captured. Retry with --all-arcadia --all-xhr and navigate account pages.');
    }

    if (closeBrowser) {
      try {
        await browser.close();
      } catch (_) {
        // noop
      }
    }

    process.exit(exitCode);
  };

  process.once('SIGINT', async () => {
    console.log('\nSIGINT detected. Saving partial capture...');
    await finalize({ reason: 'interrupted', closeBrowser: true, exitCode: 130 });
  });

  process.once('SIGTERM', async () => {
    console.log('\nSIGTERM detected. Saving partial capture...');
    await finalize({ reason: 'interrupted', closeBrowser: true, exitCode: 143 });
  });

  browser.on('disconnected', async () => {
    if (!waitUntilClose || finalized) return;
    await finalize({ reason: 'browser-closed', closeBrowser: false, exitCode: 0 });
  });

  await page.setUserAgent(
    process.env.PINNACLE_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': process.env.PINNACLE_ACCEPT_LANGUAGE || 'es-ES,es;q=0.9,en;q=0.8'
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.on('request', async (request) => {
    try {
      const method = request.method();
      const url = request.url();
      const resourceType = request.resourceType();
      const postData = request.postData() || null;
      const reasons = shouldCaptureRequest({ method, url, resourceType, postData });
      if (!reasons) return;

      const id = ++seq;
      const entry = {
        id,
        ts: new Date().toISOString(),
        method,
        url,
        shortPath: toShortPath(url),
        resourceType,
        matchedBy: reasons,
        request: {
          headers: sanitizeHeaders(request.headers()),
          bodyRaw: sanitizeBodyText(postData),
          bodyJson: parseJsonIfPossible(postData),
          bodyForm: parseFormIfPossible(postData)
        },
        response: null
      };

      requestLogs.push(entry);
      requestMap.set(request, entry);

      console.log(`Captured #${id}: ${method} ${entry.shortPath}`);
    } catch (_) {
      // noop
    }
  });

  page.on('response', async (response) => {
    try {
      const req = response.request();
      const entry = requestMap.get(req);
      if (!entry) return;

      let responseBody = null;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }

      entry.response = {
        ts: new Date().toISOString(),
        status: response.status(),
        headers: sanitizeHeaders(response.headers() || {}),
        bodyRaw: sanitizeBodyText(responseBody),
        bodyJson: parseJsonIfPossible(responseBody)
      };
    } catch (_) {
      // noop
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
  } catch (error) {
    console.warn(`Navigation warning: ${error.message}`);
  }

  console.log('Action suggested: open account/inbox/bets/deposit pages to force balance-related requests.');

  if (waitUntilClose) {
    console.log('Waiting for manual browser close to finish capture.');
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, captureMs));
  await finalize({ reason: 'timeout', closeBrowser: true, exitCode: 0 });
};

run().catch((error) => {
  console.error(`Capture error: ${error.message}`);
  process.exit(1);
});
