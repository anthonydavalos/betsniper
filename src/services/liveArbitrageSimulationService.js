import db, { initDB, writeDBWithRetry } from '../db/database.js';
import { getLiveArbitragePreview } from './liveArbitrageService.js';
import {
  prepareSemiAutoTicket,
  getRealPlacementDryRun,
  cancelSemiAutoTicket
} from './bookySemiAutoService.js';
import {
  preparePinnacleSemiAutoTicket,
  getPinnacleRealPlacementDryRun,
  cancelPinnacleSemiAutoTicket
} from './pinnacleSemiAutoService.js';

const SIM_HISTORY_LIMIT = Math.max(200, Math.floor(Number(process.env.LIVE_ARBITRAGE_SIM_HISTORY_LIMIT || 3000)));
const SIM_DEFAULT_LIMIT = Math.max(1, Math.floor(Number(process.env.LIVE_ARBITRAGE_SIM_DEFAULT_LIMIT || 5)));

const nowIso = () => new Date().toISOString();

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const toNonNegativeNumber = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const safeNum = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeProvider = (provider = '') => {
  const p = String(provider || '').trim().toLowerCase();
  if (p === 'altenar' || p === 'booky') return 'booky';
  if (p === 'pinnacle') return 'pinnacle';
  return null;
};

const isLikelyUncertainError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toLowerCase();
  const status = Number(error?.statusCode || error?.diagnostic?.providerStatus || 0);

  if (code.includes('timeout') || code.includes('econnreset') || code.includes('eai_again')) return true;
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('socket hang up')) return true;
  if (status >= 500 && status < 600) return true;
  return false;
};

const ensureSimulationStore = () => {
  if (!db.data.liveArbitrageSimulation || typeof db.data.liveArbitrageSimulation !== 'object') {
    db.data.liveArbitrageSimulation = {
      history: [],
      lastRunAt: null,
      lastSummary: null
    };
  }

  if (!Array.isArray(db.data.liveArbitrageSimulation.history)) {
    db.data.liveArbitrageSimulation.history = [];
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.liveArbitrageSimulation, 'lastRunAt')) {
    db.data.liveArbitrageSimulation.lastRunAt = null;
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.liveArbitrageSimulation, 'lastSummary')) {
    db.data.liveArbitrageSimulation.lastSummary = null;
  }

  return db.data.liveArbitrageSimulation;
};

