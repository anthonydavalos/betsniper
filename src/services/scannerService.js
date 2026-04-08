import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
// [MOD] Importamos AMBAS estrategias
import { scanLiveOpportunities as performValueScan, getLiveOverview } from './liveValueScanner.js';
import { scanLiveOpportunities as performTurnaroundScan, getLiveSnipeScanDiagnostics } from './liveScannerService.js'; 
import { placeAutoBet, updateActiveBetsWithLiveData } from './paperTradingService.js';
import { prepareSemiAutoTicket, confirmSemiAutoTicket, confirmRealPlacementFast } from './bookySemiAutoService.js';
import { fetchBookyBalance } from './bookyAccountService.js';
import { refreshOpportunity } from './oddsService.js';
import {
    startAcityLiveSocketService,
    consumeAcitySocketDirtySignals,
    getAcityLiveSocketDiagnostics
} from './acityLiveSocketService.js';
import { refreshAltenarEventDetailsNow } from './altenarPrematchScheduler.js';
import {
    preparePinnacleSemiAutoTicket,
    confirmPinnacleSemiAutoTicket,
    confirmPinnacleRealPlacementFast,
    preflightPinnacleRealQuoteByOpportunity
} from './pinnacleSemiAutoService.js';
import fs from 'fs';
import path from 'path';

const parseBooleanFromEnv = (rawValue, fallback = false) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return fallback;
    }
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
};

const parsePositiveIntOr = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const intN = Math.floor(n);
    return intN > 0 ? intN : fallback;
};

const parsePositiveNumberOr = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n > 0 ? n : fallback;
};

const parseAllowedOpportunityTypes = (rawValue, fallback = []) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return [...fallback];
    }
    const values = String(rawValue)
        .split(',')
        .map((v) => String(v).trim().toUpperCase())
        .filter(Boolean);
    return values.length > 0 ? values : [...fallback];
};

const parsePlacementProvider = (rawValue, fallback = 'booky') => {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (normalized === 'booky' || normalized === 'pinnacle') return normalized;
    return fallback;
};

const SOCKET_MARKET_FAMILY_ALIAS = {
    '1x2': 'match_result',
    match_result: 'match_result',
    'match-result': 'match_result',
    moneyline: 'match_result',
    winner: 'match_result',
    totals: 'totals',
    total: 'totals',
    over_under: 'totals',
    overunder: 'totals',
    ou: 'totals',
    dc: 'double_chance',
    double_chance: 'double_chance',
    'double-chance': 'double_chance',
    doublechance: 'double_chance',
    unknown: 'unknown'
};

const parseAllowedSocketFamilies = (rawValue, fallback = ['match_result', 'totals', 'double_chance']) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return [...fallback];
    }

    const parsed = String(rawValue)
        .split(',')
        .map((v) => SOCKET_MARKET_FAMILY_ALIAS[String(v || '').trim().toLowerCase()] || null)
        .filter(Boolean);

    return parsed.length > 0 ? Array.from(new Set(parsed)) : [...fallback];
};

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER" (Background Worker)
// Estrategia: "La Volteada" (Favorito Pre-match perdiendo por 1 gol)
// + PAPER TRADING: Monitoreo de apuestas activas
// =====================================================================

// MEMORY CACHE
let cachedOpportunities = [];
let cachedPrematchIds = new Set(); // IDs de eventos ya detectados en Pre-Match
const liveQuoteStability = new Map();
const QUOTE_STABILITY_WINDOW_MS = 20000;
const LIVE_GLOBAL_STABILITY_ENABLED = parseBooleanFromEnv(process.env.LIVE_GLOBAL_STABILITY_ENABLED, true);
const QUOTE_STABILITY_MIN_HITS = parsePositiveIntOr(process.env.LIVE_GLOBAL_STABILITY_MIN_HITS, 2);

const AUTO_SNIPE_ENABLED = parseBooleanFromEnv(process.env.AUTO_SNIPE_ENABLED, false);
const AUTO_SNIPE_DRY_RUN = parseBooleanFromEnv(process.env.AUTO_SNIPE_DRY_RUN, true);
const AUTO_SNIPE_MIN_EV_PERCENT = parsePositiveNumberOr(
    process.env.AUTO_SNIPE_MIN_EV_PERCENT,
    Math.max(0.1, Number(process.env.BOOKY_MIN_EV_PERCENT || 2))
);
const AUTO_SNIPE_MIN_STAKE_SOL = parsePositiveNumberOr(process.env.AUTO_SNIPE_MIN_STAKE_SOL, 1);
const AUTO_SNIPE_MAX_BETS_PER_HOUR = parsePositiveIntOr(process.env.AUTO_SNIPE_MAX_BETS_PER_HOUR, 3);
const AUTO_SNIPE_COOLDOWN_PER_PICK_MS = parsePositiveIntOr(process.env.AUTO_SNIPE_COOLDOWN_PER_PICK_MS, 180000);
const AUTO_SNIPE_REENTRY_MIN_ODD_IMPROVEMENT_PCT = parsePositiveNumberOr(process.env.AUTO_SNIPE_REENTRY_MIN_ODD_IMPROVEMENT_PCT, 8);
const AUTO_SNIPE_REENTRY_MIN_ODD_POINTS = parsePositiveNumberOr(process.env.AUTO_SNIPE_REENTRY_MIN_ODD_POINTS, 0.30);
const AUTO_SNIPE_MAX_ENTRIES_PER_PICK = parsePositiveIntOr(process.env.AUTO_SNIPE_MAX_ENTRIES_PER_PICK, 2);
const AUTO_SNIPE_BALANCE_CHECK_CACHE_MS = parsePositiveIntOr(process.env.AUTO_SNIPE_BALANCE_CHECK_CACHE_MS, 10000);
const AUTO_SNIPE_REQUIRE_REAL_PLACEMENT_ENABLED = parseBooleanFromEnv(
    process.env.AUTO_SNIPE_REQUIRE_REAL_PLACEMENT_ENABLED,
    true
);
const AUTO_PLACEMENT_ALLOWED_TYPES = parseAllowedOpportunityTypes(
    process.env.AUTO_SNIPE_ALLOWED_TYPES,
    ['LIVE_SNIPE', 'LA_VOLTEADA', 'LIVE_VALUE']
);
const AUTO_PLACEMENT_ALLOWED_TYPES_SET = new Set(AUTO_PLACEMENT_ALLOWED_TYPES);
const BOOKY_REAL_PLACEMENT_ENABLED = parseBooleanFromEnv(process.env.BOOKY_REAL_PLACEMENT_ENABLED, false);
const PINNACLE_REAL_PLACEMENT_ENABLED = parseBooleanFromEnv(process.env.PINNACLE_REAL_PLACEMENT_ENABLED, false);
const AUTO_PLACEMENT_PROVIDER_OPTIONS = ['booky', 'pinnacle'];
let runtimeAutoPlacementProvider = parsePlacementProvider(process.env.AUTO_PLACEMENT_PROVIDER, 'booky');
const LIVE_DIAG_MAX_ENTRIES = parsePositiveIntOr(process.env.LIVE_DIAG_MAX_ENTRIES, 1000);
const LIVE_DIAG_PERSIST_FILE = parseBooleanFromEnv(process.env.LIVE_DIAG_PERSIST_FILE, true);
const LIVE_DIAG_FILE = path.resolve('data', 'live_opportunity_decisions.jsonl');
const LIVE_SOCKET_REQUOTE_ENABLED = parseBooleanFromEnv(process.env.LIVE_SOCKET_REQUOTE_ENABLED, true);
const LIVE_SOCKET_REQUOTE_MAX_PER_CYCLE = parsePositiveIntOr(process.env.LIVE_SOCKET_REQUOTE_MAX_PER_CYCLE, 8);
const LIVE_SOCKET_DIRTY_MAX_AGE_MS = parsePositiveIntOr(process.env.LIVE_SOCKET_DIRTY_MAX_AGE_MS, 90000);
const LIVE_SOCKET_REQUOTE_ALLOWED_FAMILIES = parseAllowedSocketFamilies(
    process.env.LIVE_SOCKET_REQUOTE_ALLOWED_FAMILIES,
    ['match_result', 'totals', 'double_chance']
);
const LIVE_SOCKET_REQUOTE_ALLOWED_FAMILIES_SET = new Set(LIVE_SOCKET_REQUOTE_ALLOWED_FAMILIES);
const PREMATCH_SOCKET_REFRESH_ENABLED = parseBooleanFromEnv(process.env.PREMATCH_SOCKET_REFRESH_ENABLED, true);
const PREMATCH_SOCKET_REFRESH_MAX_PER_CYCLE = parsePositiveIntOr(process.env.PREMATCH_SOCKET_REFRESH_MAX_PER_CYCLE, 3);
const LIVE_HYBRID_SELECTIVE_ENABLED = parseBooleanFromEnv(process.env.LIVE_HYBRID_SELECTIVE_ENABLED, true);
const LIVE_HYBRID_REQUIRE_WSAPI_DISABLED = parseBooleanFromEnv(process.env.LIVE_HYBRID_REQUIRE_WSAPI_DISABLED, true);
const LIVE_HYBRID_SOCKET_COLD_MIN_RAW_MESSAGES = parsePositiveIntOr(process.env.LIVE_HYBRID_SOCKET_COLD_MIN_RAW_MESSAGES, 20);
const LIVE_HYBRID_FULL_SCAN_EVERY_N_CYCLES = parsePositiveIntOr(process.env.LIVE_HYBRID_FULL_SCAN_EVERY_N_CYCLES, 4);
const LIVE_HYBRID_SELECTIVE_MAX_PER_CYCLE = parsePositiveIntOr(process.env.LIVE_HYBRID_SELECTIVE_MAX_PER_CYCLE, 5);
const LIVE_HYBRID_SELECTIVE_ALLOWED_FAMILIES = parseAllowedSocketFamilies(
    process.env.LIVE_HYBRID_SELECTIVE_ALLOWED_FAMILIES,
    ['match_result', 'totals', 'double_chance']
);
const LIVE_HYBRID_SELECTIVE_ALLOWED_FAMILIES_SET = new Set(LIVE_HYBRID_SELECTIVE_ALLOWED_FAMILIES);

