import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--url='));
const targetUrl = targetArg
  ? targetArg.replace('--url=', '')
  : 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview';

const headless = !args.includes('--headed');
const timeoutMs = Number((args.find(a => a.startsWith('--timeout=')) || '--timeout=25000').split('=')[1]);
const showAllHeaders = args.includes('--all-headers');
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitCloseArg = args.includes('--no-wait-close');
const waitUntilClose = explicitNoWaitCloseArg ? false : (waitCloseArg || !headless);
const logSockets = !args.includes('--no-sockets');

const profile = {
  referer: '',
  origin: '',
  integration: '',
  countryCode: '',
  culture: '',
  timezoneOffset: '',
  numFormat: '',
  deviceType: '',
  sportId: '',
  widgetBaseUrl: ''
};

const asUrl = (raw) => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const fillProfileFromRequest = (request) => {
  const url = request.url();
  const parsed = asUrl(url);
  if (!parsed) return;

  if (url.includes('/api/widget/')) {
    profile.widgetBaseUrl = `${parsed.origin}/api/widget`;
  }

  const keys = [
    'integration',
    'countryCode',
    'culture',
    'timezoneOffset',
    'numFormat',
    'deviceType',
    'sportId'
  ];

  for (const key of keys) {
    const val = parsed.searchParams.get(key);
    if (val && !profile[key]) profile[key] = val;
  }

  const headers = request.headers();
  if (headers.referer && !profile.referer) profile.referer = headers.referer;
  if (headers.origin && !profile.origin) profile.origin = headers.origin;
};

const logRequestIfAltenar = (request) => {
  const url = request.url();
  if (!url.includes('/api/widget/')) return;

  fillProfileFromRequest(request);
  const parsed = asUrl(url);
  if (!parsed) return;

  const interestingParams = {};
  [
    'integration', 'countryCode', 'culture', 'timezoneOffset',
    'numFormat', 'deviceType', 'sportId', 'eventId', 'categoryId'
  ].forEach(k => {
    const v = parsed.searchParams.get(k);
    if (v !== null) interestingParams[k] = v;
  });

  console.log(`\n📡 ${request.method()} ${parsed.pathname}`);
  console.log(`   Host: ${parsed.origin}`);
  console.log(`   Params: ${JSON.stringify(interestingParams)}`);

  const headers = request.headers();
  const headerSnapshot = showAllHeaders
    ? headers
    : {
        origin: headers.origin,
        referer: headers.referer,
        'user-agent': headers['user-agent'],
        cookie: headers.cookie ? '[present]' : '[absent]',
        authorization: headers.authorization ? '[present]' : '[absent]',
        'accept-language': headers['accept-language'],
        'sec-fetch-site': headers['sec-fetch-site'],
        'sec-fetch-mode': headers['sec-fetch-mode']
      };
  console.log(`   Headers: ${JSON.stringify(headerSnapshot)}`);
};

const logResponseIfAltenar = async (response) => {
  const url = response.url();
  if (!url.includes('/api/widget/')) return;
  const parsed = asUrl(url);
  if (!parsed) return;
  const status = response.status();

  if (status >= 400) {
    const headers = response.headers() || {};
    const headerSnapshot = {
      'www-authenticate': headers['www-authenticate'] || '',
      'set-cookie': headers['set-cookie'] ? '[present]' : '[absent]',
      server: headers.server || '',
      'cf-ray': headers['cf-ray'] || '',
      'x-cache': headers['x-cache'] || ''
    };
    console.log(`   ↩️ Response ${status} ${parsed.pathname} headers=${JSON.stringify(headerSnapshot)}`);
    return;
  }

  if (status >= 400 || parsed.pathname.includes('GetLivenow')) {
    console.log(`   ↩️ Response ${status} ${parsed.pathname}`);
  }
};