const buildOperationId = () => `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const pushTransition = (operation, toState, reason, meta = null) => {
  const fromState = operation.state;
  operation.state = toState;
  operation.transitions.push({
    at: nowIso(),
    from: fromState,
    to: toState,
    reason: reason || null,
    meta: meta || null
  });
};

const buildLegOpportunity = ({ operation, leg, stake, order }) => {
  const provider = normalizeProvider(leg?.provider);
  const legMarket = String(leg?.market || '').trim() || '1x2';
  const legSelection = String(leg?.selection || '').trim() || 'SELECCION';
  const stakeAmount = toNonNegativeNumber(stake, 0.1);
  const odd = safeNum(leg?.odd, 0);

  const common = {
    type: 'LIVE_ARBITRAGE_SIM',
    strategy: 'LIVE_ARBITRAGE_SIM',
    source: `PHASE2_SIM_${operation.id}`,
    match: operation.match,
    league: operation.league,
    market: legMarket,
    selection: legSelection,
    action: `Apostar ${legSelection}`,
    odd,
    price: odd,
    kellyStake: Math.max(0.1, Number(stakeAmount.toFixed(2))),
    ev: toNonNegativeNumber(operation.edgePercent, 0.01),
    provider: provider === 'booky' ? 'altenar' : 'pinnacle',
    eventId: provider === 'booky'
      ? String(operation.altenarId || operation.eventId || '')
      : String(operation.pinnacleId || operation.eventId || ''),
    pinnacleId: String(operation.pinnacleId || ''),
    legOrder: order
  };

  return common;
};

const runLegDryRun = async ({ operation, leg, stake, order }) => {
  const provider = normalizeProvider(leg?.provider);
  if (!provider) {
    return {
      ok: false,
      provider: leg?.provider || null,
      status: 'REJECTED',
      stage: 'provider-validation',
      message: 'Proveedor de pata no soportado para simulacion.',
      request: null,
      response: null,
      diagnostic: {
        provider: leg?.provider || null,
        allowed: ['pinnacle', 'altenar/booky']
      }
    };
  }

  const opportunity = buildLegOpportunity({ operation, leg, stake, order });
  let ticket = null;
  let dryRun = null;

  try {
    if (provider === 'booky') {
      ticket = await prepareSemiAutoTicket(opportunity);
      dryRun = await getRealPlacementDryRun(ticket.id);
    } else {
      ticket = await preparePinnacleSemiAutoTicket(opportunity);
      dryRun = await getPinnacleRealPlacementDryRun(ticket.id);
    }

    return {
      ok: true,
      provider,
      status: 'CONFIRMED',
      stage: 'dryrun-ok',
      message: 'Dry-run generado correctamente.',
      request: {
        ticketId: ticket?.id || null,
        market: opportunity.market,
        selection: opportunity.selection,
        stake: opportunity.kellyStake,
        price: opportunity.price,
        eventId: opportunity.eventId,
        pinnacleId: opportunity.pinnacleId || null,
        endpoint: provider === 'booky' ? '/api/booky/real/dryrun/:id' : '/api/pinnacle/real/dryrun/:id'
      },
      response: {
        endpoint: dryRun?.endpoint || null,
        quoteEndpoint: dryRun?.quoteEndpoint || null,
        preview: dryRun?.preview || null,
        quotePreview: dryRun?.quotePreview || null,
        payload: dryRun?.payload || null
      },
      diagnostic: null
    };
  } catch (error) {
    const uncertain = isLikelyUncertainError(error);
    return {
      ok: false,
      provider,
      status: uncertain ? 'UNCERTAIN' : 'REJECTED',
      stage: 'dryrun-error',
      message: error?.message || 'Dry-run fallido.',
      request: {
        ticketId: ticket?.id || null,
        market: opportunity.market,
        selection: opportunity.selection,
        stake: opportunity.kellyStake,
        price: opportunity.price,
        eventId: opportunity.eventId,
        pinnacleId: opportunity.pinnacleId || null,
        endpoint: provider === 'booky' ? '/api/booky/real/dryrun/:id' : '/api/pinnacle/real/dryrun/:id'
      },
      response: null,
      diagnostic: {
        code: error?.code || null,
        statusCode: Number(error?.statusCode || 0) || null,
        providerStatus: Number(error?.diagnostic?.providerStatus || 0) || null,
        providerBody: error?.diagnostic?.providerBody || null,
        requestId: error?.diagnostic?.requestId || null,
        rawDiagnostic: error?.diagnostic || null
      }
    };
  } finally {
    if (ticket?.id) {
      try {
        if (provider === 'booky') {
          await cancelSemiAutoTicket(ticket.id);
        } else {
          await cancelPinnacleSemiAutoTicket(ticket.id);
        }
      } catch (_) {
        // No bloquea simulacion: ticket temporal puede expirar o ya estar cancelado.
      }
    }
  }
};

const createOperationFromOpportunity = (opportunity, index = 0) => {
  const legs = Array.isArray(opportunity?.legs) ? opportunity.legs.slice(0, 2) : [];
  const labels = opportunity?.stakePlan?.labels || {};
  const stakes = opportunity?.stakePlan?.stakes || {};

  const legStakeBySelection = new Map();
  if (labels.cover) {
    legStakeBySelection.set(String(labels.cover).toLowerCase(), toNonNegativeNumber(stakes.cover, 0));
  }
  if (labels.opposite) {
    legStakeBySelection.set(String(labels.opposite).toLowerCase(), toNonNegativeNumber(stakes.opposite, 0));
  }

  return {
    id: buildOperationId(),
    createdAt: nowIso(),
    closedAt: null,
    state: 'OPEN',
    outcome: null,
    rank: index + 1,
    source: 'live-arbitrage-preview',
    type: opportunity?.type || null,
    market: opportunity?.market || null,
    comboCode: opportunity?.comboCode || null,
    comboLabel: opportunity?.comboLabel || null,
    eventId: opportunity?.eventId || null,
    altenarId: opportunity?.altenarId || opportunity?.eventId || null,
    pinnacleId: opportunity?.pinnacleId || null,
    match: opportunity?.match || null,
    league: opportunity?.league || null,
    liveTime: opportunity?.liveTime || null,
    score: opportunity?.score || null,
    edgePercent: safeNum(opportunity?.edgePercent, 0),
    roiPercent: safeNum(opportunity?.roiPercent, 0),
    expectedProfit: safeNum(opportunity?.expectedProfit, 0),
    guaranteedPayout: safeNum(opportunity?.guaranteedPayout, 0),
    stakePlan: opportunity?.stakePlan || null,
    transitions: [
      {
        at: nowIso(),
        from: null,
        to: 'OPEN',
        reason: 'simulation_created',
        meta: null
      }
    ],
    legs: legs.map((leg, legIndex) => ({
      order: legIndex + 1,
      market: leg?.market || null,
      selection: leg?.selection || null,
      provider: normalizeProvider(leg?.provider),
      odd: safeNum(leg?.odd, null),
      stake: toNonNegativeNumber(legStakeBySelection.get(String(leg?.selection || '').toLowerCase()), 0),
      status: 'PENDING',
      evidence: null
    }))
  };
};

const runSingleOperationSimulation = async (operation) => {
  if (!Array.isArray(operation.legs) || operation.legs.length !== 2) {
    operation.outcome = 'REJECTED';
    operation.closedAt = nowIso();
    pushTransition(operation, 'CLOSED', 'invalid_legs_count', { expected: 2, got: operation.legs?.length || 0 });
    return operation;
  }

  const first = operation.legs[0];
  const second = operation.legs[1];

  const firstResult = await runLegDryRun({
    operation,
    leg: first,
    stake: first.stake,
    order: first.order
  });

  first.status = firstResult.status;
  first.evidence = firstResult;

  if (!firstResult.ok) {
    operation.outcome = firstResult.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'REJECTED';
    operation.closedAt = nowIso();
    pushTransition(operation, 'CLOSED', 'first_leg_failed', {
      legOrder: first.order,
      status: firstResult.status,
      provider: first.provider || null
    });
    return operation;
  }

  pushTransition(operation, 'PARTIAL', 'first_leg_dryrun_ok', {
    legOrder: first.order,
    provider: first.provider || null
  });

  const secondResult = await runLegDryRun({
    operation,
    leg: second,
    stake: second.stake,
    order: second.order
  });

  second.status = secondResult.status;
  second.evidence = secondResult;

  if (secondResult.ok) {
    pushTransition(operation, 'HEDGED', 'second_leg_dryrun_ok', {
      legOrder: second.order,
      provider: second.provider || null
    });
    operation.outcome = 'CONFIRMED';
    operation.closedAt = nowIso();
    pushTransition(operation, 'CLOSED', 'dual_leg_dryrun_ok', {
      finalOutcome: 'CONFIRMED'
    });
    return operation;
  }

  pushTransition(operation, 'HEDGED', 'hedge_policy_simulated', {
    reason: 'second_leg_failed',
    hedgeTargetLeg: first.order,
    mode: 'simulated_only',
    expectedAction: 'reducir_exposicion_en_provider_de_pata_1'
  });

  operation.outcome = secondResult.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'REJECTED';
  operation.closedAt = nowIso();
  pushTransition(operation, 'CLOSED', 'second_leg_failed', {
    finalOutcome: operation.outcome,
    failedLeg: second.order,
    provider: second.provider || null
  });

  return operation;
};

const summarizeOperations = (operations = []) => {
  const summary = {
    total: 0,
    confirmed: 0,
    rejected: 0,
    uncertain: 0,
    closed: 0,
    avgEdgePercent: 0,
    avgRoiPercent: 0
  };

  if (!Array.isArray(operations) || operations.length === 0) return summary;

  let edgeAcc = 0;
  let roiAcc = 0;

  for (const op of operations) {
    summary.total += 1;
    if (op?.state === 'CLOSED') summary.closed += 1;

    const outcome = String(op?.outcome || '').toUpperCase();
    if (outcome === 'CONFIRMED') summary.confirmed += 1;
    else if (outcome === 'UNCERTAIN') summary.uncertain += 1;
    else summary.rejected += 1;

    edgeAcc += toNonNegativeNumber(op?.edgePercent, 0);
    roiAcc += toNonNegativeNumber(op?.roiPercent, 0);
  }

  summary.avgEdgePercent = Number((edgeAcc / summary.total).toFixed(3));
  summary.avgRoiPercent = Number((roiAcc / summary.total).toFixed(3));
  return summary;
};

const persistSimulationRun = async (operations = [], context = {}) => {
  const store = ensureSimulationStore();
  const now = nowIso();

  for (const op of operations) {
    store.history.push({
      ...op,
      simulationContext: {
        generatedAt: context.generatedAt || null,
        sourceCount: Number(context.sourceCount || 0),
        selectedCount: Number(context.selectedCount || 0),
        risk: context.risk || null
      }
    });
  }

  if (store.history.length > SIM_HISTORY_LIMIT) {
    store.history.splice(0, store.history.length - SIM_HISTORY_LIMIT);
  }

  store.lastRunAt = now;
  store.lastSummary = {
    generatedAt: now,
    ...summarizeOperations(operations)
  };

  await writeDBWithRetry({ maxAttempts: 8, baseDelayMs: 120 });
  return store.lastSummary;
};

const selectPhase2Candidates = (rows = [], limit = SIM_DEFAULT_LIMIT) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const twoLegOnly = rows.filter((op) => op?.type === 'SUREBET_DC_OPPOSITE_LIVE' && Array.isArray(op?.legs) && op.legs.length === 2);
  return twoLegOnly.slice(0, Math.max(1, limit));
};

export const runLiveArbitrageSimulation = async ({
  bankroll = null,
  limit = SIM_DEFAULT_LIMIT,
  minRoiPercent = null,
  minProfitAbs = null
} = {}) => {
  await initDB();
  await db.read();
  ensureSimulationStore();

  const safeLimit = toPositiveInt(limit, SIM_DEFAULT_LIMIT);

  const preview = await getLiveArbitragePreview(
    {
      bankroll,
      limit: Math.max(10, safeLimit * 3),
      minRoiPercent,
      minProfitAbs
    },
    {
      persistDiagnostics: true,
      trigger: 'scheduled',
      tag: 'phase2-simulation'
    }
  );

  const candidates = selectPhase2Candidates(preview?.data || [], safeLimit);
  const operations = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const operation = createOperationFromOpportunity(candidates[i], i);
    const finalOperation = await runSingleOperationSimulation(operation);
    operations.push(finalOperation);
  }

  const runSummary = await persistSimulationRun(operations, {
    generatedAt: preview?.generatedAt || nowIso(),
    sourceCount: Number(preview?.count || 0),
    selectedCount: operations.length,
    risk: preview?.risk || null
  });

  return {
    success: true,
    mode: 'simulation-paper-dryrun',
    generatedAt: nowIso(),
    source: {
      previewCount: Number(preview?.count || 0),
      selectedForSimulation: operations.length,
      filters: {
        type: 'SUREBET_DC_OPPOSITE_LIVE',
        legs: 2
      }
    },
    summary: runSummary,
    operations
  };
};

export const getLiveArbitrageSimulationHistory = async ({ limit = 100 } = {}) => {
  await initDB();
  await db.read();
  const store = ensureSimulationStore();
  const safeLimit = Math.min(5000, toPositiveInt(limit, 100));
  const recent = store.history.slice(-safeLimit);

  return {
    generatedAt: nowIso(),
    storedOperations: store.history.length,
    returnedOperations: recent.length,
    lastRunAt: store.lastRunAt || null,
    lastSummary: store.lastSummary || null,
    summary: summarizeOperations(recent),
    recent
  };
};

export const getLiveArbitrageSimulationSummary = async ({ windowMinutes = 180 } = {}) => {
  await initDB();
  await db.read();
  const store = ensureSimulationStore();

  const safeWindow = Math.max(10, toPositiveInt(windowMinutes, 180));
  const cutoff = Date.now() - safeWindow * 60 * 1000;
  const inWindow = store.history.filter((op) => {
    const atMs = new Date(op?.createdAt || 0).getTime();
    return Number.isFinite(atMs) && atMs >= cutoff;
  });

  return {
    generatedAt: nowIso(),
    windowMinutes: safeWindow,
    totalStored: store.history.length,
    inWindow: inWindow.length,
    summary: summarizeOperations(inWindow),
    lastRunAt: store.lastRunAt || null,
    lastSummary: store.lastSummary || null
  };
};
