import db, { initDB } from '../db/database.js';

const DEFAULT_WINDOW_MINUTES = Math.max(
  10,
  Math.floor(Number(process.env.LIVE_ARBITRAGE_DASHBOARD_WINDOW_MINUTES || 180))
);

const nowIso = () => new Date().toISOString();

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const toNumberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeProvider = (provider = '') => {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'altenar' || p === 'booky') return 'booky';
  if (p === 'pinnacle') return 'pinnacle';
  return 'unknown';
};

const toMs = (value) => {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : null;
};

const round = (value, digits = 3) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
};

const summarizeNumericSeries = (series = [], { digits = 3 } = {}) => {
  if (!Array.isArray(series) || series.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p95: null
    };
  }

  const sorted = [...series].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p95: null
    };
  }

  const count = sorted.length;
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const at = (q) => {
    if (count === 1) return sorted[0];
    const idx = Math.max(0, Math.min(count - 1, Math.floor((count - 1) * q)));
    return sorted[idx];
  };

  return {
    count,
    min: round(sorted[0], digits),
    max: round(sorted[count - 1], digits),
    avg: round(sum / count, digits),
    p50: round(at(0.5), digits),
    p95: round(at(0.95), digits)
  };
};

const inWindow = (value, cutoffMs) => {
  const ts = toMs(value);
  return Number.isFinite(ts) && ts >= cutoffMs;
};

const buildSimulationSection = ({ simHistory = [], cutoffMs }) => {
  const rows = Array.isArray(simHistory)
    ? simHistory.filter((row) => inWindow(row?.createdAt || row?.closedAt, cutoffMs))
    : [];

  const byFinalState = { open: 0, partial: 0, hedged: 0, closed: 0, other: 0 };
  const byOutcome = { confirmed: 0, rejected: 0, uncertain: 0, unknown: 0 };
  const transitionTotals = { open: 0, partial: 0, hedged: 0, closed: 0 };
  const opLatencyMs = [];

  for (const row of rows) {
    const state = String(row?.state || '').trim().toLowerCase();
    if (state === 'open') byFinalState.open += 1;
    else if (state === 'partial') byFinalState.partial += 1;
    else if (state === 'hedged') byFinalState.hedged += 1;
    else if (state === 'closed') byFinalState.closed += 1;
    else byFinalState.other += 1;

    const outcome = String(row?.outcome || '').trim().toLowerCase();
    if (outcome === 'confirmed') byOutcome.confirmed += 1;
    else if (outcome === 'rejected') byOutcome.rejected += 1;
    else if (outcome === 'uncertain') byOutcome.uncertain += 1;
    else byOutcome.unknown += 1;

    const transitions = Array.isArray(row?.transitions) ? row.transitions : [];
    for (const tr of transitions) {
      const to = String(tr?.to || '').trim().toLowerCase();
      if (to === 'open') transitionTotals.open += 1;
      else if (to === 'partial') transitionTotals.partial += 1;
      else if (to === 'hedged') transitionTotals.hedged += 1;
      else if (to === 'closed') transitionTotals.closed += 1;
    }

    const createdMs = toMs(row?.createdAt);
    const closedMs = toMs(row?.closedAt);
    if (Number.isFinite(createdMs) && Number.isFinite(closedMs) && closedMs >= createdMs) {
      opLatencyMs.push(closedMs - createdMs);
    }
  }

  return {
    operationsInWindow: rows.length,
    byFinalState,
    byOutcome,
    transitionsToState: transitionTotals,
    operationLatencyMs: summarizeNumericSeries(opLatencyMs, { digits: 1 })
  };
};

