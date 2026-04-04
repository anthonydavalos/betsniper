import db, { initDB, writeDBWithRetry } from '../db/database.js';

const DEFAULT_PREVIEW_LIMIT = 50;
const MAX_PREVIEW_LIMIT = 500;
const ARBITRAGE_PREMATCH_START_GRACE_MINUTES = Math.max(
  0,
  Math.floor(Number(process.env.ARBITRAGE_PREMATCH_START_GRACE_MINUTES || 0))
);
const ARBITRAGE_DIAG_MAX_HISTORY = Math.max(
  200,
  Math.floor(Number(process.env.ARBITRAGE_DIAG_MAX_HISTORY || 5000))
);
const ARBITRAGE_DIAG_DEFAULT_LIMIT = 200;
const ARBITRAGE_DIAG_DEFAULT_SUMMARY_WINDOW_MINUTES = Math.max(
  10,
  Math.floor(Number(process.env.ARBITRAGE_DIAG_SUMMARY_WINDOW_MINUTES || 180))
);
const ARBITRAGE_ALTENAR_MAX_ODD_AGE_MS = Math.max(
  60000,
  Math.floor(Number(process.env.ARBITRAGE_ALTENAR_MAX_ODD_AGE_MS || 900000))
);
const DC_OPPOSITE_COMBOS = [
  {
    code: '1X_PLUS_AWAY',
    label: '1X + Away',
    dcKey: 'homeDraw',
    dcSelection: '1X',
    oppositeKey: 'away',
    oppositeSelection: 'Away'
  },
  {
    code: 'X2_PLUS_HOME',
    label: 'X2 + Home',
    dcKey: 'drawAway',
    dcSelection: 'X2',
    oppositeKey: 'home',
    oppositeSelection: 'Home'
  },
  {
    code: '12_PLUS_DRAW',
    label: '12 + Draw',
    dcKey: 'homeAway',
    dcSelection: '12',
    oppositeKey: 'draw',
    oppositeSelection: 'Draw'
  }
];

const toNumber = (value, fallback = NaN) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toNonNegative = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const safePositiveOdd = (value) => {
  const n = toNumber(value, NaN);
  if (!Number.isFinite(n) || n <= 1) return null;
  return n;
};