const autoSnipeInFlight = new Set();
const autoSnipeLastAttemptAt = new Map();
const autoSnipePlacedAtHistory = [];
let autoSnipeBookyBalanceCache = {
    checkedAtMs: 0,
    value: null
};
const liveDecisionLog = [];
let lastLivePipelineStats = {
    at: null,
    liveEventCount: 0,
    rawCount: 0,
    dedupCount: 0,
    stableCount: 0,
    finalCount: 0,
    activeLiveBets: 0,
    pollMode: 'idle',
    socketDirtyConsumed: 0,
    socketDirtyLiveConsumed: 0,
    socketDirtyPrematchConsumed: 0,
    socketRequotesAttempted: 0,
    socketRequotesApplied: 0,
    socketPrematchRefreshAttempted: 0,
    socketPrematchRefreshApplied: 0,
    socketPrematchRefreshChanged: 0,
    hybridSelectiveCycle: 0,
    hybridSkippedFullScan: 0,
    hybridRequotesAttempted: 0,
    hybridRequotesApplied: 0,
    hybridReason: null,
    wsapiSocketsEnabledCount: null
};

const appendLiveDecisionLog = (entry = {}) => {
    const payload = {
        at: new Date().toISOString(),
        ...entry
    };

    liveDecisionLog.push(payload);
    if (liveDecisionLog.length > LIVE_DIAG_MAX_ENTRIES) {
        liveDecisionLog.splice(0, liveDecisionLog.length - LIVE_DIAG_MAX_ENTRIES);
    }

    if (LIVE_DIAG_PERSIST_FILE) {
        fs.appendFile(LIVE_DIAG_FILE, `${JSON.stringify(payload)}\n`, () => {});
    }
};

const recordLivePipelineStats = (stats = {}) => {
    lastLivePipelineStats = {
        ...lastLivePipelineStats,
        ...stats,
        at: new Date().toISOString()
    };
};

// Helper: Generar ID único por oportunidad (eventId + selection)
// Debe coincidir con la función del frontend
function normalizePick(obj = {}) {
    if (obj.pick) return String(obj.pick).toLowerCase();

    const actionStr = (obj.action || '').toUpperCase();
    const selectionStr = (obj.selection || '').toUpperCase();
    const marketStr = (obj.market || '').toUpperCase();
    const combined = `${selectionStr} ${actionStr} ${marketStr}`;

    if (selectionStr === 'HOME' || actionStr.includes('LOCAL')) return 'home';
    if (selectionStr === 'AWAY' || actionStr.includes('VISITA')) return 'away';
    if (selectionStr === 'DRAW' || actionStr.includes('EMPATE')) return 'draw';

    if (combined.includes('BTTS') && (combined.includes('YES') || combined.includes('SI') || combined.includes('SÍ'))) return 'btts_yes';
    if (combined.includes('BTTS') && combined.includes('NO')) return 'btts_no';

    if (combined.includes('OVER') || combined.includes('MÁS') || combined.includes('MAS')) {
        const lineMatch = selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/);
        const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
        return Number.isFinite(line) ? `over_${line}` : 'over';
    }

    if (combined.includes('UNDER') || combined.includes('MENOS')) {
        const lineMatch = selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/);
        const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
        return Number.isFinite(line) ? `under_${line}` : 'under';
    }

    return String(obj.selection || obj.action || obj.market || '').replace(/\s+/g, '_');
}

function getOpportunityId(op) {
  const eventId = String(op.eventId || op.id);
    return `${eventId}_${normalizePick(op)}`;
}

const isAutoSnipeOpportunity = (op = {}) => {
    const type = String(op?.type || op?.strategy || '').toUpperCase();
    return AUTO_PLACEMENT_ALLOWED_TYPES_SET.has(type);
};

const isRealPlacementEnabledForProvider = (provider = 'booky') => {
    const normalized = parsePlacementProvider(provider, 'booky');
    if (normalized === 'pinnacle') return PINNACLE_REAL_PLACEMENT_ENABLED;
    return BOOKY_REAL_PLACEMENT_ENABLED;
};

const buildPlacementMode = ({ provider = 'booky', realEnabled = false } = {}) => {
    const p = parsePlacementProvider(provider, 'booky');
    return `${p}-${realEnabled ? 'real' : 'sim'}`;
};

export const getAutoPlacementProvider = () => runtimeAutoPlacementProvider;

export const setAutoPlacementProvider = (providerRaw = '') => {
    const normalized = String(providerRaw || '').trim().toLowerCase();
    if (!AUTO_PLACEMENT_PROVIDER_OPTIONS.includes(normalized)) {
        throw new Error(`Proveedor inválido: ${providerRaw}. Usa ${AUTO_PLACEMENT_PROVIDER_OPTIONS.join(', ')}.`);
    }
    runtimeAutoPlacementProvider = normalized;
    return {
        provider: runtimeAutoPlacementProvider,
        updatedAt: new Date().toISOString(),
        allowed: AUTO_PLACEMENT_PROVIDER_OPTIONS
    };
};

const pruneAutoSnipeState = () => {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    while (autoSnipePlacedAtHistory.length > 0 && autoSnipePlacedAtHistory[0] < oneHourAgo) {
        autoSnipePlacedAtHistory.shift();
    }

    for (const [key, ts] of autoSnipeLastAttemptAt.entries()) {
        if ((now - ts) > Math.max(AUTO_SNIPE_COOLDOWN_PER_PICK_MS * 4, 20 * 60 * 1000)) {
            autoSnipeLastAttemptAt.delete(key);
        }
    }
};

const getAutoSnipeBookyBalance = async ({ forceRefresh = false } = {}) => {
    const now = Date.now();
    if (!forceRefresh && autoSnipeBookyBalanceCache.value && (now - autoSnipeBookyBalanceCache.checkedAtMs) < AUTO_SNIPE_BALANCE_CHECK_CACHE_MS) {
        return autoSnipeBookyBalanceCache.value;
    }

    const snapshot = await fetchBookyBalance({ forceRefresh, profileKey: null });
    autoSnipeBookyBalanceCache = {
        checkedAtMs: now,
        value: snapshot || null
    };
    return snapshot;
};

