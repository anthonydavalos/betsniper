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
const tryAutoLogin = !args.includes('--no-login');
const useSystemChrome = !args.includes('--no-system-chrome');
const captureMsArg = args.find(a => a.startsWith('--capture-ms='));
const requiredProfileArg = args.find(a => a.startsWith('--require-profile='));
const requiredProfile = (requiredProfileArg?.split('=')[1] || '').toLowerCase();
const captureMs = Number(captureMsArg?.split('=')[1] || process.env.BOOKY_CAPTURE_MS || 120000);

const targetUrl = process.env.ALTENAR_BOOKY_URL || 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview';
const username = process.env.ALTENAR_LOGIN_USERNAME || '';
const password = process.env.ALTENAR_LOGIN_PASSWORD || '';
const bookProfile = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
const profileDir = path.join(outputDir, `chrome-profile-${bookProfile}`);

const interestingUrlKeywords = [
  'betslip', 'quickbet', 'easybet', 'placebet', 'bet', 'coupon', 'ticket', 'wager', 'stake', 'submit', 'cashout'
];

const interestingBodyKeywords = [
  'stake', 'amount', 'odd', 'price', 'selection', 'eventid', 'market', 'ticket', 'coupon', 'bet'
];

const sanitizeHeaders = (headers = {}) => {
  const redacted = { ...headers };
  const secretKeys = ['authorization', 'cookie', 'set-cookie', 'x-auth-token', 'token'];

  Object.keys(redacted).forEach((key) => {
    const lower = key.toLowerCase();
    if (secretKeys.includes(lower)) {
      redacted[key] = '[REDACTED]';
    }
  });

  return redacted;
};

const sanitizeBody = (raw = '') => {
  if (!raw) return raw;
  let out = String(raw);

  if (password) {
    out = out.split(password).join('[REDACTED_PASSWORD]');
  }
  if (username) {
    out = out.split(username).join('[REDACTED_USERNAME]');
  }

  return out;
};

const buildSummary = (captured = [], captureMsValue = captureMs) => ({
  generatedAt: new Date().toISOString(),
  bookProfile,
  targetUrl,
  captureMs: captureMsValue,
  totalCaptured: captured.length,
  captures: captured
});

const saveCaptureSummary = (summary) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `capture-${bookProfile}-${stamp}.json`;
  const filePath = path.join(outputDir, fileName);
  const latestPath = path.join(outputDir, `capture-${bookProfile}.latest.json`);

  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2), 'utf8');

  return { filePath, latestPath };
};

const toJsonIfPossible = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const isInterestingRequest = ({ url, method, postData }) => {
  const lowUrl = String(url || '').toLowerCase();
  const lowBody = String(postData || '').toLowerCase();

  const urlHit = interestingUrlKeywords.some(k => lowUrl.includes(k));
  const bodyHit = interestingBodyKeywords.some(k => lowBody.includes(k));

  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    return false;
  }

  return urlHit || bodyHit;
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const firstSelector = async (page, selectors = []) => {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) return selector;
  }
  return null;
};

const tryLogin = async (page) => {
  if (!username || !password) {
    console.log('ℹ️ ALTENAR_LOGIN_USERNAME/ALTENAR_LOGIN_PASSWORD no definidos. Login automático omitido.');
    return false;
  }

  const isAcity = bookProfile === 'acity';
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
    'button[class*="signin"]',
    '[role="button"][id*="login"]'
  ];

  try {
    await page.waitForTimeout?.(1000);

    const alreadyLoggedIn = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').toLowerCase();
      const hasMyBets = bodyText.includes('mis apuestas');
      const hasDeposit = bodyText.includes('depositar');
      return hasMyBets && hasDeposit;
    }).catch(() => false);

    if (alreadyLoggedIn) {
      console.log('✅ Sesión ya autenticada en ACity (MIS APUESTAS + DEPOSITAR detectado). Se omite login.');
      return true;
    }

    if (isAcity) {
      const triggerSelector = await firstSelector(page, loginTriggerSelectors);
      if (triggerSelector) {
        try {
          const triggerHandle = await page.$(triggerSelector);
          const canClick = triggerHandle
            ? await page.evaluate((el) => {
                const txt = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
                return txt.includes('ingresar') || txt.includes('iniciar sesi') || txt.includes('login');
              }, triggerHandle)
            : false;
          if (canClick) {
            await page.click(triggerSelector);
            await page.waitForTimeout?.(450);
          }
        } catch (_) {}
      }
    }

    const userSelector = await firstSelector(page, userSelectors);
    const passSelector = await firstSelector(page, passSelectors);

    if (!userSelector || !passSelector) {
      console.log('ℹ️ No se detectó formulario clásico de login. Continúa login manual si hace falta.');
      return false;
    }

    await page.click(userSelector, { clickCount: 3 });
    await page.type(userSelector, username, { delay: 35 });

    await page.click(passSelector, { clickCount: 3 });
    await page.type(passSelector, password, { delay: 35 });

    const submitSelector = await firstSelector(page, submitSelectors);
    if (submitSelector) {
      const clicked = await page.$eval(submitSelector, (el) => {
        const txt = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
        if (txt.includes('mostrar')) return false;
        el.click();
        return true;
      }).catch(() => false);
      if (clicked) {
        console.log('🔐 Login automático enviado. Si hay captcha/2FA, complétalo manualmente en la ventana.');
        return true;
      }
    }

    const submittedByForm = await page.$eval(passSelector, (el) => {
      const form = el?.form || el?.closest?.('form');
      if (!form) return false;

      const buttons = Array.from(form.querySelectorAll('button, [role="button"]'));
      const submitBtn = buttons.find((btn) => {
        const txt = String(btn?.innerText || btn?.textContent || '').trim().toLowerCase();
        if (!txt || txt.includes('mostrar')) return false;
        if (txt.includes('iniciar sesi') || txt.includes('ingresar') || txt.includes('login') || txt.includes('sign in')) return true;
        return btn?.type === 'submit';
      });

      if (submitBtn) {
        submitBtn.click();
        return true;
      }

      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return true;
      }

      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }).catch(() => false);

    if (submittedByForm) {
      console.log('🔐 Login automático enviado por formulario.');
      return true;
    }

    await page.keyboard.press('Enter');
    console.log('🔐 Login automático enviado con Enter.');
    return true;
  } catch (error) {
    console.warn(`⚠️ Login automático parcial/fallido: ${error.message}`);
    return false;
  }
};

