import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

// Configuración de rutas para ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyDbPath = path.join(__dirname, '../../db.json');
const coreDbPath = path.join(__dirname, '../../db-core.json');
const diagnosticsDbPath = path.join(__dirname, '../../db-diagnostics.json');
const coreTmpPath = path.join(path.dirname(coreDbPath), `.${path.basename(coreDbPath)}.tmp`);
const diagnosticsTmpPath = path.join(path.dirname(diagnosticsDbPath), `.${path.basename(diagnosticsDbPath)}.tmp`);

const DIAGNOSTICS_KEYS = [
  'arbitrageDiagnostics',
  'liveArbitrageDiagnostics',
  'arbitrageExecutionAudit',
  'liveArbitrageSimulation'
];

const ARBITRAGE_DIAG_MAX_HISTORY_DEFAULT = 1200;
const LIVE_ARBITRAGE_DIAG_MAX_HISTORY_DEFAULT = 1200;
const ARBITRAGE_EXEC_AUDIT_MAX_HISTORY_DEFAULT = 1200;
const LIVE_ARBITRAGE_SIM_HISTORY_LIMIT_DEFAULT = 800;

// Estructura por defecto del core (sin historiales diagnósticos pesados)
const defaultCoreData = {
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

// Estructura por defecto de diagnósticos (archivo separado)
const defaultDiagnosticsData = {
  arbitrageDiagnostics: {
    history: [],
    lastInventoryAt: null,
    lastSummary: null
  },
  liveArbitrageDiagnostics: {
    history: [],
    lastInventoryAt: null,
    lastSummary: null
  },
  // AUDITORIA DE EJECUCION DUAL (preview/preflight/placement correlacionados por executionId)
  arbitrageExecutionAudit: {
    history: [],
    lastUpdatedAt: null,
    lastSummary: null
  },
  liveArbitrageSimulation: {
    history: [],
    lastRunAt: null,
    lastSummary: null
  }
};

// Inicialización de LowDB
const adapter = new JSONFile(coreDbPath);
const db = new Low(adapter, defaultCoreData);
const rawDbRead = db.read.bind(db);
let writeQueue = Promise.resolve();
let splitBootstrapPromise = null;
let lastGoodDiagnosticsSnapshot = defaultDiagnosticsData;

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

const cloneJson = (value, fallback = {}) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
};

lastGoodDiagnosticsSnapshot = cloneJson(defaultDiagnosticsData, defaultDiagnosticsData);

const ensureObject = (value, fallback = {}) => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : cloneJson(fallback, fallback);
};

