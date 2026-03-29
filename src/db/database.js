import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuración de rutas para ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../../db.json');

// Estructura por defecto de la Base de Datos
const defaultData = {
  config: { 
    bankroll: 100, 
    kellyFraction: 0.25 
  },
  mappedTeams: { 
    "Man City": "Manchester City" 
  },
  upcomingMatches: [],
  altenarUpcoming: [], // Caché de cuotas Pre-Match Altenar
  liveTracking: [],
  blacklist: [], // [NEW] Lista negra persistente de eventos descartados
  // PORTFOLIO Y SIMULACIÓN
  portfolio: {
    balance: 100,
    initialCapital: 100,
    activeBets: [], // Apuestas en juego
    history: []     // Apuestas cerradas
  },
  // FLUJO SEMI-AUTO BOOKY (Fase 1)
  booky: {
    pendingTickets: [],
    history: []
  },
  // FLUJO SEMI-AUTO PINNACLE (Fase 2)
  pinnacle: {
    pendingTickets: [],
    history: []
  }
};

// Inicialización de LowDB
const adapter = new JSONFile(dbPath);
const db = new Low(adapter, defaultData);
let writeQueue = Promise.resolve();

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

const isRetryableWriteError = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || '').toUpperCase();
  return (
    code === 'EPERM' ||
    code === 'EBUSY' ||
    code === 'EACCES' ||
    code === 'ENOENT' ||
    msg.includes('EPERM') ||
    msg.includes('EBUSY') ||
    msg.includes('EACCES') ||
    msg.includes('ENOENT')
  );
};

const runWriteWithRetry = async ({ maxAttempts = 8, baseDelayMs = 120 } = {}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await db.write();
      return { ok: true, attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableWriteError(error) || attempt === maxAttempts) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * 80);
      await wait(baseDelayMs * attempt + jitter);
    }
  }

  if (lastError) throw lastError;
  return { ok: false, attempt: maxAttempts };
};

export const writeDBWithRetry = async ({ maxAttempts = 8, baseDelayMs = 120 } = {}) => {
  const op = writeQueue.then(() => runWriteWithRetry({ maxAttempts, baseDelayMs }));
  // Mantener cola viva aunque falle un write previo.
  writeQueue = op.catch(() => {});
  return op;
};

export const pruneStaleEventCaches = async ({
  upcomingGraceMinutes = 180,
  altenarGraceMinutes = 180,
  persist = true
} = {}) => {
  await db.read();

  const nowMs = Date.now();
  const upcomingCutoff = nowMs - (Math.max(30, Number(upcomingGraceMinutes) || 180) * 60 * 1000);
  const altenarCutoff = nowMs - (Math.max(30, Number(altenarGraceMinutes) || 180) * 60 * 1000);

  const currentUpcoming = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
  const currentAltenar = Array.isArray(db.data?.altenarUpcoming) ? db.data.altenarUpcoming : [];

  const nextUpcoming = currentUpcoming.filter((row) => {
    const ts = new Date(row?.date || '').getTime();
    if (!Number.isFinite(ts)) return false;
    return ts >= upcomingCutoff;
  });

  const nextAltenar = currentAltenar.filter((row) => {
    const ts = new Date(row?.startDate || row?.date || '').getTime();
    if (!Number.isFinite(ts)) return false;
    return ts >= altenarCutoff;
  });

  const removedUpcoming = currentUpcoming.length - nextUpcoming.length;
  const removedAltenar = currentAltenar.length - nextAltenar.length;
  const changed = removedUpcoming > 0 || removedAltenar > 0;

  if (changed) {
    db.data.upcomingMatches = nextUpcoming;
    db.data.altenarUpcoming = nextAltenar;
    if (persist) {
      await writeDBWithRetry();
    }
  }

  return {
    changed,
    removedUpcoming,
    removedAltenar,
    remainingUpcoming: nextUpcoming.length,
    remainingAltenar: nextAltenar.length
  };
};

// Función para inicializar/leer la DB
export const initDB = async () => {
  await db.read();
  
  let modified = false;

  // Si falta data, escribir los defaults
  if (!db.data) {
    db.data = defaultData;
    modified = true;
  }
  
  // Asegurar que existan todas las claves principales
  if (!db.data.upcomingMatches) { db.data.upcomingMatches = []; modified = true; }
  if (!db.data.config) { db.data.config = defaultData.config; modified = true; }
  if (!db.data.mappedTeams) { db.data.mappedTeams = defaultData.mappedTeams; modified = true; }
  if (!db.data.blacklist) { db.data.blacklist = []; modified = true; } // [NEW] Ensure blacklist exists
  if (!db.data.liveTracking) { db.data.liveTracking = []; modified = true; }
  if (!db.data.booky) { db.data.booky = { pendingTickets: [], history: [] }; modified = true; }
  if (!db.data.booky.pendingTickets) { db.data.booky.pendingTickets = []; modified = true; }
  if (!db.data.booky.history) { db.data.booky.history = []; modified = true; }
  if (!db.data.pinnacle) { db.data.pinnacle = { pendingTickets: [], history: [] }; modified = true; }
  if (!db.data.pinnacle.pendingTickets) { db.data.pinnacle.pendingTickets = []; modified = true; }
  if (!db.data.pinnacle.history) { db.data.pinnacle.history = []; modified = true; }
  
  // Solo escribir si hubo cambios estructurales (evita trigger nodemon loop)
  if (modified) {
      await writeDBWithRetry();
      console.log('✅ Base de Datos LowDB (JSON) inicializada y guardada.');
  } else {
      // console.log('✅ Base de Datos LowDB (JSON) cargada.');
  }
};

export default db;