const normalizeText = (value = '') => String(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeTeam = (value = '') => normalizeText(value)
  .replace(/\b(fc|cf|sc|ac|cd|club|futbol|football|deportivo)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const splitVsName = (name = '') => {
  const raw = String(name || '');
  const parts = raw.split(/\s+vs\.?\s+/i);
  return {
    home: String(parts[0] || '').trim(),
    away: String(parts[1] || '').trim()
  };
};

const teamSimilarity = (a = '', b = '') => {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const token of ta) {
    if (tb.has(token)) common += 1;
  }
  return common / Math.max(ta.size, tb.size);
};

const resolveOrientation = ({ pinHome = '', pinAway = '', altName = '' } = {}) => {
  const sides = splitVsName(altName);
  if (!sides.home || !sides.away) return { orientation: 'unknown', confidence: 0 };

  const normalScore = teamSimilarity(pinHome, sides.home) + teamSimilarity(pinAway, sides.away);
  const swappedScore = teamSimilarity(pinHome, sides.away) + teamSimilarity(pinAway, sides.home);

  if (normalScore < 0.8 && swappedScore < 0.8) {
    return {
      orientation: 'unknown',
      confidence: Number(Math.max(normalScore, swappedScore).toFixed(3))
    };
  }

  if (swappedScore > normalScore + 0.15) {
    return {
      orientation: 'swapped',
      confidence: Number(swappedScore.toFixed(3))
    };
  }

  return {
    orientation: 'normal',
    confidence: Number(normalScore.toFixed(3))
  };
};

const chooseBestOdd = ({ pinnacleOdd, altenarOdd } = {}) => {
  const pin = safePositiveOdd(pinnacleOdd);
  const alt = safePositiveOdd(altenarOdd);

  if (!pin && !alt) return null;
  if (!pin) return { provider: 'altenar', odd: alt };
  if (!alt) return { provider: 'pinnacle', odd: pin };

  if (alt > pin) return { provider: 'altenar', odd: alt };
  return { provider: 'pinnacle', odd: pin };
};

const buildThreeLegStakePlan = ({ bankroll, bestOdds } = {}) => {
  const base = toNumber(bankroll, NaN);
  if (!Number.isFinite(base) || base <= 0) return null;

  const oHome = safePositiveOdd(bestOdds?.home?.odd);
  const oDraw = safePositiveOdd(bestOdds?.draw?.odd);
  const oAway = safePositiveOdd(bestOdds?.away?.odd);
  if (!oHome || !oDraw || !oAway) return null;

  const impliedSum = (1 / oHome) + (1 / oDraw) + (1 / oAway);
  if (!(impliedSum < 1)) return null;

  const rawStakes = {
    home: base * ((1 / oHome) / impliedSum),
    draw: base * ((1 / oDraw) / impliedSum),
    away: base * ((1 / oAway) / impliedSum)
  };

  // Redondeo operativo: centavos para stake por pata.
  const rounded = {
    home: Number(rawStakes.home.toFixed(2)),
    draw: Number(rawStakes.draw.toFixed(2)),
    away: Number(rawStakes.away.toFixed(2))
  };

  // Ajuste de residuos para mantener suma exacta del bankroll en centavos.
  const sumRounded = rounded.home + rounded.draw + rounded.away;
  const diff = Number((base - sumRounded).toFixed(2));
  if (Math.abs(diff) > 0) {
    const targetLeg = Object.entries(bestOdds)
      .map(([key, val]) => ({ key, odd: safePositiveOdd(val?.odd) || 0 }))
      .sort((a, b) => b.odd - a.odd)[0]?.key || 'home';
    rounded[targetLeg] = Number((rounded[targetLeg] + diff).toFixed(2));
  }

  const payoutHome = Number((rounded.home * oHome).toFixed(2));
  const payoutDraw = Number((rounded.draw * oDraw).toFixed(2));
  const payoutAway = Number((rounded.away * oAway).toFixed(2));
  const guaranteedPayout = Number(Math.min(payoutHome, payoutDraw, payoutAway).toFixed(2));
  const expectedProfit = Number((guaranteedPayout - base).toFixed(2));
  const roiPercent = Number(((expectedProfit / base) * 100).toFixed(3));
  const edgePercent = Number(((1 - impliedSum) * 100).toFixed(3));

  return {
    impliedSum: Number(impliedSum.toFixed(6)),
    edgePercent,
    stakes: rounded,
    payouts: {
      home: payoutHome,
      draw: payoutDraw,
      away: payoutAway
    },
    guaranteedPayout,
    expectedProfit,
    roiPercent
  };
};

const buildTwoLegStakePlan = ({ bankroll, bestOdds } = {}) => {
  const base = toNumber(bankroll, NaN);
  if (!Number.isFinite(base) || base <= 0) return null;

  const oCover = safePositiveOdd(bestOdds?.cover?.odd);
  const oOpposite = safePositiveOdd(bestOdds?.opposite?.odd);
  if (!oCover || !oOpposite) return null;

  const impliedSum = (1 / oCover) + (1 / oOpposite);
  if (!(impliedSum < 1)) return null;

  const rawStakes = {
    cover: base * ((1 / oCover) / impliedSum),
    opposite: base * ((1 / oOpposite) / impliedSum)
  };

  const rounded = {
    cover: Number(rawStakes.cover.toFixed(2)),
    opposite: Number(rawStakes.opposite.toFixed(2))
  };

  const sumRounded = rounded.cover + rounded.opposite;
  const diff = Number((base - sumRounded).toFixed(2));
  if (Math.abs(diff) > 0) {
    const targetLeg = oOpposite >= oCover ? 'opposite' : 'cover';
    rounded[targetLeg] = Number((rounded[targetLeg] + diff).toFixed(2));
  }

  const payoutCover = Number((rounded.cover * oCover).toFixed(2));
  const payoutOpposite = Number((rounded.opposite * oOpposite).toFixed(2));
  const guaranteedPayout = Number(Math.min(payoutCover, payoutOpposite).toFixed(2));
  const expectedProfit = Number((guaranteedPayout - base).toFixed(2));
  const roiPercent = Number(((expectedProfit / base) * 100).toFixed(3));
  const edgePercent = Number(((1 - impliedSum) * 100).toFixed(3));

  return {
    impliedSum: Number(impliedSum.toFixed(6)),
    edgePercent,
    stakes: rounded,
    payouts: {
      cover: payoutCover,
      opposite: payoutOpposite
    },
    guaranteedPayout,
    expectedProfit,
    roiPercent
  };
};

const getDoubleChanceOdd = ({ odds = {}, key = '' } = {}) => {
  const source = odds || {};
  if (key === 'homeDraw') {
    return safePositiveOdd(source.homeDraw ?? source['1X'] ?? source['1x'] ?? source.home_draw);
  }
  if (key === 'homeAway') {
    return safePositiveOdd(source.homeAway ?? source['12'] ?? source.home_away);
  }
  if (key === 'drawAway') {
    return safePositiveOdd(source.drawAway ?? source['X2'] ?? source['x2'] ?? source.draw_away);
  }
  return null;
};

const normalizeDoubleChanceOdds = (doubleChance = {}) => ({
  homeDraw: getDoubleChanceOdd({ odds: doubleChance, key: 'homeDraw' }),
  homeAway: getDoubleChanceOdd({ odds: doubleChance, key: 'homeAway' }),
  drawAway: getDoubleChanceOdd({ odds: doubleChance, key: 'drawAway' })
});

const mapDoubleChanceByOrientation = ({ doubleChance = {}, orientation = 'normal' } = {}) => {
  const normalized = normalizeDoubleChanceOdds(doubleChance);
  if (orientation === 'swapped') {
    // En swap, 1X <-> X2 porque home/away se invierten; 12 permanece igual.
    return {
      homeDraw: normalized.drawAway,
      homeAway: normalized.homeAway,
      drawAway: normalized.homeDraw
    };
  }
  return normalized;
};

const ensureArbitrageDiagnosticsStore = () => {
  if (!db.data.arbitrageDiagnostics || typeof db.data.arbitrageDiagnostics !== 'object') {
    db.data.arbitrageDiagnostics = {
      history: [],
      lastInventoryAt: null,
      lastSummary: null
    };
  }

  if (!Array.isArray(db.data.arbitrageDiagnostics.history)) {
    db.data.arbitrageDiagnostics.history = [];
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.arbitrageDiagnostics, 'lastInventoryAt')) {
    db.data.arbitrageDiagnostics.lastInventoryAt = null;
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.arbitrageDiagnostics, 'lastSummary')) {
    db.data.arbitrageDiagnostics.lastSummary = null;
  }

  return db.data.arbitrageDiagnostics;
};

const clampPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const summarizeArbitrageDiagnostics = (history = [], { windowMinutes = ARBITRAGE_DIAG_DEFAULT_SUMMARY_WINDOW_MINUTES } = {}) => {
  const windowSafe = clampPositiveInt(windowMinutes, ARBITRAGE_DIAG_DEFAULT_SUMMARY_WINDOW_MINUTES);
  const nowMs = Date.now();
  const windowStartMs = nowMs - (windowSafe * 60 * 1000);

  const inWindow = history.filter((row) => {
    const ts = new Date(row?.at || 0).getTime();
    return Number.isFinite(ts) && ts >= windowStartMs;
  });

  const reasonTotals = {};
  const generatedTotals = {
    surebet1x2: 0,
    surebetDcOpposite: 0
  };

  let withOps = 0;
  let zeroOps = 0;
  let eligibleRowsSum = 0;

  for (const row of inWindow) {
    const count = Number(row?.result?.count || 0);
    if (count > 0) withOps += 1;
    else zeroOps += 1;

    eligibleRowsSum += Number(row?.diagnostics?.eligiblePinnacleRows || 0);

    const generatedByType = row?.diagnostics?.generatedByType || {};
    generatedTotals.surebet1x2 += Number(generatedByType?.surebet1x2 || 0);
    generatedTotals.surebetDcOpposite += Number(generatedByType?.surebetDcOpposite || 0);

    const reasons = row?.rejections || {};
    Object.entries(reasons).forEach(([key, val]) => {
      const num = Number(val || 0);
      if (!Number.isFinite(num) || num <= 0) return;
      reasonTotals[key] = (reasonTotals[key] || 0) + num;
    });
  }

  return {
    windowMinutes: windowSafe,
    snapshotsInWindow: inWindow.length,
    withOpportunities: withOps,
    zeroOpportunities: zeroOps,
    avgEligiblePinnacleRows: inWindow.length > 0
      ? Number((eligibleRowsSum / inWindow.length).toFixed(2))
      : 0,
    generatedTotals,
    rejectionReasonTotals: reasonTotals
  };
};

