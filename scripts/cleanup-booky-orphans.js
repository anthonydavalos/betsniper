import dotenv from 'dotenv';
import { cleanupBookyOrphanActiveBets } from '../src/services/bookyAccountService.js';

dotenv.config();

const args = process.argv.slice(2);

const readArgValue = (name, fallback = '') => {
  const pref = `--${name}=`;
  const arg = args.find((item) => String(item).startsWith(pref));
  if (!arg) return fallback;
  return String(arg.slice(pref.length)).trim();
};

const hasFlag = (name) => args.includes(`--${name}`);

const parseBooleanArg = (name, fallback) => {
  const raw = readArgValue(name, '');
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseNumberArg = (name, fallback) => {
  const raw = readArgValue(name, '');
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const printUsage = () => {
  console.log('Uso: node scripts/cleanup-booky-orphans.js [opciones]');
  console.log('');
  console.log('Opciones:');
  console.log('  --profile=acity|doradobet   Perfil booky a usar (default: BOOK_PROFILE).');
  console.log('  --refresh=true|false        Fuerza sync remoto antes de limpiar (default: true).');
  console.log('  --history-limit=N           Límite remoto por sync (0 = todos, default: 0).');
  console.log('  --fetch-all=true|false      Trae historial completo remoto (default: true).');
  console.log('  --json                      Imprime solo JSON resultado.');
  console.log('  --help                      Muestra esta ayuda.');
};

if (hasFlag('help')) {
  printUsage();
  process.exit(0);
}

const profile = readArgValue('profile', process.env.BOOK_PROFILE || '').trim() || null;
const forceRefresh = parseBooleanArg('refresh', true);
const historyLimit = parseNumberArg('history-limit', 0);
const fetchAll = parseBooleanArg('fetch-all', true);
const jsonOnly = hasFlag('json');

const run = async () => {
  const result = await cleanupBookyOrphanActiveBets({
    profileKey: profile,
    forceRefresh,
    historyLimit,
    fetchAll
  });

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const removed = Number(result?.removedCount || 0);
  const patched = Number(result?.patchedCount || 0);
  const before = Number(result?.activeBefore || 0);
  const after = Number(result?.activeAfter || 0);

  console.log('🧹 Saneo de apuestas activas huérfanas (Booky)');
  console.log(`Perfil: ${result?.profile || '-'} | Integración: ${result?.integration || '-'}`);
  console.log(`Activas antes/después: ${before} -> ${after}`);
  console.log(`Removidas: ${removed} | Parchadas: ${patched} | Total tocadas: ${Number(result?.touchedCount || 0)}`);

  if (Array.isArray(result?.removedIds) && result.removedIds.length > 0) {
    console.log(`IDs removidos: ${result.removedIds.join(', ')}`);
  }

  if (result?.remoteError) {
    console.warn(`⚠️ Sync remoto con fallback/error: ${result.remoteError}`);
  }
};

run().catch((error) => {
  console.error(`❌ Error en cleanup-booky-orphans: ${error.message}`);
  process.exit(1);
});
