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
const timeoutArg = args.find(a => a.startsWith('--capture-ms='));
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitArg = args.includes('--no-wait-close');
const rawCaptureMs = Number(timeoutArg?.split('=')[1] || process.env.BOOKY_SPY_CAPTURE_MS || 120000);
const waitUntilClose = explicitNoWaitArg ? false : (waitCloseArg || (!headless && !timeoutArg));
const captureMs = waitUntilClose ? 0 : (rawCaptureMs > 0 ? rawCaptureMs : 120000);

const bookProfile = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
const requiredProfileArg = args.find(a => a.startsWith('--require-profile='));
const requiredProfile = (requiredProfileArg?.split('=')[1] || '').toLowerCase();

const targetArg = args.find(a => a.startsWith('--url='));
const targetUrl = targetArg?.split('=')[1]
  || process.env.ALTENAR_BOOKY_URL
  || (bookProfile === 'acity'
    ? 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview'
    : 'https://doradobet.com/deportes-en-vivo');

const profileDir = path.join(outputDir, `chrome-profile-${bookProfile}`);
const useSystemChrome = !args.includes('--no-system-chrome');

const RESPONSE_BODY_MAX_CHARS = Number(process.env.BOOKY_SPY_MAX_BODY_CHARS || 18000);

const watchedKeywords = [
  'WidgetReports/widgetBetHistory',
  'WidgetReports/widgetExpandedBetHistory',
  'WidgetReports/widgetPendingBets',
  'WidgetReports/GetBetsCountWithEvents',
  'WidgetReports/WidgetGetBetDetails',
  'WidgetReports/WidgetGetArchBetDetails',
  'WidgetResults/GetEventResults',
  'WidgetResults/GetSportMenu',
  'WidgetPlatform/getOwnBalance',
  'WidgetPlatform/getBalance'
].map(x => x.toLowerCase());

const sanitizeHeaders = (headers = {}) => {
  const redacted = { ...headers };
  const secretKeys = ['authorization', 'cookie', 'set-cookie', 'x-auth-token', 'token'];

  Object.keys(redacted).forEach((key) => {
    const lower = String(key).toLowerCase();
    if (secretKeys.includes(lower)) {
      redacted[key] = '[REDACTED]';
    }
  });

  return redacted;
};

const sanitizeBodyText = (raw = '') => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (text.length <= RESPONSE_BODY_MAX_CHARS) return text;
  return `${text.slice(0, RESPONSE_BODY_MAX_CHARS)} ...[TRUNCATED ${text.length - RESPONSE_BODY_MAX_CHARS} chars]`;
};

const parseJsonIfPossible = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const buildCaptureSummary = ({ requestLogs, startedAt }) => ({
  generatedAt: new Date().toISOString(),
  startedAt,
  bookProfile,
  targetUrl,
  waitUntilClose,
  captureMs,
  totalCaptured: requestLogs.length,
  watchedKeywords,
  captures: requestLogs
});

const saveSummary = (summary) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `spy-history-${bookProfile}-${stamp}.json`;
  const filePath = path.join(outputDir, fileName);
  const latestPath = path.join(outputDir, `spy-history-${bookProfile}.latest.json`);

  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2), 'utf8');

  return { filePath, latestPath };
};

const hasWatchedKeyword = (url = '') => {
  const low = String(url).toLowerCase();
  return watchedKeywords.some(k => low.includes(k));
};

const isRelevantApiRequest = (url = '') => {
  const low = String(url).toLowerCase();
  if (!low.includes('biahosted.com/api/')) return false;
  return hasWatchedKeyword(low) || low.includes('/widgetreports/') || low.includes('/widgetresults/') || low.includes('/widgetplatform/');
};

const toShortPath = (url = '') => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