const buildRejectionBreakdown = (diagnostics = {}) => {
  const generatedByType = diagnostics?.generatedByType || {};
  const generatedTotal = Number(generatedByType?.surebet1x2 || 0) + Number(generatedByType?.surebetDcOpposite || 0);

  return {
    startedAt: Number(diagnostics?.skippedByStartedAt || 0),
    invalidDate: Number(diagnostics?.skippedByInvalidDate || 0),
    unlinked: Number(diagnostics?.skippedUnlinked || 0),
    staleAltenar: Number(diagnostics?.skippedStaleAltenar || 0),
    orientation: Number(diagnostics?.skippedOrientation || 0),
    missingOdds1x2: Number(diagnostics?.skippedMissingOdds1x2 || 0),
    missingOddsDcOpposite: Number(diagnostics?.skippedMissingOddsDcOpposite || 0),
    filteredByRisk: Number(diagnostics?.filteredByRisk || 0),
    noSurebetEdge: generatedTotal <= 0 ? 1 : 0
  };
};

const persistArbitrageDiagnosticSnapshot = async ({
  payload,
  query,
  trigger = 'request',
  tag = null
} = {}) => {
  if (!payload || !payload?.diagnostics) return;

  ensureArbitrageDiagnosticsStore();
  const store = db.data.arbitrageDiagnostics;

  const row = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: payload.generatedAt || new Date().toISOString(),
    trigger: String(trigger || 'request').toLowerCase(),
    tag: tag ? String(tag) : null,
    query: {
      bankroll: Number(query?.bankroll || 0),
      limit: Number(query?.limit || 0),
      minRoiPercent: Number(query?.minRoiPercent || 0),
      minProfitAbs: Number(query?.minProfitAbs || 0)
    },
    result: {
      count: Number(payload?.count || 0),
      source: payload?.source || null,
      market: payload?.market || null
    },
    diagnostics: payload.diagnostics,
    rejections: buildRejectionBreakdown(payload.diagnostics)
  };

  store.history.push(row);
  if (store.history.length > ARBITRAGE_DIAG_MAX_HISTORY) {
    store.history.splice(0, store.history.length - ARBITRAGE_DIAG_MAX_HISTORY);
  }

  if (row.trigger === 'scheduled') {
    store.lastInventoryAt = row.at;
  }

  store.lastSummary = summarizeArbitrageDiagnostics(store.history, {
    windowMinutes: ARBITRAGE_DIAG_DEFAULT_SUMMARY_WINDOW_MINUTES
  });

  await writeDBWithRetry();
};