const maybeRunAutoSnipe = async (opportunity) => {
    if (!AUTO_SNIPE_ENABLED) return { triggered: false, reason: 'disabled' };
    if (!isAutoSnipeOpportunity(opportunity)) return { triggered: false, reason: 'type-not-enabled' };

    const placementProvider = getAutoPlacementProvider();
    const providerRealEnabled = isRealPlacementEnabledForProvider(placementProvider);

    if (AUTO_SNIPE_REQUIRE_REAL_PLACEMENT_ENABLED && !providerRealEnabled) {
        return { triggered: false, reason: `${placementProvider}-real-disabled`, placementProvider };
    }

    pruneAutoSnipeState();

    const key = getOpportunityId(opportunity);
    const now = Date.now();

    if (autoSnipeInFlight.has(key)) return { triggered: false, reason: 'in-flight' };

    const lastAttempt = Number(autoSnipeLastAttemptAt.get(key) || 0);
    if (lastAttempt > 0 && (now - lastAttempt) < AUTO_SNIPE_COOLDOWN_PER_PICK_MS) {
        return { triggered: false, reason: 'cooldown' };
    }

    const evPercent = Number(opportunity?.ev);
    if (!Number.isFinite(evPercent) || evPercent < AUTO_SNIPE_MIN_EV_PERCENT) {
        return { triggered: false, reason: 'ev-guard' };
    }

    const stake = Number(opportunity?.kellyStake || 0);
    if (!Number.isFinite(stake) || stake < AUTO_SNIPE_MIN_STAKE_SOL) {
        return { triggered: false, reason: 'stake-guard' };
    }

    if (!AUTO_SNIPE_DRY_RUN && placementProvider === 'booky' && providerRealEnabled) {
        let balance = await getAutoSnipeBookyBalance({ forceRefresh: false });
        let balanceAmount = Number(balance?.amount);

        // Si detectamos saldo en cero, refrescamos una vez para confirmar y evitar falso bloqueo por caché viejo.
        if (Number.isFinite(balanceAmount) && balanceAmount <= 0) {
            balance = await getAutoSnipeBookyBalance({ forceRefresh: true });
            balanceAmount = Number(balance?.amount);
        }

        if (Number.isFinite(balanceAmount) && balanceAmount <= 0) {
            const currency = String(balance?.currency || 'PEN').toUpperCase();
            return {
                triggered: false,
                reason: 'insufficient-balance',
                placementProvider,
                balanceAmount,
                balanceCurrency: currency
            };
        }

        if (Number.isFinite(balanceAmount) && stake > balanceAmount) {
            const currency = String(balance?.currency || 'PEN').toUpperCase();
            return {
                triggered: false,
                reason: 'insufficient-balance',
                placementProvider,
                balanceAmount,
                balanceCurrency: currency
            };
        }
    }

    const opEventId = String(opportunity?.eventId || opportunity?.id || '');
    const opPick = normalizePick(opportunity);
    const candidateOdd = Number(opportunity?.price ?? opportunity?.odd ?? NaN);
    const activeSamePick = (db.data?.portfolio?.activeBets || []).filter((b) => {
        const betEventId = String(b?.eventId || b?.id || '');
        if (!betEventId || !opEventId || betEventId !== opEventId) return false;
        return normalizePick(b) === opPick;
    });

    if (activeSamePick.length >= AUTO_SNIPE_MAX_ENTRIES_PER_PICK) {
        return { triggered: false, reason: 'reentry-cap' };
    }

    if (activeSamePick.length > 0 && Number.isFinite(candidateOdd) && candidateOdd > 1) {
        const bestExistingOdd = activeSamePick.reduce((best, b) => {
            const odd = Number(b?.odd ?? b?.price ?? NaN);
            if (!Number.isFinite(odd) || odd <= 1) return best;
            return Math.max(best, odd);
        }, NaN);

        if (Number.isFinite(bestExistingOdd) && bestExistingOdd > 1) {
            const oddImprovementPoints = candidateOdd - bestExistingOdd;
            const oddImprovementPct = ((candidateOdd / bestExistingOdd) - 1) * 100;
            const passesByPoints = oddImprovementPoints >= AUTO_SNIPE_REENTRY_MIN_ODD_POINTS;
            const passesByPct = oddImprovementPct >= AUTO_SNIPE_REENTRY_MIN_ODD_IMPROVEMENT_PCT;

            if (!passesByPoints && !passesByPct) {
                return {
                    triggered: false,
                    reason: `reentry-no-improvement(${oddImprovementPoints.toFixed(2)}pts/${oddImprovementPct.toFixed(1)}%)`
                };
            }
        }
    }

    if (autoSnipePlacedAtHistory.length >= AUTO_SNIPE_MAX_BETS_PER_HOUR) {
        return { triggered: false, reason: 'hourly-cap' };
    }

    autoSnipeInFlight.add(key);
    autoSnipeLastAttemptAt.set(key, now);

    let ticketIdForLog = 'n/a';

    try {
        if (AUTO_SNIPE_DRY_RUN) {
            console.log(`🤖 [AUTO_SNIPE_DRY_RUN] ${opportunity.match} | ${opportunity.selection} | EV=${evPercent.toFixed(2)}% | stake=S/. ${stake.toFixed(2)}`);
            return { triggered: true, dryRun: true };
        }

        const placementMode = buildPlacementMode({ provider: placementProvider, realEnabled: providerRealEnabled });
        const runPlacementOnce = async () => {
            if (placementProvider === 'pinnacle' && providerRealEnabled) {
                const preflight = await preflightPinnacleRealQuoteByOpportunity(opportunity);
                if (!preflight?.quoteable) {
                    return {
                        ok: false,
                        reason: `not-quoteable:${String(preflight?.status || 'unknown')}`,
                        preflight
                    };
                }
            }

            const ticket = placementProvider === 'pinnacle'
                ? await preparePinnacleSemiAutoTicket(opportunity)
                : await prepareSemiAutoTicket(opportunity);
            const ticketId = ticket?.id;
            ticketIdForLog = ticketId || 'n/a';
            if (!ticketId) {
                return { ok: false, reason: 'ticket-missing-id' };
            }

            const placementResult = placementProvider === 'pinnacle'
                ? (providerRealEnabled
                    ? await confirmPinnacleRealPlacementFast(ticketId)
                    : await confirmPinnacleSemiAutoTicket(ticketId))
                : (providerRealEnabled
                    ? await confirmRealPlacementFast(ticketId)
                    : await confirmSemiAutoTicket(ticketId));
            return { ok: true, ticketId, placementResult };
        };

        let placementAttempt = await runPlacementOnce();
        if (!placementAttempt.ok) {
            return { triggered: false, reason: placementAttempt.reason || 'ticket-missing-id' };
        }

        const extractMsg = (err) => String(err?.message || '').toLowerCase();
        const shouldRetryRequote = (err) => extractMsg(err).includes('re-quote requerido') || extractMsg(err).includes('cuota cambió demasiado');

        try {
            // noop: ya tenemos resultado del primer intento
        } catch (_) {
            // unreachable
        }

        const placementResult = placementAttempt.placementResult;
        autoSnipePlacedAtHistory.push(Date.now());
        const status = String(placementResult?.ticket?.status || (placementMode === 'real' ? 'REAL_CONFIRMED_FAST' : 'CONFIRMED'));
        const portfolioBetId = placementResult?.mirroredBet?.id || placementResult?.bet?.id || placementResult?.ticket?.portfolioBetId || 'n/a';
        console.log(
            `✅ [AUTO_SNIPE] Resultado final=CONFIRMED mode=${placementMode.toUpperCase()} | ${opportunity.match} (${opportunity.selection}) ` +
            `ticket=${placementAttempt.ticketId} status=${status} portfolioBetId=${portfolioBetId}`
        );
        return {
            triggered: true,
            dryRun: false,
            ticketId: placementAttempt.ticketId,
            outcome: 'confirmed',
            status,
            portfolioBetId,
            placementMode,
            placementProvider
        };
    } catch (error) {
        const placementMode = buildPlacementMode({ provider: placementProvider, realEnabled: providerRealEnabled });
        const msg = error?.message || 'Error desconocido';
        const code = String(error?.code || '');

        const lowerMsg = String(msg || '').toLowerCase();
        const isRequote = lowerMsg.includes('re-quote requerido') || lowerMsg.includes('cuota cambió demasiado');
        if (isRequote) {
            try {
                console.warn(`↻ [AUTO_SNIPE] Re-quote detectado. Reintentando una vez con cuota refrescada: ${opportunity?.match || 'n/a'}`);
                const retryTicket = placementProvider === 'pinnacle'
                    ? await preparePinnacleSemiAutoTicket(opportunity)
                    : await prepareSemiAutoTicket(opportunity);
                const retryTicketId = retryTicket?.id;
                ticketIdForLog = retryTicketId || ticketIdForLog;
                if (!retryTicketId) {
                    return { triggered: false, reason: 'ticket-missing-id' };
                }

                const retryResult = placementProvider === 'pinnacle'
                    ? (providerRealEnabled
                        ? await confirmPinnacleRealPlacementFast(retryTicketId)
                        : await confirmPinnacleSemiAutoTicket(retryTicketId))
                    : (providerRealEnabled
                        ? await confirmRealPlacementFast(retryTicketId)
                        : await confirmSemiAutoTicket(retryTicketId));

                autoSnipePlacedAtHistory.push(Date.now());
                const retryStatus = String(retryResult?.ticket?.status || (placementMode === 'real' ? 'REAL_CONFIRMED_FAST' : 'CONFIRMED'));
                const retryPortfolioBetId = retryResult?.mirroredBet?.id || retryResult?.bet?.id || retryResult?.ticket?.portfolioBetId || 'n/a';
                console.log(
                    `✅ [AUTO_SNIPE] Resultado final=CONFIRMED mode=${placementMode.toUpperCase()} (retry) | ${opportunity.match} (${opportunity.selection}) ` +
                    `ticket=${retryTicketId} status=${retryStatus} portfolioBetId=${retryPortfolioBetId}`
                );
                return {
                    triggered: true,
                    dryRun: false,
                    ticketId: retryTicketId,
                    outcome: 'confirmed',
                    status: retryStatus,
                    portfolioBetId: retryPortfolioBetId,
                    placementMode,
                    placementProvider,
                    retry: true
                };
            } catch (retryErr) {
                const retryMsg = retryErr?.message || msg;
                console.warn(`⚠️ [AUTO_SNIPE] Reintento por re-quote falló para ${opportunity?.match || 'n/a'}: ${retryMsg}`);
                return { triggered: false, reason: 'execution-error', error: retryMsg };
            }
        }

        if (code === 'BOOKY_REAL_PLACEMENT_REJECTED' || code === 'PINNACLE_REAL_REJECTED') {
            console.warn(
                `❌ [AUTO_SNIPE] Resultado final=REJECTED | ${opportunity?.match || 'n/a'} ` +
                `(${opportunity?.selection || 'n/a'}) ticket=${ticketIdForLog} | ${msg}`
            );
            return {
                triggered: true,
                dryRun: false,
                outcome: 'rejected',
                reason: 'provider-rejected',
                error: msg,
                code,
                placementMode,
                placementProvider
            };
        }

        if (code === 'BOOKY_INSUFFICIENT_BALANCE') {
            console.warn(
                `💸 [AUTO_SNIPE] Bloqueado por saldo insuficiente | ${opportunity?.match || 'n/a'} ` +
                `(${opportunity?.selection || 'n/a'}) | ${msg}`
            );
            return {
                triggered: false,
                reason: 'insufficient-balance',
                error: msg,
                code,
                placementProvider
            };
        }

        if (code === 'BOOKY_REAL_CONFIRMATION_UNCERTAIN') {
            console.warn(
                `❓ [AUTO_SNIPE] Resultado final=UNCERTAIN | ${opportunity?.match || 'n/a'} ` +
                `(${opportunity?.selection || 'n/a'}) ticket=${ticketIdForLog} | ${msg}`
            );
            return {
                triggered: true,
                dryRun: false,
                outcome: 'uncertain',
                reason: 'provider-uncertain',
                error: msg,
                code,
                placementMode,
                placementProvider
            };
        }

        console.warn(`⚠️ [AUTO_SNIPE] Falló ejecución para ${opportunity?.match || 'n/a'}: ${msg}`);
        return { triggered: false, reason: 'execution-error', error: msg, placementProvider };
    } finally {
        autoSnipeInFlight.delete(key);
    }
};