const buildExecutionAuditSection = ({ auditHistory = [], cutoffMs }) => {
  const rows = Array.isArray(auditHistory)
    ? auditHistory.filter((row) => inWindow(row?.at, cutoffMs))
    : [];

  const byStatus = {};
  const byStage = {};
  const rejectionCodes = {};
  const providerRejections = {};
  const executions = new Map();

  for (const row of rows) {
    const status = String(row?.status || 'unknown').trim().toLowerCase();
    const stage = String(row?.stage || 'unknown').trim().toLowerCase();
    const provider = normalizeProvider(row?.provider);

    byStatus[status] = (byStatus[status] || 0) + 1;
    byStage[stage] = (byStage[stage] || 0) + 1;

    const isRejected = status === 'rejected' || String(row?.outcome || '').trim().toLowerCase() === 'rejected';
    if (isRejected) {
      const code = String(row?.code || 'unknown').trim() || 'unknown';
      rejectionCodes[code] = (rejectionCodes[code] || 0) + 1;
      providerRejections[provider] = (providerRejections[provider] || 0) + 1;
    }

    const executionId = String(row?.executionId || '').trim();
    if (!executionId) continue;
    if (!executions.has(executionId)) {
      executions.set(executionId, {
        startedAtMs: toMs(row?.at),
        endedAtMs: toMs(row?.at),
        provider
      });
      continue;
    }

    const curr = executions.get(executionId);
    const atMs = toMs(row?.at);
    if (!Number.isFinite(atMs)) continue;
    if (!Number.isFinite(curr.startedAtMs) || atMs < curr.startedAtMs) curr.startedAtMs = atMs;
    if (!Number.isFinite(curr.endedAtMs) || atMs > curr.endedAtMs) curr.endedAtMs = atMs;
    if (provider !== 'unknown') curr.provider = provider;
  }

  const cycleLatencies = [];
  const cycleLatenciesByProvider = {
    booky: [],
    pinnacle: [],
    unknown: []
  };

  for (const value of executions.values()) {
    if (!Number.isFinite(value.startedAtMs) || !Number.isFinite(value.endedAtMs)) continue;
    const latency = Math.max(0, value.endedAtMs - value.startedAtMs);
    cycleLatencies.push(latency);
    if (!Array.isArray(cycleLatenciesByProvider[value.provider])) {
      cycleLatenciesByProvider[value.provider] = [];
    }
    cycleLatenciesByProvider[value.provider].push(latency);
  }

  return {
    eventsInWindow: rows.length,
    executionsInWindow: executions.size,
    byStatus,
    byStage,
    rejectionCodes,
    providerRejections,
    cycleLatencyMs: summarizeNumericSeries(cycleLatencies, { digits: 1 }),
    providerCycleLatencyMs: {
      booky: summarizeNumericSeries(cycleLatenciesByProvider.booky, { digits: 1 }),
      pinnacle: summarizeNumericSeries(cycleLatenciesByProvider.pinnacle, { digits: 1 }),
      unknown: summarizeNumericSeries(cycleLatenciesByProvider.unknown, { digits: 1 })
    }
  };
};

const extractRequestedOdd = (realPlacement = {}) => {
  const fromSelection = toNumberOrNull(realPlacement?.requested?.selections?.[0]?.price);
  if (Number.isFinite(fromSelection) && fromSelection > 1) return fromSelection;

  const fromPayload = toNumberOrNull(realPlacement?.payload?.selections?.[0]?.price);
  if (Number.isFinite(fromPayload) && fromPayload > 1) return fromPayload;

  const fromFallback = toNumberOrNull(realPlacement?.requested?.price);
  if (Number.isFinite(fromFallback) && fromFallback > 1) return fromFallback;

  return null;
};

const extractAcceptedOdd = (realPlacement = {}) => {
  const direct = toNumberOrNull(realPlacement?.accepted?.acceptedOdd);
  if (Number.isFinite(direct) && direct > 1) return direct;

  const responsePrice = toNumberOrNull(realPlacement?.response?.price);
  if (Number.isFinite(responsePrice) && responsePrice > 1) return responsePrice;

  const responseSelection = toNumberOrNull(realPlacement?.response?.selections?.[0]?.price);
  if (Number.isFinite(responseSelection) && responseSelection > 1) return responseSelection;

  const bookyBetOdd = toNumberOrNull(realPlacement?.response?.bets?.[0]?.odd);
  if (Number.isFinite(bookyBetOdd) && bookyBetOdd > 1) return bookyBetOdd;

  return null;
};