const run = async () => {
  if (requiredProfile && bookProfile !== requiredProfile) {
    console.error(`❌ Perfil inválido para captura. Requerido: ${requiredProfile} | Actual: ${bookProfile}`);
    console.error(`   Ejecuta: npm run book:${requiredProfile === 'acity' ? 'acity' : 'dorado'} y vuelve a intentar.`);
    process.exit(1);
  }

  ensureDir(outputDir);

  console.log('🕵️ Captura Altenar Betslip iniciando...');
  console.log(`   BOOK_PROFILE=${bookProfile}`);
  console.log(`   URL=${targetUrl}`);
  console.log(`   Modo=${headless ? 'headless' : 'headed'}`);
  console.log(`   Navegador=${useSystemChrome ? 'chrome-channel' : 'bundled-chromium'}`);
  console.log(`   Ventana de captura=${captureMs}ms`);

  ensureDir(profileDir);

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
  const captured = [];
  let finalized = false;

  const finalizeAndSave = async (reason = 'normal') => {
    if (finalized) return;
    finalized = true;

    const summary = buildSummary(captured);
    const { filePath, latestPath } = saveCaptureSummary(summary);

    console.log(`\n✅ Captura ${reason === 'normal' ? 'completada' : 'guardada (interrumpida)'} .`);
    console.log(`   Archivo: ${filePath}`);
    console.log(`   Latest:  ${latestPath}`);

    if (captured.length === 0) {
      console.log('⚠️ No se detectaron payloads candidatos. Repite en modo headed y realiza flujo completo de betslip.');
    }

    try {
      await browser.close();
    } catch (_) {}
  };

  process.once('SIGINT', async () => {
    console.log('\n⛔ SIGINT detectado, guardando captura parcial...');
    await finalizeAndSave('interrupted');
    process.exit(130);
  });

  process.once('SIGTERM', async () => {
    console.log('\n⛔ SIGTERM detectado, guardando captura parcial...');
    await finalizeAndSave('interrupted');
    process.exit(143);
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

  page.on('request', (request) => {
    try {
      const entry = {
        ts: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        headers: sanitizeHeaders(request.headers()),
        postData: sanitizeBody(request.postData() || '')
      };

      if (!['xhr', 'fetch'].includes(entry.resourceType)) return;
      if (!isInterestingRequest(entry)) return;

      const parsed = toJsonIfPossible(entry.postData);
      entry.postDataJson = parsed;

      captured.push(entry);
      console.log(`📌 Capturado #${captured.length}: ${entry.method} ${entry.url}`);
    } catch (_) {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
  } catch (error) {
    console.warn(`⚠️ Navegación con timeout: ${error.message}`);
  }

  if (tryAutoLogin) {
    await tryLogin(page);
  }

  // Intento suave de cerrar overlays/cookies que bloquean betslip
  const overlaySelectors = [
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[id*="cookie"]',
    'button[class*="cookie"]',
    '[aria-label*="close"]',
    '[aria-label*="cerrar"]'
  ];
  for (const selector of overlaySelectors) {
    try {
      const el = await page.$(selector);
      if (el) await el.click();
    } catch (_) {}
  }

  console.log('🧭 Acción requerida: abre un mercado, agrega selección al betslip, ingresa stake y presiona "apostar" (o último paso antes de confirmar).');
  console.log('   El script seguirá capturando payloads de requests relevantes...');

  await new Promise(resolve => setTimeout(resolve, captureMs));

  await finalizeAndSave('normal');
};

run().catch(async (error) => {
  console.error(`❌ Error en captura Altenar Betslip: ${error.message}`);
  process.exit(1);
});