const printEnvSuggestion = () => {
  console.log('\n================ PERFIL ALTENAR DETECTADO ================');
  console.log(`TARGET_URL=${targetUrl}`);
  if (profile.widgetBaseUrl) console.log(`ALTENAR_WIDGET_BASE_URL=${profile.widgetBaseUrl}`);
  if (profile.referer) console.log(`ALTENAR_REFERER=${profile.referer}`);
  if (profile.origin) console.log(`ALTENAR_ORIGIN=${profile.origin}`);
  if (profile.integration) console.log(`ALTENAR_INTEGRATION=${profile.integration}`);
  if (profile.countryCode) console.log(`ALTENAR_COUNTRY_CODE=${profile.countryCode}`);
  if (profile.culture) console.log(`ALTENAR_CULTURE=${profile.culture}`);
  if (profile.timezoneOffset) console.log(`ALTENAR_TIMEZONE_OFFSET=${profile.timezoneOffset}`);
  if (profile.numFormat) console.log(`ALTENAR_NUM_FORMAT=${profile.numFormat}`);
  if (profile.deviceType) console.log(`ALTENAR_DEVICE_TYPE=${profile.deviceType}`);
  if (profile.sportId) console.log(`ALTENAR_SPORT_ID=${profile.sportId}`);
  console.log('===========================================================\n');
};

const attachSocketSpy = async (page) => {
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');

  cdp.on('Network.webSocketCreated', (evt) => {
    const url = evt?.url || '';
    if (!url) return;
    console.log(`\n🧵 WS Created: ${url}`);
  });

  cdp.on('Network.webSocketWillSendHandshakeRequest', (evt) => {
    const req = evt?.request || {};
    const headers = req?.headers || {};
    const url = req?.url || '';
    if (!url) return;
    console.log(`   🧵 WS Handshake Request: ${url}`);
    console.log(`   🧵 WS Req Headers: ${JSON.stringify({
      origin: headers.Origin || headers.origin,
      host: headers.Host || headers.host,
      'user-agent': headers['User-Agent'] || headers['user-agent'],
      cookie: headers.Cookie || headers.cookie ? '[present]' : '[absent]',
      authorization: headers.Authorization || headers.authorization ? '[present]' : '[absent]'
    })}`);
  });

  cdp.on('Network.webSocketHandshakeResponseReceived', (evt) => {
    const res = evt?.response || {};
    const headers = res?.headers || {};
    console.log(`   🧵 WS Handshake Response: status=${res?.status}`);
    console.log(`   🧵 WS Res Headers: ${JSON.stringify({
      server: headers.server || headers.Server,
      'set-cookie': headers['set-cookie'] || headers['Set-Cookie'] ? '[present]' : '[absent]',
      'cf-ray': headers['cf-ray'] || headers['CF-RAY'] || ''
    })}`);
  });

  cdp.on('Network.webSocketClosed', (evt) => {
    console.log(`   🧵 WS Closed requestId=${evt?.requestId || ''}`);
  });

  cdp.on('Network.webSocketFrameError', (evt) => {
    console.log(`   🧵 WS Frame Error requestId=${evt?.requestId || ''} msg=${evt?.errorMessage || ''}`);
  });
};

const run = async () => {
  console.log(`🕵️ Spy Altenar iniciando en: ${targetUrl}`);
  console.log(`   Modo: ${headless ? 'headless' : 'headed'}`);
  console.log(`   Estrategia: ${waitUntilClose ? 'esperar cierre manual del navegador' : `timeout ${timeoutMs}ms`}`);

  const browser = await puppeteer.launch({
    headless,
    defaultViewport: { width: 1440, height: 900 }
  });

  try {
    const page = await browser.newPage();

    if (logSockets) {
      try {
        await attachSocketSpy(page);
      } catch (error) {
        console.warn(`⚠️ No se pudo habilitar socket-spy CDP: ${error.message}`);
      }
    }

    page.on('request', (req) => {
      try {
        logRequestIfAltenar(req);
      } catch (_) {}
    });

    page.on('response', (res) => {
      try {
        logResponseIfAltenar(res);
      } catch (_) {}
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    } catch (err) {
      console.warn(`⚠️ Navegación con timeout (${err.message}). Continuando con datos capturados...`);
    }

    if (waitUntilClose) {
      console.log('   Completa login/navegación manual en la ventana. El spy finalizará cuando cierres el navegador.');
      await new Promise((resolve) => {
        browser.once('disconnected', resolve);
      });
      return;
    }

    await new Promise(r => setTimeout(r, timeoutMs));

    printEnvSuggestion();
    console.log('✅ Spy finalizado. Copia variables al .env y reinicia backend.');
  } finally {
    if (browser.connected) {
      await browser.close();
    }
  }
};

run().catch(err => {
  console.error('❌ Error en spy-altenar-profile:', err.message);
  process.exit(1);
});
