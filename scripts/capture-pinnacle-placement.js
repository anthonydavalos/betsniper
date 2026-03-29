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
const includeAllPosts = args.includes('--all-posts');
const useSystemChrome = !args.includes('--no-system-chrome');

const rawCaptureMs = Number(captureMsArg?.split('=')[1] || process.env.PINNACLE_CAPTURE_MS || 180000);
const waitUntilClose = explicitNoWaitArg ? false : (waitCloseArg || (!headless && !captureMsArg));
const captureMs = waitUntilClose ? 0 : (rawCaptureMs > 0 ? rawCaptureMs : 180000);
const maxBodyChars = Number(maxBodyArg?.split('=')[1] || process.env.PINNACLE_CAPTURE_MAX_BODY_CHARS || 24000);

const targetUrl =
  urlArg?.split('=').slice(1).join('=')
  || process.env.PINNACLE_CAPTURE_URL
  || 'https://www.pinnacle.com/es/soccer/matchups/live/';

const DEFAULT_PINNACLE_PROFILE_DIR = path.join(projectRoot, 'data', 'pinnacle', 'chrome-profile');
const profileDir = process.env.PINNACLE_CHROME_PROFILE_DIR
  ? (path.isAbsolute(process.env.PINNACLE_CHROME_PROFILE_DIR)
    ? process.env.PINNACLE_CHROME_PROFILE_DIR
    : path.join(projectRoot, process.env.PINNACLE_CHROME_PROFILE_DIR))
  : DEFAULT_PINNACLE_PROFILE_DIR;

const watchedUrlKeywords = [
  'place',
  'wager',
  'bet',
  'betslip',
  'slip',
  'stake',
  'ticket',
  'coupon',
  'checkout',
  'quickbet',
  'acceptprice',
  'confirm'
];

const watchedBodyKeywords = [
  'stake',
  'amount',
  'lineid',
  'selection',
  'selectionid',
  'matchupid',
  'market',
  'price',
  'odds',
  'risk',
  'win',
  'ticket',
  'wager'
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
  return `${parsed.origin}${parsed.pathname}`;
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
  if (includeAllPosts && isArcadiaApiRequest(url)) reasons.push('all-posts-arcadia');

  return reasons;
};

const shouldCaptureRequest = ({ method = '', url = '', resourceType = '', postData = '' }) => {
  const methodUp = String(method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(methodUp)) return null;
  if (!isPinnacleHost(url)) return null;
  if (!['xhr', 'fetch'].includes(String(resourceType || '').toLowerCase())) return null;

  const reasons = getCandidateReasons({ url, postData });
  if (reasons.length === 0) return null;

  return reasons;
};

const buildSummary = ({ requestLogs, startedAt }) => ({
  generatedAt: new Date().toISOString(),
  startedAt,
  targetUrl,
  profileDir,
  headless,
  waitUntilClose,
  includeAllPosts,
  captureMs,
  maxBodyChars,
  watchedUrlKeywords,
  watchedBodyKeywords,
  totalCaptured: requestLogs.length,
  captures: requestLogs
});

const saveSummary = (summary) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `capture-placement-${stamp}.json`);
  const latestPath = path.join(outputDir, 'capture-placement.latest.json');

  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2), 'utf8');

  return { filePath, latestPath };
};

const run = async () => {
  ensureDir(outputDir);
  ensureDir(profileDir);

  console.log('Starting Pinnacle placement capture...');
  console.log(`  URL=${targetUrl}`);
  console.log(`  Profile=${profileDir}`);
  console.log(`  Mode=${headless ? 'headless' : 'headed'}`);
  console.log(`  Strategy=${waitUntilClose ? 'wait-close' : `timeout ${captureMs}ms`}`);
  console.log(`  Filter=${includeAllPosts ? 'all-posts on arcadia' : 'placement-keywords'}`);

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

    const byEndpoint = requestLogs.reduce((acc, item) => {
      const key = item.shortPath;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const top = Object.entries(byEndpoint)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (top.length > 0) {
      console.log('  Top endpoints:');
      for (const [endpoint, count] of top) {
        console.log(`  - (${count}) ${endpoint}`);
      }
    }

    if (requestLogs.length === 0) {
      console.log('  Warning: no candidate requests captured. Retry with --all-posts and perform full betslip flow.');
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

  console.log('Action required: open event, add selection, set stake, and click the final place/confirm button.');

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
