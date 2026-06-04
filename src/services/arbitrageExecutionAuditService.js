import db, { initDB, writeDBWithRetry } from '../db/database.js';

const EXEC_AUDIT_MAX_HISTORY = Math.max(
  200,
  Math.floor(Number(process.env.ARBITRAGE_EXEC_AUDIT_MAX_HISTORY || 1200))
);
const EXEC_AUDIT_RECENT_LIMIT = Math.max(
  10,
  Math.floor(Number(process.env.ARBITRAGE_EXEC_AUDIT_RECENT_LIMIT || 150))
);
const EXEC_AUDIT_SUMMARY_WINDOW_MINUTES = Math.max(
  10,
  Math.floor(Number(process.env.ARBITRAGE_EXEC_AUDIT_SUMMARY_WINDOW_MINUTES || 180))
);

const nowIso = () => new Date().toISOString();

const clampPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const ensureExecutionAuditStore = () => {
  if (!db.data.arbitrageExecutionAudit || typeof db.data.arbitrageExecutionAudit !== 'object') {
    db.data.arbitrageExecutionAudit = {
      history: [],
      lastUpdatedAt: null,
      lastSummary: null
    };
  }

  if (!Array.isArray(db.data.arbitrageExecutionAudit.history)) {
    db.data.arbitrageExecutionAudit.history = [];
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.arbitrageExecutionAudit, 'lastUpdatedAt')) {
    db.data.arbitrageExecutionAudit.lastUpdatedAt = null;
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.arbitrageExecutionAudit, 'lastSummary')) {
    db.data.arbitrageExecutionAudit.lastSummary = null;
  }

  return db.data.arbitrageExecutionAudit;
};

const toNullableNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeStringOrNull = (value) => {
  const str = String(value || '').trim();
  return str || null;
};

const normalizeArrayStrings = (values = []) => {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item || '').trim())
    .filter(Boolean);
};

const summarizeExecutionAudit = (history = [], { windowMinutes = EXEC_AUDIT_SUMMARY_WINDOW_MINUTES } = {}) => {
  const windowSafe = clampPositiveInt(windowMinutes, EXEC_AUDIT_SUMMARY_WINDOW_MINUTES);
  const nowMs = Date.now();
  const windowStartMs = nowMs - (windowSafe * 60 * 1000);

  const inWindow = history.filter((row) => {
    const ts = new Date(row?.at || 0).getTime();
    return Number.isFinite(ts) && ts >= windowStartMs;
  });

  const byStatus = {};
  const byStage = {};
  const executionIds = new Set();

  for (const row of inWindow) {
    const status = String(row?.status || 'unknown').toLowerCase();
    const stage = String(row?.stage || 'unknown').toLowerCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
    byStage[stage] = (byStage[stage] || 0) + 1;
    if (row?.executionId) executionIds.add(String(row.executionId));
  }

  return {
    windowMinutes: windowSafe,
    eventsInWindow: inWindow.length,
    executionsInWindow: executionIds.size,
    byStatus,
    byStage
  };
};