const diagnosticsHasEvidence = (diag = {}) => {
  const source = ensureDiagnosticsShape(diag);
  const hasHistory =
    source.arbitrageDiagnostics.history.length > 0 ||
    source.liveArbitrageDiagnostics.history.length > 0 ||
    source.arbitrageExecutionAudit.history.length > 0 ||
    source.liveArbitrageSimulation.history.length > 0;

  const hasTimestamps = Boolean(
    source.arbitrageDiagnostics.lastInventoryAt ||
    source.liveArbitrageDiagnostics.lastInventoryAt ||
    source.arbitrageExecutionAudit.lastUpdatedAt ||
    source.liveArbitrageSimulation.lastRunAt
  );

  return hasHistory || hasTimestamps;
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readJsonFileSafe = async (filePath, fallback = null) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const extractCoreSnapshot = (merged = {}) => {
  const base = ensureObject(merged, defaultCoreData);
  const next = { ...base };
  for (const key of DIAGNOSTICS_KEYS) {
    delete next[key];
  }
  return next;
};

const ensureDiagnosticsShape = (candidate = {}) => {
  const source = ensureObject(candidate, defaultDiagnosticsData);

  const arbitrageDiagnostics = ensureObject(
    source.arbitrageDiagnostics,
    defaultDiagnosticsData.arbitrageDiagnostics
  );
  if (!Array.isArray(arbitrageDiagnostics.history)) arbitrageDiagnostics.history = [];
  if (!Object.prototype.hasOwnProperty.call(arbitrageDiagnostics, 'lastInventoryAt')) arbitrageDiagnostics.lastInventoryAt = null;
  if (!Object.prototype.hasOwnProperty.call(arbitrageDiagnostics, 'lastSummary')) arbitrageDiagnostics.lastSummary = null;

  const liveArbitrageDiagnostics = ensureObject(
    source.liveArbitrageDiagnostics,
    defaultDiagnosticsData.liveArbitrageDiagnostics
  );
  if (!Array.isArray(liveArbitrageDiagnostics.history)) liveArbitrageDiagnostics.history = [];
  if (!Object.prototype.hasOwnProperty.call(liveArbitrageDiagnostics, 'lastInventoryAt')) liveArbitrageDiagnostics.lastInventoryAt = null;
  if (!Object.prototype.hasOwnProperty.call(liveArbitrageDiagnostics, 'lastSummary')) liveArbitrageDiagnostics.lastSummary = null;

  const arbitrageExecutionAudit = ensureObject(
    source.arbitrageExecutionAudit,
    defaultDiagnosticsData.arbitrageExecutionAudit
  );
  if (!Array.isArray(arbitrageExecutionAudit.history)) arbitrageExecutionAudit.history = [];
  if (!Object.prototype.hasOwnProperty.call(arbitrageExecutionAudit, 'lastUpdatedAt')) arbitrageExecutionAudit.lastUpdatedAt = null;
  if (!Object.prototype.hasOwnProperty.call(arbitrageExecutionAudit, 'lastSummary')) arbitrageExecutionAudit.lastSummary = null;

  const liveArbitrageSimulation = ensureObject(
    source.liveArbitrageSimulation,
    defaultDiagnosticsData.liveArbitrageSimulation
  );
  if (!Array.isArray(liveArbitrageSimulation.history)) liveArbitrageSimulation.history = [];
  if (!Object.prototype.hasOwnProperty.call(liveArbitrageSimulation, 'lastRunAt')) liveArbitrageSimulation.lastRunAt = null;
  if (!Object.prototype.hasOwnProperty.call(liveArbitrageSimulation, 'lastSummary')) liveArbitrageSimulation.lastSummary = null;

  return {
    arbitrageDiagnostics,
    liveArbitrageDiagnostics,
    arbitrageExecutionAudit,
    liveArbitrageSimulation
  };
};

const extractDiagnosticsSnapshot = (merged = {}) => {
  const source = ensureObject(merged, {});
  const picked = {};
  for (const key of DIAGNOSTICS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      picked[key] = source[key];
    }
  }
  return ensureDiagnosticsShape(picked);
};

const mergeCoreWithDiagnostics = (coreData = {}, diagnosticsData = {}) => {
  const core = ensureObject(coreData, defaultCoreData);
  const diagnostics = ensureDiagnosticsShape(diagnosticsData);
  return {
    ...core,
    ...diagnostics
  };
};

const writeJsonAtomicWithRetry = async ({
  filePath,
  tmpPath,
  payload,
  maxAttempts = 8,
  baseDelayMs = 120
} = {}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const serialized = `${JSON.stringify(payload ?? {}, null, 2)}\n`;
      await fs.writeFile(tmpPath, serialized, 'utf8');
      await fs.rename(tmpPath, filePath);
      return { ok: true, attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableWriteError(error) || attempt === maxAttempts) {
        break;
      }
      await fs.unlink(tmpPath).catch(() => {});
      const jitter = Math.floor(Math.random() * 80);
      await wait(baseDelayMs * attempt + jitter);
    }
  }

  // Fallback directo sin rename para entornos Windows con lock intermitente.
  if (lastError && isRetryableWriteError(lastError)) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const serialized = `${JSON.stringify(payload ?? {}, null, 2)}\n`;
        await fs.writeFile(filePath, serialized, 'utf8');
        return { ok: true, attempt, mode: 'direct-write-fallback' };
      } catch (error) {
        lastError = error;
        if (!isRetryableWriteError(error) || attempt === 3) {
          break;
        }
        const jitter = Math.floor(Math.random() * 70);
        await wait(170 * attempt + jitter);
      }
    }
  }

  if (lastError) throw lastError;
  return { ok: false, attempt: maxAttempts };
};