const run = async () => {
  if (requiredProfile && requiredProfile !== bookProfile) {
    console.error(`❌ Perfil inválido. Requerido=${requiredProfile} | Actual=${bookProfile}`);
    process.exit(1);
  }

  ensureDir(outputDir);
  ensureDir(profileDir);

  console.log('🕵️ Spy Booky History iniciando...');
  console.log(`   BOOK_PROFILE=${bookProfile}`);
  console.log(`   URL=${targetUrl}`);
  console.log(`   Modo=${headless ? 'headless' : 'headed'}`);
  console.log(`   Estrategia=${waitUntilClose ? 'esperar cierre manual del navegador' : `timeout ${captureMs}ms`}`);

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

  const finalize = async (reason = 'normal') => {
    if (finalized) return;
    finalized = true;

    const summary = buildCaptureSummary({ requestLogs, startedAt });
    const { filePath, latestPath } = saveSummary(summary);

    console.log(`\n✅ Spy finalizado (${reason}).`);
    console.log(`   Capturas: ${requestLogs.length}`);
    console.log(`   Archivo:  ${filePath}`);
    console.log(`   Latest:   ${latestPath}`);

    const grouped = requestLogs.reduce((acc, item) => {
      const key = item.shortPath;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const top = Object.entries(grouped)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    if (top.length > 0) {
      console.log('   Endpoints relevantes detectados:');
      for (const [ep, count] of top) {
        console.log(`   - (${count}) ${ep}`);
      }
    }

    try {
      await browser.close();
    } catch (_) {}
  };

  process.once('SIGINT', async () => {
    console.log('\n⛔ SIGINT detectado. Guardando captura parcial...');
    await finalize('interrupted');
    process.exit(130);
  });

  process.once('SIGTERM', async () => {
    console.log('\n⛔ SIGTERM detectado. Guardando captura parcial...');
    await finalize('interrupted');
    process.exit(143);
  });

  page.on('request', async (request) => {
    try {
      const url = request.url();
      if (!isRelevantApiRequest(url)) return;

      const id = ++seq;
      const postData = request.postData() || null;
      const entry = {
        id,
        ts: new Date().toISOString(),
        method: request.method(),
        url,
        shortPath: toShortPath(url),
        watched: hasWatchedKeyword(url),
        resourceType: request.resourceType(),
        request: {
          headers: sanitizeHeaders(request.headers()),
          bodyRaw: sanitizeBodyText(postData),
          bodyJson: parseJsonIfPossible(postData)
        },
        response: null
      };

      requestLogs.push(entry);
      requestMap.set(request, entry);
      console.log(`📌 #${id} ${entry.method} ${entry.shortPath}`);
    } catch (_) {}
  });

  page.on('response', async (response) => {
    try {
      const req = response.request();
      const entry = requestMap.get(req);
      if (!entry) return;

      let bodyText = null;
      try {
        bodyText = await response.text();
      } catch (_) {
        bodyText = null;
      }

      entry.response = {
        status: response.status(),
        ok: response.ok(),
        headers: sanitizeHeaders(response.headers()),
        bodyRaw: sanitizeBodyText(bodyText),
        bodyJson: parseJsonIfPossible(bodyText)
      };
    } catch (_) {}
  });

  await page.setUserAgent(
    process.env.ALTENAR_USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': process.env.ALTENAR_ACCEPT_LANGUAGE || 'es-ES,es;q=0.9,en;q=0.8'
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
  } catch (err) {
    console.warn(`⚠️ Navegación con timeout (${err.message}). Continuando...`);
  }

  console.log('🧭 Acción recomendada: abre Bet History, Pending Bets, Event Results y Bet Details para capturar payloads reales.');

  if (waitUntilClose) {
    browser.on('disconnected', async () => {
      await finalize('browser-closed');
      process.exit(0);
    });
    return;
  }

  setTimeout(async () => {
    await finalize('timeout');
    process.exit(0);
  }, captureMs);
};

run().catch(async (error) => {
  console.error(`❌ Error en spy-booky-history: ${error.message}`);
  process.exit(1);
});