const buildEventRow = (event = {}) => {
  const executionId = normalizeStringOrNull(event.executionId);
  if (!executionId) {
    const error = new Error('executionId es obligatorio para auditar ejecución dual.');
    error.statusCode = 400;
    throw error;
  }

  return {
    id: `ax_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: normalizeStringOrNull(event.at) || nowIso(),
    executionId,
    executionKey: normalizeStringOrNull(event.executionKey),
    stage: normalizeStringOrNull(event.stage) || 'info',
    status: normalizeStringOrNull(event.status) || 'info',
    reason: normalizeStringOrNull(event.reason),
    message: normalizeStringOrNull(event.message),
    provider: normalizeStringOrNull(event.provider),
    outcome: normalizeStringOrNull(event.outcome),
    code: normalizeStringOrNull(event.code),
    ticketId: normalizeStringOrNull(event.ticketId),
    match: normalizeStringOrNull(event.match),
    eventId: normalizeStringOrNull(event.eventId),
    pinnacleId: normalizeStringOrNull(event.pinnacleId),
    comboCode: normalizeStringOrNull(event.comboCode),
    baseRoi: toNullableNumber(event.baseRoi),
    baseProfit: toNullableNumber(event.baseProfit),
    liveRoi: toNullableNumber(event.liveRoi),
    liveProfit: toNullableNumber(event.liveProfit),
    previewSnapshotIds: normalizeArrayStrings(event.previewSnapshotIds),
    preflightSnapshotIds: normalizeArrayStrings(event.preflightSnapshotIds),
    meta: event?.meta && typeof event.meta === 'object' ? event.meta : null
  };
};

const findTicketById = (ticketId, rows = [], provider = null) => {
  const id = String(ticketId || '').trim();
  if (!id || !Array.isArray(rows)) return null;

  const found = rows.find((row) => String(row?.id || '').trim() === id);
  if (!found) return null;

  return {
    id: String(found?.id || ''),
    status: found?.status || null,
    createdAt: found?.createdAt || null,
    updatedAt: found?.updatedAt || null,
    provider: provider || null,
    providerBetId: found?.realPlacement?.providerBetId || found?.providerBetId || null,
    requestId: found?.realPlacement?.requestId || found?.providerRequestId || null,
    match: found?.opportunity?.match || found?.match || null,
    selection: found?.opportunity?.selection || found?.selection || null,
    market: found?.opportunity?.market || found?.market || null,
    diagnostic: found?.realPlacement?.diagnostic || null
  };
};

const buildPlacementCorrelation = (events = []) => {
  const ticketIds = Array.from(new Set(
    events
      .map((row) => String(row?.ticketId || '').trim())
      .filter(Boolean)
  ));

  if (ticketIds.length === 0) return [];

  const bookyPending = Array.isArray(db.data?.booky?.pendingTickets) ? db.data.booky.pendingTickets : [];
  const bookyHistory = Array.isArray(db.data?.booky?.history) ? db.data.booky.history : [];
  const pinnaclePending = Array.isArray(db.data?.pinnacle?.pendingTickets) ? db.data.pinnacle.pendingTickets : [];
  const pinnacleHistory = Array.isArray(db.data?.pinnacle?.history) ? db.data.pinnacle.history : [];

  return ticketIds.map((ticketId) => {
    const fromBookyPending = findTicketById(ticketId, bookyPending, 'booky');
    if (fromBookyPending) return fromBookyPending;

    const fromBookyHistory = findTicketById(ticketId, bookyHistory, 'booky');
    if (fromBookyHistory) return fromBookyHistory;

    const fromPinnaclePending = findTicketById(ticketId, pinnaclePending, 'pinnacle');
    if (fromPinnaclePending) return fromPinnaclePending;

    const fromPinnacleHistory = findTicketById(ticketId, pinnacleHistory, 'pinnacle');
    if (fromPinnacleHistory) return fromPinnacleHistory;

    return {
      id: ticketId,
      status: 'NOT_FOUND_IN_DB',
      provider: null
    };
  });
};

const buildSnapshotCorrelation = (events = []) => {
  const snapshotIds = Array.from(new Set(
    events.flatMap((row) => [
      ...(Array.isArray(row?.previewSnapshotIds) ? row.previewSnapshotIds : []),
      ...(Array.isArray(row?.preflightSnapshotIds) ? row.preflightSnapshotIds : [])
    ])
  ));

  if (snapshotIds.length === 0) {
    return {
      snapshotIds: [],
      snapshots: []
    };
  }

  const diagHistory = Array.isArray(db.data?.arbitrageDiagnostics?.history)
    ? db.data.arbitrageDiagnostics.history
    : [];

  const snapshots = snapshotIds
    .map((snapshotId) => {
      const row = diagHistory.find((item) => String(item?.id || '').trim() === snapshotId);
      if (!row) {
        return {
          id: snapshotId,
          found: false
        };
      }

      return {
        id: snapshotId,
        found: true,
        at: row?.at || null,
        trigger: row?.trigger || null,
        count: Number(row?.result?.count || 0),
        topMatch: row?.topOpportunities?.[0]?.match || null,
        topType: row?.topOpportunities?.[0]?.type || null
      };
    });

  return {
    snapshotIds,
    snapshots
  };
};

export const appendArbitrageExecutionAuditEvent = async (event = {}) => {
  await initDB();
  await db.read();

  const store = ensureExecutionAuditStore();
  const row = buildEventRow(event);

  store.history.push(row);
  if (store.history.length > EXEC_AUDIT_MAX_HISTORY) {
    store.history.splice(0, store.history.length - EXEC_AUDIT_MAX_HISTORY);
  }

  store.lastUpdatedAt = row.at;
  store.lastSummary = summarizeExecutionAudit(store.history, {
    windowMinutes: EXEC_AUDIT_SUMMARY_WINDOW_MINUTES
  });

  await writeDBWithRetry();

  return {
    ok: true,
    event: row
  };
};

export const getArbitrageExecutionAuditByExecutionId = async (executionId, { includeCorrelations = true } = {}) => {
  await initDB();
  await db.read();

  const store = ensureExecutionAuditStore();
  const normalizedExecutionId = normalizeStringOrNull(executionId);
  if (!normalizedExecutionId) {
    const error = new Error('executionId es obligatorio.');
    error.statusCode = 400;
    throw error;
  }

  const timeline = store.history
    .filter((row) => String(row?.executionId || '').trim() === normalizedExecutionId)
    .sort((a, b) => new Date(a?.at || 0).getTime() - new Date(b?.at || 0).getTime());

  const byStatus = {};
  const byStage = {};
  for (const row of timeline) {
    const status = String(row?.status || 'unknown').toLowerCase();
    const stage = String(row?.stage || 'unknown').toLowerCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
    byStage[stage] = (byStage[stage] || 0) + 1;
  }

  const payload = {
    executionId: normalizedExecutionId,
    count: timeline.length,
    timeline,
    summary: {
      byStatus,
      byStage,
      startedAt: timeline[0]?.at || null,
      endedAt: timeline[timeline.length - 1]?.at || null
    }
  };

  if (includeCorrelations) {
    payload.correlations = {
      ...buildSnapshotCorrelation(timeline),
      placements: buildPlacementCorrelation(timeline)
    };
  }

  return payload;
};

export const getArbitrageExecutionAuditRecent = async ({ limit = EXEC_AUDIT_RECENT_LIMIT } = {}) => {
  await initDB();
  await db.read();

  const store = ensureExecutionAuditStore();
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || EXEC_AUDIT_RECENT_LIMIT)));

  const latestByExecution = new Map();
  for (let i = store.history.length - 1; i >= 0; i -= 1) {
    const row = store.history[i];
    const key = String(row?.executionId || '').trim();
    if (!key || latestByExecution.has(key)) continue;
    latestByExecution.set(key, row);
    if (latestByExecution.size >= safeLimit) break;
  }

  const items = Array.from(latestByExecution.values())
    .sort((a, b) => new Date(b?.at || 0).getTime() - new Date(a?.at || 0).getTime());

  return {
    limit: safeLimit,
    totalEvents: store.history.length,
    totalExecutions: latestByExecution.size,
    items,
    lastUpdatedAt: store.lastUpdatedAt || null,
    summary: store.lastSummary || null
  };
};