const migrateLegacyDbIfNeeded = async () => {
  const hasCore = await fileExists(coreDbPath);
  const hasDiagnostics = await fileExists(diagnosticsDbPath);

  if (hasCore && hasDiagnostics) {
    return { migrated: false };
  }

  const legacyExists = await fileExists(legacyDbPath);
  const legacyData = legacyExists
    ? await readJsonFileSafe(legacyDbPath, null)
    : null;

  const source = legacyData && typeof legacyData === 'object'
    ? legacyData
    : {};

  if (!hasCore) {
    const coreSeed = {
      ...cloneJson(defaultCoreData, defaultCoreData),
      ...extractCoreSnapshot(source)
    };
    await writeJsonAtomicWithRetry({
      filePath: coreDbPath,
      tmpPath: coreTmpPath,
      payload: coreSeed,
      maxAttempts: 8,
      baseDelayMs: 120
    });
  }

  if (!hasDiagnostics) {
    const diagnosticsSeed = ensureDiagnosticsShape(
      legacyData && typeof legacyData === 'object'
        ? legacyData
        : source
    );
    await writeJsonAtomicWithRetry({
      filePath: diagnosticsDbPath,
      tmpPath: diagnosticsTmpPath,
      payload: diagnosticsSeed,
      maxAttempts: 8,
      baseDelayMs: 120
    });
  }

  if (legacyExists && (!hasCore || !hasDiagnostics)) {
    console.log('✅ Migración automática DB: db.json -> db-core.json + db-diagnostics.json');
  }

  return { migrated: legacyExists && (!hasCore || !hasDiagnostics) };
};

const ensureSplitStorageReady = async () => {
  if (!splitBootstrapPromise) {
    splitBootstrapPromise = migrateLegacyDbIfNeeded().catch((error) => {
      splitBootstrapPromise = null;
      throw error;
    });
  }
  await splitBootstrapPromise;
};

const readDiagnosticsData = async ({ fallbackSource = null, memoryFallback = null } = {}) => {
  const fromDiagnosticsFile = await readJsonFileSafe(diagnosticsDbPath, null);
  if (fromDiagnosticsFile && typeof fromDiagnosticsFile === 'object') {
    const normalized = ensureDiagnosticsShape(fromDiagnosticsFile);
    lastGoodDiagnosticsSnapshot = cloneJson(normalized, defaultDiagnosticsData);
    return normalized;
  }

  // Retry corto para cubrir lecturas durante reemplazo/lock transitorio en Windows.
  await wait(25);
  const fromDiagnosticsRetry = await readJsonFileSafe(diagnosticsDbPath, null);
  if (fromDiagnosticsRetry && typeof fromDiagnosticsRetry === 'object') {
    const normalized = ensureDiagnosticsShape(fromDiagnosticsRetry);
    lastGoodDiagnosticsSnapshot = cloneJson(normalized, defaultDiagnosticsData);
    return normalized;
  }

  const source = fallbackSource && typeof fallbackSource === 'object'
    ? fallbackSource
    : (await readJsonFileSafe(legacyDbPath, {}));

  const fallbackFromMemory = ensureDiagnosticsShape(memoryFallback || db.data || {});
  const fallbackFromLastGood = ensureDiagnosticsShape(lastGoodDiagnosticsSnapshot);
  const fallbackFromSource = ensureDiagnosticsShape(source);

  // Orden de prioridad para evitar wipe de auditoria:
  // 1) snapshot en memoria si tiene evidencia,
  // 2) ultimo snapshot bueno,
  // 3) source normalizado (legacy/default).
  const normalized = diagnosticsHasEvidence(fallbackFromMemory)
    ? fallbackFromMemory
    : diagnosticsHasEvidence(fallbackFromLastGood)
      ? fallbackFromLastGood
      : fallbackFromSource;

  await writeJsonAtomicWithRetry({
    filePath: diagnosticsDbPath,
    tmpPath: diagnosticsTmpPath,
    payload: normalized,
    maxAttempts: 8,
    baseDelayMs: 120
  });

  lastGoodDiagnosticsSnapshot = cloneJson(normalized, defaultDiagnosticsData);

  return normalized;
};

