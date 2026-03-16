import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

const rawArg = (process.argv[2] || '').toLowerCase();

const profiles = {
  dorado: {
    BOOK_PROFILE: 'doradobet',
    ALTENAR_INTEGRATION: 'doradobet',
    ALTENAR_ORIGIN: 'https://doradobet.com',
    ALTENAR_REFERER: 'https://doradobet.com/deportes-en-vivo',
    ALTENAR_BOOKY_URL: 'https://doradobet.com/deportes-en-vivo',
    ALTENAR_COUNTRY_CODE: 'PE',
    ALTENAR_CULTURE: 'es-ES',
    ALTENAR_TIMEZONE_OFFSET: '300',
    ALTENAR_NUM_FORMAT: 'en-GB',
    ALTENAR_DEVICE_TYPE: '1',
    ALTENAR_SPORT_ID: '0',
    ALTENAR_PUBLIC_INTEGRATION: 'doradobet',
    ALTENAR_PUBLIC_ORIGIN: 'https://doradobet.com',
    ALTENAR_PUBLIC_REFERER: 'https://doradobet.com/deportes-en-vivo',
    ALTENAR_PUBLIC_COUNTRY_CODE: 'PE',
    ALTENAR_PUBLIC_CULTURE: 'es-ES',
    ALTENAR_PUBLIC_TIMEZONE_OFFSET: '300',
    ALTENAR_PUBLIC_NUM_FORMAT: 'en-GB',
    ALTENAR_PUBLIC_DEVICE_TYPE: '1',
    ALTENAR_PUBLIC_SPORT_ID: '0'
  },
  acity: {
    BOOK_PROFILE: 'acity',
    ALTENAR_INTEGRATION: 'acity',
    ALTENAR_ORIGIN: 'https://www.casinoatlanticcity.com',
    ALTENAR_REFERER: 'https://www.casinoatlanticcity.com/apuestas-deportivas',
    ALTENAR_BOOKY_URL: 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview',
    ALTENAR_COUNTRY_CODE: 'PE',
    ALTENAR_CULTURE: 'es-ES',
    ALTENAR_TIMEZONE_OFFSET: '300',
    ALTENAR_NUM_FORMAT: 'en-GB',
    ALTENAR_DEVICE_TYPE: '1',
    ALTENAR_SPORT_ID: '0',
    ALTENAR_PUBLIC_INTEGRATION: 'acity',
    ALTENAR_PUBLIC_ORIGIN: 'https://www.casinoatlanticcity.com',
    ALTENAR_PUBLIC_REFERER: 'https://www.casinoatlanticcity.com/apuestas-deportivas',
    ALTENAR_PUBLIC_COUNTRY_CODE: 'PE',
    ALTENAR_PUBLIC_CULTURE: 'es-ES',
    ALTENAR_PUBLIC_TIMEZONE_OFFSET: '300',
    ALTENAR_PUBLIC_NUM_FORMAT: 'en-GB',
    ALTENAR_PUBLIC_DEVICE_TYPE: '1',
    ALTENAR_PUBLIC_SPORT_ID: '0'
  }
};

if (!profiles[rawArg]) {
  console.error('Uso: node scripts/set-book-profile.js <dorado|acity>');
  process.exit(1);
}

const target = profiles[rawArg];

const readEnvLines = () => {
  if (!fs.existsSync(envPath)) return [];
  return fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
};

const upsertEnvKey = (lines, key, value) => {
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  const newLine = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
};

const getEnvValue = (lines, key) => {
  const line = lines.find(l => l.startsWith(`${key}=`));
  if (!line) return '';
  return line.slice(`${key}=`.length).trim();
};

const removeApiSportsKey = (lines) => lines.filter(l => !l.startsWith('API_SPORTS_KEY='));

const hasSection = (lines, marker) => lines.some(l => l.trim() === marker.trim());

let lines = readEnvLines();
lines = removeApiSportsKey(lines);

if (!hasSection(lines, '# Altenar Profile (autogenerado por set-book-profile.js)')) {
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push('# Altenar Profile (autogenerado por set-book-profile.js)');
}

Object.entries(target).forEach(([k, v]) => upsertEnvKey(lines, k, v));

// Mantener llaves de credenciales para flujo de captura/control real
if (!lines.some(l => l.startsWith('ALTENAR_LOGIN_USERNAME='))) upsertEnvKey(lines, 'ALTENAR_LOGIN_USERNAME', '');
if (!lines.some(l => l.startsWith('ALTENAR_LOGIN_PASSWORD='))) upsertEnvKey(lines, 'ALTENAR_LOGIN_PASSWORD', '');
if (!lines.some(l => l.startsWith('ALTENAR_PUBLIC_USER_AGENT='))) {
  upsertEnvKey(
    lines,
    'ALTENAR_PUBLIC_USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  );
}

const normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
fs.writeFileSync(envPath, normalized, 'utf8');

console.log(`✅ Perfil actualizado en .env: ${rawArg}`);
console.log(`   BOOK_PROFILE=${target.BOOK_PROFILE}`);
console.log(`   ALTENAR_INTEGRATION=${target.ALTENAR_INTEGRATION}`);
console.log(`   ALTENAR_PUBLIC_INTEGRATION=${target.ALTENAR_PUBLIC_INTEGRATION}`);
console.log(`   ALTENAR_BOOKY_URL=${target.ALTENAR_BOOKY_URL}`);

const loginUser = getEnvValue(lines, 'ALTENAR_LOGIN_USERNAME');
const loginPass = getEnvValue(lines, 'ALTENAR_LOGIN_PASSWORD');
const hasCreds = Boolean(loginUser && loginPass);

if (!hasCreds) {
  console.warn('⚠️ Credenciales faltantes: define ALTENAR_LOGIN_USERNAME y ALTENAR_LOGIN_PASSWORD en .env');
} else if (rawArg === 'dorado') {
  console.warn('🔐 Recuerda validar que las credenciales en .env sean las de DORADO antes de capturar/apostar.');
} else if (rawArg === 'acity') {
  console.log('🔐 Verifica que las credenciales en .env correspondan a ACITY para evitar login cruzado.');
}
