import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const outputDir = path.join(projectRoot, 'data', 'booky');

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const timeoutMsArg = args.find(a => a.startsWith('--timeout='));
const captureMsArg = args.find(a => a.startsWith('--capture-ms='));
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitCloseArg = args.includes('--no-wait-close');
const rawTimeoutMs = Number(timeoutMsArg?.split('=')[1] || captureMsArg?.split('=')[1] || 0);
const waitUntilClose = explicitNoWaitCloseArg
  ? false
  : (waitCloseArg || (!headless && !timeoutMsArg && !captureMsArg));
const timeoutMs = waitUntilClose ? 0 : (rawTimeoutMs > 0 ? rawTimeoutMs : 45000);
const useSystemChrome = !args.includes('--no-system-chrome');

const bookProfile = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
const requiredProfileArg = args.find(a => a.startsWith('--require-profile='));
const requiredProfile = (requiredProfileArg?.split('=')[1] || '').toLowerCase();

const targetUrl = process.env.ALTENAR_BOOKY_URL ||
  (bookProfile === 'acity'
    ? 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview'
    : 'https://doradobet.com/deportes-en-vivo');

const profileDir = path.join(outputDir, `chrome-profile-${bookProfile}`);
const keepRealPlacementEnabled = String(process.env.BOOKY_KEEP_REAL_PLACEMENT_ON_TOKEN_REFRESH || '').toLowerCase() === 'true';
const username = process.env.ALTENAR_LOGIN_USERNAME || '';
const password = process.env.ALTENAR_LOGIN_PASSWORD || '';

const firstSelector = async (page, selectors = []) => {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) return selector;
  }
  return null;
};

const tryAutoLogin = async (page) => {
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

const upsertEnvKey = (content, key, value) => {
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  const line = `${key}=${value}`;

  if (idx >= 0) lines[idx] = line;
  else lines.push(line);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
};

const normalizeAuthToken = (value = '') => {
  const token = String(value).trim();
  if (!token) return '';
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
};

const decodeJwtPayload = (token = '') => {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_) {
    return null;
  }
};

const isAuthenticatedJwt = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const personId = String(payload.PersonId || '').trim();
  const loginId = String(payload.LoginId || '').trim();
  const userName = String(payload.UserName || '').trim();
  if (!personId || !loginId || !userName) return false;
  const lowUser = userName.toLowerCase();
  if (lowUser === 'guest' || lowUser.includes('invitado')) return false;
  return true;
};

const isAltenarApiRequest = (url = '') => {
  const low = String(url).toLowerCase();
  return low.includes('biahosted.com/api/') || low.includes('/api/widget/');
};

// Función para enviar el token a Google Sheets por medio del Webhook
const syncTokenToGoogleSheets = async (nuevoToken) => {
  const WEBHOOK_URL = process.env.GSHEETS_TOKEN_WEBHOOK_URL || '';

  if (!WEBHOOK_URL) return;

  try {
    if (typeof fetch !== 'function') {
      console.warn('   ⚠️ fetch no está disponible en esta versión de Node. Se omite sync con Google Sheets.');
      return;
    }

    console.log('   Sincronizando token con Google Sheets...');
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: nuevoToken })
    });

    const result = await response.json().catch(() => ({}));
    if (result?.success) {
      console.log('   ✅ Google Sheets Token Actualizado!');
    } else {
      console.log(`   ⚠️ Error al actualizar Sheets: ${result?.message || `HTTP ${response.status}`}`);
    }
  } catch (error) {
    console.error(`   ❌ Falló la conexión con el Webhook de Google Sheets: ${error.message}`);
  }
};

const run = async () => {
  if (requiredProfile && bookProfile !== requiredProfile) {
    console.error(`❌ Perfil inválido. Requerido=${requiredProfile} Actual=${bookProfile}`);
    process.exit(1);
  }

  if (!fs.existsSync(envPath)) {
    console.error('❌ No se encontró .env en la raíz del proyecto.');
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  console.log('🔑 Extracción de token Altenar iniciando...');
  console.log(`   BOOK_PROFILE=${bookProfile}`);
  console.log(`   URL=${targetUrl}`);
  console.log(`   Modo=${headless ? 'headless' : 'headed'}`);
  console.log(`   Estrategia=${waitUntilClose ? 'esperar cierre manual del navegador' : `timeout ${timeoutMs}ms`}`);
  console.log(`   BOOKY_KEEP_REAL_PLACEMENT_ON_TOKEN_REFRESH=${keepRealPlacementEnabled}`);

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

  let foundAuth = '';
  let skippedNonUserTokens = 0;
  let settled = false;

  const finish = async (ok, message) => {
    if (settled) return;
    settled = true;

    try { await browser.close(); } catch (_) {}

    if (!ok) {
      console.error(`❌ ${message}`);
      process.exit(1);
    }

    console.log(`✅ ${message}`);
    process.exit(0);
  };

  page.on('request', async (request) => {
    if (settled) return;

    try {
      const url = request.url();
      if (!isAltenarApiRequest(url)) return;

      const headers = request.headers();
      const authRaw = headers.authorization || headers.Authorization;
      const auth = normalizeAuthToken(authRaw);
      if (!auth) return;

      const rawToken = auth.replace(/^Bearer\s+/i, '').trim();
      const payload = decodeJwtPayload(rawToken);
      const isUserToken = isAuthenticatedJwt(payload);
      if (!isUserToken) {
        skippedNonUserTokens += 1;
        return;
      }

      foundAuth = auth;

      const currentEnv = fs.readFileSync(envPath, 'utf8');
      let nextEnv = upsertEnvKey(currentEnv, 'ALTENAR_BOOKY_AUTH_TOKEN', foundAuth);
      if (!keepRealPlacementEnabled) {
        nextEnv = upsertEnvKey(nextEnv, 'BOOKY_REAL_PLACEMENT_ENABLED', 'false');
      }
      fs.writeFileSync(envPath, nextEnv, 'utf8');

      // Sincronizar el nuevo token con Google Sheets automáticamente
      await syncTokenToGoogleSheets(foundAuth);

      await finish(true, 'Token capturado y guardado en .env (ALTENAR_BOOKY_AUTH_TOKEN).');
    } catch (_) {}
  });

  browser.on('disconnected', async () => {
    if (settled) return;
    if (foundAuth) {
      await finish(true, 'Token capturado y guardado en .env (ALTENAR_BOOKY_AUTH_TOKEN).');
      return;
    }
    if (skippedNonUserTokens > 0) {
      await finish(false, `Se detectaron ${skippedNonUserTokens} token(es) no autenticados/guest. Inicia sesión con tu usuario antes de cerrar.`);
      return;
    }
    await finish(false, 'Navegador cerrado sin detectar token Authorization. Inicia sesión y navega en sportsbook antes de cerrar.');
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
  } catch (_) {}

  await tryAutoLogin(page);

  console.log('   Esperando request Altenar con Authorization...');

  if (waitUntilClose) {
    console.log('   Puedes tomarte el tiempo que necesites. El script terminará cuando cierres el navegador.');
    return;
  }

  setTimeout(async () => {
    if (!foundAuth) {
      await finish(false, 'No se detectó Authorization en el tiempo esperado. Usa --wait-close para esperar al cierre manual.');
    }
  }, timeoutMs);
};

run().catch((error) => {
  console.error(`❌ Error extrayendo token: ${error.message}`);
  process.exit(1);
});