const readSplitDbIntoMemory = async () => {
  await ensureSplitStorageReady();

  const previousDiagnostics = extractDiagnosticsSnapshot(
    ensureObject(db.data, mergeCoreWithDiagnostics(defaultCoreData, lastGoodDiagnosticsSnapshot))
  );

  await rawDbRead();
  const coreData = ensureObject(db.data, defaultCoreData);
  const diagnosticsData = await readDiagnosticsData({
    fallbackSource: coreData,
    memoryFallback: previousDiagnostics
  });
  db.data = mergeCoreWithDiagnostics(coreData, diagnosticsData);
  if (diagnosticsHasEvidence(diagnosticsData) || !diagnosticsHasEvidence(lastGoodDiagnosticsSnapshot)) {
    lastGoodDiagnosticsSnapshot = cloneJson(diagnosticsData, defaultDiagnosticsData);
  }
};

const resolveHistoryLimit = (value, fallback = 1000, min = 200, max = 50000) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.floor(n);
  if (bounded < min) return min;
  if (bounded > max) return max;
  return bounded;
};

const trimArrayHistoryByLimit = (arr, limit) => {
  if (!Array.isArray(arr) || !Number.isFinite(limit) || limit <= 0) return false;
  if (arr.length <= limit) return false;
  arr.splice(0, arr.length - limit);
  return true;
};

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
  await ensureSplitStorageReady();

  const merged = ensureObject(db.data, mergeCoreWithDiagnostics(defaultCoreData, defaultDiagnosticsData));
  let diagnosticsSnapshot = extractDiagnosticsSnapshot(merged);

  const diagLimit = resolveHistoryLimit(
    process.env.ARBITRAGE_DIAG_MAX_HISTORY,
    ARBITRAGE_DIAG_MAX_HISTORY_DEFAULT
  );
  trimArrayHistoryByLimit(diagnosticsSnapshot.arbitrageDiagnostics.history, diagLimit);

  const liveDiagLimit = resolveHistoryLimit(
    process.env.LIVE_ARBITRAGE_DIAG_MAX_HISTORY,
    LIVE_ARBITRAGE_DIAG_MAX_HISTORY_DEFAULT
  );
  trimArrayHistoryByLimit(diagnosticsSnapshot.liveArbitrageDiagnostics.history, liveDiagLimit);

  const execAuditLimit = resolveHistoryLimit(
    process.env.ARBITRAGE_EXEC_AUDIT_MAX_HISTORY,
    ARBITRAGE_EXEC_AUDIT_MAX_HISTORY_DEFAULT
  );
  trimArrayHistoryByLimit(diagnosticsSnapshot.arbitrageExecutionAudit.history, execAuditLimit);

  const simHistoryLimit = resolveHistoryLimit(
    process.env.LIVE_ARBITRAGE_SIM_HISTORY_LIMIT,
    LIVE_ARBITRAGE_SIM_HISTORY_LIMIT_DEFAULT
  );
  trimArrayHistoryByLimit(diagnosticsSnapshot.liveArbitrageSimulation.history, simHistoryLimit);

  if (diagnosticsHasEvidence(lastGoodDiagnosticsSnapshot) && !diagnosticsHasEvidence(diagnosticsSnapshot)) {
    diagnosticsSnapshot = ensureDiagnosticsShape(lastGoodDiagnosticsSnapshot);
  }

  const coreSnapshot = {
    ...cloneJson(defaultCoreData, defaultCoreData),
    ...extractCoreSnapshot(merged)
  };

  db.data = mergeCoreWithDiagnostics(coreSnapshot, diagnosticsSnapshot);

  await writeJsonAtomicWithRetry({
    filePath: coreDbPath,
    tmpPath: coreTmpPath,
    payload: coreSnapshot,
    maxAttempts,
    baseDelayMs
  });

  await writeJsonAtomicWithRetry({
    filePath: diagnosticsDbPath,
    tmpPath: diagnosticsTmpPath,
    payload: diagnosticsSnapshot,
    maxAttempts,
    baseDelayMs
  });

  lastGoodDiagnosticsSnapshot = cloneJson(diagnosticsSnapshot, defaultDiagnosticsData);

  return { ok: true, mode: 'split-db-write', attempt: 1 };
};