const buildSlippageSection = ({ bookyHistory = [], pinnacleHistory = [], cutoffMs }) => {
  const allRows = [
    ...(Array.isArray(bookyHistory) ? bookyHistory.map((row) => ({ provider: 'booky', row })) : []),
    ...(Array.isArray(pinnacleHistory) ? pinnacleHistory.map((row) => ({ provider: 'pinnacle', row })) : [])
  ];

  const samples = [];

  for (const item of allRows) {
    const row = item.row || {};
    const rp = row?.realPlacement;
    if (!rp || typeof rp !== 'object') continue;

    const at = rp?.placedAt || row?.confirmedAt || row?.updatedAt || row?.createdAt;
    if (!inWindow(at, cutoffMs)) continue;

    const requestedOdd = extractRequestedOdd(rp);
    const acceptedOdd = extractAcceptedOdd(rp);
    if (!Number.isFinite(requestedOdd) || !Number.isFinite(acceptedOdd) || requestedOdd <= 1 || acceptedOdd <= 1) continue;

    const points = acceptedOdd - requestedOdd;
    const pct = (points / requestedOdd) * 100;

    samples.push({
      provider: item.provider,
      requestedOdd,
      acceptedOdd,
      points,
      pct,
      at,
      ticketId: String(row?.id || '').trim() || null
    });
  }

  const pctAll = samples.map((s) => s.pct);
  const absPctAll = samples.map((s) => Math.abs(s.pct));

  const perProvider = {
    booky: samples.filter((s) => s.provider === 'booky'),
    pinnacle: samples.filter((s) => s.provider === 'pinnacle')
  };

  const providerSummary = {};
  for (const [provider, rows] of Object.entries(perProvider)) {
    providerSummary[provider] = {
      count: rows.length,
      pct: summarizeNumericSeries(rows.map((r) => r.pct), { digits: 4 }),
      absPct: summarizeNumericSeries(rows.map((r) => Math.abs(r.pct)), { digits: 4 }),
      positive: rows.filter((r) => r.pct > 0).length,
      negative: rows.filter((r) => r.pct < 0).length,
      neutral: rows.filter((r) => Math.abs(r.pct) < 1e-9).length
    };
  }

  const topAbsSamples = [...samples]
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 10)
    .map((s) => ({
      provider: s.provider,
      at: s.at,
      ticketId: s.ticketId,
      requestedOdd: round(s.requestedOdd, 4),
      acceptedOdd: round(s.acceptedOdd, 4),
      slippagePoints: round(s.points, 4),
      slippagePct: round(s.pct, 4)
    }));

  return {
    samplesInWindow: samples.length,
    slippagePct: summarizeNumericSeries(pctAll, { digits: 4 }),
    slippageAbsPct: summarizeNumericSeries(absPctAll, { digits: 4 }),
    providers: providerSummary,
    topAbsSamples
  };
};

const getRolloutFlags = () => ({
  totalsEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.LIVE_ARBITRAGE_ROLLOUT_TOTALS_ENABLED || 'false').trim().toLowerCase()),
  bttsEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.LIVE_ARBITRAGE_ROLLOUT_BTTS_ENABLED || 'false').trim().toLowerCase()),
  requireCrossProvider: !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_REQUIRE_CROSS_PROVIDER || 'true').trim().toLowerCase())
});

export const getLiveArbitrageOperationsDashboard = async ({ windowMinutes = DEFAULT_WINDOW_MINUTES } = {}) => {
  await initDB();
  await db.read();

  const safeWindow = Math.max(10, toPositiveInt(windowMinutes, DEFAULT_WINDOW_MINUTES));
  const nowMs = Date.now();
  const cutoffMs = nowMs - (safeWindow * 60 * 1000);

  const simHistory = Array.isArray(db.data?.liveArbitrageSimulation?.history)
    ? db.data.liveArbitrageSimulation.history
    : [];
  const auditHistory = Array.isArray(db.data?.arbitrageExecutionAudit?.history)
    ? db.data.arbitrageExecutionAudit.history
    : [];

  const bookyHistory = Array.isArray(db.data?.booky?.history) ? db.data.booky.history : [];
  const pinnacleHistory = Array.isArray(db.data?.pinnacle?.history) ? db.data.pinnacle.history : [];

  return {
    success: true,
    generatedAt: nowIso(),
    windowMinutes: safeWindow,
    rollout: getRolloutFlags(),
    operations: buildSimulationSection({ simHistory, cutoffMs }),
    executionAudit: buildExecutionAuditSection({ auditHistory, cutoffMs }),
    slippage: buildSlippageSection({ bookyHistory, pinnacleHistory, cutoffMs })
  };
};
