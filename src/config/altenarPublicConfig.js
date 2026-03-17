import dotenv from 'dotenv';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const envFilePath = path.join(projectRoot, '.env');
const ENV_RELOAD_MIN_INTERVAL_MS = 1500;
let lastEnvReloadAt = 0;
let lastEnvMtimeMs = 0;

const maybeReloadEnvFromDisk = ({ force = false } = {}) => {
  try {
    const now = Date.now();
    if (!force && now - lastEnvReloadAt < ENV_RELOAD_MIN_INTERVAL_MS) return false;

    lastEnvReloadAt = now;
    const stat = fs.statSync(envFilePath);
    const mtimeMs = Number(stat?.mtimeMs || 0);
    if (!force && mtimeMs <= lastEnvMtimeMs) return false;

    // Recarga incremental para reflejar tokens renovados por procesos externos.
    dotenv.config({ path: envFilePath, override: true });
    lastEnvMtimeMs = mtimeMs;
    return true;
  } catch (_) {
    return false;
  }
};

maybeReloadEnvFromDisk({ force: true });

const TOKEN_RENEW_COOLDOWN_MS = Math.max(
  15000,
  Number(process.env.ALTENAR_WIDGET_TOKEN_RENEW_COOLDOWN_MS || 120000)
);
const TOKEN_RENEW_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.ALTENAR_WIDGET_TOKEN_RENEW_TIMEOUT_MS || 90000)
);
let lastWidgetRenewLaunchAt = 0;

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`[Config] Falta variable obligatoria: ${name}`);
  }
  return value;
};