export const writeDBWithRetry = async ({ maxAttempts = 8, baseDelayMs = 120 } = {}) => {
  const op = writeQueue.then(() => runWriteWithRetry({ maxAttempts, baseDelayMs }));
  // Mantener cola viva aunque falle un write previo.
  writeQueue = op.catch(() => {});
  return op;
};

// Garantiza que TODO db.write() en el proyecto use cola + retry + fallback.
db.write = async () => {
  await writeDBWithRetry();
};

// Garantiza que TODO db.read() hidrate core + diagnostics en memoria.
db.read = async () => {
  await readSplitDbIntoMemory();
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
    db.data = mergeCoreWithDiagnostics(defaultCoreData, defaultDiagnosticsData);
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

  const normalizedDiagnostics = ensureDiagnosticsShape(db.data);
  const diagnosticsChanged = JSON.stringify(normalizedDiagnostics) !== JSON.stringify(extractDiagnosticsSnapshot(db.data));
  db.data = mergeCoreWithDiagnostics(extractCoreSnapshot(db.data), normalizedDiagnostics);
  if (diagnosticsChanged) modified = true;

  // Rotación corta de historiales diagnósticos (no afecta history de trading).
  const diagLimit = resolveHistoryLimit(
    process.env.ARBITRAGE_DIAG_MAX_HISTORY,
    ARBITRAGE_DIAG_MAX_HISTORY_DEFAULT
  );
  if (trimArrayHistoryByLimit(db.data.arbitrageDiagnostics.history, diagLimit)) {
    modified = true;
  }

  const liveDiagLimit = resolveHistoryLimit(
    process.env.LIVE_ARBITRAGE_DIAG_MAX_HISTORY,
    LIVE_ARBITRAGE_DIAG_MAX_HISTORY_DEFAULT
  );
  if (trimArrayHistoryByLimit(db.data.liveArbitrageDiagnostics.history, liveDiagLimit)) {
    modified = true;
  }

  const execAuditLimit = resolveHistoryLimit(
    process.env.ARBITRAGE_EXEC_AUDIT_MAX_HISTORY,
    ARBITRAGE_EXEC_AUDIT_MAX_HISTORY_DEFAULT
  );
  if (trimArrayHistoryByLimit(db.data.arbitrageExecutionAudit.history, execAuditLimit)) {
    modified = true;
  }

  const simHistoryLimit = resolveHistoryLimit(
    process.env.LIVE_ARBITRAGE_SIM_HISTORY_LIMIT,
    LIVE_ARBITRAGE_SIM_HISTORY_LIMIT_DEFAULT
  );
  if (trimArrayHistoryByLimit(db.data.liveArbitrageSimulation.history, simHistoryLimit)) {
    modified = true;
  }
  
  // Solo escribir si hubo cambios estructurales (evita trigger nodemon loop)
  if (modified) {
      await writeDBWithRetry();
      console.log('✅ Base de Datos split inicializada y guardada (core + diagnostics).');
  } else {
      // console.log('✅ Base de Datos LowDB (JSON) cargada.');
  }
};

export default db;