const buildOpportunityCoreKey = (op = {}) => {
    const eventId = String(op.eventId || op.id || 'na');
    const market = String(op.market || '').toLowerCase();
    const selection = String(op.selection || '').toLowerCase();
    const pick = String(op.pick || normalizePick(op) || '').toLowerCase();
    return `${eventId}|${market}|${selection}|${pick}`;
};

const roundOdd = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'na';
    return n.toFixed(2);
};

const buildOpportunitySignature = (op = {}) => {
    const altenarPrice = roundOdd(op.price ?? op.odd);
    const pinnaclePrice = roundOdd(op.pinnaclePrice);
    const score = String(op.score || 'na');
    return `${altenarPrice}|${pinnaclePrice}|${score}`;
};

const pruneQuoteStabilityCache = () => {
    const now = Date.now();
    for (const [key, state] of liveQuoteStability.entries()) {
        if ((now - state.lastSeenAt) > QUOTE_STABILITY_WINDOW_MS * 2) {
            liveQuoteStability.delete(key);
        }
    }
};

const filterStableLiveQuotes = (ops = []) => {
    if (!LIVE_GLOBAL_STABILITY_ENABLED) return ops;

    const now = Date.now();
    const stable = [];

    for (const op of ops) {
        const coreKey = buildOpportunityCoreKey(op);
        const signature = buildOpportunitySignature(op);
        const prev = liveQuoteStability.get(coreKey);

        if (!prev || (now - prev.lastSeenAt) > QUOTE_STABILITY_WINDOW_MS || prev.signature !== signature) {
            liveQuoteStability.set(coreKey, {
                signature,
                hits: 1,
                firstSeenAt: now,
                lastSeenAt: now
            });

            // Si el umbral es 1, no debe requerir una segunda confirmacion.
            if (QUOTE_STABILITY_MIN_HITS <= 1) {
                stable.push(op);
            }
            continue;
        }

        const next = {
            signature,
            hits: prev.hits + 1,
            firstSeenAt: prev.firstSeenAt,
            lastSeenAt: now
        };
        liveQuoteStability.set(coreKey, next);

        if (next.hits >= QUOTE_STABILITY_MIN_HITS) {
            stable.push(op);
        }
    }

    return stable;
};

const normalizeSocketText = (value = '') => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const normalizeSocketFamily = (family) => {
    const key = String(family || '').trim().toLowerCase();
    return SOCKET_MARKET_FAMILY_ALIAS[key] || 'unknown';
};

const normalizeSocketScopes = (scopes = []) => {
    const out = new Set();
    for (const scope of Array.isArray(scopes) ? scopes : []) {
        const key = String(scope || '').trim().toLowerCase();
        if (key === 'live' || key === 'prematch' || key === 'unknown') {
            out.add(key);
        }
    }
    if (out.size === 0) out.add('unknown');
    return out;
};

const mapOpportunityMarketFamily = (op = {}) => {
    const text = normalizeSocketText([
        op?.market,
        op?.selection,
        op?.action,
        op?.pick,
        op?.type,
        op?.strategy
    ].filter(Boolean).join(' '));

    const compact = text.replace(/[^a-z0-9]+/g, '');
    const hasOverUnderToken = /\b(over|under)\b/.test(text) || /\bo\/u\b/.test(text) || /\bu\/o\b/.test(text);

    if (
        text.includes('double chance') ||
        text.includes('doble oportunidad') ||
        compact.includes('1x') ||
        compact.includes('x2') ||
        compact.includes('12')
    ) {
        return 'double_chance';
    }

    if (
        text.includes('total') ||
        hasOverUnderToken ||
        text.includes('mas') ||
        text.includes('menos')
    ) {
        return 'totals';
    }

    if (
        text.includes('1x2') ||
        text.includes('resultado') ||
        text.includes('match winner') ||
        text.includes('match result') ||
        text.includes('moneyline') ||
        text.includes('local') ||
        text.includes('visita') ||
        text.includes('empate') ||
        text.includes('home') ||
        text.includes('away') ||
        text.includes('draw')
    ) {
        return 'match_result';
    }

    return 'unknown';
};

const buildDirtySignalMapByScope = (dirtySignals = [], scope = 'live') => {
    const out = new Map();

    for (const signal of Array.isArray(dirtySignals) ? dirtySignals : []) {
        const eventId = String(signal?.eventId || '').trim();
        if (!eventId) continue;

        const scopes = normalizeSocketScopes(signal?.scopes || []);
        if (!scopes.has(scope) && !scopes.has('unknown')) continue;

        const families = new Set(
            (Array.isArray(signal?.families) ? signal.families : ['unknown'])
                .map((family) => normalizeSocketFamily(family))
                .filter(Boolean)
        );
        if (families.size === 0) families.add('unknown');

        const prev = out.get(eventId);
        if (!prev) {
            out.set(eventId, {
                families,
                scopes,
                eventNames: new Set(Array.isArray(signal?.eventNames) ? signal.eventNames : [])
            });
            continue;
        }

        for (const family of families) prev.families.add(family);
        for (const s of scopes) prev.scopes.add(s);
        for (const eventName of Array.isArray(signal?.eventNames) ? signal.eventNames : []) {
            prev.eventNames.add(eventName);
        }
    }

    return out;
};