const toNumberOrThrow = (name) => {
  const raw = required(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[Config] ${name} debe ser numerico. Valor recibido: ${raw}`);
  }
  return n;
};

const DEFAULT_PUBLIC_CONFIG = {
  integration: required('ALTENAR_PUBLIC_INTEGRATION'),
  countryCode: required('ALTENAR_PUBLIC_COUNTRY_CODE'),
  numFormat: required('ALTENAR_PUBLIC_NUM_FORMAT'),
  culture: required('ALTENAR_PUBLIC_CULTURE'),
  timezoneOffset: toNumberOrThrow('ALTENAR_PUBLIC_TIMEZONE_OFFSET'),
  deviceType: toNumberOrThrow('ALTENAR_PUBLIC_DEVICE_TYPE'),
  sportId: toNumberOrThrow('ALTENAR_PUBLIC_SPORT_ID'),
  origin: required('ALTENAR_PUBLIC_ORIGIN'),
  referer: required('ALTENAR_PUBLIC_REFERER'),
  userAgent: required('ALTENAR_PUBLIC_USER_AGENT')
};

const activeProfile = String(
  process.env.BOOK_PROFILE || process.env.ALTENAR_INTEGRATION || ''
).trim().toLowerCase();
const publicIntegration = String(DEFAULT_PUBLIC_CONFIG.integration || '').trim().toLowerCase();

if (activeProfile && publicIntegration && activeProfile !== publicIntegration) {
  throw new Error(
    `[Config] Mezcla detectada: perfil activo=${activeProfile} y ALTENAR_PUBLIC_INTEGRATION=${publicIntegration}. ` +
    'Deben ser iguales para evitar cruces de feed entre Booky y scanner.'
  );
}

const normalizeWidgetAuthToken = (raw = '') => String(raw || '').trim();

const shouldRequireScannerAuth = () => {
  return activeProfile === 'acity' || publicIntegration === 'acity';
};

const getScannerAuthorizationHeader = () => {
  maybeReloadEnvFromDisk();

  if (!shouldRequireScannerAuth()) return '';

  const widgetAuth = normalizeWidgetAuthToken(process.env.ALTENAR_WIDGET_AUTH_TOKEN || '');
  if (widgetAuth) return widgetAuth;

  const legacyBookyAuth = normalizeWidgetAuthToken(process.env.ALTENAR_BOOKY_AUTH_TOKEN || '');
  if (legacyBookyAuth) {
    console.warn(
      '[Config] ALTENAR_WIDGET_AUTH_TOKEN no definido. Usando ALTENAR_BOOKY_AUTH_TOKEN como fallback para scanner ACity. '
      + 'Recomendado: refrescar token con npm run token:booky:wait-close para capturar ambos.'
    );
    return legacyBookyAuth;
  }

  throw new Error(
    '[Config] ALTENAR_WIDGET_AUTH_TOKEN es obligatorio para scanner ACity. ' +
    'Ejecuta: npm run token:booky:wait-close'
  );
};

export const getAltenarPublicRequestConfig = (extraParams = {}) => {
  const auth = getScannerAuthorizationHeader();

  return {
    params: {
      culture: DEFAULT_PUBLIC_CONFIG.culture,
      timezoneOffset: DEFAULT_PUBLIC_CONFIG.timezoneOffset,
      integration: DEFAULT_PUBLIC_CONFIG.integration,
      deviceType: DEFAULT_PUBLIC_CONFIG.deviceType,
      numFormat: DEFAULT_PUBLIC_CONFIG.numFormat,
      countryCode: DEFAULT_PUBLIC_CONFIG.countryCode,
      sportId: DEFAULT_PUBLIC_CONFIG.sportId,
      ...extraParams
    },
    headers: {
      Origin: DEFAULT_PUBLIC_CONFIG.origin,
      Referer: DEFAULT_PUBLIC_CONFIG.referer,
      'User-Agent': DEFAULT_PUBLIC_CONFIG.userAgent,
      ...(auth ? { Authorization: auth } : {})
    }
  };
};

const isAuthErrorStatus = (error) => {
  const status = Number(error?.response?.status || 0);
  return status === 401 || status === 403;
};

const triggerWidgetTokenRenewal = () => {
  const profile = String(process.env.BOOK_PROFILE || 'doradobet').trim().toLowerCase();
  const scriptPath = path.join(projectRoot, 'scripts', 'extract-booky-auth-token.js');
  const logDir = path.join(projectRoot, 'data', 'booky');
  const logPath = path.join(logDir, 'widget-token-renew.log');
  const args = [
    '--headed',
    '--no-wait-close',
    '--widget-only',
    `--timeout=${TOKEN_RENEW_TIMEOUT_MS}`,
    `--require-profile=${profile}`
  ];

  try {
    fs.mkdirSync(logDir, { recursive: true });
    const logFd = fs.openSync(logPath, 'a');

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: false,
      env: {
        ...process.env,
        BOOK_PROFILE: profile
      }
    });
    child.unref();
    return { started: true, logPath, pid: child.pid || 0 };
  } catch (_) {
    return { started: false, logPath, pid: 0 };
  }
};

export const maybeAutoRenewWidgetToken = (error, source = 'unknown') => {
  if (!isAuthErrorStatus(error)) {
    return { mustRenew: false, triggered: false, busy: false, status: Number(error?.response?.status || 0), source };
  }

  const now = Date.now();
  const elapsed = now - lastWidgetRenewLaunchAt;
  if (lastWidgetRenewLaunchAt > 0 && elapsed < TOKEN_RENEW_COOLDOWN_MS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((TOKEN_RENEW_COOLDOWN_MS - elapsed) / 1000));
    console.warn(
      `⚠️ [WidgetToken] 401/403 en ${source}. Renovación automática suprimida por cooldown (${retryAfterSeconds}s restantes).`
    );
    return { mustRenew: true, triggered: false, busy: true, retryAfterSeconds, status: Number(error?.response?.status || 0), source };
  }

  const launch = triggerWidgetTokenRenewal();
  if (launch.started) {
    lastWidgetRenewLaunchAt = now;
    console.warn(
      `🔐 [WidgetToken] 401/403 en ${source}. Lanzada renovación automática (timeout=${TOKEN_RENEW_TIMEOUT_MS}ms, pid=${launch.pid || 'n/a'}). ` +
      `Log: ${launch.logPath}. Reinicia backend si .env se actualiza con token nuevo.`
    );
  } else {
    console.warn(
      `⚠️ [WidgetToken] 401/403 en ${source}. No se pudo lanzar renovación automática; revisa ${launch.logPath} o ejecuta: npm run token:booky:wait-close`
    );
  }

  return {
    mustRenew: true,
    triggered: launch.started,
    busy: false,
    status: Number(error?.response?.status || 0),
    source
  };
};