export const getArbitrageDiagnosticsReport = async ({
  limit = ARBITRAGE_DIAG_DEFAULT_LIMIT,
  trigger = 'all',
  windowMinutes = ARBITRAGE_DIAG_DEFAULT_SUMMARY_WINDOW_MINUTES
} = {}) => {
  await initDB();
  await db.read();

  const store = ensureArbitrageDiagnosticsStore();
  const safeLimit = Math.min(5000, clampPositiveInt(limit, ARBITRAGE_DIAG_DEFAULT_LIMIT));
  const triggerKey = String(trigger || 'all').trim().toLowerCase();

  const filtered = triggerKey === 'all'
    ? store.history
    : store.history.filter((row) => String(row?.trigger || '').toLowerCase() === triggerKey);

  const recent = filtered.slice(-safeLimit);
  const summary = summarizeArbitrageDiagnostics(filtered, { windowMinutes });

  return {
    generatedAt: new Date().toISOString(),
    trigger: triggerKey,
    storedSnapshots: store.history.length,
    filteredSnapshots: filtered.length,
    returnedSnapshots: recent.length,
    lastInventoryAt: store.lastInventoryAt || null,
    summary,
    recent
  };
};

export const runArbitrageDiagnosticsInventory = async ({
  bankroll = null,
  limit = DEFAULT_PREVIEW_LIMIT,
  minRoiPercent = null,
  minProfitAbs = null,
  tag = 'scheduler'
} = {}) => {
  const payload = await getArbitragePreview1x2(
    {
      bankroll,
      limit,
      minRoiPercent,
      minProfitAbs
    },
    {
      persistDiagnostics: true,
      trigger: 'scheduled',
      tag
    }
  );

  return {
    ok: true,
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    count: Number(payload?.count || 0),
    diagnostics: payload?.diagnostics || null
  };
};

const getDefaultBankroll = () => {
  const configBankroll = toNumber(db.data?.config?.bankroll, NaN);
  if (Number.isFinite(configBankroll) && configBankroll > 0) return Number(configBankroll);
  return 100;
};

