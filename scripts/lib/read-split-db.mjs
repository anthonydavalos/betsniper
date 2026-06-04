import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const legacyDbPath = path.join(projectRoot, 'db.json');
const coreDbPath = path.join(projectRoot, 'db-core.json');
const diagnosticsDbPath = path.join(projectRoot, 'db-diagnostics.json');
const coreTmpPath = path.join(projectRoot, '.db-core.json.tmp');
const diagnosticsTmpPath = path.join(projectRoot, '.db-diagnostics.json.tmp');

const DIAGNOSTICS_KEYS = [
  'arbitrageDiagnostics',
  'liveArbitrageDiagnostics',
  'arbitrageExecutionAudit',
  'liveArbitrageSimulation'
];

export const DEFAULT_CORE_DATA = {
  config: {
    bankroll: 100,
    kellyFraction: 0.25
  },
  mappedTeams: {
    'Man City': 'Manchester City'
  },
  upcomingMatches: [],
  altenarUpcoming: [],
  liveTracking: [],
  blacklist: [],
  portfolio: {
    balance: 100,
    initialCapital: 100,
    activeBets: [],
    history: []
  },
  booky: {
    pendingTickets: [],
    history: []
  },
  pinnacle: {
    pendingTickets: [],
    history: []
  }
};

export const DEFAULT_DIAGNOSTICS_DATA = {
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

const cloneJson = (value, fallback = {}) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
};

const ensureObject = (value, fallback = {}) => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : cloneJson(fallback, fallback);
};

const normalizeDiagnostics = (candidate = {}) => {
  const src = ensureObject(candidate, DEFAULT_DIAGNOSTICS_DATA);

  const arbitrageDiagnostics = ensureObject(src.arbitrageDiagnostics, DEFAULT_DIAGNOSTICS_DATA.arbitrageDiagnostics);
  if (!Array.isArray(arbitrageDiagnostics.history)) arbitrageDiagnostics.history = [];
  if (!Object.prototype.hasOwnProperty.call(arbitrageDiagnostics, 'lastInventoryAt')) arbitrageDiagnostics.lastInventoryAt = null;
  if (!Object.prototype.hasOwnProperty.call(arbitrageDiagnostics, 'lastSummary')) arbitrageDiagnostics.lastSummary = null;

  const liveArbitrageDiagnostics = ensureObject(src.liveArbitrageDiagnostics, DEFAULT_DIAGNOSTICS_DATA.liveArbitrageDiagnostics);
  if (!Array.isArray(liveArbitrageDiagnostics.history)) liveArbitrageDiagnostics.history = [];
  if (!Object.prototype.hasOwnProperty.call(liveArbitrageDiagnostics, 'lastInventoryAt')) liveArbitrageDiagnostics.lastInventoryAt = null;
  if (!Object.prototype.hasOwnProperty.call(liveArbitrageDiagnostics, 'lastSummary')) liveArbitrageDiagnostics.lastSummary = null;

  const arbitrageExecutionAudit = ensureObject(src.arbitrageExecutionAudit, DEFAULT_DIAGNOSTICS_DATA.arbitrageExecutionAudit);
  if (!Array.isArray(arbitrageExecutionAudit.history)) arbitrageExecutionAudit.history = [];
  if (!Object.prototype.hasOwnProperty.call(arbitrageExecutionAudit, 'lastUpdatedAt')) arbitrageExecutionAudit.lastUpdatedAt = null;
  if (!Object.prototype.hasOwnProperty.call(arbitrageExecutionAudit, 'lastSummary')) arbitrageExecutionAudit.lastSummary = null;

  const liveArbitrageSimulation = ensureObject(src.liveArbitrageSimulation, DEFAULT_DIAGNOSTICS_DATA.liveArbitrageSimulation);
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

const extractCoreSnapshot = (merged = {}) => {
  const source = ensureObject(merged, DEFAULT_CORE_DATA);
  const next = { ...source };
  for (const key of DIAGNOSTICS_KEYS) {
    delete next[key];
  }
  return next;
};

const extractDiagnosticsSnapshot = (merged = {}) => {
  const source = ensureObject(merged, {});
  const picked = {};
  for (const key of DIAGNOSTICS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      picked[key] = source[key];
    }
  }
  return normalizeDiagnostics(picked);
};

const readJsonSafe = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const mergeCoreWithDiagnostics = (core = {}, diagnostics = {}) => ({
  ...(core && typeof core === 'object' ? core : {}),
  ...(diagnostics && typeof diagnostics === 'object' ? diagnostics : {})
});

const writeJsonAtomicSync = (filePath, tmpPath, payload) => {
  const serialized = `${JSON.stringify(payload ?? {}, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    fs.writeFileSync(filePath, serialized, 'utf8');
  }
};

export const getSplitDbPaths = () => ({
  legacyDbPath,
  coreDbPath,
  diagnosticsDbPath
});

export const readMergedDbSync = () => {
  const core = readJsonSafe(coreDbPath);
  const diagnostics = readJsonSafe(diagnosticsDbPath);

  if (core || diagnostics) {
    const normalizedCore = {
      ...cloneJson(DEFAULT_CORE_DATA, DEFAULT_CORE_DATA),
      ...ensureObject(core, {})
    };
    return mergeCoreWithDiagnostics(normalizedCore, normalizeDiagnostics(diagnostics || {}));
  }

  const legacy = readJsonSafe(legacyDbPath) || {};
  const coreFromLegacy = {
    ...cloneJson(DEFAULT_CORE_DATA, DEFAULT_CORE_DATA),
    ...extractCoreSnapshot(legacy)
  };
  return mergeCoreWithDiagnostics(coreFromLegacy, normalizeDiagnostics(legacy));
};

export const writeMergedDbSync = (mergedDb = {}, { writeLegacyMirror = false } = {}) => {
  const coreCurrent = readJsonSafe(coreDbPath) || {};
  const diagnosticsCurrent = normalizeDiagnostics(readJsonSafe(diagnosticsDbPath) || {});

  const corePayload = {
    ...cloneJson(DEFAULT_CORE_DATA, DEFAULT_CORE_DATA),
    ...ensureObject(coreCurrent, {}),
    ...extractCoreSnapshot(mergedDb)
  };

  const diagnosticsPayload = normalizeDiagnostics({
    ...diagnosticsCurrent,
    ...extractDiagnosticsSnapshot(mergedDb)
  });

  writeJsonAtomicSync(coreDbPath, coreTmpPath, corePayload);
  writeJsonAtomicSync(diagnosticsDbPath, diagnosticsTmpPath, diagnosticsPayload);

  if (writeLegacyMirror) {
    writeJsonAtomicSync(
      legacyDbPath,
      path.join(projectRoot, '.db.json.tmp'),
      mergeCoreWithDiagnostics(corePayload, diagnosticsPayload)
    );
  }

  return {
    corePath: coreDbPath,
    diagnosticsPath: diagnosticsDbPath,
    legacyPath: legacyDbPath
  };
};