const familyMatchesSignal = (opFamily = 'unknown', signalFamilies = new Set()) => {
    if (!signalFamilies || signalFamilies.size === 0) return true;
    if (signalFamilies.has('unknown')) return true;
    if (opFamily === 'unknown') return true;
    return signalFamilies.has(opFamily);
};

const applySocketDrivenRequotes = async (ops = [], dirtySignals = []) => {
    if (!LIVE_SOCKET_REQUOTE_ENABLED) {
        return {
            ops,
            attempted: 0,
            applied: 0,
            skipped: 0
        };
    }

    if (!Array.isArray(ops) || ops.length === 0) {
        return {
            ops: Array.isArray(ops) ? ops : [],
            attempted: 0,
            applied: 0,
            skipped: 0
        };
    }

    const dirtySignalMap = buildDirtySignalMapByScope(dirtySignals, 'live');
    if (dirtySignalMap.size === 0) {
        return {
            ops,
            attempted: 0,
            applied: 0,
            skipped: 0
        };
    }

    const updatedOps = [...ops];
    const byEventQuota = new Map();
    let attempted = 0;
    let applied = 0;
    let skipped = 0;

    for (let idx = 0; idx < updatedOps.length; idx += 1) {
        if (attempted >= LIVE_SOCKET_REQUOTE_MAX_PER_CYCLE) break;

        const op = updatedOps[idx];
        const eventId = String(op?.eventId || op?.id || '').trim();
        if (!eventId || !dirtySignalMap.has(eventId)) continue;

        const signal = dirtySignalMap.get(eventId);
        const opFamily = mapOpportunityMarketFamily(op);

        if (!LIVE_SOCKET_REQUOTE_ALLOWED_FAMILIES_SET.has(opFamily) && opFamily !== 'unknown') {
            continue;
        }

        if (!familyMatchesSignal(opFamily, signal?.families)) {
            skipped += 1;
            continue;
        }

        const perEventCount = Number(byEventQuota.get(eventId) || 0);
        if (perEventCount >= 2) {
            skipped += 1;
            continue;
        }

        byEventQuota.set(eventId, perEventCount + 1);
        attempted += 1;

        try {
            const refreshed = await refreshOpportunity(op);
            if (!refreshed || typeof refreshed !== 'object') {
                skipped += 1;
                continue;
            }

            const beforeOdd = Number(op?.price ?? op?.odd ?? NaN);
            const afterPrice = Number(refreshed?.price ?? NaN);
            const merged = { ...op, ...refreshed };

            // LIVE_SNIPE guarda la cuota en "odd"; mantenemos ambas para UI y guardas.
            if (Number.isFinite(afterPrice) && afterPrice > 1) {
                merged.price = afterPrice;
                if (Object.prototype.hasOwnProperty.call(op || {}, 'odd')) {
                    merged.odd = afterPrice;
                }
            }

            const afterOdd = Number(merged?.price ?? merged?.odd ?? NaN);
            if (Number.isFinite(beforeOdd) && Number.isFinite(afterOdd) && Math.abs(afterOdd - beforeOdd) >= 0.0001) {
                applied += 1;
            }

            updatedOps[idx] = merged;
        } catch (error) {
            skipped += 1;
            console.warn(`⚠️ Socket requote falló (${op?.match || eventId}): ${error.message}`);
        }
    }

    return {
        ops: updatedOps,
        attempted,
        applied,
        skipped
    };
};

const applySocketDrivenPrematchRefresh = async (dirtySignals = []) => {
    if (!PREMATCH_SOCKET_REFRESH_ENABLED) {
        return {
            attempted: 0,
            applied: 0,
            changed: 0,
            failed: 0
        };
    }

    const dirtySignalMap = buildDirtySignalMapByScope(dirtySignals, 'prematch');
    if (dirtySignalMap.size === 0) {
        return {
            attempted: 0,
            applied: 0,
            changed: 0,
            failed: 0
        };
    }

    const candidates = Array.from(dirtySignalMap.keys()).slice(0, PREMATCH_SOCKET_REFRESH_MAX_PER_CYCLE);
    let attempted = 0;
    let applied = 0;
    let changed = 0;
    let failed = 0;

    for (const eventId of candidates) {
        attempted += 1;
        try {
            const result = await refreshAltenarEventDetailsNow({ eventId });
            if (result?.success) {
                applied += 1;
                if (result?.changed) changed += 1;
            } else {
                failed += 1;
            }
        } catch (_) {
            failed += 1;
        }
    }

    return {
        attempted,
        applied,
        changed,
        failed
    };
};

const decideHybridSelectiveCycle = ({
    socketDiagnostics,
    socketDirtyConsumed = 0,
    cycle = 0,
    cachedOpsCount = 0
} = {}) => {
    if (!LIVE_HYBRID_SELECTIVE_ENABLED) {
        return { enabled: false, reason: 'hybrid-disabled' };
    }

    if (socketDirtyConsumed > 0) {
        return { enabled: false, reason: 'socket-dirty-present' };
    }

    if (!Number.isFinite(cachedOpsCount) || cachedOpsCount <= 0) {
        return { enabled: false, reason: 'no-cached-ops' };
    }

    const stats = socketDiagnostics?.stats || {};
    const authOk = Number(stats?.authOk || 0);
    const rawMessages = Number(stats?.rawMessages || 0);
    const wsapiSocketsEnabled = Array.isArray(socketDiagnostics?.wsapiSocketsEnabled)
        ? socketDiagnostics.wsapiSocketsEnabled
        : null;
    const wsapiDisabled = Array.isArray(wsapiSocketsEnabled) && wsapiSocketsEnabled.length === 0;

    if (authOk <= 0) {
        return { enabled: false, reason: 'socket-not-authenticated' };
    }

    if (rawMessages < LIVE_HYBRID_SOCKET_COLD_MIN_RAW_MESSAGES) {
        return { enabled: false, reason: 'socket-warmup' };
    }

    if (LIVE_HYBRID_REQUIRE_WSAPI_DISABLED && !wsapiDisabled) {
        return { enabled: false, reason: wsapiSocketsEnabled ? 'wsapi-enabled' : 'wsapi-unknown' };
    }

    const fullScanEvery = Math.max(1, LIVE_HYBRID_FULL_SCAN_EVERY_N_CYCLES);
    if (cycle % fullScanEvery === 0) {
        return { enabled: false, reason: 'scheduled-full-scan' };
    }

    return { enabled: true, reason: 'socket-cold-selective' };
};

const applyHybridSelectiveRequotes = async (ops = []) => {
    if (!LIVE_HYBRID_SELECTIVE_ENABLED) {
        return {
            ops: Array.isArray(ops) ? ops : [],
            attempted: 0,
            applied: 0,
            skipped: 0
        };
    }

    if (!Array.isArray(ops) || ops.length === 0) {
        return {
            ops: [],
            attempted: 0,
            applied: 0,
            skipped: 0
        };
    }

    const updatedOps = [...ops];
    const byEventQuota = new Map();
    let attempted = 0;
    let applied = 0;
    let skipped = 0;

    for (let idx = 0; idx < updatedOps.length; idx += 1) {
        if (attempted >= LIVE_HYBRID_SELECTIVE_MAX_PER_CYCLE) break;

        const op = updatedOps[idx];
        const eventId = String(op?.eventId || op?.id || '').trim();
        if (!eventId) continue;

        const opFamily = mapOpportunityMarketFamily(op);
        if (!LIVE_HYBRID_SELECTIVE_ALLOWED_FAMILIES_SET.has(opFamily)) {
            continue;
        }

        const perEventCount = Number(byEventQuota.get(eventId) || 0);
        if (perEventCount >= 2) {
            skipped += 1;
            continue;
        }

        byEventQuota.set(eventId, perEventCount + 1);
        attempted += 1;

        try {
            const refreshed = await refreshOpportunity(op);
            if (!refreshed || typeof refreshed !== 'object') {
                skipped += 1;
                continue;
            }

            const beforeOdd = Number(op?.price ?? op?.odd ?? NaN);
            const afterPrice = Number(refreshed?.price ?? NaN);
            const merged = { ...op, ...refreshed };

            // LIVE_SNIPE mantiene cuota en "odd"; preservamos ambos campos para UI y guardas.
            if (Number.isFinite(afterPrice) && afterPrice > 1) {
                merged.price = afterPrice;
                if (Object.prototype.hasOwnProperty.call(op || {}, 'odd')) {
                    merged.odd = afterPrice;
                }
            }

            const afterOdd = Number(merged?.price ?? merged?.odd ?? NaN);
            if (Number.isFinite(beforeOdd) && Number.isFinite(afterOdd) && Math.abs(afterOdd - beforeOdd) >= 0.0001) {
                applied += 1;
            }

            updatedOps[idx] = merged;
        } catch (error) {
            skipped += 1;
            console.warn(`⚠️ Hybrid requote falló (${op?.match || eventId}): ${error.message}`);
        }
    }

    return {
        ops: updatedOps,
        attempted,
        applied,
        skipped
    };
};