export const getArbitragePreview1x2 = async ({
  bankroll = null,
  limit = DEFAULT_PREVIEW_LIMIT,
  minRoiPercent = null,
  minProfitAbs = null
} = {}, {
  persistDiagnostics = true,
  trigger = 'request',
  tag = null
} = {}) => {
  await initDB();
  await db.read();

  const maxItems = (() => {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_LIMIT;
    if (parsed <= 0) return DEFAULT_PREVIEW_LIMIT;
    return Math.min(MAX_PREVIEW_LIMIT, Math.floor(parsed));
  })();

  const stakeBankroll = (() => {
    const parsed = Number(bankroll);
    if (!Number.isFinite(parsed) || parsed <= 0) return getDefaultBankroll();
    return Number(parsed);
  })();

  const riskThresholds = {
    minRoiPercent: toNonNegative(
      minRoiPercent,
      toNonNegative(process.env.ARBITRAGE_MIN_ROI_PERCENT, 0)
    ),
    minProfitAbs: toNonNegative(
      minProfitAbs,
      toNonNegative(process.env.ARBITRAGE_MIN_PROFIT_ABS, 0)
    )
  };

  const pinnacleRows = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
  const altenarRows = Array.isArray(db.data?.altenarUpcoming) ? db.data.altenarUpcoming : [];
  const altenarById = new Map(altenarRows.map((row) => [String(row?.id), row]));

  const nowMs = Date.now();
  const startCutoffMs = nowMs - (ARBITRAGE_PREMATCH_START_GRACE_MINUTES * 60 * 1000);
  let skippedByStartedAt = 0;
  let skippedByInvalidDate = 0;

  const eligiblePinnacleRows = pinnacleRows.filter((pin) => {
    const matchDateMs = new Date(pin?.date || 0).getTime();
    if (!Number.isFinite(matchDateMs)) {
      skippedByInvalidDate += 1;
      return false;
    }

    if (matchDateMs <= startCutoffMs) {
      skippedByStartedAt += 1;
      return false;
    }

    return true;
  });

  const opportunities = [];
  let skippedUnlinked = 0;
  let skippedStaleAltenar = 0;
  let skippedOrientation = 0;
  let skippedMissingOdds1x2 = 0;
  let skippedMissingOddsDcOpposite = 0;
  let generated1x2 = 0;
  let generatedDcOpposite = 0;

  for (const pin of eligiblePinnacleRows) {
    const altenarId = pin?.altenarId;
    if (altenarId === null || altenarId === undefined || String(altenarId).trim() === '') {
      skippedUnlinked += 1;
      continue;
    }

    const alt = altenarById.get(String(altenarId));
    if (!alt) {
      skippedUnlinked += 1;
      continue;
    }

    const altLastUpdatedMs = new Date(alt?.lastUpdated || 0).getTime();
    const altAgeMs = nowMs - altLastUpdatedMs;
    if (!Number.isFinite(altLastUpdatedMs) || altAgeMs > ARBITRAGE_ALTENAR_MAX_ODD_AGE_MS) {
      skippedStaleAltenar += 1;
      continue;
    }

    const orientationInfo = resolveOrientation({
      pinHome: pin?.home,
      pinAway: pin?.away,
      altName: alt?.name
    });

    if (orientationInfo.orientation === 'unknown') {
      skippedOrientation += 1;
      continue;
    }

    const pinOdds = pin?.odds || {};
    const altOdds = alt?.odds || {};
    const pinDoubleChance = normalizeDoubleChanceOdds(pinOdds.doubleChance || {});

    const altMapped = orientationInfo.orientation === 'swapped'
      ? {
        home: altOdds.away,
        draw: altOdds.draw,
        away: altOdds.home
      }
      : {
        home: altOdds.home,
        draw: altOdds.draw,
        away: altOdds.away
      };

    const altDoubleChance = mapDoubleChanceByOrientation({
      doubleChance: altOdds.doubleChance || {},
      orientation: orientationInfo.orientation
    });

    const bestOdds = {
      home: chooseBestOdd({ pinnacleOdd: pinOdds.home, altenarOdd: altMapped.home }),
      draw: chooseBestOdd({ pinnacleOdd: pinOdds.draw, altenarOdd: altMapped.draw }),
      away: chooseBestOdd({ pinnacleOdd: pinOdds.away, altenarOdd: altMapped.away })
    };

    if (!bestOdds.home || !bestOdds.draw || !bestOdds.away) {
      skippedMissingOdds1x2 += 1;
    } else {
      const plan = buildThreeLegStakePlan({ bankroll: stakeBankroll, bestOdds });
      if (plan) {
        opportunities.push({
          type: 'SUREBET_1X2_PREMATCH',
          eventId: alt?.id || null,
          pinnacleId: pin?.id || null,
          match: `${pin?.home || ''} vs ${pin?.away || ''}`.trim(),
          matchDate: pin?.date || alt?.startDate || null,
          league: pin?.league?.name || alt?.league || null,
          country: alt?.country || null,
          orientation: orientationInfo,
          odds: {
            pinnacle: {
              home: safePositiveOdd(pinOdds.home),
              draw: safePositiveOdd(pinOdds.draw),
              away: safePositiveOdd(pinOdds.away)
            },
            altenar: {
              home: safePositiveOdd(altMapped.home),
              draw: safePositiveOdd(altMapped.draw),
              away: safePositiveOdd(altMapped.away)
            },
            best: bestOdds
          },
          plan
        });
        generated1x2 += 1;
      }
    }

    for (const combo of DC_OPPOSITE_COMBOS) {
      const dcBest = chooseBestOdd({
        pinnacleOdd: pinDoubleChance[combo.dcKey],
        altenarOdd: altDoubleChance[combo.dcKey]
      });
      const oppositeBest = chooseBestOdd({
        pinnacleOdd: pinOdds[combo.oppositeKey],
        altenarOdd: altMapped[combo.oppositeKey]
      });

      if (!dcBest || !oppositeBest) {
        skippedMissingOddsDcOpposite += 1;
        continue;
      }

      const plan = buildTwoLegStakePlan({
        bankroll: stakeBankroll,
        bestOdds: {
          cover: dcBest,
          opposite: oppositeBest
        }
      });
      if (!plan) continue;

      opportunities.push({
        type: 'SUREBET_DC_OPPOSITE_PREMATCH',
        market: 'double_chance+opposite_1x2',
        comboCode: combo.code,
        comboLabel: combo.label,
        eventId: alt?.id || null,
        pinnacleId: pin?.id || null,
        match: `${pin?.home || ''} vs ${pin?.away || ''}`.trim(),
        matchDate: pin?.date || alt?.startDate || null,
        league: pin?.league?.name || alt?.league || null,
        country: alt?.country || null,
        orientation: orientationInfo,
        legs: [
          {
            market: 'Double Chance',
            selection: combo.dcSelection,
            provider: dcBest.provider,
            odd: dcBest.odd
          },
          {
            market: '1x2',
            selection: combo.oppositeSelection,
            provider: oppositeBest.provider,
            odd: oppositeBest.odd
          }
        ],
        odds: {
          pinnacle: {
            doubleChance: pinDoubleChance[combo.dcKey],
            opposite: safePositiveOdd(pinOdds[combo.oppositeKey])
          },
          altenar: {
            doubleChance: altDoubleChance[combo.dcKey],
            opposite: safePositiveOdd(altMapped[combo.oppositeKey])
          },
          best: {
            doubleChance: dcBest,
            opposite: oppositeBest
          }
        },
        plan: {
          ...plan,
          labels: {
            cover: combo.dcSelection,
            opposite: combo.oppositeSelection
          }
        }
      });
      generatedDcOpposite += 1;
    }
  }

  const riskFiltered = opportunities.filter((op) => {
    const roi = Number(op?.plan?.roiPercent || 0);
    const profit = Number(op?.plan?.expectedProfit || 0);
    if (roi < riskThresholds.minRoiPercent) return false;
    if (profit < riskThresholds.minProfitAbs) return false;
    return true;
  });

  const filteredByRisk = opportunities.length - riskFiltered.length;

  const ordered = riskFiltered
    .sort((a, b) => Number(b?.plan?.edgePercent || 0) - Number(a?.plan?.edgePercent || 0))
    .slice(0, maxItems);

  const payload = {
    success: true,
    mode: 'preview-only',
    market: 'mixed',
    markets: ['1x2', 'double_chance+opposite_1x2'],
    source: 'prematch-cache-db',
    generatedAt: new Date().toISOString(),
    bankroll: stakeBankroll,
    risk: {
      ...riskThresholds,
      stakeBankroll
    },
    count: ordered.length,
    data: ordered,
    diagnostics: {
      scannedPinnacleRows: pinnacleRows.length,
      eligiblePinnacleRows: eligiblePinnacleRows.length,
      scannedAltenarRows: altenarRows.length,
      skippedByStartedAt,
      skippedByInvalidDate,
      startCutoffIso: new Date(startCutoffMs).toISOString(),
      startGraceMinutes: ARBITRAGE_PREMATCH_START_GRACE_MINUTES,
      skippedUnlinked,
      skippedStaleAltenar,
      skippedOrientation,
      skippedMissingOdds: skippedMissingOdds1x2 + skippedMissingOddsDcOpposite,
      skippedMissingOdds1x2,
      skippedMissingOddsDcOpposite,
      filteredByRisk,
      riskThresholds,
      altenarMaxOddAgeMs: ARBITRAGE_ALTENAR_MAX_ODD_AGE_MS,
      generatedByType: {
        surebet1x2: generated1x2,
        surebetDcOpposite: generatedDcOpposite
      }
    }
  };

  if (persistDiagnostics) {
    try {
      await persistArbitrageDiagnosticSnapshot({
        payload,
        query: {
          bankroll: stakeBankroll,
          limit: maxItems,
          minRoiPercent: riskThresholds.minRoiPercent,
          minProfitAbs: riskThresholds.minProfitAbs
        },
        trigger,
        tag
      });
    } catch (error) {
      console.warn(`⚠️ No se pudo persistir diagnostico de arbitraje: ${error?.message || error}`);
    }
  }

  return payload;
};
