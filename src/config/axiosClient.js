import axios from 'axios';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

// =====================================================================
// CONFIGURACIÓN AXIOS "INMORTAL" PARA ALTENAR (DoradoBet)
// =====================================================================
// Respetando el PROTOCOLO INMORTAL definido en copilot-instructions.md
// NO usar header Authorization para evitar bloqueos por token caducado.

const BOOK_PROFILES = {
  doradobet: {
    referer: 'https://doradobet.com/deportes-en-vivo',
    origin: 'https://doradobet.com',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8',
    integration: 'doradobet',
    countryCode: 'PE',
    culture: 'es-ES',
    timezoneOffset: 300,
    numFormat: 'en-GB',
    deviceType: 1,
    sportId: 0
  },
  acity: {
    referer: 'https://www.casinoatlanticcity.com/apuestas-deportivas',
    origin: 'https://www.casinoatlanticcity.com',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8',
    integration: 'acity',
    countryCode: 'PE',
    culture: 'es-ES',
    timezoneOffset: 300,
    numFormat: 'en-GB',
    deviceType: 1,
    sportId: 0
  }
};

const PROFILE_ALIASES = {
  casinoatlanticcity: 'acity'
};

const rawProfileName = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
const selectedProfileName = PROFILE_ALIASES[rawProfileName] || rawProfileName;
const selectedProfile = BOOK_PROFILES[selectedProfileName] || BOOK_PROFILES.doradobet;

// Overrides finos por .env (útil después de un spy con Puppeteer)
const resolvedConfig = {
  referer: process.env.ALTENAR_REFERER || selectedProfile.referer,
  origin: process.env.ALTENAR_ORIGIN || selectedProfile.origin,
  userAgent: process.env.ALTENAR_USER_AGENT || selectedProfile.userAgent,
  acceptLanguage: process.env.ALTENAR_ACCEPT_LANGUAGE || selectedProfile.acceptLanguage,
  integration: process.env.ALTENAR_INTEGRATION || selectedProfile.integration,
  countryCode: process.env.ALTENAR_COUNTRY_CODE || selectedProfile.countryCode,
  culture: process.env.ALTENAR_CULTURE || selectedProfile.culture,
  timezoneOffset: Number(process.env.ALTENAR_TIMEZONE_OFFSET || selectedProfile.timezoneOffset),
  numFormat: process.env.ALTENAR_NUM_FORMAT || selectedProfile.numFormat,
  deviceType: Number(process.env.ALTENAR_DEVICE_TYPE || selectedProfile.deviceType),
  sportId: Number(process.env.ALTENAR_SPORT_ID || selectedProfile.sportId)
};

if (!BOOK_PROFILES[selectedProfileName]) {
  console.warn(`⚠️ BOOK_PROFILE desconocido: "${rawProfileName}". Usando doradobet.`);
}

console.log(`📘 Altenar Profile: ${BOOK_PROFILES[selectedProfileName] ? selectedProfileName : 'doradobet'} | integration=${resolvedConfig.integration}`);

const altenarClient = axios.create({
  baseURL: process.env.ALTENAR_WIDGET_BASE_URL || 'https://sb2frontend-altenar2.biahosted.com/api/widget',
  // Forzar IPv4 para evitar errores ENOTFOUND en redes con IPv6 inestable
  httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
  headers: {
    // Simulación de navegador real (perfil por casa + overrides por .env)
    'User-Agent': resolvedConfig.userAgent,
    'Accept-Language': resolvedConfig.acceptLanguage,
    'Referer': resolvedConfig.referer,
    'Origin': resolvedConfig.origin,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
  },
  params: {
    // Parámetros Globales Obligatorios (Capturados del tráfico real)
    culture: resolvedConfig.culture,
    timezoneOffset: resolvedConfig.timezoneOffset,
    integration: resolvedConfig.integration,
    deviceType: resolvedConfig.deviceType,
    numFormat: resolvedConfig.numFormat,
    countryCode: resolvedConfig.countryCode,
    sportId: resolvedConfig.sportId // Default a todos (luego se sobreescribe a 66 en los servicios)
  },
  timeout: 10000 // 10 segundos timeout
});

// Interceptor para debugging (opcional, ayuda a ver errores de red)
altenarClient.interceptors.response.use(
  response => response,
  error => {
    // Si falla, loguear pero no romper todo el proceso si es posible
    console.error(`[Axios Altenar Error] ${error.message}`, error.response?.status);
    return Promise.reject(error);
  }
);

export default altenarClient;