export const discardOpportunity = async (opportunityId) => {
    await initDB();
    if (!db.data.blacklist) db.data.blacklist = [];
    const idStr = String(opportunityId);
    
    if (!db.data.blacklist.includes(idStr)) {
        db.data.blacklist.push(idStr);
        await db.write();
        console.log(`🗑️ Oportunidad DESCARTADA y añadida a Blacklist (Persistente): ${opportunityId}`);
    }
    return true;
};

// Getter para uso en rutas
export const getDiscardedIds = () => {
    if (!db.data || !db.data.blacklist) return [];
    return db.data.blacklist;
};

let lastScanTime = null;
let isScanning = false;
let ticks = 0; // Contador de ciclos

/**
 * INICIAR LOOP DE FONDO (BACKGROUND WORKER)
 */
export const startBackgroundScanner = () => {
    if (isScanning) return;
    isScanning = true;

    const socketBoot = startAcityLiveSocketService();
    if (socketBoot?.started) {
        console.log(`🧵 ACity Socket.IO activado para recotización LIVE (reason=${socketBoot.reason || 'enabled'}).`);
    } else {
        console.log(`🧵 ACity Socket.IO no activo (reason=${socketBoot?.reason || 'disabled'}).`);
    }
    
    const loop = async () => {
        let pollMode = 'idle';
        try {
            await initDB(); // Refrescar DB en cada ciclo
            ticks++;
            pruneQuoteStabilityCache();
            
            // ---------------------------------------------------------
            // 1. REFRESCO LIVIANO PRE-MATCH (sin scan pesado)
            // ---------------------------------------------------------
            // En picos de sábados, scanPrematchOpportunities() puede bloquear el event loop.
            // Aquí solo refrescamos IDs desde DB para evitar duplicados Live vs Prematch.
            if (ticks === 1 || ticks % 30 === 0) {
                 const nextPrematchIds = new Set();
                 const dbUpcoming = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
                 for (const row of dbUpcoming) {
                     if (row?.id != null) nextPrematchIds.add(String(row.id));
                     if (row?.altenarId != null) nextPrematchIds.add(String(row.altenarId));
                 }
                 cachedPrematchIds = nextPrematchIds;
                 if (ticks % 60 === 0) {
                     console.log(`   🧠 Prematch IDs cache refrescado: ${cachedPrematchIds.size}`);
                 }
            }

            // ---------------------------------------------------------
            // 2. ESCANEAR LIVE (Cada ciclo ~30s)
            // ---------------------------------------------------------

            const socketDirtySignals = consumeAcitySocketDirtySignals({
                max: LIVE_SOCKET_REQUOTE_MAX_PER_CYCLE * 3,
                maxAgeMs: LIVE_SOCKET_DIRTY_MAX_AGE_MS
            });
            const socketDirtyConsumed = socketDirtySignals.length;
            const socketDirtyLiveConsumed = socketDirtySignals.filter((signal) => {
                const scopes = new Set((signal?.scopes || []).map((s) => String(s || '').toLowerCase()));
                if (scopes.size === 0) return true;
                return scopes.has('live') || scopes.has('unknown');
            }).length;
            const socketDirtyPrematchConsumed = socketDirtySignals.filter((signal) => {
                const scopes = new Set((signal?.scopes || []).map((s) => String(s || '').toLowerCase()));
                if (scopes.size === 0) return true;
                return scopes.has('prematch') || scopes.has('unknown');
            }).length;
            let socketRequotesAttempted = 0;
            let socketRequotesApplied = 0;
            let socketPrematchRefreshAttempted = 0;
            let socketPrematchRefreshApplied = 0;
            let socketPrematchRefreshChanged = 0;

            if (socketDirtyConsumed > 0) {
                const prematchRefreshResult = await applySocketDrivenPrematchRefresh(socketDirtySignals);
                socketPrematchRefreshAttempted = Number(prematchRefreshResult?.attempted || 0);
                socketPrematchRefreshApplied = Number(prematchRefreshResult?.applied || 0);
                socketPrematchRefreshChanged = Number(prematchRefreshResult?.changed || 0);

                if (socketPrematchRefreshAttempted > 0) {
                    console.log(
                        `   🧵 Socket prematch refresh: dirty=${socketDirtyPrematchConsumed} attempted=${socketPrematchRefreshAttempted} ` +
                        `applied=${socketPrematchRefreshApplied} changed=${socketPrematchRefreshChanged}`
                    );
                }
            }
            
            const socketDiagnostics = getAcityLiveSocketDiagnostics();
            const wsapiSocketsEnabledCount = Array.isArray(socketDiagnostics?.wsapiSocketsEnabled)
                ? socketDiagnostics.wsapiSocketsEnabled.length
                : null;

            let hybridSelectiveCycle = 0;
            let hybridSkippedFullScan = 0;
            let hybridRequotesAttempted = 0;
            let hybridRequotesApplied = 0;
            let hybridReason = null;

            let ranFullLiveOverview = false;
            let rawEvents = [];
            let liveEventCount = 0;
            let rawOps = [];
            let dedupCount = 0;
            let stableCount = 0;
            let ops = Array.isArray(cachedOpportunities) ? [...cachedOpportunities] : [];

            // Contar apuestas activas que siguen en juego para mantener modo rápido.
            const activeLiveBets = (db.data.portfolio?.activeBets || []).filter(b => {
                const isLiveOrigin = b.type === 'LIVE_SNIPE' || b.type === 'LIVE_VALUE' || b.type === 'LA_VOLTEADA' || b.isLive;
                const hasLiveClock = b.liveTime && b.liveTime !== 'Final' && b.liveTime !== 'FT';
                return isLiveOrigin || hasLiveClock;
            }).length;

            const hybridDecision = decideHybridSelectiveCycle({
                socketDiagnostics,
                socketDirtyConsumed,
                cycle: ticks,
                cachedOpsCount: ops.length
            });

            if (hybridDecision.enabled) {
                hybridSelectiveCycle = 1;
                hybridSkippedFullScan = 1;
                hybridReason = hybridDecision.reason;

                const filteredInitialCount = ops.length;
                const activeBetIds = new Set(
                    (db.data.portfolio.activeBets || []).map(b => {
                        const eventId = String(b.eventId);
                        return `${eventId}_${normalizePick(b)}`;
                    })
                );
                const hiddenIds = new Set(db.data.blacklist || []);
                ops = ops.filter((op) => {
                    const opId = getOpportunityId(op);
                    if (activeBetIds.has(opId)) return false;
                    if (hiddenIds.has(opId)) return false;
                    return true;
                });

                if (ops.length < filteredInitialCount) {
                    console.log(`   🧹 Hybrid selectivo ocultó ${filteredInitialCount - ops.length} oportunidades ya jugadas/descartadas.`);
                }

                const hybridResult = await applyHybridSelectiveRequotes(ops);
                ops = Array.isArray(hybridResult?.ops) ? hybridResult.ops : ops;
                hybridRequotesAttempted = Number(hybridResult?.attempted || 0);
                hybridRequotesApplied = Number(hybridResult?.applied || 0);

                dedupCount = ops.length;
                stableCount = ops.length;

                if (ticks % 2 === 0) {
                    console.log(
                        `   🛰️ Hybrid selectivo: reason=${hybridReason} attempted=${hybridRequotesAttempted} ` +
                        `applied=${hybridRequotesApplied} cachedOps=${ops.length}`
                    );
                }
            } else {
                hybridReason = hybridDecision.reason;
                ranFullLiveOverview = true;

                // A) Obtener RAW Events (Solo 1 llamada HTTP)
                rawEvents = await getLiveOverview();
                liveEventCount = Array.isArray(rawEvents) ? rawEvents.length : 0;

                // B) Pasar a lógica de detección (Inyectamos eventos para ahorrar calls)
                // STRATEGY 1: VALUE BETS (Arbitraje Live)
                let opsValue = [];
                try {
                    opsValue = await performValueScan(rawEvents);
                } catch (e) {
                    console.error("⚠️ Error en Value Scan:", e.message);
                }

                // STRATEGY 2: TURNAROUNDS ("La Volteada")
                let opsTurnaround = [];
                try {
                    opsTurnaround = await performTurnaroundScan(rawEvents); // Inyectamos eventos
                } catch (e) {
                    console.error("⚠️ Error en Turnaround Scan:", e.message);
                }

                // Combinar Oportunidades
                rawOps = [...(opsValue || []), ...(opsTurnaround || [])];

                // [MOD] Deduplicación estricta para evitar filas repetidas en UI
                // Filtramos por key única compuesta: EventID + Market + Selection + Line
                // Preferimos la estrategia "Value" si colisiona con "Turnaround"
                const uniqueMap = new Map();
                rawOps.forEach(op => {
                    const key = `${op.eventId}_${op.market}_${op.selection}_${op.line||''}`;
                    if (!uniqueMap.has(key)) {
                        uniqueMap.set(key, op);
                    } else {
                        // Si ya existe, nos quedamos con la que tenga mejor EV (o la más reciente)
                        const existing = uniqueMap.get(key);
                        if ((op.ev || 0) > (existing.ev || 0)) {
                            uniqueMap.set(key, op);
                        }
                    }
                });
                ops = Array.from(uniqueMap.values());
                dedupCount = ops.length;

                // [ANTI-VOLATILIDAD] Requiere 2 confirmaciones con la misma firma de cuota
                // antes de exponer oportunidad en UI (aplica a VALUE + TURNAROUND).
                const preStableCount = ops.length;
                ops = filterStableLiveQuotes(ops);
                stableCount = ops.length;
                if (preStableCount > 0 && ops.length < preStableCount && ticks % 3 === 0) {
                    console.log(`   🧱 Filtro de estabilidad: ${preStableCount - ops.length} oportunidades en enfriamiento.`);
                }

                // FILTRADO ROBUSTO:
                // 1. Remover eventos que ya eran Oportunidades Pre-Match (Memoria sesión actual)
                // 2. Remover selecciones específicas que ya tienen apuestas activas (Persistencia DB)
                if (ops && ops.length > 0) {
                    const initialCount = ops.length;

                    // [FIX] IDs de apuestas activas (usar ID único: eventId + selection)
                    const activeBetIds = new Set(
                        (db.data.portfolio.activeBets || []).map(b => {
                            const eventId = String(b.eventId);
                            return `${eventId}_${normalizePick(b)}`;
                        })
                    );
                    const hiddenIds = new Set(db.data.blacklist || []);

                    ops = ops.filter(op => {
                        const opId = getOpportunityId(op); // ID único para ambos checks

                        // 1. Filtrar si ya se apostó ESTA SELECCIÓN ESPECÍFICA
                        if (activeBetIds.has(opId)) return false;
                        // 2. Filtrar si se descartó esta selección específica
                        if (hiddenIds.has(opId)) return false;

                        return true;
                    });

                    if (ops.length < initialCount) {
                        console.log(`   🧹 Ocultando ${initialCount - ops.length} oportunidades LIVE (Repetidas o Ya Apostadas).`);
                    }

                    if ((rawOps.length > 0 || dedupCount > 0) && ticks % 2 === 0) {
                        console.log(`   📊 Pipeline LIVE: raw=${rawOps.length} dedup=${dedupCount} stable=${stableCount} final=${ops.length}`);
                    }
                }

                if (socketDirtyConsumed > 0 && ops.length > 0) {
                    const requoteResult = await applySocketDrivenRequotes(ops, socketDirtySignals);
                    ops = Array.isArray(requoteResult?.ops) ? requoteResult.ops : ops;
                    socketRequotesAttempted = Number(requoteResult?.attempted || 0);
                    socketRequotesApplied = Number(requoteResult?.applied || 0);

                    if (socketRequotesAttempted > 0) {
                        console.log(
                            `   🧵 Socket requote: dirty=${socketDirtyLiveConsumed} attempted=${socketRequotesAttempted} applied=${socketRequotesApplied}`
                        );
                    }
                }
            }

            // C) AUTO-TRADING LIVE (Detectar entrada)
            if (ops && ops.length > 0) {
                 console.log(`   🎯 Oportunidades LIVE encontradas: ${ops.length}`);
                for (const op of ops) {
                    // Modo por defecto: semi-automático.
                    // Si AUTO_SNIPE está activo, ejecuta los tipos permitidos con guardas.
                    const autoResult = await maybeRunAutoSnipe(op);
                    if (autoResult?.triggered) {
                        appendLiveDecisionLog({
                            type: String(op?.type || op?.strategy || 'UNKNOWN').toUpperCase(),
                            eventId: op?.eventId || op?.id || null,
                            match: op?.match || null,
                            selection: op?.selection || op?.action || null,
                            ev: Number(op?.ev || 0),
                            kellyStake: Number(op?.kellyStake || 0),
                            decision: 'triggered',
                            outcome: autoResult?.outcome || (autoResult?.dryRun ? 'dry-run' : 'triggered'),
                            reason: autoResult?.reason || null,
                            ticketId: autoResult?.ticketId || null,
                            placementMode: autoResult?.placementMode || buildPlacementMode({
                                provider: getAutoPlacementProvider(),
                                realEnabled: isRealPlacementEnabledForProvider(getAutoPlacementProvider())
                            }),
                            placementProvider: autoResult?.placementProvider || getAutoPlacementProvider()
                        });
                        if (autoResult.dryRun) {
                            console.log(`      🤖 AUTO_SNIPE (dry-run): ${op.match}`);
                        } else if (autoResult.outcome === 'confirmed') {
                            console.log(`      🤖 AUTO_SNIPE resultado final: CONFIRMED | ${op.match} | ticket=${autoResult.ticketId}`);
                        } else if (autoResult.outcome === 'rejected') {
                            console.log(`      🤖 AUTO_SNIPE resultado final: REJECTED | ${op.match}`);
                        } else if (autoResult.outcome === 'uncertain') {
                            console.log(`      🤖 AUTO_SNIPE resultado final: UNCERTAIN | ${op.match}`);
                        } else {
                            console.log(`      🤖 AUTO_SNIPE ejecutado: ${op.match}`);
                        }
                    } else {
                        const reason = autoResult?.reason || 'manual-default';
                        appendLiveDecisionLog({
                            type: String(op?.type || op?.strategy || 'UNKNOWN').toUpperCase(),
                            eventId: op?.eventId || op?.id || null,
                            match: op?.match || null,
                            selection: op?.selection || op?.action || null,
                            ev: Number(op?.ev || 0),
                            kellyStake: Number(op?.kellyStake || 0),
                            decision: 'not-triggered',
                            outcome: 'manual',
                            reason,
                            placementMode: buildPlacementMode({
                                provider: getAutoPlacementProvider(),
                                realEnabled: isRealPlacementEnabledForProvider(getAutoPlacementProvider())
                            }),
                            placementProvider: getAutoPlacementProvider()
                        });
                        console.log(`      👀 Oportunidad detectada (Esperando confirmación manual): ${op.match} | reason=${reason}`);
                    }
                }
            } else {
                 appendLiveDecisionLog({
                    decision: 'no-opportunities',
                    outcome: 'none',
                    reason: 'empty-final-op-list',
                    pipeline: {
                        liveEventCount,
                        rawCount: rawOps.length,
                        dedupCount,
                        stableCount,
                        finalCount: ops.length
                    }
                 });
                 if(ticks % 2 === 0) console.log(`   ... Escaneo Live completado. Sin oportunidades (nuevas).`);
            }

              // [AUTO-ADAPTIVO] Mantener modo agresivo solo si hay actividad real.
              // Si estamos en ciclo híbrido selectivo, reducimos carga de polling masivo.
              if (hybridSelectiveCycle) {
                  pollMode = (ops && ops.length > 0) ? 'hybrid-selective' : 'idle';
              } else {
                  // Actividad = eventos live en feed o apuestas activas live u oportunidades detectadas
                  pollMode = (liveEventCount > 0 || activeLiveBets > 0 || (ops && ops.length > 0)) ? 'live-hot' : 'idle';
              }

                        recordLivePipelineStats({
                                liveEventCount,
                                rawCount: rawOps.length,
                                dedupCount,
                                stableCount,
                                finalCount: ops.length,
                                activeLiveBets,
                                pollMode,
                                socketDirtyConsumed,
                                socketDirtyLiveConsumed,
                                socketDirtyPrematchConsumed,
                                socketRequotesAttempted,
                                socketRequotesApplied,
                                socketPrematchRefreshAttempted,
                                socketPrematchRefreshApplied,
                                socketPrematchRefreshChanged,
                                hybridSelectiveCycle,
                                hybridSkippedFullScan,
                                hybridRequotesAttempted,
                                hybridRequotesApplied,
                                hybridReason,
                                wsapiSocketsEnabledCount
                        });

            // (Pre-match block moved up)

            // ---------------------------------------------------------
            // 3. MONITORING (Actualizar salidas)
            // ---------------------------------------------------------
            // Usamos los rawEvents para el tracking solo cuando hubo full scan.
            if (ranFullLiveOverview && rawEvents) {
                // [MOD] Obtener Pinnacle Feed para sincronizar activeBets también
                let pinFeed = [];
                try {
                     const { getAllPinnacleLiveOdds } = await import('./pinnacleService.js');
                     const map = await getAllPinnacleLiveOdds(); // Reusa cache de la llamada previa en scanner si la hubo
                     if (map) pinFeed = Array.from(map.values());
                } catch(e) {}
                
                await updateActiveBetsWithLiveData(rawEvents, pinFeed);
            } else if (hybridSelectiveCycle && ticks % 10 === 0) {
                console.log('   🛰️ Hybrid selectivo activo: se omite refresh de activeBets en este subciclo.');
            }

            cachedOpportunities = ops;
            lastScanTime = new Date();

        } catch (e) {
            pollMode = 'error';
            console.error('⚠️ Background Scan Error:', e.message);
            // [FIX] Si hay error, limpiar caché para no mostrar partidos congelados "zombis" (Arkadag Min 19)
            if (cachedOpportunities.length > 0) {
                 console.log("   🧹 Datos de caché obsoletos/congelados. Limpiando para evitar errores visuales.");
                 cachedOpportunities = [];
            }
        } finally {
            // POLLING AUTO-ADAPTATIVO
            // - live-hot: máxima frescura para EN VIVO
            // - idle: baja frecuencia cuando no hay actividad live
            // - error: backoff para reducir presión ante fallos
            let MIN_POLL_INTERVAL = 4500;
            let RANDOM_JITTER = 1500;

            if (pollMode === 'live-hot') {
                MIN_POLL_INTERVAL = 2000;
                RANDOM_JITTER = 600;
            } else if (pollMode === 'hybrid-selective') {
                MIN_POLL_INTERVAL = 2200;
                RANDOM_JITTER = 700;
            } else if (pollMode === 'error') {
                MIN_POLL_INTERVAL = 7000;
                RANDOM_JITTER = 2000;
            }
            
            const delay = MIN_POLL_INTERVAL + Math.floor(Math.random() * RANDOM_JITTER);

            if (ticks % 10 === 0) {
                console.log(`   ⏱️ Poll Mode: ${pollMode} (${MIN_POLL_INTERVAL}-${MIN_POLL_INTERVAL + RANDOM_JITTER}ms)`);
            }
            
            setTimeout(loop, delay);
        }
    };

    loop();
    console.log(
        `🔄 Background Scanner Iniciado (Modo Seguro Anti-Ban) | ` +
        `AUTO_SNIPE=${AUTO_SNIPE_ENABLED ? 1 : 0} dryRun=${AUTO_SNIPE_DRY_RUN ? 1 : 0} ` +
        `provider=${getAutoPlacementProvider()} ` +
        `types=${AUTO_PLACEMENT_ALLOWED_TYPES.join(',')} ` +
        `bookyReal=${BOOKY_REAL_PLACEMENT_ENABLED ? 1 : 0} minEV=${AUTO_SNIPE_MIN_EV_PERCENT} ` +
        `pinnacleReal=${PINNACLE_REAL_PLACEMENT_ENABLED ? 1 : 0} ` +
        `minStake=${AUTO_SNIPE_MIN_STAKE_SOL} hourlyCap=${AUTO_SNIPE_MAX_BETS_PER_HOUR} ` +
        `reentryPct=${AUTO_SNIPE_REENTRY_MIN_ODD_IMPROVEMENT_PCT}% reentryPts=${AUTO_SNIPE_REENTRY_MIN_ODD_POINTS} ` +
        `maxEntriesPick=${AUTO_SNIPE_MAX_ENTRIES_PER_PICK}`
    );
};

