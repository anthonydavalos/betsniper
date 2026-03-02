import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--url='));
const targetUrl = targetArg
  ? targetArg.replace('--url=', '')
  : 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview';

const headless = !args.includes('--headed');
const timeoutMs = Number((args.find(a => a.startsWith('--timeout=')) || '--timeout=25000').split('=')[1]);

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

const run = async () => {
  console.log(`🕵️ Spy Altenar iniciando en: ${targetUrl}`);
  console.log(`   Modo: ${headless ? 'headless' : 'headed'}`);
  console.log(`   Tiempo de captura: ${timeoutMs}ms`);

  const browser = await puppeteer.launch({
    headless,
    defaultViewport: { width: 1440, height: 900 }
  });

  try {
    const page = await browser.newPage();

    page.on('request', (req) => {
      try {
        logRequestIfAltenar(req);
      } catch (_) {}
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
    } catch (err) {
      console.warn(`⚠️ Navegación con timeout (${err.message}). Continuando con datos capturados...`);
    }
    await new Promise(r => setTimeout(r, timeoutMs));

    printEnvSuggestion();
    console.log('✅ Spy finalizado. Copia variables al .env y reinicia backend.');
  } finally {
    await browser.close();
  }
};

run().catch(err => {
  console.error('❌ Error en spy-altenar-profile:', err.message);
  process.exit(1);
});