export const getCachedLiveOpportunities = () => {
    // [FIX] Filtrar al momento de servir también, por si el caché tiene datos viejos o hubo una desconexión
    const hiddenMap = new Set(db.data.blacklist || []);
    const filtered = (cachedOpportunities || []).filter(op => {
        const opId = getOpportunityId(op); // ID único por selección
        return !hiddenMap.has(opId);
    });
    
    return {
        timestamp: lastScanTime,
        data: filtered
    };
};

export const getLiveDecisionDiagnostics = ({ limit = 200 } = {}) => {
    const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
    const recent = liveDecisionLog.slice(-safeLimit);

    const reasonBreakdown = {};
    for (const row of recent) {
        const key = String(row?.reason || row?.outcome || 'unknown');
        reasonBreakdown[key] = (reasonBreakdown[key] || 0) + 1;
    }

    return {
        generatedAt: new Date().toISOString(),
        scanner: {
            autoSnipeEnabled: AUTO_SNIPE_ENABLED,
            autoSnipeDryRun: AUTO_SNIPE_DRY_RUN,
            autoPlacementProvider: getAutoPlacementProvider(),
            autoPlacementProviderOptions: AUTO_PLACEMENT_PROVIDER_OPTIONS,
            autoPlacementAllowedTypes: AUTO_PLACEMENT_ALLOWED_TYPES,
            bookyRealPlacementEnabled: BOOKY_REAL_PLACEMENT_ENABLED,
            pinnacleRealPlacementEnabled: PINNACLE_REAL_PLACEMENT_ENABLED,
            minEvPercent: AUTO_SNIPE_MIN_EV_PERCENT,
            minStakeSol: AUTO_SNIPE_MIN_STAKE_SOL,
            maxBetsPerHour: AUTO_SNIPE_MAX_BETS_PER_HOUR,
            cooldownPerPickMs: AUTO_SNIPE_COOLDOWN_PER_PICK_MS,
            reentryMinOddImprovementPct: AUTO_SNIPE_REENTRY_MIN_ODD_IMPROVEMENT_PCT,
            reentryMinOddPoints: AUTO_SNIPE_REENTRY_MIN_ODD_POINTS,
            maxEntriesPerPick: AUTO_SNIPE_MAX_ENTRIES_PER_PICK,
            liveGlobalStabilityEnabled: LIVE_GLOBAL_STABILITY_ENABLED,
            liveGlobalStabilityMinHits: QUOTE_STABILITY_MIN_HITS,
            liveSocketRequoteEnabled: LIVE_SOCKET_REQUOTE_ENABLED,
            liveSocketRequoteMaxPerCycle: LIVE_SOCKET_REQUOTE_MAX_PER_CYCLE,
            liveSocketDirtyMaxAgeMs: LIVE_SOCKET_DIRTY_MAX_AGE_MS,
            liveSocketRequoteAllowedFamilies: LIVE_SOCKET_REQUOTE_ALLOWED_FAMILIES,
            prematchSocketRefreshEnabled: PREMATCH_SOCKET_REFRESH_ENABLED,
            prematchSocketRefreshMaxPerCycle: PREMATCH_SOCKET_REFRESH_MAX_PER_CYCLE,
            liveHybridSelectiveEnabled: LIVE_HYBRID_SELECTIVE_ENABLED,
            liveHybridRequireWsapiDisabled: LIVE_HYBRID_REQUIRE_WSAPI_DISABLED,
            liveHybridSocketColdMinRawMessages: LIVE_HYBRID_SOCKET_COLD_MIN_RAW_MESSAGES,
            liveHybridFullScanEveryNCycles: LIVE_HYBRID_FULL_SCAN_EVERY_N_CYCLES,
            liveHybridSelectiveMaxPerCycle: LIVE_HYBRID_SELECTIVE_MAX_PER_CYCLE,
            liveHybridSelectiveAllowedFamilies: LIVE_HYBRID_SELECTIVE_ALLOWED_FAMILIES
        },
        pipeline: lastLivePipelineStats,
        acitySocketDiagnostics: getAcityLiveSocketDiagnostics(),
        liveSnipeDiagnostics: getLiveSnipeScanDiagnostics(),
        summary: {
            totalStored: liveDecisionLog.length,
            returned: recent.length,
            reasonBreakdown
        },
        recent
    };
};

/**
 * LÓGICA CORE: The Sniper
 * (Wrapper para compatibilidad, redirige al servicio especializado)
 */
export const scanLiveOpportunities = async () => {
    return await performLiveScan();
};

