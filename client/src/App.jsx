import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
  Trophy, RefreshCw, Zap, TrendingUp, Calendar, Activity, RotateCcw, Archive, Clock, Volume2, 
  ChevronLeft, ChevronRight, Filter, Layers, Edit, Search, Link as LinkIcon, Trash2 
} from 'lucide-react';
import ManualMatcher from './components/ManualMatcher';
import MonitorDashboard from './components/MonitorDashboard';

// Sonido de Notificación (Ping Suave)
const ALERT_SOUND = "data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU..."; 
// Nota: Usaré un enlace externo confiable o un base64 real corto en la implementación final
// Para este ejemplo, usaré un método de oscilador web audio api que no requiere assets externos y es más fiable.

// Helper: Generar PICK normalizado para IDs consistentes entre UI y backend
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

// Helper: Generar ID único por oportunidad (eventId + pick normalizado)
function getOpportunityId(op) {
    const eventId = String(op.eventId || op.id);
    return `${eventId}_${normalizePick(op)}`;
}

const BOOKY_SETTLED_STATUSES = new Set([1, 2, 4, 8, 18]);
const isBookyOpenStatus = (value) => Number(value) === 0;
const OPTIMISTIC_BET_TTL_MS = 45000;
const OPTIMISTIC_BET_TTL_SNIPE_MS = 60000;
const LIVE_ALERT_COOLDOWN_MS = 90000;
const REENTRY_MIN_ODD_IMPROVEMENT_PCT = 8;
const REENTRY_MIN_EV_PERCENT = 3;
const REENTRY_MIN_STAKE_SOL = 1;
const MIN_BOOKY_STAKE_SOL = 1;
const AUTO_PLACEMENT_PROVIDER_ALLOWED = ['booky', 'pinnacle'];

const normalizeAutoPlacementProvider = (value = '', fallback = 'booky') => {
    const normalized = String(value || '').trim().toLowerCase();
    return AUTO_PLACEMENT_PROVIDER_ALLOWED.includes(normalized) ? normalized : fallback;
};

const normalizeAutoPlacementProviderOptions = (values = []) => {
    const list = Array.isArray(values) ? values : [];
    const normalized = list
        .map((v) => normalizeAutoPlacementProvider(v, ''))
        .filter(Boolean);
    return normalized.length > 0 ? Array.from(new Set(normalized)) : [...AUTO_PLACEMENT_PROVIDER_ALLOWED];
};

const FINISHED_PROVIDER_FILTER_ALLOWED = ['ALL', 'BOOKY', 'PINNACLE', 'SIM'];
const FINISHED_PROVIDER_FILTER_LABELS = {
    ALL: 'Todos',
    BOOKY: 'Booky',
    PINNACLE: 'Pinnacle',
    SIM: 'Sim'
};

const ARBITRAGE_RISK_PROFILE_PRESETS = {
    conservative: {
        label: 'Conservador',
        config: {
            stakeMode: 'percent_nav',
            stakePercentNav: 12,
            stakeFixedAmount: 12,
            maxStakePercentNav: 20,
            maxStakeAbs: 20,
            minRoiPercent: 0.8,
            minProfitAbs: 1
        }
    },
    moderate: {
        label: 'Moderado',
        config: {
            stakeMode: 'percent_nav',
            stakePercentNav: 20,
            stakeFixedAmount: 20,
            maxStakePercentNav: 30,
            maxStakeAbs: 30,
            minRoiPercent: 0.6,
            minProfitAbs: 1.5
        }
    },
    aggressive: {
        label: 'Agresivo',
        config: {
            stakeMode: 'percent_nav',
            stakePercentNav: 28,
            stakeFixedAmount: 28,
            maxStakePercentNav: 40,
            maxStakeAbs: 40,
            minRoiPercent: 0.4,
            minProfitAbs: 1
        }
    }
};

const normalizeFinishedProviderFilter = (value = 'ALL') => {
    const normalized = String(value || '').trim().toUpperCase();
    return FINISHED_PROVIDER_FILTER_ALLOWED.includes(normalized) ? normalized : 'ALL';
};

const resolveFinishedProviderOrigin = (row = {}) => {
    if (!row || typeof row !== 'object') return 'SIM';

    if (typeof row?.finishedProviderOrigin === 'string' && row.finishedProviderOrigin.trim()) {
        return normalizeFinishedProviderFilter(row.finishedProviderOrigin);
    }

    const source = String(row?.source || '').trim().toLowerCase();
    const integration = String(
        row?.integration ||
        row?.realPlacement?.integration ||
        row?.realPlacement?.requested?.integration ||
        ''
    ).trim().toLowerCase();
    const providerHint = String(
        row?.provider ||
        row?.realPlacement?.provider ||
        row?.placementProvider ||
        ''
    ).trim().toLowerCase();
    const endpoint = String(row?.realPlacement?.endpoint || '').trim().toLowerCase();
    const providerRequestId = String(row?.providerRequestId || row?.realPlacement?.response?.requestId || '').trim();

    const looksPinnacle = Boolean(
        providerHint.includes('pinnacle') ||
        providerHint.includes('arcadia') ||
        endpoint.includes('arcadia.pinnacle.com') ||
        endpoint.includes('/0.1/bets') ||
        providerRequestId
    );
    if (looksPinnacle) return 'PINNACLE';

    const looksBooky = Boolean(
        row?.isBookyHistory ||
        source === 'remote' ||
        integration === 'acity' ||
        integration === 'doradobet' ||
        endpoint.includes('placewidget') ||
        endpoint.includes('altenar') ||
        endpoint.includes('biahosted')
    );
    if (looksBooky) return 'BOOKY';

    const hasRealMarkers = Boolean(
        row?.isRealHistory ||
        row?.providerBetId ||
        row?.providerStatus ||
        row?.realPlacement
    );
    if (hasRealMarkers) return 'BOOKY';

    return 'SIM';
};

const getFinishedProviderBadgeMeta = (row = {}) => {
    const origin = resolveFinishedProviderOrigin(row);

    if (origin === 'PINNACLE') {
        return {
            origin,
            label: 'PINNACLE',
            className: 'bg-orange-500/15 text-orange-300 border-orange-500/30'
        };
    }

    if (origin === 'BOOKY') {
        return {
            origin,
            label: 'BOOKY',
            className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
        };
    }

    return {
        origin: 'SIM',
        label: 'SIM',
        className: 'bg-blue-500/15 text-blue-300 border-blue-500/30'
    };
};

const resolveBookyOutcome = (row = {}) => {
    const status = Number(row?.status);
    const stake = Number(row?.stake);
    const payout = Number(row?.payout);
    const potentialReturn = Number(row?.potentialReturn);

    const safeStake = Number.isFinite(stake) ? stake : 0;
    let returnAmount = 0;

    if (Number.isFinite(payout) && payout > 0) {
        returnAmount = payout;
    } else if (Number.isFinite(potentialReturn) && potentialReturn > 0 && status === 1) {
        returnAmount = potentialReturn;
    } else if (status === 4 || status === 18) {
        returnAmount = safeStake;
    }

    const pnl = returnAmount - safeStake;

    if (status === 2) {
        return { label: 'PERDIDA', pnl: -Math.abs(safeStake), colorClass: 'text-red-400' };
    }
    if (status === 4 || status === 18) {
        return { label: 'ANULADA', pnl: 0, colorClass: 'text-slate-300' };
    }
    if (status === 8) {
        return { label: 'CASHOUT', pnl, colorClass: pnl >= 0 ? 'text-emerald-400' : 'text-red-400' };
    }
    if (status === 1) {
        return { label: 'GANADA', pnl, colorClass: pnl >= 0 ? 'text-emerald-400' : 'text-red-400' };
    }

    return { label: 'LIQUIDADA', pnl, colorClass: pnl >= 0 ? 'text-emerald-400' : 'text-red-400' };
};

const normalizeScoreText = (value) => {
    if (typeof value !== 'string') return null;
    const clean = value.trim();
    if (!clean) return null;
    if (clean.includes(':')) return clean.replace(':', '-');
    return clean;
};

const isMissingScoreText = (value) => {
    const normalized = normalizeScoreText(value);
    if (!normalized) return true;
    const compact = normalized.replace(/\s+/g, '');
    return compact === '?-?' || compact === '?' || compact === '-';
};

const resolveBestScoreText = (...rows) => {
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const candidates = [
            row?.finalScore,
            row?.lastKnownScore,
            Array.isArray(row?.score) ? row.score.join(' - ') : row?.score,
            resolveBookyFinalScore(row)
        ];
        for (const candidate of candidates) {
            const normalized = normalizeScoreText(candidate);
            if (!isMissingScoreText(normalized)) return normalized;
        }
    }
    return null;
};

const resolveBookyFinalScore = (row = {}) => {
    const fromSelectionRaw = row?.selections?.[0]?.raw?.eventScore;
    const fromRawSelection = row?.raw?.selections?.[0]?.eventScore;
    const fromRawRoot = row?.raw?.eventScore;
    const fromDirect = row?.score;
    return (
        normalizeScoreText(fromSelectionRaw) ||
        normalizeScoreText(fromRawSelection) ||
        normalizeScoreText(fromRawRoot) ||
        normalizeScoreText(fromDirect) ||
        null
    );
};

const resolveBookyGameTime = (row = {}) => {
    const fromSelectionRaw = row?.selections?.[0]?.raw?.gameTime;
    const fromRawSelection = row?.raw?.selections?.[0]?.gameTime;
    if (typeof fromSelectionRaw === 'string' && fromSelectionRaw.trim()) return fromSelectionRaw.trim();
    if (typeof fromRawSelection === 'string' && fromRawSelection.trim()) return fromRawSelection.trim();
    return null;
};

const isBookyMatchFinished = (row = {}) => {
    const gameTimeRaw = String(resolveBookyGameTime(row) || '').trim();
    const normalized = gameTimeRaw.toUpperCase();

    if (
        normalized === 'FINAL' ||
        normalized === 'FT' ||
        normalized === 'FULL TIME' ||
        normalized === 'ENDED'
    ) {
        return true;
    }

    const minuteMatch = normalized.match(/(\d{1,3})/);
    if (minuteMatch) {
        const minute = Number(minuteMatch[1]);
        if (Number.isFinite(minute) && minute >= 90) return true;
        if (Number.isFinite(minute) && minute < 90) return false;
    }

    const startIso = resolveBookyEventStartIso(row) || row?.matchDate || row?.date || null;
    if (!startIso) return false;
    const startTs = new Date(startIso).getTime();
    if (!Number.isFinite(startTs)) return false;

    const minutesSinceStart = (Date.now() - startTs) / 60000;
    return minutesSinceStart >= 140;
};

const resolveBookyEventStartIso = (row = {}) => {
    const fromSelection = row?.selections?.[0]?.eventDate;
    const fromSelectionRaw = row?.selections?.[0]?.raw?.eventDate;
    const fromRawSelection = row?.raw?.selections?.[0]?.eventDate;

    const candidate = fromSelection || fromSelectionRaw || fromRawSelection || null;
    const date = candidate ? new Date(candidate) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const resolveOpEventStartIso = (row = {}) => {
    const candidate =
        row?.matchDate ||
        row?.eventDate ||
        row?.selections?.[0]?.eventDate ||
        row?.selections?.[0]?.raw?.eventDate ||
        row?.raw?.selections?.[0]?.eventDate ||
        row?.date ||
        null;

    const date = candidate ? new Date(candidate) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const resolveOpTicketId = (row = {}) => {
    return (
        row?.providerBetId ||
        row?.realPlacement?.providerBetId ||
        row?.realPlacement?.response?.bets?.[0]?.id ||
        null
    );
};

const resolveOpBetTimeIso = (row = {}, fallbackRow = null) => {
    const candidate =
        row?.placedAt ||
        row?.createdAt ||
        row?.confirmedAt ||
        row?.updatedAt ||
        row?.date ||
        fallbackRow?.placedAt ||
        fallbackRow?.createdAt ||
        fallbackRow?.confirmedAt ||
        fallbackRow?.updatedAt ||
        fallbackRow?.date ||
        null;

    const date = candidate ? new Date(candidate) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const resolvePlacementTimingOrigin = (row = {}, fallbackRow = null) => {
    const eventStartIso = resolveOpEventStartIso(row) || resolveOpEventStartIso(fallbackRow || {});
    const betTimeIso = resolveOpBetTimeIso(row, fallbackRow);

    const eventStartMs = eventStartIso ? new Date(eventStartIso).getTime() : NaN;
    const betPlacedMs = betTimeIso ? new Date(betTimeIso).getTime() : NaN;
    const hasValidTiming = Number.isFinite(eventStartMs) && Number.isFinite(betPlacedMs);

    const inferredLiveByTiming = hasValidTiming
        ? betPlacedMs >= (eventStartMs + (2 * 60 * 1000))
        : false;

    const inferredPrematchByTiming = hasValidTiming
        ? betPlacedMs < (eventStartMs + (2 * 60 * 1000))
        : false;

    return {
        hasValidTiming,
        inferredLiveByTiming,
        inferredPrematchByTiming,
        eventStartIso,
        betTimeIso
    };
};

const formatTimeSafe = (candidate) => {
    const date = candidate ? new Date(candidate) : null;
    if (!date || !Number.isFinite(date.getTime())) return '--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatTimeWithSecondsSafe = (candidate) => {
    const date = candidate ? new Date(candidate) : null;
    if (!date || !Number.isFinite(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatDateSafe = (candidate) => {
    const date = candidate ? new Date(candidate) : null;
    if (!date || !Number.isFinite(date.getTime())) return '--/--/----';
    return date.toLocaleDateString();
};

const normalizeMarketLabel = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '1x2';

    const normalized = raw
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (
        normalized === 'match winner' ||
        normalized === 'match result' ||
        normalized === 'moneyline' ||
        normalized === '1x2' ||
        normalized === '1 x 2'
    ) {
        return '1x2';
    }

    return raw;
};

const extractLineFromText = (value = '') => {
    const match = String(value || '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
};

const resolveSelectionLabel = (row = {}) => {
    const source = String(row?.selection || row?.action || '').trim();
    let clean = source
        .replace(/^BET\s+/i, '')
        .replace(/^APOSTAR\s+A(L|\s+LA)?\s+/i, '')
        .split('@')[0]
        .trim();

    const upper = clean.toUpperCase();
    const actionUpper = String(row?.action || '').toUpperCase();

    if (upper === 'HOME' || upper === 'LOCAL' || actionUpper.includes('LOCAL')) return 'LOCAL';
    if (upper === 'AWAY' || upper === 'VISITA' || actionUpper.includes('VISITA')) return 'VISITA';
    if (upper === 'DRAW' || upper === 'EMPATE' || actionUpper.includes('EMPATE')) return 'EMPATE';

    if ((upper === 'OVER' || upper === 'UNDER') && String(row?.market || '').toUpperCase().includes('TOTAL')) {
        const line = String(row?.market || '').match(/(\d+\.?\d*)/)?.[0];
        if (line) clean = `${upper} ${line}`;
        else clean = upper;
    }

    return clean || '-';
};

const resolveCanonicalSelectionLabel = (row = {}) => {
    const marketLabel = normalizeMarketLabel(row?.market || '');
    const marketNorm = String(marketLabel || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
    const isOneXTwo = marketNorm === '1x2';

    const rawSelection = String(resolveBookySelectionText(row) || row?.selection || '').trim();
    const rawSelectionNorm = rawSelection
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();

    if (isOneXTwo && rawSelectionNorm) {
        if (rawSelectionNorm.includes('draw') || rawSelectionNorm.includes('empate') || rawSelectionNorm === 'x') {
            return 'EMPATE';
        }

        const matchText = String(row?.match || '').trim();
        const teams = matchText.split(/\s+vs\.?\s+|\s+v\s+/i).map(t => t.trim()).filter(Boolean);
        if (teams.length >= 2) {
            const homeNorm = teams[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
            const awayNorm = teams[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

            if (rawSelectionNorm === homeNorm || rawSelectionNorm.includes(homeNorm)) return 'LOCAL';
            if (rawSelectionNorm === awayNorm || rawSelectionNorm.includes(awayNorm)) return 'VISITA';
        }

        const selectionTypeId = Number(
            row?.selectionTypeId ??
            row?.selections?.[0]?.selectionTypeId ??
            row?.raw?.selections?.[0]?.selectionTypeId
        );

        if (Number.isFinite(selectionTypeId)) {
            if (selectionTypeId === 1) return 'LOCAL';
            if (selectionTypeId === 2) return 'EMPATE';
            if (selectionTypeId === 3) return 'VISITA';
        }
    }

    const pick = String(normalizePick(row) || '').toLowerCase();

    if (pick === 'home') return 'LOCAL';
    if (pick === 'away') return 'VISITA';
    if (pick === 'draw') return 'EMPATE';
    if (pick === 'btts_yes') return 'BTTS SI';
    if (pick === 'btts_no') return 'BTTS NO';

    if (pick.startsWith('over_')) {
        const line = pick.split('_')[1];
        return line ? `OVER ${line}` : 'OVER';
    }

    if (pick.startsWith('under_')) {
        const line = pick.split('_')[1];
        return line ? `UNDER ${line}` : 'UNDER';
    }

    return resolveSelectionLabel(row);
};

const resolveBookySelectionText = (row = {}) => {
    const rawSelection = row?.selections?.[0]?.name;
    const directSelection = row?.selection;
    const text = String(rawSelection || directSelection || '').trim();
    if (!text) return null;
    return text.replace(/^BET\s+/i, '').split('@')[0].trim();
};

const resolveFinishedOpPnl = (op = {}) => {
    if (op?.isBookyHistory) {
        const outcome = resolveBookyOutcome(op);
        return Number.isFinite(Number(outcome?.pnl)) ? Number(outcome.pnl) : 0;
    }

    const pnl = Number(op?.profit);
    return Number.isFinite(pnl) ? pnl : 0;
};

const resolveStakeSyncFlags = (row = {}, fallbackStake = null, fallbackOdd = null) => {
    const requestedStake = Number(
        row?.realPlacement?.requested?.stake ??
        row?.realPlacement?.sentStake
    );
    const acceptedStake = Number(
        row?.realPlacement?.accepted?.acceptedStake ??
        row?.realPlacement?.response?.bets?.[0]?.finalStake ??
        row?.realPlacement?.response?.bets?.[0]?.totalStake
    );
    const requestedOdd = Number(
        row?.realPlacement?.requested?.odd ??
        row?.realPlacement?.sentOdd
    );
    const acceptedOdd = Number(
        row?.realPlacement?.accepted?.acceptedOdd ??
        row?.realPlacement?.response?.bets?.[0]?.odd
    );
    const baseStake = Number(fallbackStake);
    const baseOdd = Number(fallbackOdd);

    const hasRequestedStake = Number.isFinite(requestedStake) && requestedStake > 0;
    const hasAcceptedStake = Number.isFinite(acceptedStake) && acceptedStake > 0;
    const hasBaseStake = Number.isFinite(baseStake) && baseStake > 0;
    const hasRequestedOdd = Number.isFinite(requestedOdd) && requestedOdd > 1;
    const hasAcceptedOdd = Number.isFinite(acceptedOdd) && acceptedOdd > 1;
    const hasBaseOdd = Number.isFinite(baseOdd) && baseOdd > 1;

    const recalcFromPrep = row?.recalcFromPrep === true || (
        hasRequestedStake && hasBaseStake && Math.abs(requestedStake - baseStake) >= 0.01
    );

    const recalcByOdd = row?.recalcByOdd === true || (
        hasRequestedOdd && hasBaseOdd && Math.abs(requestedOdd - baseOdd) >= 0.001
    );

    const oddOnlyRecalc = row?.oddOnlyRecalc === true || (recalcByOdd && !recalcFromPrep);

    const providerAdjusted = row?.providerAdjusted === true || (
        (hasRequestedStake && hasAcceptedStake && Math.abs(acceptedStake - requestedStake) >= 0.01) ||
        (hasRequestedOdd && hasAcceptedOdd && Math.abs(acceptedOdd - requestedOdd) >= 0.001)
    );

    return { recalcFromPrep, oddOnlyRecalc, providerAdjusted };
};

const resolveBookySelectionTypePick = (row = {}) => {
    const typeId = Number(row?.selections?.[0]?.selectionTypeId ?? row?.raw?.selections?.[0]?.selectionTypeId);
    if (typeId === 1) return 'home';
    if (typeId === 2) return 'draw';
    if (typeId === 3) return 'away';
    return null;
};

const getBookyOpenBetKey = (row = {}) => {
    const eventId = String(row?.eventId || row?.selections?.[0]?.eventId || row?.raw?.selections?.[0]?.eventId || '').trim();
    if (!eventId) return null;

    const pickByType = resolveBookySelectionTypePick(row);
    const pick = pickByType || normalizePick(row);
    if (!pick) return null;

    return `${eventId}_${String(pick).toLowerCase()}`;
};

const getBookyOpenEventId = (row = {}) => {
    const eventId = String(row?.eventId || row?.selections?.[0]?.eventId || row?.raw?.selections?.[0]?.eventId || '').trim();
    return eventId || null;
};

const hasLiveClockSignal = (value = '') => {
    const txt = String(value || '').trim().toUpperCase();
    if (!txt) return false;
    if (txt === 'HT' || txt === 'HALF TIME' || txt === 'FINAL' || txt === 'FT') return true;

    // Evitar confundir hora calendario (ej: 02:09 p. m.) con minuto de juego.
    const normalized = txt.replace(/\s+/g, ' ').trim();
    if (/\b(A\.?\s*M\.?|P\.?\s*M\.?|AM|PM)\b/i.test(normalized)) return false;
    if (normalized.includes(':')) return false;

    // Señales válidas de reloj futbolístico: 12', 45+2', 90, 90+4 min
    return /\b\d{1,3}(?:\+\d{1,2})?\s*'?\s*(MIN)?\b/i.test(normalized);
};

const isEventInPlayNow = (row = {}, fallbackRow = null) => {
    const liveSignal =
        row?.liveTime ||
        row?.time ||
        row?.pinnacleInfo?.time ||
        row?.raw?.selections?.[0]?.gameTime ||
        fallbackRow?.liveTime ||
        fallbackRow?.time ||
        fallbackRow?.pinnacleInfo?.time ||
        fallbackRow?.raw?.selections?.[0]?.gameTime ||
        '';

    const upperLiveSignal = String(liveSignal || '').trim().toUpperCase();
    if (upperLiveSignal === 'FINAL' || upperLiveSignal === 'FT') return false;
    if (hasLiveClockSignal(liveSignal)) return true;

    const eventStartIso = resolveOpEventStartIso(row) || resolveOpEventStartIso(fallbackRow || {});
    if (!eventStartIso) return false;

    const eventStartMs = new Date(eventStartIso).getTime();
    if (!Number.isFinite(eventStartMs)) return false;

    const minutesSinceStart = (Date.now() - eventStartMs) / 60000;
    return minutesSinceStart >= 2 && minutesSinceStart <= 180;
};

const resolveOptimisticTtlMs = (meta = {}) => {
    const custom = Number(meta?.optimisticTtlMs);
    if (Number.isFinite(custom) && custom > 0) return custom;
    return meta?.optimisticIsSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS;
};

const hasMinBookyStake = (op = {}) => {
    const suggestedStake = Number(op?.kellyStake ?? op?.stake ?? 0);
    return Number.isFinite(suggestedStake) && suggestedStake >= MIN_BOOKY_STAKE_SOL;
};

const isLiveOriginOpportunity = (op = {}) => {
    const type = String(op?.type || op?.strategy || '').toUpperCase();
    if (type.includes('LIVE') || type === 'LA_VOLTEADA') return true;
    if (op?.isLive === true) return true;

    const liveSignal =
        op?.liveTime ||
        op?.time ||
        op?.pinnacleInfo?.time ||
        op?.raw?.selections?.[0]?.gameTime ||
        '';

    return hasLiveClockSignal(liveSignal);
};

const isPrematchOriginOpportunity = (op = {}) => {
    const type = String(op?.type || op?.strategy || op?.opportunityType || '').toUpperCase();
    if (type.includes('PREMATCH')) return true;
    if (isLiveOriginOpportunity(op)) return false;
    return false;
};

const sanitizePinnaclePriceForOrigin = ({ price = null, pinnacleInfo = null, isPrematchOrigin = false, preserveForPending = false } = {}) => {
    const raw = Number(price);
    if (!Number.isFinite(raw) || raw <= 1) return null;
    if (isPrematchOrigin) return raw;
    if (preserveForPending) return raw;

    const prematchPrice = Number(pinnacleInfo?.prematchPrice);
    if (Number.isFinite(prematchPrice) && prematchPrice > 1 && Math.abs(raw - prematchPrice) < 1e-9) {
        return null;
    }

    return raw;
};

function playAlert(kind = 'DEFAULT') {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();

        const playTone = ({
            start,
            duration,
            fromFreq,
            toFreq,
            volume = 0.08,
            type = 'sine'
        }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.type = type;
            osc.frequency.setValueAtTime(fromFreq, ctx.currentTime + start);
            osc.frequency.exponentialRampToValueAtTime(toFreq, ctx.currentTime + start + duration);

            gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);

            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + duration + 0.02);
        };

        // Sonido estándar para LIVE_VALUE
        if (kind === 'SNIPE') {
            // Sonido más distintivo para LIVE_SNIPE (doble ping rápido y más agudo)
            playTone({ start: 0, duration: 0.14, fromFreq: 780, toFreq: 1180, volume: 0.11, type: 'triangle' });
            playTone({ start: 0.18, duration: 0.16, fromFreq: 980, toFreq: 1480, volume: 0.1, type: 'triangle' });
        } else {
            playTone({ start: 0, duration: 0.45, fromFreq: 500, toFreq: 1000, volume: 0.08, type: 'sine' });
        }

        // Cerrar contexto para evitar fugas
        setTimeout(() => {
            try { ctx.close(); } catch (_) {}
        }, 900);
  } catch (e) {
    console.error("Audio play failed", e);
  }
}

function App() {
  const [liveOps, setLiveOps] = useState([]);
  const [prematchOps, setPrematchOps] = useState([]);
    const [arbitrageOps, setArbitrageOps] = useState([]);
    const [arbitrageMeta, setArbitrageMeta] = useState({
            generatedAt: null,
            source: null,
            diagnostics: null,
            risk: null,
            count: 0
    });
    const [arbitrageView, setArbitrageView] = useState('PREMATCH');
    const [arbitrageRefreshState, setArbitrageRefreshState] = useState({
        running: false,
        phase: null,
        lastOkAt: null,
        lastError: null
    });
    const [arbitrageExecutingKeys, setArbitrageExecutingKeys] = useState(new Set());
    const [arbitrageRiskProfileKey, setArbitrageRiskProfileKey] = useState('conservative');
    const [arbitrageRiskConfig, setArbitrageRiskConfig] = useState(() => ({
        ...ARBITRAGE_RISK_PROFILE_PRESETS.conservative.config
    }));
  const [portfolio, setPortfolio] = useState({ balance: 100, activeBets: [], history: [] });
    const [bookyAccount, setBookyAccount] = useState({
        profile: null,
        integration: null,
        balance: { amount: null, currency: 'PEN', stale: true },
        history: [],
        historyCount: 0,
        historyTotalCount: 0,
        pnl: { realized: 0, source: null, rowsCount: 0 },
        fetchedAt: null
    });
    const [pinnacleAccount, setPinnacleAccount] = useState({
        balance: { amount: null, currency: 'USD', stale: true },
        pnl: { total: null, baseCapital: null, baseCapitalSource: null, source: null, rowsCount: 0 },
        transactions: { source: null, fetchedAt: null, windowDays: 0, summary: null, error: null },
        fetchedAt: null,
        endpoint: '/wallet/balance',
        source: 'arcadia'
    });
    const [tokenHealth, setTokenHealth] = useState(null);
    const [kellyDiagnostics, setKellyDiagnostics] = useState(null);
    const [tokenClockMs, setTokenClockMs] = useState(() => Date.now());
    const [autoPlacementProvider, setAutoPlacementProvider] = useState('booky');
    const [autoPlacementProviderOptions, setAutoPlacementProviderOptions] = useState([...AUTO_PLACEMENT_PROVIDER_ALLOWED]);
    const [autoPlacementProviderLoading, setAutoPlacementProviderLoading] = useState(false);
    const [autoPlacementProviderSaving, setAutoPlacementProviderSaving] = useState(false);
    const [pinnacleHistorySyncing, setPinnacleHistorySyncing] = useState(false);
    const [pinnacleSyncButtonHover, setPinnacleSyncButtonHover] = useState(false);
    const [pinnacleHistorySyncMeta, setPinnacleHistorySyncMeta] = useState({
        fetchedAt: null,
        totalCount: 0,
        touchedCount: 0,
        source: null,
        error: null
    });
  
  const [loading, setLoading] = useState(false);
  
  // NAVEGACIÓN TIPO FLASHSCORE
    const [activeTab, setActiveTab] = useState('ALL'); // 'ALL', 'ARBITRAGE', 'LIVE', 'FINISHED', 'MATCHER', 'MONITOR'
  const [dateFilter, setDateFilter] = useState(new Date());
  const [finishedSelectionView, setFinishedSelectionView] = useState(() => {
      try {
          const stored = localStorage.getItem('finishedSelectionView');
          if (stored === 'HYBRID' || stored === 'BOOKY' || stored === 'CANONICAL') return stored;
      } catch (_) {}
      return 'HYBRID';
  }); // HYBRID | BOOKY | CANONICAL
  const [finishedProviderFilter, setFinishedProviderFilter] = useState(() => {
      try {
          return normalizeFinishedProviderFilter(localStorage.getItem('finishedProviderFilter') || 'ALL');
      } catch (_) {
          return 'ALL';
      }
  });

  // Refs para control de notificaciones
  const isFirstLoad = useRef(true);
    const prevLiveOpsIdsRef = useRef(new Set());
  const prevOddsRef = useRef({}); // [NEW] Cache para detectar tendencias de cuotas
        const latestLiveCandidatesByKeyRef = useRef(new Map());
          const stickyPinnacleByKeyRef = useRef(new Map());
        const lastAlertedLiveOpAtRef = useRef(new Map());
    const fetchInFlightRef = useRef(false);
    const prematchFetchInFlightRef = useRef(false);
    const arbitrageFetchInFlightRef = useRef(false);
    const lastBookyAccountFetchAtRef = useRef(0);
    const lastKellyDiagnosticsFetchAtRef = useRef(0);
    const lastPrematchFetchAtRef = useRef(0);
    const lastArbitrageFetchAtRef = useRef(0);
    const lastPlacementProviderFetchAtRef = useRef(0);
    const lastPinnacleAccountFetchAtRef = useRef(0);
    const pinnacleBalanceFetchInFlightRef = useRef(false);
    const latestPortfolioActiveBetsRef = useRef([]);
    const latestBookyHistoryRef = useRef([]);
    const activeTabRef = useRef(activeTab);
    const tokenHealthRef = useRef(tokenHealth);
    const realFinishedHydratedRef = useRef(false);
    const blockedBetIdsRef = useRef(new Set());
    const remoteOpenBetIdsRef = useRef(new Set());
    const remoteOpenEventIdsRef = useRef(new Set());
    const autoTokenRenewInFlightRef = useRef(false);
    const lastSilentTokenRenewAttemptAtRef = useRef(0);
    const placementProviderFetchInFlightRef = useRef(false);
    const arbitrageExecutingKeysRef = useRef(new Set());

    const CORE_POLL_MS = 2000;
    const PREMATCH_POLL_MS = 30000;
    const ARBITRAGE_POLL_MS = 30000;
    const ARBITRAGE_PREVIEW_LIMIT = 80;
    const PLACEMENT_PROVIDER_POLL_MS = 20000;
    const PINNACLE_BALANCE_POLL_MS = 15000;
    const PINNACLE_HISTORY_SYNC_DAYS = 180;
    const PINNACLE_HISTORY_SYNC_LIMIT = 500;
    const BOOKY_HISTORY_LIMIT = 120;
    const BOOKY_HISTORY_LIMIT_FINISHED_REAL = 0;
    const TOKEN_CLOCK_TICK_MS = 1000;
    const TOKEN_AUTO_RENEW_COOLDOWN_MS = 45000;
    const TOKEN_AUTO_RENEW_RETRY_ON_FAILURE_MS = 8000;
    const TOKEN_AUTO_RENEW_LEAD_MINUTES = 1;
  
  // [NEW] Local optimismo state: IDs recently interacted with (USING REFS TO AVOID STALE CLOSURES IN INTERVAL)
  const localDiscardedIdsRef = useRef(new Set());
  const localPlacedBetIdsRef = useRef(new Set());
  const pendingBetDetailsRef = useRef({});
    const optimisticWarnedIdsRef = useRef(new Set());

  // Trigger re-render when we update refs (hacky but works for instant feedback)
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick(t => t + 1);

        // Mantener refs vivas para evitar cierres stale dentro de setInterval(fetchData).
        activeTabRef.current = activeTab;
        tokenHealthRef.current = tokenHealth;

    const hasPrematchContext = (info = null) => {
        const ctx = info?.prematchContext;
        if (!ctx || typeof ctx !== 'object') return false;

        const candidates = [ctx.home, ctx.draw, ctx.away, ctx.over25, ctx.under25];
        return candidates.some(value => Number.isFinite(Number(value)) && Number(value) > 1);
    };

    const derivePinnacleReferencePrice = ({ pinnacleInfo = null, pick = null, market = null, selection = null } = {}) => {
        const ctx = pinnacleInfo?.prematchContext;
        if (!ctx || typeof ctx !== 'object') return null;

        const pickKey = String(pick || '').trim().toLowerCase();
        const marketLabel = normalizeMarketLabel(market || '');
        const selectionText = String(selection || '').toLowerCase();

        let candidate = null;

        if (pickKey === 'home' || selectionText.includes('local') || selectionText.includes('home')) {
            candidate = Number(ctx.home);
        } else if (pickKey === 'draw' || selectionText.includes('empate') || selectionText.includes('draw')) {
            candidate = Number(ctx.draw);
        } else if (pickKey === 'away' || selectionText.includes('visita') || selectionText.includes('away')) {
            candidate = Number(ctx.away);
        } else if (pickKey.startsWith('over_') || selectionText.includes('over') || selectionText.includes('mas ') || selectionText.includes('más ')) {
            const pickLine = extractLineFromText(pickKey);
            const selectionLine = extractLineFromText(selectionText);
            const marketLine = extractLineFromText(marketLabel);
            const targetLine = pickLine ?? selectionLine ?? marketLine;
            const totals = Array.isArray(ctx.totals) ? ctx.totals : [];
            const exact = Number.isFinite(targetLine)
                ? totals.find((t) => Math.abs(Number(t?.line) - targetLine) < 0.1)
                : null;
            candidate = Number(exact?.over);
            if (!(Number.isFinite(candidate) && candidate > 1)) {
                candidate = Number(ctx.over25);
            }
        } else if (pickKey.startsWith('under_') || selectionText.includes('under') || selectionText.includes('menos')) {
            const pickLine = extractLineFromText(pickKey);
            const selectionLine = extractLineFromText(selectionText);
            const marketLine = extractLineFromText(marketLabel);
            const targetLine = pickLine ?? selectionLine ?? marketLine;
            const totals = Array.isArray(ctx.totals) ? ctx.totals : [];
            const exact = Number.isFinite(targetLine)
                ? totals.find((t) => Math.abs(Number(t?.line) - targetLine) < 0.1)
                : null;
            candidate = Number(exact?.under);
            if (!(Number.isFinite(candidate) && candidate > 1)) {
                candidate = Number(ctx.under25);
            }
        } else if (marketLabel === 'BTTS') {
            const btts = ctx.btts || {};
            if (pickKey === 'btts_yes' || selectionText.includes('yes') || selectionText.includes('si') || selectionText.includes('sí')) {
                candidate = Number(btts.yes);
            } else if (pickKey === 'btts_no' || selectionText.includes('no')) {
                candidate = Number(btts.no);
            }
        } else if (marketLabel === '1x2') {
            if (Number.isFinite(Number(ctx.home)) && Number(ctx.home) > 1) candidate = Number(ctx.home);
        }

        return Number.isFinite(candidate) && candidate > 1 ? candidate : null;
    };

    const extractPinnaclePrice = (row = {}) => {
        const raw = Number(
                row?.pinnaclePrice ??
                row?.pinnacleInfo?.price ??
                row?.realPlacement?.requested?.odd
        );
        return Number.isFinite(raw) && raw > 1 ? raw : null;
    };

    const buildPinnacleReferenceKeys = (row = {}) => {
        const keys = [];

        const providerBetId = resolveOpTicketId(row);
        if (providerBetId !== null && providerBetId !== undefined && String(providerBetId).trim() !== '') {
                keys.push(`ticket:${String(providerBetId).trim()}`);
        }

        const oppKey = getOpportunityId(row);
        if (oppKey) keys.push(`opp:${oppKey}`);

        const pinnacleId = row?.pinnacleId || row?.pinnacleInfo?.id || null;
        if (pinnacleId !== null && pinnacleId !== undefined && String(pinnacleId).trim() !== '') {
                keys.push(`pin:${String(pinnacleId).trim()}`);
        }

        return keys;
    };

    const mergePinnacleInfoCandidates = (...candidates) => {
        const validCandidates = candidates.filter(Boolean);
        if (validCandidates.length === 0) return null;

        const first = validCandidates[0];
        if (hasPrematchContext(first)) return first;

        const withPrematch = validCandidates.find(hasPrematchContext);
        if (!withPrematch) return first;

        return {
                ...first,
                prematchContext: withPrematch?.prematchContext || first?.prematchContext || null
        };
    };

    const getStickyPinnacleReference = (row = {}) => {
        const keys = buildPinnacleReferenceKeys(row);
        for (const key of keys) {
                const found = stickyPinnacleByKeyRef.current.get(key);
                if (found) return found;
        }
        return null;
    };

    const rememberStickyPinnacleReference = (row = {}) => {
        const keys = buildPinnacleReferenceKeys(row);
        if (keys.length === 0) return;

        const pinnacleInfo = row?.pinnacleInfo || null;
        const pinnaclePrice = extractPinnaclePrice(row);
        if (!hasPrematchContext(pinnacleInfo) && !Number.isFinite(pinnaclePrice)) return;

        const payload = {
                pinnacleInfo,
                pinnaclePrice,
                updatedAt: Date.now()
        };

        for (const key of keys) {
                const prev = stickyPinnacleByKeyRef.current.get(key) || null;
                const mergedInfo = mergePinnacleInfoCandidates(payload.pinnacleInfo, prev?.pinnacleInfo);
                const mergedPrice = Number.isFinite(payload.pinnaclePrice)
                        ? payload.pinnaclePrice
                        : (Number.isFinite(prev?.pinnaclePrice) ? prev.pinnaclePrice : null);

                stickyPinnacleByKeyRef.current.set(key, {
                        pinnacleInfo: mergedInfo,
                        pinnaclePrice: mergedPrice,
                        updatedAt: Date.now()
                });
        }
    };

    const buildBlockingSets = ({ activeBets = null, remoteHistory = null } = {}) => {
        const safeActiveBets = Array.isArray(activeBets)
            ? activeBets
            : (Array.isArray(latestPortfolioActiveBetsRef.current) ? latestPortfolioActiveBetsRef.current : []);

        const safeRemoteHistory = Array.isArray(remoteHistory)
            ? remoteHistory
            : (Array.isArray(latestBookyHistoryRef.current) ? latestBookyHistoryRef.current : []);

        const serverActiveBetIds = new Set(
            safeActiveBets.map(b => {
                const eventId = String(b?.eventId || '');
                return `${eventId}_${normalizePick(b || {})}`;
            })
        );

        const openRows = safeRemoteHistory.filter(row => isBookyOpenStatus(row?.status));
        const remoteOpenBetIds = new Set(
            openRows
                .map(getBookyOpenBetKey)
                .filter(Boolean)
        );
        const remoteOpenEventIds = new Set(
            openRows
                .map(getBookyOpenEventId)
                .filter(Boolean)
        );

        return {
            blockedBetIds: new Set([...serverActiveBetIds, ...remoteOpenBetIds]),
            remoteOpenBetIds,
            remoteOpenEventIds
        };
    };

    const fetchAutoPlacementProvider = async ({ force = false } = {}) => {
        if (placementProviderFetchInFlightRef.current) return;

        const nowMs = Date.now();
        if (!force && (nowMs - lastPlacementProviderFetchAtRef.current) < PLACEMENT_PROVIDER_POLL_MS) return;

        placementProviderFetchInFlightRef.current = true;
        setAutoPlacementProviderLoading(true);

        try {
            const res = await axios.get('/api/opportunities/live/placement-provider', { timeout: 6000 });
            if (!res?.data?.success) return;

            const provider = normalizeAutoPlacementProvider(res.data.provider, 'booky');
            const options = normalizeAutoPlacementProviderOptions(res.data.allowed);
            setAutoPlacementProvider(provider);
            setAutoPlacementProviderOptions(options);
        } catch (error) {
            console.warn('⚠️ Provider auto-placement fetch falló. Se mantiene snapshot previo.', error?.message || error);
        } finally {
            lastPlacementProviderFetchAtRef.current = Date.now();
            placementProviderFetchInFlightRef.current = false;
            setAutoPlacementProviderLoading(false);
        }
    };

    const fetchPinnacleBalanceSnapshot = async ({ force = false } = {}) => {
        if (pinnacleBalanceFetchInFlightRef.current) return;

        const nowMs = Date.now();
        if (!force && (nowMs - lastPinnacleAccountFetchAtRef.current) < PINNACLE_BALANCE_POLL_MS) return;

        pinnacleBalanceFetchInFlightRef.current = true;

        try {
            const res = await axios.get(force ? '/api/pinnacle/account?refresh=1' : '/api/pinnacle/account', { timeout: force ? 15000 : 8000 });
            if (!res?.data?.success) return;

            const rawAmount = res.data?.balance?.amount;
            const parsedAmount = (rawAmount === null || rawAmount === undefined || String(rawAmount).trim() === '')
                ? null
                : Number(rawAmount);
            const rawPnlTotal = res.data?.pnl?.total;
            const parsedPnlTotal = (rawPnlTotal === null || rawPnlTotal === undefined || String(rawPnlTotal).trim() === '')
                ? null
                : Number(rawPnlTotal);
            const rawBaseCapital = res.data?.pnl?.baseCapital;
            const parsedBaseCapital = (rawBaseCapital === null || rawBaseCapital === undefined || String(rawBaseCapital).trim() === '')
                ? null
                : Number(rawBaseCapital);

            setPinnacleAccount({
                balance: {
                    amount: Number.isFinite(parsedAmount) ? parsedAmount : null,
                    currency: String(res.data?.balance?.currency || 'USD').toUpperCase(),
                    stale: false
                },
                pnl: {
                    total: Number.isFinite(parsedPnlTotal) ? parsedPnlTotal : null,
                    netAfterOpenStake: Number.isFinite(parsedPnlTotal) ? parsedPnlTotal : null,
                    byBalance: Number.isFinite(Number(res.data?.pnl?.byBalance)) ? Number(res.data?.pnl?.byBalance) : null,
                    baseCapital: Number.isFinite(parsedBaseCapital) ? parsedBaseCapital : null,
                    baseCapitalSource: String(res.data?.pnl?.baseCapitalSource || '').trim() || null,
                    source: String(res.data?.pnl?.source || '').trim() || null,
                    rowsCount: Number(res.data?.pnl?.rowsCount || 0)
                },
                transactions: {
                    source: String(res.data?.transactions?.source || '').trim() || null,
                    fetchedAt: res.data?.transactions?.fetchedAt || null,
                    windowDays: Number(res.data?.transactions?.windowDays || 0),
                    summary: res.data?.transactions?.summary || null,
                    error: res.data?.transactions?.error || null
                },
                fetchedAt: res.data?.fetchedAt || new Date().toISOString(),
                endpoint: res.data?.endpoint || '/wallet/balance',
                source: res.data?.source || 'arcadia'
            });
            lastPinnacleAccountFetchAtRef.current = Date.now();
        } catch (error) {
            console.warn('⚠️ Pinnacle balance fetch falló. Se mantiene snapshot previo.', error?.message || error);
        } finally {
            pinnacleBalanceFetchInFlightRef.current = false;
        }
    };

  // --- API CALLS ---

        const fetchData = async ({ forceBookyRefresh = false } = {}) => {
        if (fetchInFlightRef.current) return;
        fetchInFlightRef.current = true;
        setLoading(true);

        try {
            const currentActiveTab = String(activeTabRef.current || 'ALL');
            const currentIsSimulatedDisplayMode = !(tokenHealthRef.current?.realPlacementEnabled === true);
            const nowMs = Date.now();
            const shouldForceRealFinishedHydration = (!currentIsSimulatedDisplayMode && currentActiveTab === 'FINISHED' && !realFinishedHydratedRef.current);
            const shouldFetchBooky = forceBookyRefresh || (nowMs - lastBookyAccountFetchAtRef.current) >= 15000;
            const shouldFetchKellyDiagnostics = forceBookyRefresh || (nowMs - lastKellyDiagnosticsFetchAtRef.current) >= 60000;
            const selectedHistoryLimit = (!currentIsSimulatedDisplayMode && currentActiveTab === 'FINISHED')
                ? BOOKY_HISTORY_LIMIT_FINISHED_REAL
                : BOOKY_HISTORY_LIMIT;
            const mustRefreshBookyNow = forceBookyRefresh || shouldForceRealFinishedHydration;
            const bookyAccountUrl = mustRefreshBookyNow
                ? `/api/booky/account?refresh=1&historyLimit=${selectedHistoryLimit}`
                : `/api/booky/account?historyLimit=${selectedHistoryLimit}`;
            const shouldFetchPlacementProvider = forceBookyRefresh || (nowMs - lastPlacementProviderFetchAtRef.current) >= PLACEMENT_PROVIDER_POLL_MS;
            const shouldFetchPinnacleBalance =
                normalizeAutoPlacementProvider(autoPlacementProvider, 'booky') === 'pinnacle'
                && (forceBookyRefresh || (nowMs - lastPinnacleAccountFetchAtRef.current) >= PINNACLE_BALANCE_POLL_MS);

            if (shouldFetchPlacementProvider) {
                void fetchAutoPlacementProvider({ force: true });
            }

            if (shouldFetchPinnacleBalance) {
                void fetchPinnacleBalanceSnapshot({ force: forceBookyRefresh });
            }

            const settled = await Promise.allSettled([
                axios.get('/api/opportunities/live'),
                axios.get('/api/portfolio')
            ]);
            const [liveReq, portfolioReq] = settled;

            if (shouldFetchBooky || shouldForceRealFinishedHydration) {
                void axios
                    .get(bookyAccountUrl, { timeout: forceBookyRefresh ? 30000 : 12000 })
                    .then((bookyRes) => {
                        if (!bookyRes?.data?.success) return;
                        setBookyAccount(bookyRes.data);
                        latestBookyHistoryRef.current = Array.isArray(bookyRes.data?.history) ? bookyRes.data.history : [];
                        lastBookyAccountFetchAtRef.current = Date.now();

                        const refreshedBlockingSets = buildBlockingSets({
                            activeBets: latestPortfolioActiveBetsRef.current,
                            remoteHistory: latestBookyHistoryRef.current
                        });
                        blockedBetIdsRef.current = refreshedBlockingSets.blockedBetIds;
                        remoteOpenBetIdsRef.current = refreshedBlockingSets.remoteOpenBetIds;
                        remoteOpenEventIdsRef.current = refreshedBlockingSets.remoteOpenEventIds;

                        if (!currentIsSimulatedDisplayMode && currentActiveTab === 'FINISHED') {
                            realFinishedHydratedRef.current = true;
                        }
                    })
                    .catch((error) => {
                        console.warn('⚠️ Booky account fetch falló. Se mantiene snapshot previo.', error?.message || error);
                    });
            }

            const blockingSets = buildBlockingSets({
                activeBets: portfolioReq?.status === 'fulfilled' ? portfolioReq.value?.data?.activeBets : null,
                remoteHistory: null
            });

            blockedBetIdsRef.current = blockingSets.blockedBetIds;
            remoteOpenBetIdsRef.current = blockingSets.remoteOpenBetIds;
            remoteOpenEventIdsRef.current = blockingSets.remoteOpenEventIds;

            if (liveReq?.status === 'fulfilled' && liveReq.value?.data?.data) {
                const serverOps = liveReq.value.data.data;

                const latestByKey = new Map();
                serverOps.forEach(op => {
                    const key = getOpportunityId(op);
                    if (key) latestByKey.set(key, op);
                    rememberStickyPinnacleReference(op);
                });
                latestLiveCandidatesByKeyRef.current = latestByKey;

                const cleanOps = serverOps.filter(op => {
                    const id = getOpportunityId(op);
                    if (localDiscardedIdsRef.current.has(id)) return false;
                    if (localPlacedBetIdsRef.current.has(id)) return false;
                    if (blockingSets.blockedBetIds.has(id)) return false;
                    if (blockingSets.remoteOpenEventIds.has(String(op?.eventId || '').trim())) return false;
                    if (!hasMinBookyStake(op)) return false;
                    return true;
                });

                const enrichedOps = cleanOps.map(op => {
                    const currentOdd = parseFloat(op.price || op.odd);
                    if (!currentOdd) return op;

                    const opKey = `${op.eventId}-${op.selection || op.action}`;
                    const prevData = prevOddsRef.current[opKey];
                    let trend = 'SAME';

                    if (prevData) {
                        if (currentOdd > prevData.odd) trend = 'UP';
                        else if (currentOdd < prevData.odd) trend = 'DOWN';
                        else trend = prevData.trend;
                    }

                    if (!prevData || currentOdd !== prevData.odd) {
                        prevOddsRef.current[opKey] = { odd: currentOdd, trend, timestamp: Date.now() };
                    }

                    return { ...op, trend: prevOddsRef.current[opKey].trend };
                });

                setLiveOps(enrichedOps);
            } else if (liveReq?.status === 'rejected') {
                console.warn('⚠️ Live opportunities fetch falló. Se mantiene snapshot previo.', liveReq.reason?.message || liveReq.reason);
            }

            if (portfolioReq?.status === 'fulfilled' && portfolioReq.value?.data) {
                const portfolioResData = portfolioReq.value.data;
                const serverActiveBets = Array.isArray(portfolioResData.activeBets) ? portfolioResData.activeBets : [];
                const serverHistory = Array.isArray(portfolioResData.history) ? portfolioResData.history : [];

                latestPortfolioActiveBetsRef.current = serverActiveBets;

                serverActiveBets.forEach(rememberStickyPinnacleReference);
                serverHistory.forEach(rememberStickyPinnacleReference);

                const serverIds = new Set(
                    serverActiveBets.map(b => {
                        const eventId = String(b.eventId);
                        return `${eventId}_${normalizePick(b)}`;
                    })
                );

                const stillPendingLocalIds = [];
                localPlacedBetIdsRef.current.forEach(id => {
                    if (serverIds.has(id) || blockingSets.remoteOpenBetIds.has(id)) {
                        localPlacedBetIdsRef.current.delete(id);
                        delete pendingBetDetailsRef.current[id];
                        optimisticWarnedIdsRef.current.delete(id);
                        return;
                    }

                    const optimisticMeta = pendingBetDetailsRef.current[id] || {};
                    const createdAtMs = Number(optimisticMeta?.optimisticCreatedAt || 0);
                    const ageMs = Number.isFinite(createdAtMs) && createdAtMs > 0
                        ? (Date.now() - createdAtMs)
                        : Number.POSITIVE_INFINITY;

                    const optimisticTtlMs = resolveOptimisticTtlMs(optimisticMeta);
                    const isInFlight = Boolean(optimisticMeta?.optimisticInFlight);
                    const optimisticPlacementMode = String(optimisticMeta?.optimisticPlacementMode || 'UNKNOWN').toUpperCase();
                    const requiresBookyConfirmation = optimisticPlacementMode === 'REAL' || optimisticPlacementMode === 'BOOKY_REAL';
                    const hasFreshRemoteCheck = !requiresBookyConfirmation || ((Date.now() - Number(lastBookyAccountFetchAtRef.current || 0)) <= 25000);

                    const confirmedAtMs = new Date(optimisticMeta?.optimisticConfirmedAt || 0).getTime();
                    const hasConfirmedMark = Number.isFinite(confirmedAtMs) && confirmedAtMs > 0;
                    const shouldExpireByTtl = ageMs >= optimisticTtlMs;

                    if (isInFlight) {
                        stillPendingLocalIds.push(id);
                        return;
                    }

                    if (hasConfirmedMark) {
                        if (!requiresBookyConfirmation) {
                            // En SIM no reconciliamos contra Open Bets remoto.
                            if (shouldExpireByTtl) {
                                localPlacedBetIdsRef.current.delete(id);
                                delete pendingBetDetailsRef.current[id];

                                if (!optimisticWarnedIdsRef.current.has(id)) {
                                    optimisticWarnedIdsRef.current.add(id);
                                    alert(
                                        '⚠️ La apuesta simulada no se confirmó en portfolio local dentro de la ventana de gracia.\n\n' +
                                        'Se retiró de EN JUEGO para evitar stake fantasma local.\n' +
                                        'Actualiza datos y reintenta si la oportunidad sigue vigente.'
                                    );
                                }
                                return;
                            }

                            stillPendingLocalIds.push(id);
                            return;
                        }

                        if (!hasFreshRemoteCheck) {
                            stillPendingLocalIds.push(id);
                            return;
                        }

                        const currentMisses = Number(optimisticMeta?.optimisticMissingRemoteChecks || 0);
                        const nextMisses = Number.isFinite(currentMisses) ? (currentMisses + 1) : 1;
                        pendingBetDetailsRef.current[id] = {
                            ...optimisticMeta,
                            optimisticMissingRemoteChecks: nextMisses
                        };

                        if (nextMisses < 3) {
                            stillPendingLocalIds.push(id);
                            return;
                        }

                        localPlacedBetIdsRef.current.delete(id);
                        delete pendingBetDetailsRef.current[id];

                        if (!optimisticWarnedIdsRef.current.has(id)) {
                            optimisticWarnedIdsRef.current.add(id);
                            const reasonText = 'Booky no reportó la apuesta tras múltiples chequeos de sincronización.';
                            alert(
                                `⚠️ Apuesta no confirmada en Booky (${reasonText})\n\n` +
                                'Se retiró de EN JUEGO para evitar stake fantasma.\n' +
                                'Verifica Open Bets en Booky antes de reintentar.'
                            );
                        }
                        return;
                    }

                    if (shouldExpireByTtl) {
                        if (!hasFreshRemoteCheck) {
                            stillPendingLocalIds.push(id);
                            return;
                        }

                        localPlacedBetIdsRef.current.delete(id);
                        delete pendingBetDetailsRef.current[id];

                        if (!optimisticWarnedIdsRef.current.has(id)) {
                            optimisticWarnedIdsRef.current.add(id);
                            if (requiresBookyConfirmation) {
                                const reasonText = 'no apareció en Booky dentro de la ventana de gracia extendida.';
                                alert(
                                    `⚠️ Apuesta no confirmada en Booky (${reasonText})\n\n` +
                                    'Se retiró de EN JUEGO para evitar stake fantasma.\n' +
                                    'Verifica Open Bets en Booky antes de reintentar.'
                                );
                            } else {
                                alert(
                                    '⚠️ La apuesta simulada no se confirmó en portfolio local dentro de la ventana de gracia.\n\n' +
                                    'Se retiró de EN JUEGO para evitar stake fantasma local.'
                                );
                            }
                        }
                        return;
                    }

                    stillPendingLocalIds.push(id);
                });

                setPortfolio({
                    ...portfolioResData,
                    activeBets: [
                        ...serverActiveBets,
                        ...stillPendingLocalIds.map(id => {
                            const originalOp = pendingBetDetailsRef.current[id];
                            return {
                                eventId: id,
                                match: originalOp ? originalOp.match : 'Procesando...',
                                league: originalOp ? originalOp.league : '...',
                                selection: originalOp?.selection || originalOp?.action || '...',
                                market: originalOp?.market || '...',
                                type: originalOp?.type || 'LIVE_SNIPE',
                                odd: originalOp?.odd || originalOp?.price || 0,
                                price: originalOp?.price || originalOp?.odd || 0,
                                stake: originalOp?.kellyStake || 0,
                                kellyStake: originalOp?.kellyStake || 0,
                                ev: originalOp?.ev || 0,
                                realProb: originalOp?.realProb || 0,
                                potentialReturn: (originalOp?.kellyStake || 0) * (originalOp?.odd || originalOp?.price || 1),
                                isOptimistic: true,
                                liveTime: originalOp?.time || originalOp?.liveTime || 'Live',
                                score: originalOp?.score,
                                pinnacleInfo: originalOp?.pinnacleInfo,
                                pinnaclePrice: originalOp?.pinnaclePrice,
                                createdAt: new Date().toISOString()
                            };
                        })
                    ]
                });
            } else if (portfolioReq?.status === 'rejected') {
                console.warn('⚠️ Portfolio fetch falló. Se mantiene snapshot previo.', portfolioReq.reason?.message || portfolioReq.reason);
            }

            void axios
                .get('/api/booky/token-health')
                .then((tokenRes) => {
                    if (tokenRes?.data?.success) setTokenHealth(tokenRes.data.token);
                })
                .catch(() => {
                    setTokenHealth(null);
                });

            if (shouldFetchKellyDiagnostics) {
                void axios
                    .get('/api/booky/kelly-diagnostics?horizonBets=200&simulations=400&ruinThreshold=0.5', {
                        timeout: forceBookyRefresh ? 12000 : 8000
                    })
                    .then((kellyRes) => {
                        if (kellyRes?.data?.success) {
                            setKellyDiagnostics(kellyRes.data);
                            lastKellyDiagnosticsFetchAtRef.current = Date.now();
                        }
                    })
                    .catch(() => {
                        // Mantener último snapshot válido en UI para evitar parpadeos
                    });
            }

            if (forceBookyRefresh) {
                fetchPrematchData();
                fetchArbitrageData({ force: true });
            }
        } catch (err) {
            console.error('Error fetching core data', err);
        } finally {
            fetchInFlightRef.current = false;
            setLoading(false);
        }
    };

    const fetchPrematchData = async ({ force = false } = {}) => {
        if (prematchFetchInFlightRef.current) return;

        const nowMs = Date.now();
        if (!force && (nowMs - lastPrematchFetchAtRef.current) < PREMATCH_POLL_MS - 300) return;

        prematchFetchInFlightRef.current = true;
        try {
            const prematchUrl = force
                ? '/api/opportunities/prematch?refresh=1'
                : '/api/opportunities/prematch';
            const prematchRes = await axios.get(prematchUrl, { timeout: 20000 });

            if (prematchRes?.data?.data) {
                const blockedBetIds = blockedBetIdsRef.current instanceof Set
                    ? blockedBetIdsRef.current
                    : new Set();

                const cleanOps = prematchRes.data.data.filter(op => {
                    if (isLiveOriginOpportunity(op)) return false;
                    if (!hasMinBookyStake(op)) return false;

                    const id = getOpportunityId(op);
                    if (localDiscardedIdsRef.current.has(id)) return false;
                    if (localPlacedBetIdsRef.current.has(id)) return false;
                    if (blockedBetIds.has(id)) return false;
                    return true;
                });

                setPrematchOps(cleanOps);
            }

            lastPrematchFetchAtRef.current = Date.now();
        } catch (err) {
            console.warn('⚠️ Prematch fetch falló. Se mantiene snapshot previo.', err?.message || err);
        } finally {
            prematchFetchInFlightRef.current = false;
        }
    };

    const toPositiveNumber = (value, fallback) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
        return parsed;
    };

    const toNonNegativeNumber = (value, fallback) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) return fallback;
        return parsed;
    };

    const updateArbitrageRiskField = (field, value) => {
        setArbitrageRiskProfileKey('custom');
        setArbitrageRiskConfig((prev) => ({
            ...prev,
            [field]: value
        }));
    };

    const resolveArbitrageStakeContext = (configOverride = null) => {
        const sourceConfig = (configOverride && typeof configOverride === 'object')
            ? configOverride
            : arbitrageRiskConfig;

        const portfolioNavRaw = Number(portfolio?.balance);
        const portfolioNav = Number.isFinite(portfolioNavRaw) && portfolioNavRaw > 0 ? portfolioNavRaw : 0;

        const bookyBalanceRaw = Number(bookyAccount?.balance?.amount);
        const bookyBalance = Number.isFinite(bookyBalanceRaw) && bookyBalanceRaw >= 0 ? bookyBalanceRaw : NaN;
        const bookyCurrency = String(bookyAccount?.balance?.currency || 'PEN').toUpperCase();

        const pinnacleBalanceRaw = Number(pinnacleAccount?.balance?.amount);
        const pinnacleBalance = Number.isFinite(pinnacleBalanceRaw) && pinnacleBalanceRaw >= 0 ? pinnacleBalanceRaw : NaN;
        const pinnacleCurrency = String(pinnacleAccount?.balance?.currency || 'USD').toUpperCase();

        let nav = portfolioNav;
        let navSource = 'portfolio.balance';
        let navCurrency = String(portfolio?.currency || bookyCurrency || 'PEN').toUpperCase();

        const hasBooky = Number.isFinite(bookyBalance);
        const hasPinnacle = Number.isFinite(pinnacleBalance);
        if (hasBooky && hasPinnacle && bookyCurrency === pinnacleCurrency) {
            nav = Number((bookyBalance + pinnacleBalance).toFixed(2));
            navSource = 'booky+pinnacle.balance';
            navCurrency = bookyCurrency;
        } else if (hasBooky) {
            nav = Number(bookyBalance.toFixed(2));
            navSource = 'booky.balance';
            navCurrency = bookyCurrency;
        } else if (hasPinnacle) {
            nav = Number(pinnacleBalance.toFixed(2));
            navSource = 'pinnacle.balance';
            navCurrency = pinnacleCurrency;
        }

        const stakeMode = String(sourceConfig?.stakeMode || 'percent_nav') === 'fixed'
            ? 'fixed'
            : 'percent_nav';

        const stakePercentNav = toPositiveNumber(sourceConfig?.stakePercentNav, 2);
        const stakeFixedAmount = toPositiveNumber(sourceConfig?.stakeFixedAmount, 20);
        const maxStakePercentNav = toPositiveNumber(sourceConfig?.maxStakePercentNav, 3);
        const maxStakeAbs = toPositiveNumber(sourceConfig?.maxStakeAbs, 30);
        const minRoiPercent = toNonNegativeNumber(sourceConfig?.minRoiPercent, 0.8);
        const minProfitAbs = toNonNegativeNumber(sourceConfig?.minProfitAbs, 2);

        const requestedStake = stakeMode === 'percent_nav'
            ? (nav * (stakePercentNav / 100))
            : stakeFixedAmount;

        const capByNavPct = nav > 0
            ? (nav * (maxStakePercentNav / 100))
            : maxStakeAbs;

        const stakeBankroll = Number(Math.max(0, Math.min(requestedStake, capByNavPct, maxStakeAbs)).toFixed(2));

        return {
            nav,
            navSource,
            navCurrency,
            stakeMode,
            stakePercentNav,
            stakeFixedAmount,
            maxStakePercentNav,
            maxStakeAbs,
            minRoiPercent,
            minProfitAbs,
            requestedStake: Number(requestedStake.toFixed(2)),
            capByNavPct: Number(capByNavPct.toFixed(2)),
            stakeBankroll,
            balances: {
                booky: Number.isFinite(bookyBalance) ? Number(bookyBalance.toFixed(2)) : null,
                pinnacle: Number.isFinite(pinnacleBalance) ? Number(pinnacleBalance.toFixed(2)) : null,
                bookyCurrency,
                pinnacleCurrency
            }
        };
    };

    const resolveArbitrageLiquidityGuard = ({ providerSplit = {} } = {}) => {
        const altenarRequired = Number(providerSplit?.altenar || 0);
        const arcadiaRequired = Number(providerSplit?.arcadia || 0);

        const bookyAvailableRaw = Number(bookyAccount?.balance?.amount);
        const pinnacleAvailableRaw = Number(pinnacleAccount?.balance?.amount);
        const bookyCurrency = String(bookyAccount?.balance?.currency || 'PEN').toUpperCase();
        const pinnacleCurrency = String(pinnacleAccount?.balance?.currency || 'USD').toUpperCase();

        const hasBookyAvailable = Number.isFinite(bookyAvailableRaw) && bookyAvailableRaw >= 0;
        const hasPinnacleAvailable = Number.isFinite(pinnacleAvailableRaw) && pinnacleAvailableRaw >= 0;

        // Comparamos solo cuando tenemos saldo y la moneda esperada del stake (PEN).
        const canCompareBooky = hasBookyAvailable && bookyCurrency === 'PEN';
        const canComparePinnacle = hasPinnacleAvailable && pinnacleCurrency === 'PEN';

        const altenarShortfall = canCompareBooky
            ? Math.max(0, Number((altenarRequired - bookyAvailableRaw).toFixed(2)))
            : 0;
        const arcadiaShortfall = canComparePinnacle
            ? Math.max(0, Number((arcadiaRequired - pinnacleAvailableRaw).toFixed(2)))
            : 0;

        return {
            altenarRequired,
            arcadiaRequired,
            bookyAvailable: hasBookyAvailable ? Number(bookyAvailableRaw.toFixed(2)) : null,
            pinnacleAvailable: hasPinnacleAvailable ? Number(pinnacleAvailableRaw.toFixed(2)) : null,
            bookyCurrency,
            pinnacleCurrency,
            canCompareBooky,
            canComparePinnacle,
            altenarShortfall,
            arcadiaShortfall,
            canFund: altenarShortfall <= 0 && arcadiaShortfall <= 0
        };
    };

    const normalizeArbitrageProviderBucket = (providerRaw = '') => {
        const provider = String(providerRaw || '').trim().toLowerCase();
        if (!provider) return 'other';
        if (provider.includes('pinnacle') || provider.includes('arcadia')) return 'arcadia';
        if (provider.includes('altenar') || provider.includes('booky') || provider.includes('acity') || provider.includes('dorado')) return 'altenar';
        return 'other';
    };

    const buildArbitrageProviderSplit = (op = {}, legs = []) => {
        const split = {
            altenar: 0,
            arcadia: 0,
            other: 0,
            total: 0
        };

        const addStake = (providerRaw, stakeRaw) => {
            const stake = Number(stakeRaw);
            if (!(Number.isFinite(stake) && stake > 0)) return;
            const bucket = normalizeArbitrageProviderBucket(providerRaw);
            split[bucket] += stake;
            split.total += stake;
        };

        const isDcOpposite = String(op?.type || '').toUpperCase() === 'SUREBET_DC_OPPOSITE_PREMATCH';
        if (isDcOpposite) {
            addStake(legs?.[0]?.provider, op?.plan?.stakes?.cover);
            addStake(legs?.[1]?.provider, op?.plan?.stakes?.opposite);
            return split;
        }

        addStake(op?.odds?.best?.home?.provider, op?.plan?.stakes?.home);
        addStake(op?.odds?.best?.draw?.provider, op?.plan?.stakes?.draw);
        addStake(op?.odds?.best?.away?.provider, op?.plan?.stakes?.away);

        return split;
    };

    const resolveArbitrageLegStake = ({ op = {}, leg = {}, legIdx = 0 } = {}) => {
        const isDcOpposite = String(op?.type || '').toUpperCase() === 'SUREBET_DC_OPPOSITE_PREMATCH';
        if (isDcOpposite) {
            const coverStake = Number(op?.plan?.stakes?.cover || 0);
            const oppositeStake = Number(op?.plan?.stakes?.opposite || 0);
            const coverLabel = String(op?.plan?.labels?.cover || '').trim().toUpperCase();
            const oppositeLabel = String(op?.plan?.labels?.opposite || '').trim().toUpperCase();
            const legSelection = String(leg?.selection || '').trim().toUpperCase();

            if (coverLabel && legSelection === coverLabel) return coverStake;
            if (oppositeLabel && legSelection === oppositeLabel) return oppositeStake;
            if (legIdx === 0) return coverStake;
            if (legIdx === 1) return oppositeStake;
            return 0;
        }

        const selection = String(leg?.selection || '').trim().toUpperCase();
        if (selection === 'HOME' || selection === '1' || selection.includes('LOCAL')) return Number(op?.plan?.stakes?.home || 0);
        if (selection === 'DRAW' || selection === 'X' || selection.includes('EMPATE')) return Number(op?.plan?.stakes?.draw || 0);
        if (selection === 'AWAY' || selection === '2' || selection.includes('VISITA')) return Number(op?.plan?.stakes?.away || 0);
        return 0;
    };

    const normalizeArbitrageLegSelection = (marketRaw = '', selectionRaw = '') => {
        const market = String(marketRaw || '').trim().toLowerCase();
        const selection = String(selectionRaw || '').trim();
        const selectionUpper = selection.toUpperCase();

        if (market === '1x2') {
            if (selectionUpper === '1' || selectionUpper === 'HOME' || selectionUpper.includes('LOCAL')) return 'Home';
            if (selectionUpper === 'X' || selectionUpper === 'DRAW' || selectionUpper.includes('EMPATE')) return 'Draw';
            if (selectionUpper === '2' || selectionUpper === 'AWAY' || selectionUpper.includes('VISITA')) return 'Away';
        }

        if (market.includes('double chance')) {
            if (selectionUpper === '1X' || selectionUpper === 'X2' || selectionUpper === '12') return selectionUpper;
        }

        return selection || '-';
    };

    const buildArbitrageLegOpportunity = ({ op = {}, leg = {}, legIdx = 0 } = {}) => {
        const providerBucket = normalizeArbitrageProviderBucket(leg?.provider || '');
        if (providerBucket !== 'altenar') return null;

        const odd = Number(leg?.odd);
        if (!(Number.isFinite(odd) && odd > 1)) return null;

        const stake = Number(resolveArbitrageLegStake({ op, leg, legIdx }));
        if (!(Number.isFinite(stake) && stake > 0)) return null;

        const market = String(leg?.market || op?.market || '1x2').trim();
        const selection = normalizeArbitrageLegSelection(market, leg?.selection || '');
        const ev = Number(op?.plan?.roiPercent || 0);
        const realProb = (Number.isFinite(ev) && Number.isFinite(odd) && odd > 1)
            ? Number((((1 + (ev / 100)) / odd) * 100).toFixed(4))
            : null;

        return {
            type: 'PREMATCH_VALUE',
            strategy: 'PREMATCH_VALUE',
            eventId: op?.eventId || null,
            pinnacleId: op?.pinnacleId || null,
            match: op?.match || '-',
            league: op?.league || '-',
            date: op?.matchDate || null,
            market,
            selection,
            action: `Apostar ${selection}`,
            odd,
            price: odd,
            kellyStake: Number(stake.toFixed(2)),
            ev: Number.isFinite(ev) ? ev : 0,
            realProb,
            provider: 'altenar',
            source: 'ARBITRAGE_PREVIEW_LEG',
            arbitrageType: op?.type || null,
            arbitrageLegIndex: legIdx
        };
    };

    const buildArbitrageLegOpportunityPinnacle = ({ op = {}, leg = {}, legIdx = 0 } = {}) => {
        const providerBucket = normalizeArbitrageProviderBucket(leg?.provider || '');
        if (providerBucket !== 'arcadia') return null;

        const odd = Number(leg?.odd);
        if (!(Number.isFinite(odd) && odd > 1)) return null;

        const stake = Number(resolveArbitrageLegStake({ op, leg, legIdx }));
        if (!(Number.isFinite(stake) && stake > 0)) return null;

        const market = String(leg?.market || '').trim();
        if (market !== '1x2') return null;

        const selection = normalizeArbitrageLegSelection(market, leg?.selection || '');
        if (!(selection === 'Home' || selection === 'Draw' || selection === 'Away')) return null;

        const ev = Number(op?.plan?.roiPercent || 0);
        const realProb = (Number.isFinite(ev) && Number.isFinite(odd) && odd > 1)
            ? Number((((1 + (ev / 100)) / odd) * 100).toFixed(4))
            : null;

        return {
            type: 'PREMATCH_VALUE',
            strategy: 'PREMATCH_VALUE',
            eventId: op?.eventId || null,
            pinnacleId: op?.pinnacleId || null,
            match: op?.match || '-',
            league: op?.league || '-',
            date: op?.matchDate || null,
            market: '1x2',
            selection,
            action: `Apostar ${selection}`,
            odd,
            price: odd,
            pinnaclePrice: odd,
            realPrice: odd,
            kellyStake: Number(stake.toFixed(2)),
            ev: Number.isFinite(ev) ? ev : 0,
            realProb,
            provider: 'pinnacle',
            source: 'ARBITRAGE_PREVIEW_LEG',
            arbitrageType: op?.type || null,
            arbitrageLegIndex: legIdx
        };
    };

    const pickMaxStakeLeg = (candidates = []) => {
        if (!Array.isArray(candidates) || candidates.length === 0) return null;
        return candidates
            .slice()
            .sort((a, b) => Number(b?.stake || 0) - Number(a?.stake || 0))[0] || null;
    };

    const buildDualExecutionPlan = (op = {}, legs = []) => {
        const normalizedLegs = Array.isArray(legs) ? legs : [];

        const arcadiaCandidates = normalizedLegs
            .map((leg, legIdx) => {
                const opportunity = buildArbitrageLegOpportunityPinnacle({ op, leg, legIdx });
                if (!opportunity) return null;
                return {
                    leg,
                    legIdx,
                    opportunity,
                    stake: Number(opportunity?.kellyStake || 0)
                };
            })
            .filter(Boolean);

        const altenarCandidates = normalizedLegs
            .map((leg, legIdx) => {
                const opportunity = buildArbitrageLegOpportunity({ op, leg, legIdx });
                if (!opportunity) return null;
                return {
                    leg,
                    legIdx,
                    opportunity,
                    stake: Number(opportunity?.kellyStake || 0)
                };
            })
            .filter(Boolean);

        const arcadia = pickMaxStakeLeg(arcadiaCandidates);
        const altenar = pickMaxStakeLeg(altenarCandidates);

        if (!arcadia || !altenar) {
            return {
                canExecute: false,
                reason: 'requires-arcadia-and-altenar-legs',
                arcadia: arcadia || null,
                altenar: altenar || null
            };
        }

        if (!arcadia?.opportunity?.pinnacleId) {
            return {
                canExecute: false,
                reason: 'missing-pinnacle-id',
                arcadia,
                altenar
            };
        }

        const matchDateMs = new Date(op?.matchDate || arcadia?.opportunity?.date || altenar?.opportunity?.date || 0).getTime();
        if (Number.isFinite(matchDateMs) && Date.now() >= matchDateMs) {
            return {
                canExecute: false,
                reason: 'match-started',
                arcadia,
                altenar,
                matchDate: new Date(matchDateMs).toISOString()
            };
        }

        return {
            canExecute: true,
            reason: null,
            arcadia,
            altenar
        };
    };

    const getArbitrageExecutionKey = (op = {}, idx = 0) => `${String(op?.type || 'ARB')}_${String(op?.eventId || idx)}_${idx}`;

    const setArbitrageExecutionRunning = (executionKey, running) => {
        const next = new Set(arbitrageExecutingKeysRef.current);
        if (running) next.add(executionKey);
        else next.delete(executionKey);
        arbitrageExecutingKeysRef.current = next;
        setArbitrageExecutingKeys(new Set(next));
    };

    const runProviderRealPlacement = async ({ provider = 'booky', opportunity = null, confirmMode = 'confirm-fast' } = {}) => {
        const apiBase = provider === 'pinnacle' ? '/api/pinnacle' : '/api/booky';
        const providerUpper = provider === 'pinnacle' ? 'ARCADIA' : 'ALTENAR';

        const includesInsufficientFundsHint = (value = '') => {
            const normalized = String(value || '').trim().toLowerCase();
            return normalized.includes('insufficient_funds') || normalized.includes('insufficient funds');
        };

        const isArcadiaInsufficientFundsFromDiagnostic = (diag = {}) => {
            const titleCandidates = [
                diag?.title,
                diag?.firstBody?.title,
                diag?.secondBody?.title,
                diag?.firstError?.providerBody?.title,
                diag?.secondError?.providerBody?.title
            ];

            const detailCandidates = [
                diag?.detail,
                diag?.firstBody?.detail,
                diag?.secondBody?.detail,
                diag?.firstError?.providerBody?.detail,
                diag?.secondError?.providerBody?.detail
            ];

            return titleCandidates.some(includesInsufficientFundsHint) || detailCandidates.some(includesInsufficientFundsHint);
        };

        const formatMoney2 = (value) => {
            const n = Number(value);
            return Number.isFinite(n) ? n.toFixed(2) : null;
        };

        let ticketId = null;
        let dryRunPayload = null;

        try {
            const prepRes = await axios.post(`${apiBase}/prepare`, opportunity, { timeout: 45000 });
            const ticket = prepRes?.data?.ticket || null;
            ticketId = ticket?.id || null;

            if (!prepRes?.data?.success || !ticketId) {
                throw new Error(prepRes?.data?.message || `${providerUpper}: prepare sin ticket válido.`);
            }

            const dryRunRes = await axios.post(`${apiBase}/real/dryrun/${ticketId}`, undefined, { timeout: 25000 });
            dryRunPayload = dryRunRes?.data?.draft || dryRunRes?.data || null;
            if (!dryRunRes?.data?.success || !dryRunPayload) {
                throw new Error(dryRunRes?.data?.message || `${providerUpper}: dry-run inválido.`);
            }

            const confirmRes = await axios.post(`${apiBase}/real/${confirmMode}/${ticketId}`, undefined, { timeout: 30000 });
            if (!confirmRes?.data?.success) {
                throw new Error(confirmRes?.data?.message || `${providerUpper}: confirm no exitoso.`);
            }

            return {
                provider,
                outcome: 'confirmed',
                ticketId,
                dryRunPayload,
                response: confirmRes.data
            };
        } catch (error) {
            const payload = error?.response?.data || {};
            let code = payload?.code || null;
            let message = payload?.message || error?.message || `${providerUpper}: error de ejecución`;
            let diagnostic = payload?.diagnostic || null;

            const looksLegacyArcadiaBadRequest = (
                provider === 'pinnacle'
                && code === 'PINNACLE_QUOTE_BAD_REQUEST'
                && isArcadiaInsufficientFundsFromDiagnostic(diagnostic || {})
            );

            if (looksLegacyArcadiaBadRequest) {
                code = 'PINNACLE_INSUFFICIENT_BALANCE';

                const requestedStake = Number(
                    diagnostic?.requestedStake
                    ?? opportunity?.kellyStake
                    ?? opportunity?.stake
                    ?? dryRunPayload?.payload?.stake
                    ?? dryRunPayload?.preview?.stake
                    ?? NaN
                );
                const availableBalance = Number(
                    diagnostic?.availableBalance
                    ?? NaN
                );

                const stakeLabel = formatMoney2(requestedStake);
                const balanceLabel = formatMoney2(availableBalance);

                let descriptiveMessage = 'Arcadia reporta saldo insuficiente para cotizar/apostar este ticket.';
                if (stakeLabel && balanceLabel) {
                    descriptiveMessage += ` Stake S/. ${stakeLabel} vs saldo S/. ${balanceLabel}.`;
                } else if (stakeLabel) {
                    descriptiveMessage += ` Stake solicitado S/. ${stakeLabel}.`;
                }

                message = descriptiveMessage;
                diagnostic = {
                    ...(diagnostic || {}),
                    normalizedByClient: true,
                    normalizedFromCode: 'PINNACLE_QUOTE_BAD_REQUEST',
                    requestedStake: Number.isFinite(requestedStake) ? Number(requestedStake) : (diagnostic?.requestedStake ?? null),
                    availableBalance: Number.isFinite(availableBalance) ? Number(availableBalance) : (diagnostic?.availableBalance ?? null)
                };
            }

            if (ticketId && (!code || code === 'BOOKY_INSUFFICIENT_BALANCE' || code === 'PINNACLE_REAL_DISABLED' || code === 'PINNACLE_INSUFFICIENT_BALANCE')) {
                await axios.post(`${apiBase}/cancel/${ticketId}`).catch(() => {});
            }

            let outcome = 'rejected';
            if (code === 'BOOKY_REAL_CONFIRMATION_UNCERTAIN') outcome = 'uncertain';

            return {
                provider,
                outcome,
                ticketId,
                dryRunPayload,
                code,
                message,
                diagnostic
            };
        }
    };

    const handleExecuteArbitrageDual = async ({ op = {}, legs = [], idx = 0 } = {}) => {
        const executionKey = getArbitrageExecutionKey(op, idx);
        if (arbitrageExecutingKeysRef.current.has(executionKey)) return;

        const dualPlan = buildDualExecutionPlan(op, legs);
        if (!dualPlan?.canExecute) {
            alert('⚠️ Esta oportunidad no tiene patas ejecutables Arcadia + Altenar para ejecución dual secuencial.');
            return;
        }

        const arcadiaLeg = dualPlan.arcadia;
        const altenarLeg = dualPlan.altenar;
        const confirmMsg =
            'Ejecución dual secuencial (Arcadia → Altenar)\n\n' +
            `Partido: ${op?.match || '-'}\n` +
            `Arcadia: ${arcadiaLeg?.opportunity?.selection || '-'} @ ${Number(arcadiaLeg?.opportunity?.odd || 0).toFixed(3)} | Stake S/. ${Number(arcadiaLeg?.opportunity?.kellyStake || 0).toFixed(2)}\n` +
            `Altenar: ${altenarLeg?.opportunity?.selection || '-'} @ ${Number(altenarLeg?.opportunity?.odd || 0).toFixed(3)} | Stake S/. ${Number(altenarLeg?.opportunity?.kellyStake || 0).toFixed(2)}\n\n` +
            'Se ejecutará dry-run obligatorio en ambos providers antes de confirmar real.\n\n' +
            '¿Continuar?';

        if (!window.confirm(confirmMsg)) return;

        setArbitrageExecutionRunning(executionKey, true);

        try {
            const arcadiaResult = await runProviderRealPlacement({
                provider: 'pinnacle',
                opportunity: arcadiaLeg.opportunity,
                confirmMode: 'confirm-fast'
            });

            if (arcadiaResult.outcome !== 'confirmed') {
                const code = arcadiaResult?.code ? ` | code=${arcadiaResult.code}` : '';
                alert(`❌ Resultado final=REJECTED (Arcadia)${code}\n${arcadiaResult?.message || 'No se pudo confirmar pata Arcadia.'}`);
                await fetchData({ forceBookyRefresh: true });
                return;
            }

            const altenarResult = await runProviderRealPlacement({
                provider: 'booky',
                opportunity: altenarLeg.opportunity,
                confirmMode: 'confirm-fast'
            });

            if (altenarResult.outcome === 'confirmed') {
                alert(
                    '✅ Resultado final=CONFIRMED (DUAL)\n\n' +
                    `Arcadia ticket: ${arcadiaResult?.ticketId || 'n/a'}\n` +
                    `Altenar ticket: ${altenarResult?.ticketId || 'n/a'}`
                );
                await fetchData({ forceBookyRefresh: true });
                return;
            }

            const secondOutcome = altenarResult.outcome === 'uncertain' ? 'UNCERTAIN' : 'REJECTED';
            const code = altenarResult?.code ? ` | code=${altenarResult.code}` : '';
            alert(
                `⚠️ Resultado final=HEDGE_REQUIRED\n\n` +
                `Arcadia CONFIRMED (ticket ${arcadiaResult?.ticketId || 'n/a'})\n` +
                `Altenar ${secondOutcome}${code}\n` +
                `${altenarResult?.message || 'Sin detalle adicional.'}\n\n` +
                'Acción: cubrir manualmente el riesgo de la pata Arcadia ya ejecutada.'
            );
            await fetchData({ forceBookyRefresh: true });
        } catch (error) {
            alert(`❌ Fallo inesperado en ejecución dual: ${error?.message || 'Error desconocido.'}`);
            await fetchData({ forceBookyRefresh: true });
        } finally {
            setArbitrageExecutionRunning(executionKey, false);
        }
    };

    const applyArbitrageRiskProfile = (profileKey = 'conservative') => {
        const normalized = String(profileKey || '').toLowerCase();
        const preset = ARBITRAGE_RISK_PROFILE_PRESETS[normalized];
        if (!preset) return;

        const nextConfig = { ...preset.config };
        setArbitrageRiskProfileKey(normalized);
        setArbitrageRiskConfig(nextConfig);
        void refreshArbitrageWithPrematch({ riskConfigOverride: nextConfig });
    };

    const fetchArbitrageData = async ({ force = false, riskConfigOverride = null } = {}) => {
        if (arbitrageFetchInFlightRef.current) return;

        const nowMs = Date.now();
        if (!force && (nowMs - lastArbitrageFetchAtRef.current) < ARBITRAGE_POLL_MS - 300) return;

        arbitrageFetchInFlightRef.current = true;
        try {
            const riskContext = resolveArbitrageStakeContext(riskConfigOverride);
            const arbitrageRes = await axios.get('/api/opportunities/arbitrage/preview', {
                params: {
                    limit: ARBITRAGE_PREVIEW_LIMIT,
                    bankroll: riskContext.stakeBankroll > 0 ? riskContext.stakeBankroll : undefined,
                    minRoiPercent: riskContext.minRoiPercent,
                    minProfitAbs: riskContext.minProfitAbs
                },
                timeout: 20000
            });

            if (arbitrageRes?.data?.success) {
                const rows = Array.isArray(arbitrageRes.data?.data) ? arbitrageRes.data.data : [];
                setArbitrageOps(rows);
                setArbitrageMeta({
                    generatedAt: arbitrageRes.data?.generatedAt || null,
                    source: arbitrageRes.data?.source || null,
                    diagnostics: arbitrageRes.data?.diagnostics || null,
                    risk: arbitrageRes.data?.risk || {
                        minRoiPercent: riskContext.minRoiPercent,
                        minProfitAbs: riskContext.minProfitAbs,
                        stakeBankroll: riskContext.stakeBankroll
                    },
                    count: Number(arbitrageRes.data?.count || rows.length || 0)
                });
            }

            lastArbitrageFetchAtRef.current = Date.now();
        } catch (err) {
            console.warn('⚠️ Arbitrage preview fetch falló. Se mantiene snapshot previo.', err?.message || err);
        } finally {
            arbitrageFetchInFlightRef.current = false;
        }
    };

    const waitUntilInFlightClears = async (ref, timeoutMs = 25000) => {
        const startedAt = Date.now();
        while (ref.current && (Date.now() - startedAt) < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 120));
        }
    };

    const refreshArbitrageWithPrematch = async ({ riskConfigOverride = null } = {}) => {
        if (arbitrageRefreshState.running) return;

        setArbitrageRefreshState({
            running: true,
            phase: 'prematch',
            lastOkAt: arbitrageRefreshState.lastOkAt,
            lastError: null
        });

        try {
            await waitUntilInFlightClears(prematchFetchInFlightRef);
            await fetchPrematchData({ force: true });

            setArbitrageRefreshState((prev) => ({
                ...prev,
                phase: 'arbitrage'
            }));

            await waitUntilInFlightClears(arbitrageFetchInFlightRef);
            await fetchArbitrageData({ force: true, riskConfigOverride });

            setArbitrageRefreshState({
                running: false,
                phase: null,
                lastOkAt: new Date().toISOString(),
                lastError: null
            });
        } catch (error) {
            setArbitrageRefreshState((prev) => ({
                running: false,
                phase: null,
                lastOkAt: prev.lastOkAt,
                lastError: error?.message || 'No se pudo refrescar prematch + arbitraje.'
            }));
        }
    };

    const handleAutoPlacementProviderChange = async (providerRaw = '') => {
        const nextProvider = normalizeAutoPlacementProvider(providerRaw, autoPlacementProvider);
        if (!nextProvider || nextProvider === autoPlacementProvider) return;

        setAutoPlacementProviderSaving(true);
        try {
            const { data } = await axios.post(
                '/api/opportunities/live/placement-provider',
                { provider: nextProvider },
                { timeout: 8000 }
            );

            if (!data?.success) {
                throw new Error(data?.error || 'No se pudo actualizar el proveedor.');
            }

            setAutoPlacementProvider(normalizeAutoPlacementProvider(data.provider, nextProvider));
            setAutoPlacementProviderOptions(normalizeAutoPlacementProviderOptions(data.allowed));
            lastPlacementProviderFetchAtRef.current = Date.now();

            if (nextProvider === 'pinnacle') {
                await fetchPinnacleBalanceSnapshot({ force: true });
            }

            void fetchData({ forceBookyRefresh: true });
        } catch (error) {
            alert(`⚠️ No se pudo cambiar proveedor de auto-placement: ${error?.message || error}`);
            void fetchAutoPlacementProvider({ force: true });
        } finally {
            setAutoPlacementProviderSaving(false);
        }
    };

    const handleManualPinnacleHistorySync = async () => {
        if (pinnacleHistorySyncing) return;

        setPinnacleHistorySyncing(true);
        setPinnacleHistorySyncMeta((prev) => ({ ...prev, error: null }));

        try {
            const { data } = await axios.get('/api/pinnacle/history', {
                params: {
                    refresh: 1,
                    limit: PINNACLE_HISTORY_SYNC_LIMIT,
                    status: 'settled',
                    days: PINNACLE_HISTORY_SYNC_DAYS
                },
                timeout: 30000
            });

            if (!data?.success) {
                throw new Error(data?.error || 'No se pudo sincronizar historial Pinnacle.');
            }

            const totalCount = Number(data?.totalCount || 0);
            const touchedCount = Number(data?.reconcileStats?.touchedCount || 0);
            const fetchedAt = data?.fetchedAt || new Date().toISOString();

            setPinnacleHistorySyncMeta({
                fetchedAt,
                totalCount,
                touchedCount,
                source: data?.source || null,
                error: null
            });

            await fetchPinnacleBalanceSnapshot({ force: true });
            await fetchData({ forceBookyRefresh: true });

            alert(`✅ Sync Pinnacle OK. Remotas: ${totalCount} | Tocadas local: ${touchedCount}`);
        } catch (error) {
            const message = error?.message || 'Error desconocido al sincronizar Pinnacle.';
            setPinnacleHistorySyncMeta((prev) => ({
                ...prev,
                error: message
            }));
            alert(`⚠️ Sync Pinnacle falló: ${message}`);
        } finally {
            setPinnacleHistorySyncing(false);
        }
    };

  const resetPortfolio = async () => {
    if (!window.confirm("¿Seguro de reiniciar la simulación?")) return;
    try {
        const { data } = await axios.post('/api/portfolio/reset');
        setPortfolio(data);
    } catch (e) {
        alert("Error reseteando portfolio");
    }
  };

  useEffect(() => {
    let isUnmounted = false;

    const bootstrap = async () => {
        await fetchData();
        if (isUnmounted) return;
        fetchPrematchData();
        fetchArbitrageData({ force: true });
    };

    bootstrap();

    const coreInterval = setInterval(() => {
        fetchData();
    }, CORE_POLL_MS);

    const prematchInterval = setInterval(() => {
        fetchPrematchData();
        fetchArbitrageData();
    }, PREMATCH_POLL_MS);

    return () => {
        isUnmounted = true;
        clearInterval(coreInterval);
        clearInterval(prematchInterval);
    };
  }, []);

  useEffect(() => {
    const clockInterval = setInterval(() => {
        setTokenClockMs(Date.now());
    }, TOKEN_CLOCK_TICK_MS);

    return () => clearInterval(clockInterval);
  }, []);

  useEffect(() => {
      const shouldAutoRenew = Boolean(
          tokenHealth?.autoRefreshEnabled &&
          tokenHealth &&
          !hasEnoughTokenLife(tokenHealth)
      );

      if (!shouldAutoRenew) return;

      const nowMs = Date.now();
      const elapsed = nowMs - Number(lastSilentTokenRenewAttemptAtRef.current || 0);
      if (autoTokenRenewInFlightRef.current || elapsed < TOKEN_AUTO_RENEW_COOLDOWN_MS) return;

      autoTokenRenewInFlightRef.current = true;
      setTokenRenewing(true);

      axios.post('/api/booky/token/renew', undefined, { timeout: 3500 })
          .then(async (renewRes) => {
              const started = Boolean(renewRes?.data?.success && renewRes?.data?.started);
              const busy = Boolean(renewRes?.data?.busy);

              if (started || busy) {
                  lastSilentTokenRenewAttemptAtRef.current = Date.now();
              } else {
                  lastSilentTokenRenewAttemptAtRef.current = Date.now() - (TOKEN_AUTO_RENEW_COOLDOWN_MS - TOKEN_AUTO_RENEW_RETRY_ON_FAILURE_MS);
                  return;
              }

              if (!started) return;

              for (let i = 0; i < 12; i += 1) {
                  await new Promise(resolve => setTimeout(resolve, 1500));
                  try {
                      const tokenRes = await axios.get('/api/booky/token-health', { timeout: 3500 });
                      if (tokenRes?.data?.success) {
                          setTokenHealth(tokenRes.data.token);
                          if (hasEnoughTokenLife(tokenRes.data.token)) {
                              await fetchData({ forceBookyRefresh: true });
                              break;
                          }
                      }
                  } catch (_) {}
              }
          })
          .catch(() => {
              lastSilentTokenRenewAttemptAtRef.current = Date.now() - (TOKEN_AUTO_RENEW_COOLDOWN_MS - TOKEN_AUTO_RENEW_RETRY_ON_FAILURE_MS);
          })
          .finally(() => {
              autoTokenRenewInFlightRef.current = false;
              setTokenRenewing(false);
          });
    }, [tokenHealth, tokenClockMs]);

    useEffect(() => {
            try {
                    localStorage.setItem('finishedSelectionView', finishedSelectionView);
            } catch (_) {}
    }, [finishedSelectionView]);

        useEffect(() => {
            try {
                localStorage.setItem('finishedProviderFilter', normalizeFinishedProviderFilter(finishedProviderFilter));
            } catch (_) {}
        }, [finishedProviderFilter]);

  // Effect para Notificaciones Sonoras (Nuevas Oportunidades Live)
  useEffect(() => {
    if (isFirstLoad.current) {
        isFirstLoad.current = false;
        prevLiveOpsIdsRef.current = new Set(liveOps.map(op => getOpportunityId(op)));
        return;
    }

    const currentIds = new Set(liveOps.map(op => getOpportunityId(op)));
    const activeKeys = new Set(
        (Array.isArray(portfolio?.activeBets) ? portfolio.activeBets : [])
            .map(getOpportunityId)
            .filter(Boolean)
    );

    const remoteOpenRows = (Array.isArray(bookyAccount?.history) ? bookyAccount.history : [])
        .filter(row => isBookyOpenStatus(row?.status));
    remoteOpenRows.forEach(row => {
        const key = getBookyOpenBetKey(row);
        if (key) activeKeys.add(key);
    });

    // No disparar sonido para selecciones ya abiertas (evita ruido por reaparición temporal).
    const newOps = liveOps.filter(op => {
        const key = getOpportunityId(op);
        if (!key) return false;
        if (activeKeys.has(key)) return false;
        return !prevLiveOpsIdsRef.current.has(key);
    });

    const nowMs = Date.now();
    const eligibleForAlert = newOps.filter(op => {
        const key = getOpportunityId(op);
        if (!key) return false;
        const lastAt = Number(lastAlertedLiveOpAtRef.current.get(key) || 0);
        return (nowMs - lastAt) >= LIVE_ALERT_COOLDOWN_MS;
    });

    if (eligibleForAlert.length > 0) {
        const hasSnipe = eligibleForAlert.some(op => op.type === 'LIVE_SNIPE' || op.strategy === 'LIVE_SNIPE');
        console.log(`🔔 ${eligibleForAlert.length} Nueva(s) Oportunidad(es) Detectada(s) - Sonido: ${hasSnipe ? 'SNIPE' : 'DEFAULT'}`);
        playAlert(hasSnipe ? 'SNIPE' : 'DEFAULT');
        eligibleForAlert.forEach(op => {
            const key = getOpportunityId(op);
            if (key) lastAlertedLiveOpAtRef.current.set(key, nowMs);
        });
    }

    // Mantener mapa de cooldown acotado (evitar crecimiento indefinido)
    for (const [key, ts] of lastAlertedLiveOpAtRef.current.entries()) {
        if ((nowMs - Number(ts || 0)) > (LIVE_ALERT_COOLDOWN_MS * 5)) {
            lastAlertedLiveOpAtRef.current.delete(key);
        }
    }

    prevLiveOpsIdsRef.current = currentIds;
    }, [liveOps, portfolio?.activeBets, bookyAccount?.history]);

    const realBalanceAmount = Number(bookyAccount?.balance?.amount);
    const realBalanceCurrency = String(bookyAccount?.balance?.currency || 'PEN').toUpperCase();
    const activeBookyLabel = String(bookyAccount?.profile || bookyAccount?.integration || 'booky').toUpperCase();
    const pinnacleBalanceAmount = Number(pinnacleAccount?.balance?.amount);
    const pinnacleBalanceCurrency = String(pinnacleAccount?.balance?.currency || 'USD').toUpperCase();
    const pinnaclePnlSnapshotRaw = Number(pinnacleAccount?.pnl?.netAfterOpenStake ?? pinnacleAccount?.pnl?.total);
    const pinnaclePnlByBalanceRaw = Number(pinnacleAccount?.pnl?.byBalance);
    const pinnacleBaseCapitalRaw = Number(pinnacleAccount?.pnl?.baseCapital);
    const pinnacleRealPnL = Number.isFinite(pinnaclePnlSnapshotRaw)
        ? pinnaclePnlSnapshotRaw
        : (Number.isFinite(pinnaclePnlByBalanceRaw) ? pinnaclePnlByBalanceRaw : NaN);
    const pnlFromSnapshot = Number(bookyAccount?.pnl?.netAfterOpenStake);
    const pnlFromSnapshotTotal = Number(bookyAccount?.pnl?.total);
    const pnlFromSnapshotRealized = Number(bookyAccount?.pnl?.realized);
    const realBookyPnL = Number.isFinite(pnlFromSnapshot)
        ? pnlFromSnapshot
        : (Number.isFinite(pnlFromSnapshotTotal) ? pnlFromSnapshotTotal : (Number.isFinite(pnlFromSnapshotRealized) ? pnlFromSnapshotRealized : 0));
    const realBookyPnLClass = realBookyPnL >= 0 ? 'text-emerald-400' : 'text-red-400';
    const getTokenRemainingMinutes = (token = null, nowMs = Date.now()) => {
        const expMs = new Date(token?.expIso || 0).getTime();
        if (Number.isFinite(expMs) && expMs > 0) {
            return Number(((expMs - nowMs) / 60000).toFixed(2));
        }
        const fallback = Number(token?.remainingMinutes);
        return Number.isFinite(fallback) ? fallback : NaN;
    };

    const hasEnoughTokenLife = (token = null, nowMs = Date.now()) => {
        const remainingMinutes = getTokenRemainingMinutes(token, nowMs);
        const minRequiredMinutes = Number(token?.minRequiredMinutes || 2);
        return Boolean(
            token?.exists &&
            token?.jwtValid &&
            token?.authenticated &&
            !token?.expired &&
            Number.isFinite(remainingMinutes) &&
            remainingMinutes >= minRequiredMinutes
        );
    };

    const tokenRemainingMinutes = getTokenRemainingMinutes(tokenHealth, tokenClockMs);
    const tokenMinRequiredMinutes = Number(tokenHealth?.minRequiredMinutes || 2);
    const tokenAutoRenewThresholdMinutes = tokenMinRequiredMinutes + TOKEN_AUTO_RENEW_LEAD_MINUTES;
    const tokenAutoRefreshEnabled = Boolean(tokenHealth?.autoRefreshEnabled);
    const silentRenewElapsedMs = tokenClockMs - Number(lastSilentTokenRenewAttemptAtRef.current || 0);
    const silentRenewCooldownRemainingSec = Math.max(0, Math.ceil((TOKEN_AUTO_RENEW_COOLDOWN_MS - silentRenewElapsedMs) / 1000));
    const silentRenewCooldownActive = Boolean(
        tokenAutoRefreshEnabled &&
        Number(lastSilentTokenRenewAttemptAtRef.current || 0) > 0 &&
        silentRenewCooldownRemainingSec > 0
    );
    const tokenNearAutoRenewWindow = Boolean(
        tokenAutoRefreshEnabled &&
        Number.isFinite(tokenRemainingMinutes) &&
        tokenRemainingMinutes <= tokenAutoRenewThresholdMinutes
    );
    const tokenProfile = String(tokenHealth?.profile || tokenHealth?.integration || '').toLowerCase();
    const tokenRenewCommand = tokenProfile === 'acity'
            ? 'npm run token:booky:acity:wait-close'
            : tokenProfile === 'doradobet'
                    ? 'npm run token:booky:dorado:wait-close'
                    : (tokenHealth?.renewalCommand || 'npm run token:booky:wait-close');
    const tokenHealthy = hasEnoughTokenLife(tokenHealth, tokenClockMs);
        const kellyBaseAmount = Number(kellyDiagnostics?.bankrollBase?.amount);
        const kellyBaseCurrency = String(bookyAccount?.balance?.currency || 'PEN').toUpperCase();
        const kellyBaseMode = String(kellyDiagnostics?.bankrollBase?.baseMode || '--').toUpperCase();
        const kellyExposurePressurePct = Number(kellyDiagnostics?.simultaneity?.exposurePressure);
        const kellyPrematchRuin = Number(kellyDiagnostics?.riskOfRuin?.PREMATCH_VALUE?.probability);
        const kellyLiveRuin = Number(kellyDiagnostics?.riskOfRuin?.LIVE_VALUE?.probability);
        const kellyRecPrematch = Number(kellyDiagnostics?.fractions?.recommended?.PREMATCH_VALUE);
        const kellyRecLive = Number(kellyDiagnostics?.fractions?.recommended?.LIVE_VALUE);
        const kellyDiagTime = kellyDiagnostics?.fetchedAt;
    const isManualKellyMode = kellyBaseMode === 'PORTFOLIO' || kellyBaseMode === 'CONFIG';
    const tokenRealPlacementEnabled = tokenHealth?.realPlacementEnabled === true;
    const isSimulatedDisplayMode = !tokenRealPlacementEnabled;
    const portfolioHistoryRows = Array.isArray(portfolio?.history) ? portfolio.history : [];
    const simulatedHistoryRows = portfolioHistoryRows.filter((row) => {
        const hasProviderBetId = row?.providerBetId !== null && row?.providerBetId !== undefined && String(row.providerBetId).trim() !== '';
        const isRemoteHistory = row?.isBookyHistory === true || String(row?.source || '').toLowerCase() === 'remote';
        return !hasProviderBetId && !isRemoteHistory;
    });
    const portfolioInitialCapital = Number(portfolio?.initialCapital);
    const simulatedRealizedPnL = simulatedHistoryRows.reduce((acc, row) => acc + resolveFinishedOpPnl(row), 0);
    const simulatedCapitalByHistory = Number.isFinite(portfolioInitialCapital)
        ? Number((portfolioInitialCapital + simulatedRealizedPnL).toFixed(2))
        : NaN;
    const simulatedCapitalAmount = simulatedCapitalByHistory;
    const simulatedPnlAmount = Number.isFinite(simulatedRealizedPnL)
        ? Number(simulatedRealizedPnL.toFixed(2))
        : 0;

    const manualProviderNormalized = normalizeAutoPlacementProvider(autoPlacementProvider, 'booky');
    const showPinnacleBalanceInHeader = manualProviderNormalized === 'pinnacle' && Number.isFinite(pinnacleBalanceAmount);
    const wantsPinnacleBalance = manualProviderNormalized === 'pinnacle';

    const showSimInHeader = isSimulatedDisplayMode || isManualKellyMode;
    const defaultHeaderCapitalAmount = showSimInHeader
        ? (Number.isFinite(simulatedCapitalAmount)
            ? simulatedCapitalAmount
            : (Number.isFinite(kellyBaseAmount) ? kellyBaseAmount : NaN))
        : realBalanceAmount;
    const defaultHeaderCapitalCurrency = showSimInHeader ? kellyBaseCurrency : realBalanceCurrency;
    const fallbackAmountWhenPinnacleMissing = Number.isFinite(realBalanceAmount) ? realBalanceAmount : defaultHeaderCapitalAmount;
    const fallbackCurrencyWhenPinnacleMissing = Number.isFinite(realBalanceAmount) ? realBalanceCurrency : defaultHeaderCapitalCurrency;
    const headerCapitalAmount = showPinnacleBalanceInHeader
        ? pinnacleBalanceAmount
        : (wantsPinnacleBalance ? fallbackAmountWhenPinnacleMissing : defaultHeaderCapitalAmount);
    const headerCapitalCurrency = showPinnacleBalanceInHeader
        ? pinnacleBalanceCurrency
        : (wantsPinnacleBalance ? fallbackCurrencyWhenPinnacleMissing : defaultHeaderCapitalCurrency);
    const headerPnlAmount = showSimInHeader
        ? simulatedPnlAmount
        : (wantsPinnacleBalance
            ? (Number.isFinite(pinnacleRealPnL) ? pinnacleRealPnL : realBookyPnL)
            : realBookyPnL);
    const headerPnlClass = headerPnlAmount >= 0 ? 'text-emerald-400' : 'text-red-400';
    const headerPnlLabel = wantsPinnacleBalance
        ? 'PnL (PINNACLE)'
        : (showSimInHeader ? 'PnL (SIM NAV)' : `PnL (${activeBookyLabel})`);
    const pinnacleBaseCapitalLabel = Number.isFinite(pinnacleBaseCapitalRaw)
        ? ` | Base: ${pinnacleBalanceCurrency} ${pinnacleBaseCapitalRaw.toFixed(2)}`
        : '';
    const headerBalanceSourceLabel = showPinnacleBalanceInHeader
        ? `Saldo mostrado: PINNACLE (${pinnacleAccount?.endpoint || '/wallet/balance'})${pinnacleBaseCapitalLabel}`
        : (wantsPinnacleBalance
            ? `Saldo Pinnacle no disponible; fallback ${activeBookyLabel}`
            : `Saldo mostrado: ${activeBookyLabel} (Booky/ACity)`);
    const autoPlacementProviderLabel = String(autoPlacementProvider || 'booky').toUpperCase();
    const autoPlacementProviderPretty = autoPlacementProvider === 'pinnacle' ? 'Pinnacle' : 'Booky';
    const autoPlacementProviderBadgeClass = autoPlacementProvider === 'pinnacle'
        ? (pinnacleHistorySyncing
            ? 'bg-blue-500/35 text-blue-100 border-blue-300/70 ring-1 ring-blue-300/35'
            : 'bg-blue-500/20 text-blue-300 border-blue-500/35 hover:bg-blue-500/30')
        : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/35';
    const [tokenRenewing, setTokenRenewing] = useState(false);
    const tokenRenewingRef = useRef(false);

  const handleTokenRenewGuide = async () => {
      if (tokenRenewingRef.current) return;
      tokenRenewingRef.current = true;
      setTokenRenewing(true);

      let launched = false;
      let handledBusy = false;

      try {
          const renewRes = await axios.post('/api/booky/token/renew', undefined, { timeout: 3500 });
          if (renewRes?.data?.busy) {
              handledBusy = true;
              alert(
                  '⏳ Ya hay una renovación iniciándose en segundo plano.\n\n' +
                  'Si Chrome no aparece en ~10s, cierra ventanas de Chrome bloqueadas y reintenta.'
              );
          }

          if (!handledBusy && renewRes?.data?.success && renewRes?.data?.started) {
              launched = true;
              alert(
                  '🚀 Se abrió Chrome automáticamente para renovar token.\n\n' +
                  '1) Inicia sesión en Altenar\n' +
                  '2) Navega por sportsbook\n' +
                  '3) Cierra Chrome para completar captura\n\n' +
                  `Perfil detectado: ${renewRes?.data?.profile || tokenProfile || 'desconocido'}`
              );
          }
      } catch (_) {}

      try {
          if (!launched && !handledBusy) {
              await navigator.clipboard.writeText(tokenRenewCommand);
              alert(
                  '📋 Comando copiado al portapapeles.\n\n' +
                  `Pégalo en tu terminal:\n${tokenRenewCommand}\n\n` +
                  `Perfil detectado: ${tokenProfile || 'desconocido'}\n\n` +
                  '1) Inicia sesión en Chrome\n' +
                  '2) Navega por sportsbook\n' +
                  '3) Cierra Chrome para completar captura'
              );
          }
      } catch (_) {
          if (!launched && !handledBusy) {
              alert(
                  'No se pudo copiar automáticamente.\n\n' +
                  `Ejecuta manualmente:\n${tokenRenewCommand}`
              );
          }
      } finally {
          tokenRenewingRef.current = false;
          setTokenRenewing(false);
      }

      if (launched) {
          (async () => {
              for (let i = 0; i < 12; i += 1) {
                  await new Promise(resolve => setTimeout(resolve, 1500));
                  try {
                      const tokenRes = await axios.get('/api/booky/token-health', { timeout: 3500 });
                      if (tokenRes?.data?.success) {
                          setTokenHealth(tokenRes.data.token);
                          if (hasEnoughTokenLife(tokenRes.data.token)) {
                              await fetchData({ forceBookyRefresh: true });
                              break;
                          }
                      }
                  } catch (_) {}
              }
          })();
      }
  };

  // --- MANUAL PLACEMENT ---
  const [processingBets, setProcessingBets] = useState(new Set());
    const processingBetsRef = useRef(new Set());

    const handlePlaceBet = async (opportunity, options = {}) => {
    const id = getOpportunityId(opportunity); // ID único por selección (eventId + selection)
                const requoteRetryCount = Number(options?.requoteRetryCount || 0);
                const forcedConfirmMode = options?.confirmModeHint === 'confirm-fast'
                        ? 'confirm-fast'
                        : (options?.confirmModeHint === 'confirm' ? 'confirm' : null);
        const optimisticIsSnipe = String(opportunity?.type || opportunity?.strategy || '').toUpperCase() === 'LIVE_SNIPE';
            const manualPlacementProvider = normalizeAutoPlacementProvider(autoPlacementProvider, 'booky');
            const isBookyManualPlacement = manualPlacementProvider === 'booky';
            const providerApiBase = isBookyManualPlacement ? '/api/booky' : '/api/pinnacle';
            const providerLabel = isBookyManualPlacement ? 'Booky' : 'Pinnacle';
            const providerPrefix = isBookyManualPlacement ? 'BOOKY' : 'PINNACLE';
            let useRealPlacement = !isBookyManualPlacement;

        const recoverPreparedTicket = async () => {
            const ticketsRes = await axios.get(`${providerApiBase}/tickets`, { timeout: 7000 });
            const pending = Array.isArray(ticketsRes?.data?.pending) ? ticketsRes.data.pending : [];
            const nowMs = Date.now();

            return pending.find((t) => {
                if (String(t?.status || '').toUpperCase() !== 'DRAFT') return false;
                const expMs = new Date(t?.expiresAt || '').getTime();
                if (!Number.isFinite(expMs) || expMs <= nowMs) return false;

                const tOpp = t?.opportunity || {};
                const sameEvent = String(tOpp?.eventId || '') === String(opportunity?.eventId || '');
                const sameSelection = String(tOpp?.selection || '').trim().toLowerCase() === String(opportunity?.selection || '').trim().toLowerCase();
                const sameMarket = String(tOpp?.market || '').trim().toLowerCase() === String(opportunity?.market || '').trim().toLowerCase();

                return sameEvent && sameSelection && sameMarket;
            });
        };

        const releaseLocalOptimisticLock = () => {
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            optimisticWarnedIdsRef.current.delete(id);
            forceUpdate();
        };

        const offerImmediateRequoteRetry = () => {
            if (requoteRetryCount >= 1) return;

            const suggestedMode = String(opportunity?.type || opportunity?.strategy || '').toUpperCase() === 'LIVE_SNIPE'
                ? 'confirm-fast'
                : 'confirm';

            const wantsRetryNow = window.confirm(
                '🔁 La casa devolvió re-quote (cuota/selección cambió en vivo).\n\n' +
                '¿Deseas reintentar ahora con ticket refrescado?'
            );

            if (!wantsRetryNow) return;

            setTimeout(() => {
                handlePlaceBet(opportunity, {
                    requoteRetryCount: requoteRetryCount + 1,
                    confirmModeHint: suggestedMode
                });
            }, 1300);
        };

        const shouldKeepBlockedAfterForcedRefresh = () => {
            const blockedByBetKey = blockedBetIdsRef.current instanceof Set && blockedBetIdsRef.current.has(id);
            const eventId = String(opportunity?.eventId || '').trim();
            const blockedByEvent = eventId && remoteOpenEventIdsRef.current instanceof Set
                ? remoteOpenEventIdsRef.current.has(eventId)
                : false;
            return Boolean(blockedByBetKey || blockedByEvent);
        };
    
        // Evitar doble clic (lock inmediato con ref para evitar race de setState)
        if (processingBetsRef.current.has(id)) return;
        processingBetsRef.current.add(id);
    
    // UI Optimista: Añadir a procesando
    setProcessingBets(prev => new Set(prev).add(id));
    
    // [NEW] Añadir a localPlacedBetIds (REF) para que fetchData lo filtre de la lista de oportunidades inmediatamente
    localPlacedBetIdsRef.current.add(id);
    pendingBetDetailsRef.current[id] = {
        ...opportunity,
        optimisticCreatedAt: Date.now(),
        optimisticTtlMs: optimisticIsSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS,
        optimisticIsSnipe,
        optimisticPlacementMode: `${providerPrefix}_UNKNOWN`,
        optimisticInFlight: true,
        optimisticFlow: 'preparing',
        optimisticConfirmedAt: null,
        optimisticMissingRemoteChecks: 0
    };
    forceUpdate(); // Forzar re-render inmediato para ocultarlo de la lista

    try {
        // Optimización UX: no bloquear el flujo por token-health lento.
        // El backend vuelve a validar token en confirmación real.
        const tokenHealthPromise = isBookyManualPlacement
            ? axios.get('/api/booky/token-health', { timeout: 3500 }).catch(() => null)
            : Promise.resolve(null);

        const prepareTimeoutMs = 45000;
        const doPrepare = () => axios.post(`${providerApiBase}/prepare`, opportunity, { timeout: prepareTimeoutMs });

        let prepRes;
        try {
            prepRes = await doPrepare();
        } catch (prepError) {
            const prepMsg = String(prepError?.response?.data?.message || prepError?.message || '').toLowerCase();
            const isTimeout = prepError?.code === 'ECONNABORTED' || prepMsg.includes('timeout');
            if (!isTimeout) throw prepError;

            const recovered = await recoverPreparedTicket().catch(() => null);
            if (recovered) {
                prepRes = { data: { success: true, ticket: recovered } };
            } else {
                await new Promise(resolve => setTimeout(resolve, 1200));
                prepRes = await doPrepare();
            }
        }

        if (!prepRes.data?.success || !prepRes.data?.ticket) {
            alert(`⚠️ No se pudo preparar ticket: ${prepRes.data?.message || 'Error desconocido'}`);
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
            return;
        }

        const ticket = prepRes.data.ticket;
        const tokenRes = await tokenHealthPromise;
        const token = tokenRes?.data?.token;
        const tokenCheckAvailable = Boolean(tokenRes?.data?.success);

        if (isBookyManualPlacement && tokenCheckAvailable && !hasEnoughTokenLife(token)) {
            const liveTokenMins = getTokenRemainingMinutes(token);
            const minRequiredMins = Number(token?.minRequiredMinutes || 2);
            const reason = !token?.authenticated
                ? 'token no autenticado'
                : (token?.expired
                    ? 'token vencido'
                    : `token por vencer (${liveTokenMins.toFixed(1)} min < ${minRequiredMins.toFixed(1)} min requeridos)`);
            await axios.post(`${providerApiBase}/cancel/${ticket.id}`).catch(() => {});
            alert(`⚠️ No se puede apostar en ${providerLabel}: ${reason}. Renueva token y reintenta.`);
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
            return;
        }

        if (isBookyManualPlacement) {
            useRealPlacement = Boolean(token?.realPlacementEnabled);
        }

        let dryRunSummaryLine = '';
        if (isBookyManualPlacement && useRealPlacement) {
            try {
                const dryRunRes = await axios.post(`${providerApiBase}/real/dryrun/${ticket.id}`, undefined, { timeout: 20000 });
                const dryDraft = dryRunRes?.data?.draft || null;
                if (!dryRunRes?.data?.success || !dryDraft) {
                    throw new Error(dryRunRes?.data?.message || 'Dry-run no devolvió payload válido.');
                }

                const dryStake = Number(dryDraft?.payload?.stakes?.[0]);
                const dryOdd = Number(dryDraft?.payload?.betMarkets?.[0]?.odds?.[0]?.price);
                const dryRequestId = String(dryDraft?.payload?.requestId || '').trim();
                const stakeTxt = Number.isFinite(dryStake) && dryStake > 0 ? `S/. ${dryStake.toFixed(2)}` : 'n/a';
                const oddTxt = Number.isFinite(dryOdd) && dryOdd > 1 ? dryOdd.toFixed(3) : 'n/a';
                dryRunSummaryLine = `Dry-run OK: stake ${stakeTxt} | odd ${oddTxt}${dryRequestId ? ` | req ${dryRequestId}` : ''}`;
            } catch (dryRunError) {
                const dryData = dryRunError?.response?.data;
                const dryMsg = dryData?.message || dryRunError?.message || 'No se pudo validar dry-run.';
                const dryDiag = dryData?.diagnostic;
                const dryDiagText = dryDiag
                    ? `\n\nDiagnóstico:\nproviderStatus: ${dryDiag.providerStatus ?? 'n/a'}\nproviderCode: ${dryDiag.providerCode ?? 'n/a'}\nrequestId: ${dryDiag.requestId ?? 'n/a'}`
                    : '';
                await axios.post(`${providerApiBase}/cancel/${ticket.id}`).catch(() => {});
                alert(`⚠️ Dry-run REAL falló en ${providerLabel}.\nNo se enviará confirmación real.${dryDiagText}\n\nDetalle: ${dryMsg}`);
                localPlacedBetIdsRef.current.delete(id);
                delete pendingBetDetailsRef.current[id];
                forceUpdate();
                return;
            }
        }

        pendingBetDetailsRef.current[id] = {
            ...opportunity,
            ...(ticket?.opportunity || {}),
            optimisticCreatedAt: pendingBetDetailsRef.current[id]?.optimisticCreatedAt || Date.now(),
            optimisticTtlMs: pendingBetDetailsRef.current[id]?.optimisticTtlMs || (optimisticIsSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS),
            optimisticIsSnipe,
            optimisticPlacementMode: `${providerPrefix}_${useRealPlacement ? 'REAL' : 'SIM'}`,
            optimisticInFlight: true,
            optimisticFlow: 'prepared',
            optimisticConfirmedAt: null,
            optimisticMissingRemoteChecks: 0
        };
        forceUpdate();

        const oldOdd = Number(opportunity?.price || opportunity?.odd || 0);
        const oldStake = Number(opportunity?.kellyStake || 0);
        const oldEv = Number(opportunity?.ev || 0);
        const oldRealProb = Number(opportunity?.realProb || 0);
        const odd = Number(ticket?.opportunity?.price || ticket?.opportunity?.odd || 0);
        const stake = Number(ticket?.opportunity?.kellyStake || 0);
        const ev = Number(ticket?.opportunity?.ev || 0);
        const realProb = Number(ticket?.opportunity?.realProb || 0);
        const fairProbSource = String(ticket?.opportunity?.fairProbSource || '').trim();

        const showDelta = (before, after, digits = 2) => {
            const b = Number(before);
            const a = Number(after);
            if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
            if (Math.abs(a - b) < 0.0001) return null;
            return `${b.toFixed(digits)} -> ${a.toFixed(digits)}`;
        };

        const oddDeltaLine = showDelta(oldOdd, odd, 2);
        const stakeDeltaLine = showDelta(oldStake, stake, 2);
        const evDeltaLine = showDelta(oldEv, ev, 2);
        const probDeltaLine = showDelta(oldRealProb, realProb, 2);
        const tokenMins = getTokenRemainingMinutes(token);
        const placementTitle = useRealPlacement ? `Apuesta REAL ${providerLabel}` : `Apuesta SIMULADA (${providerLabel})`;
        const placementQuestion = useRealPlacement
            ? `¿Confirmar envío REAL a ${providerLabel}?`
            : '¿Confirmar apuesta SIMULADA al historial local?';
        const tokenLine = isBookyManualPlacement
            ? (tokenCheckAvailable
            ? (useRealPlacement
                ? `Token restante: ${tokenMins.toFixed(1)} min\n\n`
                : 'Modo simulado: no se enviará placeWidget al provider.\n\n')
            : (useRealPlacement
                ? 'Token: verificación rápida no disponible (se validará al confirmar)\n\n'
                : 'Modo simulado: verificación de token no requerida para placement real.\n\n'))
            : (useRealPlacement
                ? 'Placement real vía Pinnacle API.\n\n'
                : 'Modo simulado: confirmación local en portfolio.\n\n');

        const refreshLines = [
            'Recalculo previo a confirmación:',
            `Cuota actual: ${odd.toFixed(2)}`,
            `Stake recalculado: S/. ${stake.toFixed(2)}`,
            `EV recalculado: ${ev.toFixed(2)}%`,
            `Prob real recalculada: ${realProb.toFixed(2)}%`
        ];

        if (oddDeltaLine) refreshLines.push(`Delta cuota: ${oddDeltaLine}`);
        if (stakeDeltaLine) refreshLines.push(`Delta stake: ${stakeDeltaLine}`);
        if (evDeltaLine) refreshLines.push(`Delta EV: ${evDeltaLine}`);
        if (probDeltaLine) refreshLines.push(`Delta prob real: ${probDeltaLine}`);
        if (fairProbSource) refreshLines.push(`Fuente fair prob: ${fairProbSource}`);
        if (dryRunSummaryLine) refreshLines.push(dryRunSummaryLine);

        const refreshBlock = `${refreshLines.join('\n')}\n\n`;

        const ok = window.confirm(
            `${placementTitle}\n\n` +
            `Partido: ${ticket?.opportunity?.match || '-'}\n` +
            `Selección: ${ticket?.opportunity?.selection || '-'}\n` +
            refreshBlock +
            tokenLine +
            `${placementQuestion}`
        );

        if (!ok) {
            await axios.post(`${providerApiBase}/cancel/${ticket.id}`);
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
            return;
        }

        const isLiveSnipe = String(ticket?.opportunity?.type || opportunity?.type || '').toUpperCase() === 'LIVE_SNIPE';
        const confirmMode = forcedConfirmMode || (isLiveSnipe ? 'confirm-fast' : 'confirm');
        const confirmEndpoint = useRealPlacement
            ? `${providerApiBase}/real/${confirmMode}/${ticket.id}`
            : `${providerApiBase}/confirm/${ticket.id}`;

        if (pendingBetDetailsRef.current[id]) {
            pendingBetDetailsRef.current[id] = {
                ...pendingBetDetailsRef.current[id],
                optimisticInFlight: true,
                optimisticFlow: 'confirming'
            };
            forceUpdate();
        }

        const confirmRes = await axios.post(confirmEndpoint, undefined, { timeout: 30000 });
        if (confirmRes.data?.success) {
            if (!useRealPlacement) {
                pendingBetDetailsRef.current[id] = {
                    ...(pendingBetDetailsRef.current[id] || opportunity),
                    odd,
                    price: odd,
                    stake,
                    kellyStake: stake,
                    potentialReturn: stake * odd,
                    confirmedAt: new Date().toISOString(),
                    optimisticCreatedAt: pendingBetDetailsRef.current[id]?.optimisticCreatedAt || Date.now(),
                    optimisticTtlMs: pendingBetDetailsRef.current[id]?.optimisticTtlMs || (isLiveSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS),
                    optimisticIsSnipe: pendingBetDetailsRef.current[id]?.optimisticIsSnipe ?? isLiveSnipe,
                    optimisticPlacementMode: `${providerPrefix}_SIM`,
                    optimisticInFlight: false,
                    optimisticFlow: 'confirmed',
                    optimisticConfirmedAt: new Date().toISOString(),
                    optimisticMissingRemoteChecks: 0
                };
                forceUpdate();
                alert(`✅ Apuesta simulada (${providerLabel}) confirmada y registrada en portfolio local.`);
                await fetchData();
                return;
            }

            if (!isBookyManualPlacement) {
                const providerBetId =
                    confirmRes?.data?.ticket?.portfolioBetId ||
                    confirmRes?.data?.providerResponse?.betId ||
                    confirmRes?.data?.providerResponse?.requestId ||
                    null;
                const requestedStakeRaw =
                    Number(confirmRes?.data?.ticket?.realPlacement?.requested?.stake) ||
                    stake;
                const requestedOddRaw =
                    Number(confirmRes?.data?.ticket?.realPlacement?.requested?.selections?.[0]?.price) ||
                    Number(confirmRes?.data?.ticket?.realPlacement?.requested?.odd) ||
                    odd;

                const syncedStake = Number.isFinite(requestedStakeRaw) && requestedStakeRaw > 0 ? requestedStakeRaw : stake;
                const syncedOdd = Number.isFinite(requestedOddRaw) && requestedOddRaw > 1 ? requestedOddRaw : odd;

                pendingBetDetailsRef.current[id] = {
                    ...(pendingBetDetailsRef.current[id] || opportunity),
                    odd: syncedOdd,
                    price: syncedOdd,
                    stake: syncedStake,
                    kellyStake: syncedStake,
                    potentialReturn: syncedStake * syncedOdd,
                    confirmedAt: new Date().toISOString(),
                    providerBetId: providerBetId || (pendingBetDetailsRef.current[id]?.providerBetId || null),
                    optimisticCreatedAt: pendingBetDetailsRef.current[id]?.optimisticCreatedAt || Date.now(),
                    optimisticTtlMs: pendingBetDetailsRef.current[id]?.optimisticTtlMs || (isLiveSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS),
                    optimisticIsSnipe: pendingBetDetailsRef.current[id]?.optimisticIsSnipe ?? isLiveSnipe,
                    optimisticPlacementMode: 'PINNACLE_REAL',
                    optimisticInFlight: false,
                    optimisticFlow: 'confirmed',
                    optimisticConfirmedAt: new Date().toISOString(),
                    optimisticMissingRemoteChecks: 0
                };
                forceUpdate();

                alert('✅ Apuesta REAL enviada y confirmada en Pinnacle.');
                await fetchData();
                return;
            }

            const providerBetId =
                confirmRes?.data?.ticket?.realPlacement?.accepted?.providerBetId ||
                confirmRes?.data?.providerResponse?.bets?.[0]?.id ||
                null;
            const sentStakeRaw =
                Number(confirmRes?.data?.ticket?.realPlacement?.requested?.stake) ||
                Number(confirmRes?.data?.ticket?.realPlacement?.sentStake);
            const sentOddRaw =
                Number(confirmRes?.data?.ticket?.realPlacement?.requested?.odd) ||
                Number(confirmRes?.data?.ticket?.realPlacement?.sentOdd);
            const acceptedStakeRaw =
                Number(confirmRes?.data?.ticket?.realPlacement?.accepted?.acceptedStake) ||
                Number(confirmRes?.data?.providerResponse?.bets?.[0]?.finalStake) ||
                Number(confirmRes?.data?.providerResponse?.bets?.[0]?.totalStake);
            const acceptedOddRaw =
                Number(confirmRes?.data?.ticket?.realPlacement?.accepted?.acceptedOdd) ||
                Number(confirmRes?.data?.providerResponse?.bets?.[0]?.odd);
            const hasSentStake = Number.isFinite(sentStakeRaw) && sentStakeRaw > 0;
            const hasAcceptedStake = Number.isFinite(acceptedStakeRaw) && acceptedStakeRaw > 0;
            const hasSentOdd = Number.isFinite(sentOddRaw) && sentOddRaw > 1;
            const hasAcceptedOdd = Number.isFinite(acceptedOddRaw) && acceptedOddRaw > 1;
            const hasProviderBetId = providerBetId !== null && providerBetId !== undefined && String(providerBetId).trim() !== '';

            if (!hasProviderBetId && !hasAcceptedStake) {
                localPlacedBetIdsRef.current.delete(id);
                delete pendingBetDetailsRef.current[id];
                forceUpdate();
                alert('⚠️ Booky no devolvió confirmación de ticket (sin providerBetId). La apuesta no se mostrará como EN JUEGO.');
                await fetchData({ forceBookyRefresh: true });
                return;
            }

            const prepVsSentDelta = hasSentStake ? Math.abs(sentStakeRaw - stake) : 0;
            const prepVsSentOddDelta = hasSentOdd ? Math.abs(sentOddRaw - odd) : 0;
            const sentVsAcceptedDelta = (hasSentStake && hasAcceptedStake)
                ? Math.abs(acceptedStakeRaw - sentStakeRaw)
                : (hasAcceptedStake ? Math.abs(acceptedStakeRaw - stake) : 0);
            const sentVsAcceptedOddDelta = (hasSentOdd && hasAcceptedOdd)
                ? Math.abs(acceptedOddRaw - sentOddRaw)
                : (hasAcceptedOdd ? Math.abs(acceptedOddRaw - odd) : 0);

            const syncedOdd = hasAcceptedOdd
                ? acceptedOddRaw
                : (hasSentOdd ? sentOddRaw : odd);
            const syncedStake = hasAcceptedStake
                ? acceptedStakeRaw
                : (hasSentStake ? sentStakeRaw : stake);

            pendingBetDetailsRef.current[id] = {
                ...(pendingBetDetailsRef.current[id] || opportunity),
                odd: syncedOdd,
                price: syncedOdd,
                stake: syncedStake,
                kellyStake: syncedStake,
                potentialReturn: syncedStake * syncedOdd,
                recalcFromPrep: hasSentStake && prepVsSentDelta >= 0.01,
                recalcByOdd: hasSentOdd && prepVsSentOddDelta >= 0.001,
                oddOnlyRecalc: (hasSentOdd && prepVsSentOddDelta >= 0.001) && !(hasSentStake && prepVsSentDelta >= 0.01),
                providerAdjusted: (hasAcceptedStake && sentVsAcceptedDelta >= 0.01) || (hasAcceptedOdd && sentVsAcceptedOddDelta >= 0.001),
                confirmedAt: new Date().toISOString(),
                providerBetId: hasProviderBetId ? providerBetId : (pendingBetDetailsRef.current[id]?.providerBetId || null),
                optimisticCreatedAt: pendingBetDetailsRef.current[id]?.optimisticCreatedAt || Date.now(),
                optimisticTtlMs: pendingBetDetailsRef.current[id]?.optimisticTtlMs || (isLiveSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS),
                optimisticIsSnipe: pendingBetDetailsRef.current[id]?.optimisticIsSnipe ?? isLiveSnipe,
                optimisticPlacementMode: 'BOOKY_REAL',
                optimisticInFlight: false,
                optimisticFlow: 'confirmed',
                optimisticConfirmedAt: new Date().toISOString(),
                optimisticMissingRemoteChecks: 0
            };
            forceUpdate();

            if (hasSentStake && prepVsSentDelta >= 0.01 && (!hasAcceptedStake || sentVsAcceptedDelta < 0.01)) {
                alert(
                    'ℹ️ Cuota/stake recalculados al confirmar (refresh en tiempo real).\n\n' +
                    `Stake mostrado en botón: S/. ${stake.toFixed(2)}\n` +
                    `Stake enviado: S/. ${sentStakeRaw.toFixed(2)}\n\n` +
                    'No fue ajuste de Booky; fue recálculo interno por cambio de cuota.'
                );
            } else if (hasAcceptedStake && sentVsAcceptedDelta >= 0.01) {
                alert(
                    '⚠️ Apuesta REAL confirmada con ajuste de stake por Booky.\n\n' +
                    `Stake solicitado: S/. ${(hasSentStake ? sentStakeRaw : stake).toFixed(2)}\n` +
                    `Stake aceptado: S/. ${acceptedStakeRaw.toFixed(2)}\n\n` +
                    'La casa puede aplicar mínimo/múltiplos por mercado.'
                );
            } else {
                alert('✅ Apuesta REAL enviada y confirmada en Booky.');
            }
            await fetchData();
        } else {
            if (confirmRes.data?.code === 'BOOKY_REAL_CONFIRMATION_UNCERTAIN') {
                const diagnostic = confirmRes.data?.diagnostic;
                const diagText = diagnostic
                    ? `\n\nDiagnóstico:\n` +
                      `providerStatus: ${diagnostic.providerStatus ?? 'n/a'}\n` +
                      `providerCode: ${diagnostic.providerCode ?? 'n/a'}\n` +
                      `requestId: ${diagnostic.requestId ?? 'n/a'}`
                    : '';
                alert(`⚠️ Estado incierto: la casa pudo aceptar la apuesta.\nVerifica Open Bets antes de reintentar.${diagText}`);
                await fetchData({ forceBookyRefresh: true });

                // Si Booky no reporta la apuesta como abierta luego de refresco forzado,
                // liberamos el lock local para permitir reapostar inmediatamente.
                if (!shouldKeepBlockedAfterForcedRefresh()) {
                    releaseLocalOptimisticLock();
                }
                return;
            }
            if (confirmRes.data?.code === 'BOOKY_REAL_REQUOTE_REQUIRED') {
                const diagnostic = confirmRes.data?.diagnostic;
                const diagText = diagnostic
                    ? `\n\nDiagnóstico:\n` +
                      `providerStatus: ${diagnostic.providerStatus ?? 'n/a'}\n` +
                      `providerCode: ${diagnostic.providerCode ?? 'n/a'}\n` +
                      `requestId: ${diagnostic.requestId ?? 'n/a'}`
                    : '';
                alert(`🔁 Re-quote requerido: la cuota/selección cambió en vivo.\nReprepara y confirma nuevamente.${diagText}`);
                await fetchData({ forceBookyRefresh: true });
                localPlacedBetIdsRef.current.delete(id);
                delete pendingBetDetailsRef.current[id];
                forceUpdate();
                offerImmediateRequoteRetry();
                return;
            }
            if (confirmRes.data?.code === 'PINNACLE_REAL_REJECTED') {
                const msg = confirmRes.data?.message || 'Provider rechazó la apuesta.';
                alert(`❌ Rechazo Pinnacle: ${msg}`);
                localPlacedBetIdsRef.current.delete(id);
                delete pendingBetDetailsRef.current[id];
                forceUpdate();
                await fetchData();
                return;
            }
            const msg = confirmRes.data?.message || 'Error desconocido';
            alert(`⚠️ ${useRealPlacement ? 'Confirmación real' : 'Confirmación simulada'} falló: ${msg}`);
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
        }
    } catch (error) {
        console.error(error);
                const apiData = error?.response?.data;
                const msg = apiData?.message || error?.message || 'Error de red';
                const code = apiData?.code;
                const diagnostic = apiData?.diagnostic;
                const diagText = diagnostic
                        ? `\n\nDiagnóstico:\n` +
                            `providerStatus: ${diagnostic.providerStatus ?? 'n/a'}\n` +
                            `providerCode: ${diagnostic.providerCode ?? 'n/a'}\n` +
                            `requestId: ${diagnostic.requestId ?? 'n/a'}`
                        : '';
                if (code === 'BOOKY_REAL_CONFIRMATION_UNCERTAIN') {
                    alert(`⚠️ Estado incierto: la casa pudo aceptar la apuesta.\nVerifica Open Bets antes de reintentar.${diagText}`);
                    await fetchData({ forceBookyRefresh: true });

                    // Misma lógica: desbloquear solo si no existe registro abierto real.
                    if (!shouldKeepBlockedAfterForcedRefresh()) {
                        releaseLocalOptimisticLock();
                    }
                } else if (code === 'BOOKY_REAL_REQUOTE_REQUIRED') {
                    alert(`🔁 Re-quote requerido: la cuota/selección cambió en vivo.\nReprepara y confirma nuevamente.${diagText}`);
                    await fetchData({ forceBookyRefresh: true });
                    localPlacedBetIdsRef.current.delete(id);
                    delete pendingBetDetailsRef.current[id];
                    forceUpdate();
                    offerImmediateRequoteRetry();
                } else if (code === 'PINNACLE_REAL_REJECTED') {
                    alert(`❌ Rechazo Pinnacle: ${msg}${diagText}`);
                    localPlacedBetIdsRef.current.delete(id);
                    delete pendingBetDetailsRef.current[id];
                    forceUpdate();
                    await fetchData();
                } else {
                    const normalizedMsg = String(msg || '').toLowerCase();
                    if (normalizedMsg.includes('ticket no encontrado')) {
                        let recoveredAndConfirmed = false;
                        try {
                            const recovered = await recoverPreparedTicket();
                            if (recovered?.id) {
                                const recoveredType = String(recovered?.opportunity?.type || opportunity?.type || '').toUpperCase();
                                const recoveredMode = recoveredType === 'LIVE_SNIPE' ? 'confirm-fast' : 'confirm';
                                const retryEndpoint = useRealPlacement
                                    ? `${providerApiBase}/real/${recoveredMode}/${recovered.id}`
                                    : `${providerApiBase}/confirm/${recovered.id}`;
                                const retryRes = await axios.post(retryEndpoint, undefined, { timeout: 30000 });
                                if (retryRes?.data?.success) {
                                    recoveredAndConfirmed = true;
                                    alert('✅ Ticket recuperado y confirmado tras desincronización temporal.');
                                    await fetchData({ forceBookyRefresh: true });
                                }
                            }
                        } catch (_) {}

                        if (!recoveredAndConfirmed) {
                            alert('⚠️ El ticket ya no existe (posible doble clic o desincronización temporal).\nActualiza datos y vuelve a intentar con la oportunidad vigente.');
                            await fetchData({ forceBookyRefresh: true });
                        }
                    } else if (normalizedMsg.includes('timeout')) {
                        alert('⏳ La preparación del ticket tardó más de lo esperado (timeout).\nLa cuota puede seguir vigente: intenta nuevamente en 2-3 segundos.');
                        await fetchData({ forceBookyRefresh: true });
                    } else {
                    alert(`❌ Error de ${useRealPlacement ? 'apuesta real' : 'apuesta simulada'}: ${msg}${diagText}`);
                    }
                    // Si falló de forma definitiva, lo quitamos de la lista local
                    localPlacedBetIdsRef.current.delete(id);
                    delete pendingBetDetailsRef.current[id];
                    forceUpdate();
                }
    } finally {
        if (pendingBetDetailsRef.current[id]) {
            const hasConfirmedMark = Boolean(pendingBetDetailsRef.current[id]?.optimisticConfirmedAt);
            pendingBetDetailsRef.current[id] = {
                ...pendingBetDetailsRef.current[id],
                optimisticInFlight: false,
                optimisticFlow: hasConfirmedMark ? 'confirmed' : 'idle'
            };
        }

        setTimeout(() => {
             processingBetsRef.current.delete(id);
             setProcessingBets(prev => {
                 const next = new Set(prev);
                 next.delete(id);
                 return next;
             });
        }, 1000);
    }
  };

  // --- MANUAL SETTLEMENT ---
  const requestSettle = async (id, mode) => {
      let score = null;
      if (mode === 'MANUAL') {
          score = prompt("Ingrese marcador FINAL (Local-Visita):", "0-0");
          if (score === null) return; // Cancelado
      } else {
          // Modo API aka "Auto"
          if (!confirm("¿Intentar buscar resultado oficial en la API?")) return;
      }
      
      try {
          const res = await fetch(`http://localhost:3000/api/portfolio/settle/${id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ score })
          });
          const json = await res.json();
          if (json.success) {
              fetchData(); 
          } else {
              alert("❌ Error: " + json.error);
          }
      } catch (e) {
          console.error(e);
          alert("Error de conexión con Backend");
      }
  };

  // --- HANDLE DISCARD (USER ACTION) ---
  const handleDiscard = async (op) => {
      // Ignoramos si es una apuesta ya realizada (no tiene sentido descartar activa)
      if (op.id && !op.eventId) { // Es una bet, tiene ID numerico o string propio
          // TO-DO: Implementar "Ocultar Apuesta Activa" si se desea
          return; 
      }
      
      const id = getOpportunityId(op); // ID único por selección (eventId + selection)
      if (!id) return;

      // Optimistic Updates: Remover de la UI inmediatamente
      // [NEW] Persistir en blacklist LOCAL (Ref) para que el próximo fetch no lo reviva
      localDiscardedIdsRef.current.add(id);

      if (activeTab === 'LIVE') {
          setLiveOps(prev => prev.filter(o => getOpportunityId(o) !== id));
      } else {
          setPrematchOps(prev => prev.filter(o => getOpportunityId(o) !== id));
      }

      try {
          // Enviar ID único (eventId + selection) para descartar solo esta selección específica
          await axios.post('http://localhost:3000/api/opportunities/discard', { id: id });
      } catch (e) {
          console.error("Error discarding opportunity:", e);
          // Si falla, revertimos el blacklist local
          localDiscardedIdsRef.current.delete(id);
          // Opcional: Podríamos hacer forceUpdate() para traerlo de vuelta si el poll aun no ha pasado
      }
  };

  // --- FILTRADO DE DATOS (TIPO FLASHSCORE) ---
  const isSameDay = (d1, d2) => {
    return d1.getDate() === d2.getDate() && 
           d1.getMonth() === d2.getMonth() && 
           d1.getFullYear() === d2.getFullYear();
  };

  const changeDate = (days) => {
      const newDate = new Date(dateFilter);
      newDate.setDate(newDate.getDate() + days);
      setDateFilter(newDate);
  };

  const getFinishedDataForSelectedDate = () => {
        const portfolioHistoryRows = Array.isArray(portfolio?.history) ? portfolio.history : [];
        const remoteHistoryRows = Array.isArray(bookyAccount?.history) ? bookyAccount.history : [];

        const isSettledByTextStatus = (row = {}) => {
            const statusTxt = String(row?.status || '').toUpperCase();
            return statusTxt === 'WON' || statusTxt === 'LOST' || statusTxt === 'VOID';
        };

        const hasProviderMarkers = (row = {}) => Boolean(
            row?.providerBetId ||
            row?.providerSelectionId ||
            row?.providerMarketId ||
            row?.providerAcceptedAt ||
            row?.realPlacement
        );

        const isRemoteLikeRow = (row = {}) => Boolean(
            row?.isBookyHistory ||
            row?.source === 'remote' ||
            (Array.isArray(row?.selections) && row.selections.length > 0)
        );

        if (isSimulatedDisplayMode) {
            const simHistoryData = portfolioHistoryRows
                .filter((h) => {
                    if (!h || typeof h !== 'object') return false;
                    if (hasProviderMarkers(h) || isRemoteLikeRow(h)) return false;

                    const hasSimProfit = Number.isFinite(Number(h?.profit));
                    return isSettledByTextStatus(h) || hasSimProfit;
                })
                .map(h => ({
                    ...h,
                    date: h.matchDate || h.createdAt || h.date || h.closedAt,
                    isFinished: true,
                    isSimulatedHistory: true,
                    finishedProviderOrigin: 'SIM'
                }));

            const pendingFinishData = (portfolio.activeBets || []).filter(b => {
                if (!b || typeof b !== 'object') return false;
                if (isRemoteLikeRow(b)) return false;
                if (hasProviderMarkers(b)) return false;

                if (b.liveTime === 'Final' || b.liveTime === 'FT') return true;

                const betTime = new Date(b.createdAt).getTime();
                const minutesSinceBet = (Date.now() - betTime) / 60000;

                if (b.liveTime) {
                    const lastKnownMinute = parseInt(b.liveTime) || 0;
                    const lastUpdate = new Date(b.lastUpdate || b.createdAt).getTime();
                    const minutesSinceUpdate = (Date.now() - lastUpdate) / 60000;

                    const estimatedCurrentMinute = lastKnownMinute + minutesSinceUpdate;
                    if (estimatedCurrentMinute > 115) return true;
                    if (lastKnownMinute > 85 && minutesSinceUpdate > 15) return true;
                } else {
                    const eventStartTime = new Date(b.matchDate || b.createdAt).getTime();
                    const minutesSinceStart = (Date.now() - eventStartTime) / 60000;
                    if (minutesSinceStart > 140) return true;
                }

                return false;
            }).map(b => ({
                ...b,
                date: b.createdAt,
                manualStatus: 'WAIT_RES',
                finishedProviderOrigin: 'SIM'
            }));

            const allFinished = [...pendingFinishData, ...simHistoryData].sort((a,b) => new Date(b.date) - new Date(a.date));
            return allFinished.filter(op => isSameDay(new Date(op.date), dateFilter));
        }

        // MODO REAL: incluir solo finalizadas reales (portfolio + remotas Booky), excluyendo abiertas actuales.
        const openProviderBetIds = new Set(
            remoteHistoryRows
                .filter(row => isBookyOpenStatus(row?.status))
                .map(row => String(row?.providerBetId || '').trim())
                .filter(Boolean)
        );

        const realHistoryFromPortfolio = portfolioHistoryRows
            .filter((h) => {
                if (!h || typeof h !== 'object') return false;
                if (!hasProviderMarkers(h)) return false;

                const providerStatusSettled = BOOKY_SETTLED_STATUSES.has(Number(h?.providerStatus));
                const settled = isSettledByTextStatus(h) || providerStatusSettled;
                if (!settled) return false;

                const providerId = String(h?.providerBetId || '').trim();
                if (providerId && openProviderBetIds.has(providerId)) return false;
                return true;
            })
            .map((h) => ({
                ...h,
                date: h.closedAt || h.providerAcceptedAt || h.createdAt || h.date || h.matchDate,
                isFinished: true,
                isRealHistory: true,
                finishedProviderOrigin: resolveFinishedProviderOrigin(h)
            }));

        const existingProviderIds = new Set(
            realHistoryFromPortfolio
                .map((row) => String(row?.providerBetId || '').trim())
                .filter(Boolean)
        );

        const realHistoryFromRemote = remoteHistoryRows
            .filter((row) => {
                if (!row || typeof row !== 'object') return false;
                if (isBookyOpenStatus(row?.status)) return false;

                const settledByProvider = BOOKY_SETTLED_STATUSES.has(Number(row?.status));
                const finishedByClock = isBookyMatchFinished(row);
                if (!settledByProvider && !finishedByClock) return false;

                const providerId = String(row?.providerBetId || '').trim();
                if (providerId && existingProviderIds.has(providerId)) return false;
                return true;
            })
            .map((row, idx) => ({
                ...row,
                id: row?.id || `booky_finished_${row?.providerBetId || idx}`,
                isBookyHistory: true,
                isFinished: true,
                isRealHistory: true,
                date: row?.settledAt || row?.closedAt || row?.placedAt || resolveBookyEventStartIso(row) || row?.date || row?.createdAt,
                finishedProviderOrigin: 'BOOKY'
            }));

        const allRealFinished = [...realHistoryFromPortfolio, ...realHistoryFromRemote]
            .sort((a,b) => new Date(b.date) - new Date(a.date));

        const scoreFallbackByEventOrMatch = new Map();
        allRealFinished.forEach((row) => {
            const score = resolveBestScoreText(row);
            if (!score) return;
            const eventKey = row?.eventId ? `event:${String(row.eventId).trim()}` : null;
            const matchKey = row?.match ? `match:${String(row.match).trim().toLowerCase()}` : null;
            if (eventKey && !scoreFallbackByEventOrMatch.has(eventKey)) scoreFallbackByEventOrMatch.set(eventKey, score);
            if (matchKey && !scoreFallbackByEventOrMatch.has(matchKey)) scoreFallbackByEventOrMatch.set(matchKey, score);
        });

        const allRealFinishedHydrated = allRealFinished.map((row) => {
            const ownScore = resolveBestScoreText(row);
            if (ownScore) return row;
            const eventKey = row?.eventId ? `event:${String(row.eventId).trim()}` : null;
            const matchKey = row?.match ? `match:${String(row.match).trim().toLowerCase()}` : null;
            const fallbackScore =
                (eventKey ? scoreFallbackByEventOrMatch.get(eventKey) : null) ||
                (matchKey ? scoreFallbackByEventOrMatch.get(matchKey) : null) ||
                null;
            if (!fallbackScore) return row;
            return {
                ...row,
                finalScore: row?.finalScore || fallbackScore,
                lastKnownScore: row?.lastKnownScore || fallbackScore,
                finishedProviderOrigin: normalizeFinishedProviderFilter(row?.finishedProviderOrigin || resolveFinishedProviderOrigin(row))
            };
        });

        const allRealFinishedNormalized = allRealFinishedHydrated.map((row) => ({
            ...row,
            finishedProviderOrigin: normalizeFinishedProviderFilter(row?.finishedProviderOrigin || resolveFinishedProviderOrigin(row))
        }));

        return allRealFinishedNormalized.filter(op => isSameDay(new Date(op.date), dateFilter));
  };

  const getOpenBookyRemoteBets = () => {
        const remoteRows = Array.isArray(bookyAccount?.history) ? bookyAccount.history : [];
        remoteRows.forEach(rememberStickyPinnacleReference);

        const activeByProviderBetId = new Map(
            (Array.isArray(portfolio?.activeBets) ? portfolio.activeBets : [])
                .filter(row => row && row.providerBetId)
                .map(row => [String(row.providerBetId), row])
        );

        const historyByProviderBetId = new Map(
            (Array.isArray(portfolio?.history) ? portfolio.history : [])
                .filter(row => row && row.providerBetId)
                .map(row => [String(row.providerBetId), row])
        );

        return remoteRows
            .filter(row => isBookyOpenStatus(row?.status))
            .map((row, idx) => {
                const rawSelection = row?.raw?.selections?.[0] || null;
                const gameTime = rawSelection?.gameTime || null;
                const eventScore = rawSelection?.eventScore || null;
                const eventDate = row?.selections?.[0]?.eventDate || rawSelection?.eventDate || null;
                const odd = Number(row?.odd);
                const stake = Number(row?.stake);
                const providerBetId = row?.providerBetId || null;
                const providerKey = providerBetId !== null && providerBetId !== undefined ? String(providerBetId) : null;
                const linkedActive = providerKey ? (activeByProviderBetId.get(providerKey) || null) : null;
                const linkedHistory = providerKey ? (historyByProviderBetId.get(providerKey) || null) : null;
                const linked = linkedActive || linkedHistory || null;
                const sticky = getStickyPinnacleReference({
                    ...row,
                    pick: row?.pick || resolveBookySelectionTypePick(row) || linked?.pick || null,
                    providerBetId,
                    eventId: row?.eventId || linked?.eventId || null
                });
                const pick = row?.pick || resolveBookySelectionTypePick(row) || linked?.pick || null;
                const evRaw = Number(row?.ev ?? linked?.ev ?? linked?.realPlacement?.ev ?? linked?.opportunity?.ev);
                const realProbRaw = Number(row?.realProb ?? linked?.realProb ?? linked?.opportunity?.realProb);
                const kellyStakeRaw = Number(row?.kellyStake ?? linked?.kellyStake ?? linked?.stake ?? stake);
                const pinnacleInfo = mergePinnacleInfoCandidates(row?.pinnacleInfo, linked?.pinnacleInfo, sticky?.pinnacleInfo);
                const rowType = String(row?.type || row?.strategy || row?.opportunityType || linked?.type || '').toUpperCase();
                const allowPrematchReferenceFallback = rowType.includes('PREMATCH');
                const derivedPinnacleReference = derivePinnacleReferencePrice({
                    pinnacleInfo,
                    pick,
                    market: row?.market || linked?.market || null,
                    selection: row?.selection || linked?.selection || null
                });
                const pinnaclePriceCandidate = Number(
                    row?.pinnaclePrice ??
                    linked?.pinnaclePrice ??
                    linked?.realPlacement?.requested?.odd ??
                    sticky?.pinnaclePrice ??
                    (allowPrematchReferenceFallback ? derivedPinnacleReference : null)
                );
                const pinnaclePriceNormalized = sanitizePinnaclePriceForOrigin({
                    price: pinnaclePriceCandidate,
                    pinnacleInfo,
                    isPrematchOrigin: allowPrematchReferenceFallback
                });
                return {
                    id: providerBetId ? `booky_open_${providerBetId}` : `booky_open_${idx}`,
                    providerBetId,
                    eventId: row?.eventId || null,
                    match: row?.match || '-',
                    league: row?.league || '-',
                    market: row?.market || '-',
                    selection: row?.selection || '-',
                    pick,
                    type: String(row?.type || row?.strategy || row?.opportunityType || 'BOOKY_REAL').toUpperCase(),
                    odd: Number.isFinite(odd) ? odd : null,
                    price: Number.isFinite(odd) ? odd : null,
                    stake: Number.isFinite(stake) ? stake : null,
                    kellyStake: Number.isFinite(kellyStakeRaw) ? kellyStakeRaw : (Number.isFinite(stake) ? stake : null),
                    ev: Number.isFinite(evRaw) ? evRaw : null,
                    realProb: Number.isFinite(realProbRaw) ? realProbRaw : null,
                    pinnacleInfo,
                    pinnaclePrice: pinnaclePriceNormalized,
                    date: row?.placedAt || eventDate || new Date().toISOString(),
                    matchDate: eventDate || row?.placedAt || null,
                    liveTime: gameTime,
                    time: gameTime,
                    score: eventScore,
                    lastKnownScore: eventScore,
                    isActiveBet: true,
                    isBookyRemoteOpen: true
                };
            });
  };

  const getFilteredData = () => {
    let data = [];
    
    if (activeTab === 'LIVE') {
        // 1. Oportunidades detectadas (Scanner)
        const ops = [...liveOps].filter(hasMinBookyStake);

        // 2. Apuestas EN JUEGO (Portfolio Active Bets)
        // Queremos mostrar aquí las apuestas que ya hicimos pero cuyo partido se está jugando.
        const activePlayingBets = (portfolio.activeBets || []).filter(bet => {
            const isLiveOrigin = bet.type === 'LIVE_SNIPE' || bet.type === 'LIVE_VALUE' || bet.type === 'LA_VOLTEADA' || bet.isLive;
            const isInPlayNow = isEventInPlayNow(bet);
            if (!isLiveOrigin && !isInPlayNow) return false;

            // a. Evitar duplicados visuales si el scanner también lo está viendo (aunque el scanner suele ocultar activeBets)
            if (ops.some(o => String(o.eventId) === String(bet.eventId))) return false;

            // b. Solo mostrar si el partido "parece" estar en vivo
            // Criterio: Tiene liveTime valido O la fecha de inicio ya pasó (y no hace 5 horas)
            const hasLiveTime = bet.liveTime && bet.liveTime !== 'Final' && bet.liveTime !== 'HT'; 
            // Nota: HT lo incluimos en Live. 'Final' no.
            
            const startDate = new Date(bet.matchDate || bet.date || bet.createdAt);
            const now = new Date();
            const minutesSinceStart = (now - startDate) / 60000;
            
            // Es Live si: (Tiene tiempo de juego explícito) O (Ya empezó hace 0-130 mins)
            const isLiveByTime = (minutesSinceStart > 0 && minutesSinceStart < 130);
            
            // Si ya determinamos que es "pending finish" (WAIT_RES) en la logica de abajo, NO mostrar aqui.
            // Para simplificar, asumimos que si está en rango 0-130 mins es Live.
            // La logica de FINISHED usa > 105 mins estricto o > 140 mins. Hay un pequeño solapamiento seguro.
            
            // [FIX] Consider matches that are technically '90+' as LIVE until backend settles them
            const isLateGame = (bet.liveTime && bet.liveTime !== 'Final' && bet.liveTime !== 'HT');
            
            return (bet.liveTime && bet.liveTime !== 'Final') || isLiveByTime || isLateGame;
        }).map(bet => ({
            ...bet,
            isActiveBet: true, // Propiedad para distingir visualmente si queremos
             // [FIX] Mapear propiedades para consistencia de UI en pestaña LIVE
            time: bet.liveTime,
            score: bet.lastKnownScore,
            date: bet.matchDate || bet.date,
            // [NEW] Ensure badges persist
            pinnacleInfo: bet.pinnacleInfo 
        }));

        const openBookyLiveBets = getOpenBookyRemoteBets().filter(bet => {
            const isLiveOrigin = isLiveOriginOpportunity(bet);
            const isInPlayNow = isEventInPlayNow(bet);
            return isLiveOrigin || isInPlayNow;
        }).filter(bet => {
            const byProvider = String(bet.providerBetId || '');
            const duplicateInPortfolio = activePlayingBets.some(a => String(a.providerBetId || '') === byProvider && byProvider);
            const betOppKey = getOpportunityId(bet);
            const duplicateInOps = betOppKey
                ? ops.some(o => getOpportunityId(o) === betOppKey)
                : false;
            return !duplicateInPortfolio && !duplicateInOps;
        });

        return [...ops, ...activePlayingBets, ...openBookyLiveBets].sort((a,b) => {
             // Ordenar: primero los minutos más altos (final del partido) para ver desenlaces
             const timeA = parseInt((a.time || a.liveTime || "0").replace("'", "")) || 0;
             const timeB = parseInt((b.time || b.liveTime || "0").replace("'", "")) || 0;
             return timeB - timeA;
        });

    } else if (activeTab === 'ARBITRAGE') {
        return [];
    } else if (activeTab === 'FINISHED') {
        const rows = getFinishedDataForSelectedDate();
        const activeProviderFilter = normalizeFinishedProviderFilter(finishedProviderFilter);
        if (activeProviderFilter === 'ALL') return rows;
        return rows.filter((row) => normalizeFinishedProviderFilter(resolveFinishedProviderOrigin(row)) === activeProviderFilter);
    } else if (activeTab === 'MATCHER' || activeTab === 'MONITOR') {
        // Tab especial Manual Matcher / Monitor: No usamos filteredData, renderizaremos componente dedicado
        return [];
    } else {
        // TAB: ALL o PRÓXIMOS
        // Comportamiento Flashscore: Mostrar Live + Prematch del día seleccionado
        
        // 1. Si es HOY, NO incluimos liveOps para separar estrictamente
        // if (isSameDay(dateFilter, new Date())) {
        //    data = [...liveOps];
        // }

        // 2. Filtrar Pre-Match por fecha seleccionada Y eliminar duplicados que ya estén en Live
        const liveOpportunityKeys = new Set(
            liveOps
                .map(op => getOpportunityId(op))
                .filter(Boolean)
        );

        const dayPrematch = prematchOps.filter(op => {
               if (isLiveOriginOpportunity(op)) return false;
                        if (!hasMinBookyStake(op)) return false;
             if (!isSameDay(new Date(op.date), dateFilter)) return false;

             // Evitar duplicados por selección exacta (eventId + pick),
             // permitiendo que convivan apuestas distintas del mismo partido.
             const opKey = getOpportunityId(op);
             return !liveOpportunityKeys.has(opKey);
        });
        
        // 3. [FIX] Inyectar APUESTAS ACTIVAS (Active Bets) que ya no están en scanners
        // Esto resuelve que las apuestas desaparezcan cuando empieza el partido
           const dayActiveBets = portfolio.activeBets.filter(bet => {
               // En PREMATCH solo deben quedar apuestas aun no iniciadas.
             const isLiveOrigin = bet.type === 'LIVE_SNIPE' || bet.type === 'LIVE_VALUE' || bet.type === 'LA_VOLTEADA' || bet.isLive;
             if (isLiveOrigin) return false;
               if (isEventInPlayNow(bet)) return false;

             // a) Filtrar por fecha
             if (!bet.matchDate) return false; // si no tiene fecha, skip
             if (!isSameDay(new Date(bet.matchDate), dateFilter)) return false;

             // b) Evitar duplicados (si ya está en liveOps o dayPrematch)
               const betKey = getOpportunityId(bet);
               const existsInLive = liveOpportunityKeys.has(betKey);
               const existsInPrematch = dayPrematch.some(op => getOpportunityId(op) === betKey);
             
             return !existsInLive && !existsInPrematch;
        }).map(bet => ({
            ...bet,
            date: bet.matchDate, // Normalizar date key
            kellyStake: bet.stake, // Normalizar stake visual
            ev: 0, // No recalculamos EV en runtime para bets viejas
            manualStatus: 'ACTIVE_INJECTED',
            isActiveBet: true, // [FIX] Marcar visualmente como apuesta activa
            time: bet.liveTime,
            score: bet.lastKnownScore
        }));

        const dayBookyOpenBets = getOpenBookyRemoteBets().filter(bet => {
                         const timingOrigin = resolvePlacementTimingOrigin(bet);

                 // Si ya esta en juego, va a LIVE (no duplicar en PREMATCH).
                 if (isEventInPlayNow(bet)) return false;

                         // Mantener en PREMATCH las apuestas colocadas antes del inicio,
                         // aunque el feed remoto luego reporte gameTime/isLive.
                         if (timingOrigin.inferredLiveByTiming) return false;

                         if (!timingOrigin.inferredPrematchByTiming && isLiveOriginOpportunity(bet)) return false;

             const baseDate = bet.matchDate || bet.date;
             if (!baseDate) return false;
             if (!isSameDay(new Date(baseDate), dateFilter)) return false;

               const betKey = getOpportunityId(bet);
               const existsInLive = liveOpportunityKeys.has(betKey);
               const existsInPrematch = dayPrematch.some(op => getOpportunityId(op) === betKey);
             const existsInActive = dayActiveBets.some(op => String(op.providerBetId || '') === String(bet.providerBetId || '') && bet.providerBetId);
             return !existsInLive && !existsInPrematch && !existsInActive;
        });

        data = [...data, ...dayPrematch, ...dayActiveBets, ...dayBookyOpenBets];
        
        // Ordenar por hora
        data.sort((a,b) => new Date(a.date) - new Date(b.date));

        return data;
    }
  };

    const filteredOps = getFilteredData();
    const arbitrageStakeContext = resolveArbitrageStakeContext();
    const finishedRowsForDate = getFinishedDataForSelectedDate();
    const finishedTabCount = finishedRowsForDate.length;
    const finishedProviderCounts = finishedRowsForDate.reduce((acc, row) => {
        const key = normalizeFinishedProviderFilter(resolveFinishedProviderOrigin(row));
        acc.ALL += 1;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, { ALL: 0, BOOKY: 0, PINNACLE: 0, SIM: 0 });
    const finishedFilteredCount = activeTab === 'FINISHED' ? filteredOps.length : finishedTabCount;
    const bookyHistoryRows = Array.isArray(bookyAccount?.history) ? bookyAccount.history : [];
    const bookyEventStartIsoByProvider = new Map();
    for (const row of bookyHistoryRows) {
        const providerBetId = row?.providerBetId;
        const providerKey = providerBetId !== null && providerBetId !== undefined && String(providerBetId).trim() !== ''
            ? String(providerBetId).trim()
            : null;
        if (!providerKey || bookyEventStartIsoByProvider.has(providerKey)) continue;

        const startIso = resolveBookyEventStartIso(row) || resolveOpEventStartIso(row);
        if (startIso) bookyEventStartIsoByProvider.set(providerKey, startIso);
    }

    const remoteOpenBookyRows = bookyHistoryRows
        .filter(row => isBookyOpenStatus(row?.status));

    const remoteOpenBookyByKey = new Map();
    const remoteOpenBookyByProvider = new Map();
    const remoteOpenBookyIds = new Set();
    for (const row of remoteOpenBookyRows) {
        const key = getBookyOpenBetKey(row);
        const providerBetId = row?.providerBetId;
        const providerKey = providerBetId !== null && providerBetId !== undefined && String(providerBetId).trim() !== ''
            ? String(providerBetId).trim()
            : null;

        if (providerKey && !remoteOpenBookyByProvider.has(providerKey)) {
            remoteOpenBookyByProvider.set(providerKey, row);
        }

        if (key) {
            remoteOpenBookyIds.add(key);
            if (!remoteOpenBookyByKey.has(key)) {
                remoteOpenBookyByKey.set(key, row);
            }
        }
    }

    const remoteOpenBookyEventIds = new Set(
        remoteOpenBookyRows
            .map(getBookyOpenEventId)
            .filter(Boolean)
    );

    const entryOrderByTicketId = new Map();
    {
        const groups = new Map();
        for (const row of filteredOps) {
            const ticketId = resolveOpTicketId(row);
            if (!ticketId) continue;
            const key = getOpportunityId(row);
            if (!key) continue;

            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }

        for (const [, list] of groups.entries()) {
            list.sort((a, b) => {
                const aTs = new Date(resolveOpBetTimeIso(a, a) || 0).getTime();
                const bTs = new Date(resolveOpBetTimeIso(b, b) || 0).getTime();
                return aTs - bTs;
            });

            list.forEach((row, idx) => {
                const ticketId = resolveOpTicketId(row);
                if (!ticketId) return;
                entryOrderByTicketId.set(String(ticketId), {
                    index: idx + 1,
                    total: list.length
                });
            });
        }
    }

    const finishedSubtotal = activeTab === 'FINISHED'
        ? filteredOps.reduce((acc, op) => acc + resolveFinishedOpPnl(op), 0)
        : 0;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6 font-sans text-sm">
      
      {/* --- HEADER --- */}
      <header className="max-w-7xl mx-auto mb-8">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between border-b border-slate-700 pb-5 gap-4">
            
            {/* LOGO */}
            <div className="flex items-center gap-3 shrink-0">
                <div className="bg-emerald-500/10 p-2 rounded-xl border border-emerald-500/20">
                    <Trophy className="w-8 h-8 text-emerald-400" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white leading-none mb-1">BetSniper <span className="text-emerald-400">Pro</span></h1>
                    <p className="text-slate-400 text-[11px] uppercase tracking-widest font-semibold">Trading System</p>
                </div>
            </div>

            {/* DASHBOARD CARDS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full xl:w-auto flex-1 xl:max-w-4xl">
                
                {/* 1. CAPITAL & PNL */}
                <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700 flex flex-col justify-between">
                    <div className="flex justify-between items-start mb-2">
                        <div>
                            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-0.5">Capital</p>
                            <p className="text-lg font-mono font-bold text-white flex items-center leading-none">
                                <span className="text-sm text-slate-500 mr-1">{headerCapitalCurrency}</span>
                                {Number.isFinite(headerCapitalAmount) ? headerCapitalAmount.toFixed(2) : '--'}
                            </p>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-0.5">{headerPnlLabel}</p>
                            <p className={`text-base font-mono font-bold flex items-center justify-end leading-none ${headerPnlClass}`}>
                                {headerPnlAmount >= 0 ? '+' : ''}{headerPnlAmount.toFixed(2)}
                            </p>
                        </div>
                    </div>
                    <div className="mb-2 text-[9px] text-slate-500 uppercase tracking-wide font-semibold">
                        {headerBalanceSourceLabel}
                    </div>
                    {/* Botones Acciones Rápidas */}
                    <div className="flex gap-1.5 pt-2 border-t border-slate-700/50 justify-end mt-auto">
                        <button onClick={playAlert} className="p-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-amber-400 transition-colors" title="Probar Sonido"><Volume2 className="w-4 h-4" /></button>
                        <button onClick={() => fetchData({ forceBookyRefresh: true })} className="p-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors" title="Actualizar Datos"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-emerald-400' : ''}`} /></button>
                        <button onClick={resetPortfolio} className="p-1.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-red-400 transition-colors" title="Resetear Simulación"><RotateCcw className="w-4 h-4" /></button>
                    </div>
                </div>

                {/* 2. KELLY DIAGNOSTICO */}
                <div className="bg-slate-800/60 p-3 rounded-xl border border-slate-700 flex flex-col justify-between">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
                            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">Kelly Risk</span>
                        </div>
                        <span className="text-[9px] font-mono text-slate-500 bg-slate-900/50 px-1.5 py-0.5 rounded">
                            {kellyDiagTime ? formatTimeSafe(kellyDiagTime) : '--:--'}
                        </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mt-auto">
                        <div className="flex justify-between border-b border-slate-700/30 pb-0.5">
                            <span className="text-slate-500">Base</span>
                            <span className="text-slate-200 font-mono font-medium">{Number.isFinite(kellyBaseAmount) ? kellyBaseAmount.toFixed(0) : '--'}</span>
                        </div>
                        <div className="flex justify-between border-b border-slate-700/30 pb-0.5">
                            <span className="text-slate-500">Press</span>
                            <span className="text-slate-200 font-mono font-medium">{Number.isFinite(kellyExposurePressurePct) ? `${(kellyExposurePressurePct * 100).toFixed(1)}%` : '--'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-slate-500">Ruin P</span>
                            <span className="text-amber-400/90 font-mono font-medium">{Number.isFinite(kellyPrematchRuin) ? `${(kellyPrematchRuin * 100).toFixed(1)}%` : '--'}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-slate-500">Ruin L</span>
                            <span className="text-amber-400/90 font-mono font-medium">{Number.isFinite(kellyLiveRuin) ? `${(kellyLiveRuin * 100).toFixed(1)}%` : '--'}</span>
                        </div>
                    </div>
                </div>

                {/* 3. TOKEN STATUS */}
                <div className={`p-3 rounded-xl border flex flex-col justify-between ${tokenHealthy ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                            <span className="relative flex h-2 w-2">
                                {!tokenHealthy && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>}
                                <span className={`relative inline-flex rounded-full h-2 w-2 ${tokenHealthy ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.8)]'}`}></span>
                            </span>
                            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-200">System Link</span>
                        </div>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${tokenProfile === 'acity' ? 'bg-blue-500/20 text-blue-300' : tokenProfile === 'doradobet' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
                            {tokenProfile ? tokenProfile : 'N/A'}
                        </span>
                    </div>
                    
                    <div className="flex justify-between items-end mt-auto">
                        <div className="flex flex-col">
                            <div className="text-[10px] text-slate-400 uppercase font-semibold mb-0.5">Time Left</div>
                            <div className={`text-xl font-mono font-bold leading-none ${tokenHealthy ? 'text-emerald-400' : 'text-amber-400'}`}>
                                {Number.isFinite(tokenRemainingMinutes) ? tokenRemainingMinutes.toFixed(1) : '--'} <span className="text-[10px] font-sans text-slate-500 font-normal">min</span>
                            </div>
                            {tokenRenewing && (
                                <div className="mt-1 text-[9px] font-bold uppercase tracking-wide text-blue-300 bg-blue-500/15 border border-blue-400/25 rounded px-1.5 py-0.5 w-fit">
                                    Renovando...
                                </div>
                            )}
                            {!tokenRenewing && tokenNearAutoRenewWindow && silentRenewCooldownActive && (
                                <div className="mt-1 text-[9px] font-bold uppercase tracking-wide text-amber-300 bg-amber-500/15 border border-amber-400/25 rounded px-1.5 py-0.5 w-fit">
                                    Renovacion en espera ({silentRenewCooldownRemainingSec}s)
                                </div>
                            )}
                        </div>
                        {!tokenHealthy && (
                            <button
                                onClick={handleTokenRenewGuide}
                                disabled={tokenRenewing}
                                className={`px-2.5 py-1.5 rounded bg-slate-900/50 border text-[10px] font-bold uppercase tracking-wide transition-all ${tokenRenewing ? 'border-amber-500/30 text-amber-500/50 cursor-not-allowed' : 'border-amber-500/50 text-amber-400 hover:bg-amber-500/20 hover:border-amber-400'}`}
                            >
                                {tokenRenewing ? 'Wait...' : 'Renovar'}
                            </button>
                        )}
                    </div>

                    <div className="mt-2 pt-2 border-t border-slate-700/50 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-col">
                            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Auto Placement</span>
                            <span className="text-[9px] text-slate-500">Cambio en caliente (scanner live)</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                            <select
                                value={autoPlacementProvider}
                                onChange={(e) => handleAutoPlacementProviderChange(e.target.value)}
                                disabled={autoPlacementProviderLoading || autoPlacementProviderSaving}
                                className="min-w-24 bg-slate-900/70 border border-slate-600 text-slate-100 text-[10px] font-bold uppercase rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-60"
                            >
                                {autoPlacementProviderOptions.map((provider) => (
                                    <option key={provider} value={provider}>
                                        {String(provider).toUpperCase()}
                                    </option>
                                ))}
                            </select>
                            <button
                                onClick={autoPlacementProvider === 'pinnacle' ? handleManualPinnacleHistorySync : undefined}
                                onMouseEnter={() => {
                                    if (autoPlacementProvider === 'pinnacle' && !pinnacleHistorySyncing) {
                                        setPinnacleSyncButtonHover(true);
                                    }
                                }}
                                onMouseLeave={() => setPinnacleSyncButtonHover(false)}
                                onFocus={() => {
                                    if (autoPlacementProvider === 'pinnacle' && !pinnacleHistorySyncing) {
                                        setPinnacleSyncButtonHover(true);
                                    }
                                }}
                                onBlur={() => setPinnacleSyncButtonHover(false)}
                                disabled={autoPlacementProviderSaving || (autoPlacementProvider === 'pinnacle' ? pinnacleHistorySyncing : true)}
                                className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border whitespace-nowrap transition-colors ${autoPlacementProvider === 'pinnacle' ? 'cursor-pointer disabled:opacity-70' : 'cursor-not-allowed opacity-90'} ${autoPlacementProviderBadgeClass}`}
                                title={autoPlacementProvider === 'pinnacle'
                                    ? 'Sincronizar historial remoto de Pinnacle y reconciliarlo al portfolio local'
                                    : 'Selecciona PINNACLE para habilitar sync manual'}
                            >
                                {autoPlacementProviderSaving
                                    ? 'Aplicando'
                                    : (autoPlacementProvider === 'pinnacle' && pinnacleHistorySyncing
                                        ? 'SYNC...'
                                        : (autoPlacementProvider === 'pinnacle'
                                            ? (pinnacleSyncButtonHover ? 'SYNC PINNACLE' : 'PINNACLE')
                                            : autoPlacementProviderLabel))}
                            </button>
                        </div>
                    </div>
                    {autoPlacementProvider === 'pinnacle' && (
                        <div className="mt-1 text-[9px] text-blue-300/90 font-mono">
                            {pinnacleHistorySyncMeta?.error
                                ? `Sync error: ${pinnacleHistorySyncMeta.error}`
                                : (pinnacleHistorySyncMeta?.fetchedAt
                                    ? `Ult sync ${formatTimeSafe(pinnacleHistorySyncMeta.fetchedAt)} | remotas ${Number(pinnacleHistorySyncMeta.totalCount || 0)} | tocadas ${Number(pinnacleHistorySyncMeta.touchedCount || 0)}`
                                    : `Sync manual disponible (${PINNACLE_HISTORY_SYNC_DAYS}d)`)}
                        </div>
                    )}
                </div>

            </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto space-y-6">
        
        {/* PANEL PRINCIPAL UNIFICADO */}
        <div className="space-y-0">
            
            {/* 1. TABS DE NAVEGACIÓN (ALL | LIVE | FINISHED) */}
            <div className="flex bg-slate-800 rounded-t-xl border-b border-slate-700 overflow-hidden">
                <button 
                    onClick={() => setActiveTab('ALL')}
                    className={`flex-1 py-4 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${activeTab === 'ALL' ? 'bg-slate-700 text-white border-b-2 border-emerald-500' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-750'}`}
                >
                    <Layers className="w-4 h-4" />
                    Prematch <span className="text-[10px] bg-slate-900 px-1.5 rounded-full text-slate-400" title="Oportunidades Pre-Match">{prematchOps.length}</span>
                </button>
                <button 
                    onClick={() => setActiveTab('ARBITRAGE')}
                    className={`flex-1 py-4 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${activeTab === 'ARBITRAGE' ? 'bg-slate-700 text-amber-400 border-b-2 border-amber-500' : 'text-slate-500 hover:text-amber-300 hover:bg-slate-750'}`}
                >
                    <TrendingUp className="w-4 h-4" />
                    Arbitraje <span className="text-[10px] bg-slate-900 px-1.5 rounded-full text-slate-400">{arbitrageOps.length}</span>
                </button>
                <button 
                    onClick={() => setActiveTab('LIVE')}
                    className={`flex-1 py-4 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${activeTab === 'LIVE' ? 'bg-slate-700 text-red-500 border-b-2 border-red-500' : 'text-slate-500 hover:text-red-400 hover:bg-slate-750'}`}
                >
                    <Zap className={`w-4 h-4 ${activeTab === 'LIVE' || liveOps.length > 0 ? 'fill-current' : ''}`} /> 
                    EN VIVO <span className="text-[10px] bg-slate-900 px-1.5 rounded-full text-slate-400">{liveOps.length}</span>
                </button>
                <button 
                    onClick={() => setActiveTab('FINISHED')}
                    className={`flex-1 py-4 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${activeTab === 'FINISHED' ? 'bg-slate-700 text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-500 hover:text-emerald-300 hover:bg-slate-750'}`}
                >
                    <Archive className="w-4 h-4" />
                    Finalizados <span className="text-[10px] bg-slate-900 px-1.5 rounded-full text-slate-400">{finishedTabCount}</span>
                </button>
                <button 
                    onClick={() => setActiveTab('MATCHER')}
                    className={`flex-1 py-4 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${activeTab === 'MATCHER' ? 'bg-slate-700 text-blue-400 border-b-2 border-blue-500' : 'text-slate-500 hover:text-blue-300 hover:bg-slate-750'}`}
                >
                    <LinkIcon className="w-4 h-4" /> Matcher
                </button>
                <button 
                    onClick={() => setActiveTab('MONITOR')}
                    className={`flex-1 py-4 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors ${activeTab === 'MONITOR' ? 'bg-slate-700 text-purple-400 border-b-2 border-purple-500' : 'text-slate-500 hover:text-purple-300 hover:bg-slate-750'}`}
                >
                    <Activity className="w-4 h-4" /> Monitor
                </button>
            </div>

            {/* 2. DATE FILTER BAR (Solo visible si no es FINISHED/LIVE puro) */}
            {(activeTab === 'ALL' || activeTab === 'FINISHED') && (
                <div className="bg-slate-800 border-b border-slate-700 p-2 flex justify-between items-center select-none">
                    <button onClick={() => changeDate(-1)} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors">
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
                        <Calendar className="w-4 h-4 text-emerald-500" />
                        <span className="uppercase tracking-wide">
                            {isSameDay(dateFilter, new Date()) ? 'HOY' : 
                             isSameDay(dateFilter, new Date(Date.now() + 86400000)) ? 'MAÑANA' : 
                             dateFilter.toLocaleDateString('es-ES', {weekday: 'short', day: 'numeric', month: 'long'})}
                        </span>
                        <span className="text-slate-500 font-normal text-xs ml-2">
                             {dateFilter.toLocaleDateString('es-ES')}
                        </span>
                    </div>

                    <button onClick={() => changeDate(1)} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors">
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            )}

            {activeTab === 'FINISHED' && (
                <div className="bg-slate-800 border-b border-slate-700 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                    {!isSimulatedDisplayMode ? (
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Vista selección</span>
                            <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
                                <button
                                    onClick={() => setFinishedSelectionView('HYBRID')}
                                    className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${finishedSelectionView === 'HYBRID' ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/70'}`}
                                    title="Texto Booky + hint canónico"
                                >
                                    Híbrida
                                </button>
                                <button
                                    onClick={() => setFinishedSelectionView('BOOKY')}
                                    className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors border-l border-slate-700 ${finishedSelectionView === 'BOOKY' ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/70'}`}
                                    title="Mostrar texto original de Booky"
                                >
                                    Booky
                                </button>
                                <button
                                    onClick={() => setFinishedSelectionView('CANONICAL')}
                                    className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors border-l border-slate-700 ${finishedSelectionView === 'CANONICAL' ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/70'}`}
                                    title="Mostrar selección normalizada"
                                >
                                    Canónica
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Finalizados simulados</div>
                    )}

                    <div className="flex items-center gap-2 ml-auto">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Proveedor</span>
                        <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
                            {FINISHED_PROVIDER_FILTER_ALLOWED.map((providerKey, idx) => {
                                const normalizedKey = normalizeFinishedProviderFilter(providerKey);
                                const isActive = finishedProviderFilter === normalizedKey;
                                const count = Number(finishedProviderCounts?.[normalizedKey] || 0);
                                return (
                                    <button
                                        key={providerKey}
                                        onClick={() => setFinishedProviderFilter(normalizedKey)}
                                        className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${idx > 0 ? 'border-l border-slate-700' : ''} ${isActive ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/70'}`}
                                        title={`Filtrar finalizados por ${FINISHED_PROVIDER_FILTER_LABELS[normalizedKey] || normalizedKey}`}
                                    >
                                        <span>{FINISHED_PROVIDER_FILTER_LABELS[normalizedKey] || normalizedKey}</span>
                                        <span className={`ml-1 font-mono ${isActive ? 'text-slate-200' : 'text-slate-500'}`}>{count}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono">{finishedFilteredCount}/{finishedTabCount}</span>
                    </div>
                </div>
            )}

            {/* 3. CONTENIDO PRINCIPAL */}
            <section className="bg-slate-800 rounded-b-xl border border-slate-700 border-t-0 overflow-hidden shadow-lg min-h-100">
                
                {/* SI ESTAMOS EN MATCHER, RENDERIZAR COMPONENTE ESPECIAL */}
                {activeTab === 'MATCHER' ? (
                     <ManualMatcher />
                ) : activeTab === 'MONITOR' ? (
                     <MonitorDashboard />
                ) : activeTab === 'ARBITRAGE' ? (
                    <div className="p-4 space-y-4">
                        <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                            <div className="space-y-1">
                                <div className="text-[11px] uppercase tracking-wider font-bold text-amber-300">Preview Arbitraje</div>
                                <div className="text-[10px] text-slate-400">
                                    {arbitrageMeta?.generatedAt
                                        ? `Snapshot: ${formatTimeSafe(arbitrageMeta.generatedAt)} | Source: ${arbitrageMeta.source || 'n/a'}`
                                        : 'Sin snapshot reciente'}
                                </div>
                                <div className="text-[10px] text-slate-500">
                                    {`Total ${Number(arbitrageMeta?.count || arbitrageOps.length || 0)} | 1x2 ${Number(arbitrageMeta?.diagnostics?.generatedByType?.surebet1x2 || 0)} | DC+Opuesto ${Number(arbitrageMeta?.diagnostics?.generatedByType?.surebetDcOpposite || 0)} | Filtradas riesgo ${Number(arbitrageMeta?.diagnostics?.filteredByRisk || 0)}`}
                                </div>
                                <div className="text-[10px] text-slate-500">
                                    {`Stake ticket: S/. ${Number(arbitrageMeta?.risk?.stakeBankroll ?? arbitrageStakeContext.stakeBankroll ?? 0).toFixed(2)} | ROI mín: ${Number(arbitrageMeta?.risk?.minRoiPercent ?? arbitrageStakeContext.minRoiPercent ?? 0).toFixed(2)}% | Profit mín: S/. ${Number(arbitrageMeta?.risk?.minProfitAbs ?? arbitrageStakeContext.minProfitAbs ?? 0).toFixed(2)}`}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
                                    <button
                                        onClick={() => setArbitrageView('PREMATCH')}
                                        className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${arbitrageView === 'PREMATCH' ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/70'}`}
                                    >
                                        Prematch
                                    </button>
                                    <button
                                        onClick={() => setArbitrageView('LIVE')}
                                        className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wide border-l border-slate-700 transition-colors ${arbitrageView === 'LIVE' ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/70'}`}
                                    >
                                        Live (prox)
                                    </button>
                                </div>
                                <button
                                    onClick={() => refreshArbitrageWithPrematch()}
                                    disabled={arbitrageRefreshState.running}
                                    className={`px-2.5 py-1.5 rounded border text-[10px] font-bold uppercase tracking-wide transition-colors ${arbitrageRefreshState.running
                                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-200/80 cursor-not-allowed'
                                        : 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-200'}`}
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        <RefreshCw className={`w-3 h-3 ${arbitrageRefreshState.running ? 'animate-spin' : ''}`} />
                                        {arbitrageRefreshState.running
                                            ? (arbitrageRefreshState.phase === 'prematch' ? 'Refrescando Prematch...' : 'Calculando Arbitraje...')
                                            : 'Refresh'}
                                    </span>
                                </button>
                            </div>
                        </div>

                        <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 space-y-2">
                            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-300">Gestion Monetaria Conservadora (Fase 1)</div>
                            <div className="flex flex-wrap items-center gap-2">
                                {Object.entries(ARBITRAGE_RISK_PROFILE_PRESETS).map(([profileKey, profile]) => (
                                    <button
                                        key={profileKey}
                                        onClick={() => applyArbitrageRiskProfile(profileKey)}
                                        className={`px-2.5 py-1 rounded border text-[10px] font-bold uppercase tracking-wide transition-colors ${arbitrageRiskProfileKey === profileKey
                                            ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200'
                                            : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'}`}
                                    >
                                        {profile.label}
                                    </button>
                                ))}
                                {arbitrageRiskProfileKey === 'custom' && (
                                    <span className="px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-[10px] font-bold uppercase tracking-wide text-amber-200">
                                        Perfil Personalizado
                                    </span>
                                )}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2 text-[10px]">
                                <label className="flex flex-col gap-1">
                                    <span className="text-slate-400 uppercase">Modo Stake</span>
                                    <select
                                        value={arbitrageRiskConfig.stakeMode}
                                        onChange={(e) => updateArbitrageRiskField('stakeMode', e.target.value)}
                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100"
                                    >
                                        <option value="percent_nav">% NAV</option>
                                        <option value="fixed">Fijo (S/.)</option>
                                    </select>
                                </label>

                                <label className="flex flex-col gap-1">
                                    <span className="text-slate-400 uppercase">{arbitrageRiskConfig.stakeMode === 'fixed' ? 'Stake Fijo' : 'Stake % NAV'}</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={arbitrageRiskConfig.stakeMode === 'fixed' ? arbitrageRiskConfig.stakeFixedAmount : arbitrageRiskConfig.stakePercentNav}
                                        onChange={(e) => updateArbitrageRiskField(arbitrageRiskConfig.stakeMode === 'fixed' ? 'stakeFixedAmount' : 'stakePercentNav', e.target.value)}
                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100"
                                    />
                                </label>

                                <label className="flex flex-col gap-1">
                                    <span className="text-slate-400 uppercase">Cap % NAV</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={arbitrageRiskConfig.maxStakePercentNav}
                                        onChange={(e) => updateArbitrageRiskField('maxStakePercentNav', e.target.value)}
                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100"
                                    />
                                </label>

                                <label className="flex flex-col gap-1">
                                    <span className="text-slate-400 uppercase">Cap Absoluto (S/.)</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={arbitrageRiskConfig.maxStakeAbs}
                                        onChange={(e) => updateArbitrageRiskField('maxStakeAbs', e.target.value)}
                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100"
                                    />
                                </label>

                                <label className="flex flex-col gap-1">
                                    <span className="text-slate-400 uppercase">ROI Mín (%)</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={arbitrageRiskConfig.minRoiPercent}
                                        onChange={(e) => updateArbitrageRiskField('minRoiPercent', e.target.value)}
                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100"
                                    />
                                </label>

                                <label className="flex flex-col gap-1">
                                    <span className="text-slate-400 uppercase">Profit Mín (S/.)</span>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={arbitrageRiskConfig.minProfitAbs}
                                        onChange={(e) => updateArbitrageRiskField('minProfitAbs', e.target.value)}
                                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-100"
                                    />
                                </label>
                            </div>
                            <div className="text-[10px] text-slate-500">
                                {`NAV base (${String(arbitrageStakeContext.navSource || 'n/a')}): ${String(arbitrageStakeContext.navCurrency || 'PEN')} ${Number(arbitrageStakeContext.nav || 0).toFixed(2)} | Stake solicitado: S/. ${Number(arbitrageStakeContext.requestedStake || 0).toFixed(2)} | Cap %NAV: S/. ${Number(arbitrageStakeContext.capByNavPct || 0).toFixed(2)} | Cap abs: S/. ${Number(arbitrageStakeContext.maxStakeAbs || 0).toFixed(2)} | Stake final ticket: S/. ${Number(arbitrageStakeContext.stakeBankroll || 0).toFixed(2)}`}
                            </div>
                        </div>

                        {(arbitrageRefreshState.running || arbitrageRefreshState.lastOkAt || arbitrageRefreshState.lastError) && (
                            <div className={`rounded-lg border p-2 text-[10px] ${arbitrageRefreshState.lastError
                                ? 'border-red-500/30 bg-red-500/10 text-red-200'
                                : 'border-slate-700 bg-slate-900/40 text-slate-400'}`}>
                                {arbitrageRefreshState.running
                                    ? (arbitrageRefreshState.phase === 'prematch'
                                        ? 'Actualizando oportunidades Prematch...'
                                        : 'Recalculando preview de arbitraje con el snapshot más reciente...')
                                    : arbitrageRefreshState.lastError
                                        ? `Refresh falló: ${arbitrageRefreshState.lastError}`
                                        : `Refresh completo: ${formatTimeSafe(arbitrageRefreshState.lastOkAt)}`}
                            </div>
                        )}

                        {arbitrageView === 'LIVE' ? (
                            <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4 text-sm text-blue-100">
                                La vista de arbitraje Live está reservada para la siguiente fase (ejecución dual con hedge y control de latencia).
                            </div>
                        ) : arbitrageOps.length === 0 ? (
                            <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-8 text-center text-slate-400">
                                No hay surebets en este snapshot. El motor está activo; espera el próximo refresco de cuotas.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                                {arbitrageOps.map((op, idx) => {
                                    const isDcOpposite = String(op?.type || '').toUpperCase() === 'SUREBET_DC_OPPOSITE_PREMATCH';
                                    const impliedSum = Number(op?.plan?.impliedSum || 0);
                                    const edge = Number(op?.plan?.edgePercent || 0);
                                    const roi = Number(op?.plan?.roiPercent || 0);
                                    const guaranteedPayout = Number(op?.plan?.guaranteedPayout || 0);
                                    const expectedProfit = Number(op?.plan?.expectedProfit || 0);

                                    const fallbackLegs = [
                                        {
                                            market: '1x2',
                                            selection: 'Home',
                                            provider: op?.odds?.best?.home?.provider,
                                            odd: op?.odds?.best?.home?.odd
                                        },
                                        {
                                            market: '1x2',
                                            selection: 'Draw',
                                            provider: op?.odds?.best?.draw?.provider,
                                            odd: op?.odds?.best?.draw?.odd
                                        },
                                        {
                                            market: '1x2',
                                            selection: 'Away',
                                            provider: op?.odds?.best?.away?.provider,
                                            odd: op?.odds?.best?.away?.odd
                                        }
                                    ].filter((leg) => Number.isFinite(Number(leg?.odd)) && Number(leg?.odd) > 1);

                                    const legs = Array.isArray(op?.legs) && op.legs.length > 0 ? op.legs : fallbackLegs;
                                    const providerSplit = buildArbitrageProviderSplit(op, legs);
                                    const splitTotal = Number(providerSplit.total || 0);
                                    const pctAlt = splitTotal > 0 ? ((providerSplit.altenar / splitTotal) * 100) : 0;
                                    const pctArc = splitTotal > 0 ? ((providerSplit.arcadia / splitTotal) * 100) : 0;
                                    const liquidityGuard = resolveArbitrageLiquidityGuard({ providerSplit });
                                    const executionKey = getArbitrageExecutionKey(op, idx);
                                    const dualPlan = buildDualExecutionPlan(op, legs);
                                    const dualRunning = arbitrageExecutingKeys.has(executionKey);
                                    const dualBlockedByLiquidity = Boolean(dualPlan?.canExecute) && !liquidityGuard.canFund;
                                    const dualReasonText = (() => {
                                        if (dualBlockedByLiquidity) {
                                            return 'Bloqueado por liquidez: el split recomendado excede saldo disponible por provider.';
                                        }
                                        if (dualPlan?.canExecute) {
                                            return 'Secuencia: Arcadia -> Altenar (dry-run obligatorio en ambas patas)';
                                        }
                                        if (dualPlan?.reason === 'match-started') {
                                            return 'No ejecutable en dual: el partido ya inició (prematch expirado).';
                                        }
                                        return 'No ejecutable en dual: requiere pata Arcadia + pata Altenar válidas';
                                    })();

                                    return (
                                        <article key={`${op?.type || 'ARB'}_${op?.eventId || idx}_${idx}`} className="rounded-lg border border-amber-500/25 bg-slate-900/40 p-3 space-y-2">
                                            <div className="flex items-start justify-between gap-2">
                                                <div>
                                                    <div className="text-[10px] uppercase tracking-wide text-amber-300 font-bold">
                                                        {isDcOpposite ? (op?.comboLabel || 'DC + Opuesto') : '1x2 Surebet'}
                                                    </div>
                                                    <div className="text-sm font-bold text-slate-100">{op?.match || '-'}</div>
                                                    <div className="text-[10px] text-slate-500">{op?.league || '-'} | {formatTimeSafe(op?.matchDate)}</div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-[10px] text-slate-400">Edge</div>
                                                    <div className="font-mono text-amber-300 font-bold">{edge.toFixed(3)}%</div>
                                                </div>
                                            </div>

                                            <div className="rounded border border-slate-700 bg-slate-800/40 p-2 space-y-1">
                                                {legs.map((leg, legIdx) => {
                                                    const legOpportunity = buildArbitrageLegOpportunity({ op, leg, legIdx });
                                                    const legOpId = legOpportunity ? getOpportunityId(legOpportunity) : null;
                                                    const legProcessing = legOpId ? processingBets.has(legOpId) : false;

                                                    return (
                                                        <div key={`${leg?.selection || legIdx}_${legIdx}`} className="flex items-center justify-between gap-2 text-[11px]">
                                                            <div className="min-w-0">
                                                                <span className="text-slate-300">{`${leg?.market || '-'} · ${leg?.selection || '-'}`}</span>
                                                                <div className="font-mono text-slate-200">{`${String(leg?.provider || '-').toUpperCase()} @ ${Number(leg?.odd || 0).toFixed(3)}`}</div>
                                                            </div>
                                                            {legOpportunity ? (
                                                                <button
                                                                    onClick={() => handlePlaceBet(legOpportunity, { confirmModeHint: 'confirm' })}
                                                                    disabled={legProcessing}
                                                                    className={`px-2 py-1 rounded border text-[9px] font-bold uppercase tracking-wide transition-colors ${legProcessing
                                                                        ? 'border-slate-600 text-slate-500 cursor-not-allowed'
                                                                        : 'border-emerald-500/60 text-emerald-200 hover:bg-emerald-500/20'}`}
                                                                    title="Flujo semi-auto: prepare + dry-run + confirm"
                                                                >
                                                                    {legProcessing ? 'Procesando...' : 'Semi-auto'}
                                                                </button>
                                                            ) : (
                                                                <span className="text-[9px] uppercase tracking-wide text-slate-500">Solo referencia</span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>

                                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                                <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                                                    <div className="text-slate-400 uppercase text-[9px]">ROI</div>
                                                    <div className="font-mono text-emerald-300 font-bold">{roi.toFixed(3)}%</div>
                                                </div>
                                                <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                                                    <div className="text-slate-400 uppercase text-[9px]">Implied Sum</div>
                                                    <div className="font-mono text-slate-200 font-bold">{impliedSum.toFixed(6)}</div>
                                                </div>
                                                <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                                                    <div className="text-slate-400 uppercase text-[9px]">Profit</div>
                                                    <div className="font-mono text-emerald-300 font-bold">S/. {expectedProfit.toFixed(2)}</div>
                                                </div>
                                                <div className="rounded border border-slate-700 bg-slate-800/40 p-2">
                                                    <div className="text-slate-400 uppercase text-[9px]">Payout Min</div>
                                                    <div className="font-mono text-slate-200 font-bold">S/. {guaranteedPayout.toFixed(2)}</div>
                                                </div>
                                            </div>

                                            <div className="text-[10px] text-slate-400 font-mono">
                                                {isDcOpposite
                                                    ? `${op?.plan?.labels?.cover || 'COVER'}: S/. ${Number(op?.plan?.stakes?.cover || 0).toFixed(2)} | ${op?.plan?.labels?.opposite || 'OPPOSITE'}: S/. ${Number(op?.plan?.stakes?.opposite || 0).toFixed(2)}`
                                                    : `Home: S/. ${Number(op?.plan?.stakes?.home || 0).toFixed(2)} | Draw: S/. ${Number(op?.plan?.stakes?.draw || 0).toFixed(2)} | Away: S/. ${Number(op?.plan?.stakes?.away || 0).toFixed(2)}`}
                                            </div>

                                            <div className="rounded border border-cyan-500/25 bg-cyan-500/5 p-2 text-[10px]">
                                                <div className="uppercase tracking-wide text-cyan-200 font-bold">Split Recomendado</div>
                                                <div className="text-slate-300 font-mono">
                                                    {`Altenar: S/. ${Number(providerSplit.altenar || 0).toFixed(2)} (${pctAlt.toFixed(1)}%) | Arcadia: S/. ${Number(providerSplit.arcadia || 0).toFixed(2)} (${pctArc.toFixed(1)}%)`}
                                                </div>
                                                {Number(providerSplit.other || 0) > 0 && (
                                                    <div className="text-slate-500 font-mono">
                                                        {`Otros providers: S/. ${Number(providerSplit.other || 0).toFixed(2)}`}
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex items-center justify-between gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 p-2">
                                                <div className="text-[10px] text-slate-300">
                                                    <div className="uppercase tracking-wide text-emerald-200 font-bold">Fase 2 · Ejecución Dual</div>
                                                    <div className="text-slate-400">{dualReasonText}</div>
                                                    {dualBlockedByLiquidity && (
                                                        <div className="mt-1 text-[10px] text-red-300 font-mono">
                                                            {`Requerido Altenar: S/. ${Number(liquidityGuard.altenarRequired || 0).toFixed(2)} vs disponible: ${liquidityGuard.bookyCurrency} ${Number(liquidityGuard.bookyAvailable || 0).toFixed(2)} | Requerido Arcadia: S/. ${Number(liquidityGuard.arcadiaRequired || 0).toFixed(2)} vs disponible: ${liquidityGuard.pinnacleCurrency} ${Number(liquidityGuard.pinnacleAvailable || 0).toFixed(2)}`}
                                                        </div>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={() => handleExecuteArbitrageDual({ op, legs, idx })}
                                                    disabled={!dualPlan?.canExecute || dualRunning || dualBlockedByLiquidity}
                                                    className={`px-2.5 py-1.5 rounded border text-[10px] font-bold uppercase tracking-wide transition-colors ${(!dualPlan?.canExecute || dualRunning || dualBlockedByLiquidity)
                                                        ? 'border-slate-600 text-slate-500 cursor-not-allowed'
                                                        : 'border-emerald-500/60 text-emerald-200 hover:bg-emerald-500/20'}`}
                                                    title="Ejecutar patas Arcadia + Altenar en secuencia"
                                                >
                                                    {dualRunning ? 'Ejecutando...' : 'Ejecutar Dual'}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : (
                /* TABLA ESTÁNDAR */
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                        <thead>
                            <tr className="bg-slate-900 text-slate-400 uppercase tracking-wider">
                                <th className="p-3 w-32">Status / Hora</th>
                                <th className="p-3">Evento</th>
                                <th className="p-3 text-center">Selección</th>
                                <th className="p-3 text-center">Cuota</th>
                                <th className="p-3 text-center">EV%</th>
                                <th className="p-3 text-center">Stake (Kelly)</th>
                                <th className="p-3 text-center">Resultado</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                             {filteredOps.length === 0 ? (
                                <tr>
                                    <td colSpan="7" className="p-12 text-center text-slate-500 italic flex flex-col items-center justify-center gap-2">
                                        <Filter className="w-8 h-8 opacity-20" />
                                        No hay partidos para el filtro seleccionado.
                                    </td>
                                </tr>
                             ) : (
                                filteredOps.map((op, idx) => {
                                    // Determinar si es LIVE OP o PREMATCH
                                    // Fix: Evitar que partidos viejos (>150 min) sin resultado se muestren como "Live 600'"
                                    const isReallyLiveType = op.type === 'LIVE_SNIPE' || op.type === 'LIVE_VALUE' || op.type === 'LA_VOLTEADA';
                                    const minutesElapsed = op.date ? Math.floor((new Date() - new Date(op.date))/60000) : 0;
                                    
                                    // [MOD] Lógica Visual Strict: Si dice "Final", NO es live, aunque sea 'LIVE_SNIPE'.
                                    const isExplicitlyFinished = op.time === 'Final' || op.liveTime === 'Final' || (minutesElapsed > 120 && isReallyLiveType);
                                    const isStatusCompleted = op.status === 'WON' || op.status === 'LOST' || op.status === 'VOID';
                                    const isBookySettledByStatus = BOOKY_SETTLED_STATUSES.has(Number(op?.status));
                                    
                                    // Búsqueda en historial para ver si esta operación fue ejecutada
                                    // Fix: Linkeo robusto por eventId + selection (manejo de fallback)
                                    const opSelection = op.selection || op.action;
                                    const providerBetIdForLookup = String(resolveOpTicketId(op) || op?.providerBetId || '').trim();

                                    const historyMatchByProvider = providerBetIdForLookup
                                        ? portfolio.history.find(h => String(resolveOpTicketId(h) || h?.providerBetId || '').trim() === providerBetIdForLookup)
                                        : null;
                                    const activeMatchByProvider = providerBetIdForLookup
                                        ? portfolio.activeBets.find(b => String(resolveOpTicketId(b) || b?.providerBetId || '').trim() === providerBetIdForLookup)
                                        : null;

                                    const historyMatchBySelection = providerBetIdForLookup
                                        ? null
                                        : portfolio.history.find(h => h.eventId === op.eventId && h.selection === opSelection);
                                    const activeMatchBySelection = providerBetIdForLookup
                                        ? null
                                        : portfolio.activeBets.find(b => b.eventId === op.eventId && b.selection === opSelection);

                                    const historyMatch = historyMatchByProvider || historyMatchBySelection;
                                    const activeMatch = activeMatchByProvider || activeMatchBySelection;
                                    
                                    const opBetKey = getOpportunityId(op);
                                    const remoteOpenRowByProvider = providerBetIdForLookup
                                        ? (remoteOpenBookyByProvider.get(providerBetIdForLookup) || null)
                                        : null;
                                    const remoteOpenRowBySelection = providerBetIdForLookup
                                        ? null
                                        : (opBetKey ? (remoteOpenBookyByKey.get(opBetKey) || null) : null);
                                    const remoteOpenRow = remoteOpenRowByProvider || remoteOpenRowBySelection;
                                    const activeInRemoteBooky = Boolean(remoteOpenRow);
                                    const executionStatus = op.isBookyHistory ? 'FINISHED' : (historyMatch ? 'FINISHED' : ((activeMatch || activeInRemoteBooky || op.isBookyRemoteOpen) ? 'ACTIVE' : 'PENDING'));
                                    const betData = op.isBookyHistory ? op : (historyMatch || activeMatch || remoteOpenRow || op);
                                    const finishedOriginMeta = getFinishedProviderBadgeMeta(betData || op);
                                    const stickyPinnacleFromBet = getStickyPinnacleReference(betData || {});
                                    const stickyPinnacleFromOp = getStickyPinnacleReference(op || {});
                                    const liveCandidate = opBetKey ? (latestLiveCandidatesByKeyRef.current.get(opBetKey) || null) : null;
                                    const pendingSnapshot = opBetKey ? (pendingBetDetailsRef.current[opBetKey] || null) : null;
                                    const effectivePinnacleInfo =
                                        mergePinnacleInfoCandidates(
                                        betData?.pinnacleInfo,
                                        op?.pinnacleInfo,
                                        stickyPinnacleFromBet?.pinnacleInfo,
                                        stickyPinnacleFromOp?.pinnacleInfo,
                                        liveCandidate?.pinnacleInfo,
                                        pendingSnapshot?.pinnacleInfo
                                        ) || null;
                                    const effectivePinnaclePriceRaw = Number(
                                        betData?.pinnaclePrice ??
                                        op?.pinnaclePrice ??
                                        stickyPinnacleFromBet?.pinnaclePrice ??
                                        stickyPinnacleFromOp?.pinnaclePrice ??
                                        liveCandidate?.pinnaclePrice ??
                                        pendingSnapshot?.pinnaclePrice
                                    );
                                    const allowPrematchReferenceFallback = isPrematchOriginOpportunity(betData || op);
                                    const derivedPinnacleReference = derivePinnacleReferencePrice({
                                        pinnacleInfo: effectivePinnacleInfo,
                                        pick: betData?.pick || op?.pick || null,
                                        market: betData?.market || op?.market || null,
                                        selection: betData?.selection || op?.selection || op?.action || null
                                    });
                                    const effectivePinnaclePriceCandidate = Number.isFinite(effectivePinnaclePriceRaw)
                                        ? effectivePinnaclePriceRaw
                                        : (allowPrematchReferenceFallback ? derivedPinnacleReference : null);
                                    const effectivePinnaclePrice = sanitizePinnaclePriceForOrigin({
                                        price: effectivePinnaclePriceCandidate,
                                        pinnacleInfo: effectivePinnacleInfo,
                                        isPrematchOrigin: allowPrematchReferenceFallback,
                                        preserveForPending: executionStatus === 'PENDING'
                                    });
                                    const visualLiveSignal =
                                        op?.liveTime ||
                                        op?.time ||
                                        effectivePinnacleInfo?.time ||
                                        betData?.liveTime ||
                                        betData?.time ||
                                        betData?.raw?.selections?.[0]?.gameTime ||
                                        op?.raw?.selections?.[0]?.gameTime ||
                                        '';
                                    const hasTrustedVisualLiveClock = hasLiveClockSignal(visualLiveSignal);
                                    const isInPlayNow = isEventInPlayNow(betData, op);
                                    const isLive =
                                        activeTab !== 'FINISHED' &&
                                        !op.isBookyHistory &&
                                        !isBookySettledByStatus &&
                                        !isStatusCompleted &&
                                        !isExplicitlyFinished &&
                                        (isReallyLiveType || hasTrustedVisualLiveClock || isInPlayNow);
                                    const ticketIdForRow = resolveOpTicketId(betData) || resolveOpTicketId(op);
                                    const showTicketId = Boolean(
                                        ticketIdForRow && !(activeTab === 'FINISHED' && !op.isBookyHistory && !op.isRealHistory)
                                    );
                                    const eventStartIsoFromHistory = ticketIdForRow
                                        ? (bookyEventStartIsoByProvider.get(String(ticketIdForRow)) || null)
                                        : null;
                                    const eventStartIso = op.isBookyHistory
                                        ? (
                                            resolveBookyEventStartIso(op) ||
                                            resolveOpEventStartIso(op) ||
                                            resolveOpEventStartIso(betData || {}) ||
                                            eventStartIsoFromHistory
                                        )
                                        : (
                                            resolveOpEventStartIso(op) ||
                                            resolveOpEventStartIso(betData || {}) ||
                                            eventStartIsoFromHistory
                                        );
                                    const entryMeta = ticketIdForRow ? (entryOrderByTicketId.get(String(ticketIdForRow)) || null) : null;
                                    const betTimeIso = resolveOpBetTimeIso(betData, op);
                                    const marketLabel = normalizeMarketLabel(op.market);
                                    const eventStartMs = eventStartIso ? new Date(eventStartIso).getTime() : NaN;
                                    const betPlacedMs = betTimeIso ? new Date(betTimeIso).getTime() : NaN;
                                    const hasValidTiming = Number.isFinite(eventStartMs) && Number.isFinite(betPlacedMs);
                                    const inferredLiveByTiming = hasValidTiming
                                        ? betPlacedMs >= (eventStartMs + (2 * 60 * 1000))
                                        : false;
                                    const inferredPrematchByTiming = hasValidTiming
                                        ? betPlacedMs < (eventStartMs + (2 * 60 * 1000))
                                        : false;
                                    const stakeSyncFlags = resolveStakeSyncFlags(
                                        betData,
                                        Number(op?.kellyStake || 0),
                                        Number(op?.price || op?.odd || 0)
                                    );
                                    const effectiveType = String(
                                        betData?.type || betData?.strategy || op?.type || op?.strategy || ''
                                    ).toUpperCase();
                                    const typeUnknown = !effectiveType || effectiveType === 'BOOKY_REAL' || effectiveType === 'UNKNOWN';
                                    const hasLiveSignal = Boolean(
                                        betData?.liveTime ||
                                        op?.liveTime ||
                                        betData?.time ||
                                        op?.time ||
                                        betData?.raw?.selections?.[0]?.gameTime ||
                                        op?.raw?.selections?.[0]?.gameTime
                                    );
                                    const showValueBadge = effectiveType === 'LIVE_VALUE';
                                    const showSnipeBadge =
                                        effectiveType === 'LIVE_SNIPE' ||
                                        effectiveType === 'LA_VOLTEADA' ||
                                        (typeUnknown && (hasLiveSignal || inferredLiveByTiming));
                                    const showPrematchBadge =
                                        effectiveType === 'PREMATCH_VALUE' ||
                                        (typeUnknown && inferredPrematchByTiming);
                                    const evRaw = Number(
                                        betData?.ev ??
                                        op?.ev ??
                                        historyMatch?.ev ??
                                        activeMatch?.ev ??
                                        liveCandidate?.ev ??
                                        pendingSnapshot?.ev
                                    );
                                    const hasEv = Number.isFinite(evRaw);
                                    const selectionCanonical = resolveCanonicalSelectionLabel(betData || op);
                                    const selectionBookyRaw = op.isBookyHistory ? resolveBookySelectionText(betData || op) : null;
                                    const selectionDiff = Boolean(
                                        op.isBookyHistory &&
                                        selectionBookyRaw &&
                                        selectionCanonical &&
                                        selectionBookyRaw.toUpperCase() !== selectionCanonical.toUpperCase()
                                    );
                                    const isFinishedSelectionMode = activeTab === 'FINISHED' && op.isBookyHistory;
                                    const selectionPrimary = isFinishedSelectionMode
                                        ? (finishedSelectionView === 'BOOKY'
                                            ? (selectionBookyRaw || selectionCanonical)
                                            : finishedSelectionView === 'CANONICAL'
                                                ? selectionCanonical
                                                : (selectionBookyRaw || selectionCanonical))
                                        : selectionCanonical;
                                    const showSelectionCanonicalHint = isFinishedSelectionMode
                                        ? (finishedSelectionView === 'HYBRID' && selectionDiff)
                                        : false;
                                    const displayOdd = Number(
                                        executionStatus === 'PENDING'
                                            ? (op?.price || op?.odd || 0)
                                            : (betData?.price || betData?.odd || op?.price || op?.odd || 0)
                                    );
                                    const acceptedOdd = Number(betData?.price || betData?.odd || op?.price || op?.odd || 0);
                                    const candidateOdd = Number(liveCandidate?.price || liveCandidate?.odd || 0);
                                    const candidateEv = Number(liveCandidate?.ev);
                                    const candidateStake = Number(liveCandidate?.kellyStake || 0);
                                    const oddImprovementPct = (Number.isFinite(candidateOdd) && candidateOdd > 1 && Number.isFinite(acceptedOdd) && acceptedOdd > 1)
                                        ? ((candidateOdd / acceptedOdd) - 1) * 100
                                        : 0;
                                    const reentryBaseChecks = executionStatus === 'ACTIVE' && liveCandidate && isLiveOriginOpportunity(liveCandidate);
                                    const reentryMeetsPrice = oddImprovementPct >= REENTRY_MIN_ODD_IMPROVEMENT_PCT;
                                    const reentryMeetsEv = Number.isFinite(candidateEv) && candidateEv >= REENTRY_MIN_EV_PERCENT;
                                    const reentryMeetsStake = Number.isFinite(candidateStake) && candidateStake >= REENTRY_MIN_STAKE_SOL;
                                    const reentryAvailable = Boolean(reentryBaseChecks && reentryMeetsPrice && reentryMeetsEv && reentryMeetsStake);
                                    const reentryBelowMinStake = Boolean(reentryBaseChecks && reentryMeetsPrice && reentryMeetsEv && !reentryMeetsStake);
                                    const previewStake = Number(op?.kellyStake || 0);
                                    const isFastModePreview = String(op?.type || '').toUpperCase() === 'LIVE_SNIPE';
                                    const betButtonTitle = [
                                        `Enviar apuesta usando proveedor manual: ${autoPlacementProviderPretty}`,
                                        `Modo: ${isFastModePreview ? 'confirm-fast (LIVE_SNIPE)' : 'confirm (seguro)'}`,
                                        `Cuota actual: ${displayOdd > 0 ? displayOdd.toFixed(2) : '--'}`,
                                        `Stake sugerido: S/. ${previewStake.toFixed(2)}`,
                                        'Nota: en vivo puede haber recálculo al confirmar.'
                                    ].join('\n');

                                    // Display Logic Fixes: Include Explicit Finish here
                                    const showFinished = executionStatus === 'FINISHED' || op.isFinished || isExplicitlyFinished;

                                    return (
                                    <tr key={idx} className={`hover:bg-slate-700/50 transition-colors ${isLive ? 'bg-slate-800/80 border-l-2 border-red-500' : ''}`}>
                                        <td className="p-3">
                                            {/* LOGICA DE STATUS/HORA */}
                                            {isLive ? (
                                                <div className="flex flex-col gap-1">
                                                    <span className="flex items-center gap-1 text-red-500 animate-pulse font-bold bg-red-500/10 px-2 py-0.5 rounded w-fit text-[10px]">
                                                       <Clock className="w-3 h-3" />
                                                       {/* Live Timer - Prioridad a liveTime (actualizado en tiempo real) */}
                                                        {(() => {
                                                            const rawClock = op.liveTime || effectivePinnacleInfo?.time || op.time || '';
                                                            if (hasLiveClockSignal(rawClock)) return rawClock;

                                                            const normalizedMinutes = Number.isFinite(minutesElapsed)
                                                                ? Math.max(1, minutesElapsed)
                                                                : 1;
                                                            return normalizedMinutes > 90 ? "90'+" : `${normalizedMinutes}'`;
                                                        })()}
                                                    </span>
                                                    {/* SCORE con Prioridad a lastKnownScore (actualizado en tiempo real) */}
                                                    <span className="font-mono font-bold text-white text-xs pl-0.5">
                                                        {op.lastKnownScore || effectivePinnacleInfo?.score || (Array.isArray(op.score) ? op.score.join(' - ') : op.score || '0 - 0')}
                                                    </span>
                                                    <span className="text-[9px] text-slate-500 leading-tight" title="Hora de Inicio">
                                                        {formatTimeSafe(eventStartIso || op.matchDate || op.date)}
                                                    </span>
                                                </div>
                                            ) : showFinished ? (
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex items-center gap-1 text-emerald-500 font-bold bg-emerald-500/10 px-2 py-0.5 rounded text-[10px] border border-emerald-500/20 w-fit">
                                                        <span>FIN</span>
                                                    </div>
                                                    {/* SCORE BELOW FIN */}
                                                     <span className="font-mono font-bold text-slate-300 text-xs pl-0.5">
                                                                          {resolveBestScoreText(betData, op) || '?-?'}
                                                     </span>
                                                     {/* HORA DE APUESTA */}
                                                     <span className="text-[9px] text-slate-400 leading-tight" title="Hora de Apuesta">
                                                         AP {formatTimeSafe(betTimeIso || op.createdAt || op.date)}
                                                     </span>
                                                     {/* HORA DE INICIO */}
                                                     <span className="text-[9px] text-slate-500 leading-tight" title="Hora de Inicio">
                                                         INI {formatTimeSafe(op.isBookyHistory ? (resolveBookyEventStartIso(op) || op.matchDate || op.date) : (op.matchDate || op.date))}
                                                     </span>
                                                </div>
                                            ) : (op.manualStatus === 'WAIT_RES' || minutesElapsed > 150) ? (
                                                <div className="flex flex-col gap-1">
                                                     <div className="flex items-center gap-1 text-amber-500 font-bold bg-amber-500/10 px-2 py-1 rounded text-[10px] w-fit">
                                                        <span>VERIFICANDO</span>
                                                        {betData.liveTime && <span className="text-[9px] opacity-75">({betData.liveTime})</span>}
                                                     </div>
                                                     <span className="text-[10px] text-slate-500">Esperando Res.</span>
                                                     {(betData.finalScore || betData.lastKnownScore) && <span className="font-mono font-bold text-slate-400 pl-1 text-[10px]">{betData.finalScore || betData.lastKnownScore}</span>}
                                                </div>
                                            ) : (
                                                <div className="flex flex-col">
                                                    {op.date ? (
                                                        <>
                                                            <span className="text-slate-200 font-mono font-bold">
                                                                {formatTimeSafe(op.date)}
                                                            </span>
                                                            <span className="text-[10px] text-slate-500">
                                                                {formatDateSafe(op.date)}
                                                            </span>
                                                        </>
                                                    ) : (
                                                        <span className="text-slate-500 text-[10px] italic">En Vivo</span>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3">
                                            {/* STRATEGY BADGE */}
                                            {((isLive || showFinished || executionStatus === 'FINISHED' || executionStatus === 'ACTIVE') || (entryMeta && entryMeta.total > 1)) && (
                                                <div className="mb-1 flex items-center gap-1.5 flex-wrap">
                                                    {(isLive || showFinished || executionStatus === 'FINISHED') && (
                                                        <>
                                                            {showValueBadge ? (
                                                                <span className="text-[9px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                                    VALUE BET
                                                                </span>
                                                            ) : showSnipeBadge ? (
                                                                <span className="text-[9px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                                    SNIPE
                                                                </span>
                                                            ) : showPrematchBadge ? (
                                                                <span className="text-[9px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                                    PRE-MATCH
                                                                </span>
                                                            ) : null}
                                                        </>
                                                    )}

                                                    {entryMeta && entryMeta.total > 1 && (
                                                        <span className="text-[9px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                            ENTRY #{entryMeta.index}/{entryMeta.total}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                            <div className="text-slate-200 font-bold text-sm text-wrap max-w-50 md:max-w-none">{op.match}</div>
                                            {(op.isBookyHistory || activeTab === 'LIVE' || activeTab === 'FINISHED' || ticketIdForRow) ? (
                                                <div className="text-slate-500 text-[10px] flex gap-2 flex-wrap items-center">
                                                    <span>{op.league || betData?.league || '-'}</span>
                                                    <span className="text-slate-600">|</span>
                                                    <span>{(entryMeta && entryMeta.total > 1) ? formatTimeWithSecondsSafe(betTimeIso || op.date) : formatTimeSafe(betTimeIso || op.date)}</span>
                                                    {showTicketId && (
                                                        <>
                                                            <span className="text-slate-600">|</span>
                                                            <span>Ticket {ticketIdForRow}</span>
                                                        </>
                                                    )}
                                                    <span className="text-slate-600">|</span>
                                                    <span>{marketLabel}</span>
                                                </div>
                                            ) : (
                                                <div className="text-slate-500 text-[10px] flex gap-2">
                                                    <span>{op.league}</span>
                                                    <span className="text-slate-600">|</span>
                                                    <span>{marketLabel}</span>
                                                </div>
                                            )}

                                            {/* PRE-MATCH CONTEXT BADGES */}
                                            {(effectivePinnacleInfo?.prematchContext) && (
                                                <div className="flex flex-wrap gap-1 mt-1.5 opacity-90">
                                                    {/* 1x2 Badge */}
                                                    {(effectivePinnacleInfo.prematchContext.home || effectivePinnacleInfo.prematchContext.draw || effectivePinnacleInfo.prematchContext.away) && (
                                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50 text-[9px] font-mono text-slate-300" title="Pre-Match 1x2 Odds (Pinnacle)">
                                                            <span className="text-blue-400 font-sans font-bold">1x2</span>
                                                            <span className={effectivePinnacleInfo.prematchContext.home < 2.0 ? "text-blue-300 font-bold" : ""}>{effectivePinnacleInfo.prematchContext.home?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={effectivePinnacleInfo.prematchContext.draw < 3.0 ? "text-amber-400" : ""}>{effectivePinnacleInfo.prematchContext.draw?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={effectivePinnacleInfo.prematchContext.away < 2.0 ? "text-blue-300 font-bold" : ""}>{effectivePinnacleInfo.prematchContext.away?.toFixed(2) || '-'}</span>
                                                        </div>
                                                    )}
                                                    
                                                    {/* Totals 2.5 Badge */}
                                                    {(effectivePinnacleInfo.prematchContext.over25 || effectivePinnacleInfo.prematchContext.under25) && (
                                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50 text-[9px] font-mono text-slate-300" title="Pre-Match Over/Under 2.5 (Pinnacle)">
                                                            <span className="text-blue-400 font-sans font-bold">2.5</span>
                                                            <span className={effectivePinnacleInfo.prematchContext.over25 < 1.8 ? "text-blue-300 font-bold" : ""}>O:{effectivePinnacleInfo.prematchContext.over25?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={effectivePinnacleInfo.prematchContext.under25 < 1.8 ? "text-blue-300 font-bold" : ""}>U:{effectivePinnacleInfo.prematchContext.under25?.toFixed(2) || '-'}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {executionStatus === 'ACTIVE' && (reentryAvailable || reentryBelowMinStake) && (
                                                <div className="mt-1">
                                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wide ${reentryAvailable ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/30'}`}>
                                                        RE-ENTRY CANDIDATE
                                                    </span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3 text-center">
                                            <div className="flex flex-col items-center gap-1">
                                                <span className={`font-bold px-2 py-1 rounded border text-[10px] whitespace-nowrap ${
                                                    selectionCanonical === 'LOCAL' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                                                    selectionCanonical === 'VISITA' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                                                    'bg-slate-700 text-slate-300 border-slate-600'
                                                }`}>
                                                    {selectionPrimary}
                                                </span>
                                                {showSelectionCanonicalHint && (
                                                    <span className="text-[9px] text-slate-500 uppercase tracking-wide">
                                                        {selectionCanonical}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-3 text-center">
                                            <div className="flex flex-col gap-1.5 items-center justify-center">
                                                {/* 1. PINNACLE (Azul - Referencia Live Sharp) */}
                                                <div className="flex flex-col items-center min-h-[2.5em] justify-center relative gap-1">
                                                    
                                                    {/* SOLO MOSTRAR SI HAY CUOTA LIVE DE PINNACLE */}
                                                    {(effectivePinnaclePrice && effectivePinnaclePrice > 1) ? (
                                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/20 w-fit relative overflow-visible shadow-[0_0_10px_rgba(59,130,246,0.05)]" title="Pinnacle (Cuota en Vivo - Snapshot)">
                                                            <span className="text-[9px] font-bold text-blue-400 tracking-tighter">PIN</span>
                                                            <span className="font-mono font-bold text-sm text-blue-300 leading-none">{effectivePinnaclePrice.toFixed(2)}</span>
                                                            
                                                            {/* INDICADORES LIVE O TENDENCIA (MISMA POSICIÓN) - Modificado para parpadear igual que Altenar */}
                                                            {(executionStatus === 'PENDING' && op.trend === 'UP') ? (
                                                                <span className="absolute -top-1 -right-1 text-emerald-400 text-[8px] z-50 drop-shadow-sm font-bold animate-pulse leading-none">
                                                                    ▲
                                                                </span>
                                                            ) : (executionStatus === 'PENDING' && op.trend === 'DOWN') ? (
                                                                <span className="absolute -top-1 -right-1 text-red-500 text-[8px] z-50 drop-shadow-sm font-bold animate-pulse leading-none">
                                                                    ▼
                                                                </span>
                                                            ) : (
                                                                // Si no hay tendencia, mostramos el punto rojo parpadeante (LIVE STANDARD)
                                                                <span className="absolute -top-1 -right-1 flex h-2 w-2 z-50">
                                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500 border border-slate-900 shadow-sm" title="Live Market Source"></span>
                                                                </span>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        // Si no hay cuota live, mostrar placeholder "OFF" discreto para mantener alineación
                                                        <div className="px-2 py-1 rounded bg-slate-800/30 border border-slate-700/30 min-w-15 flex justify-center opacity-50">
                                                            <span className="text-[8px] text-slate-600 font-bold">PIN OFF</span>
                                                        </div>
                                                    )}
                                                </div>

                                                {/* 2. ALTENAR (Color Distinto - Target Bookie API) */}
                                                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 w-fit relative shadow-[0_0_10px_rgba(16,185,129,0.05)]" title="Altenar API (DoradoBet, Atlantic City, etc.)">
                                                    <span className="text-[9px] font-bold text-emerald-600/80 tracking-tighter">ALT</span>
                                                    <span className="font-mono font-bold text-sm text-emerald-400 leading-none flex items-center gap-0.5">
                                                        {displayOdd.toFixed(2)}
                                                    </span>
                                                    
                                                    {/* INDICADORES LIVE O TENDENCIA (MISMA POSICIÓN) */}
                                                    {isLive && executionStatus === 'PENDING' && (
                                                        op.trend === 'UP' ? (
                                                            // Flecha Arriba (Verde) - Sin círculo
                                                            <span className="absolute -top-1 -right-1 text-emerald-400 text-[8px] z-50 drop-shadow-sm font-bold animate-pulse leading-none">
                                                                ▲
                                                            </span>
                                                        ) : op.trend === 'DOWN' ? (
                                                            // Flecha Abajo (Roja) - Sin círculo
                                                            <span className="absolute -top-1 -right-1 text-red-500 text-[8px] z-50 drop-shadow-sm font-bold animate-pulse leading-none">
                                                                ▼
                                                            </span>
                                                        ) : (
                                                            // Si no hay tendencia, mostramos el punto rojo standard (ESTILO PINNACLE)
                                                            <span className="absolute -top-1 -right-1 flex h-2 w-2 z-50">
                                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                                                                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500 border border-slate-900 shadow-sm"></span>
                                                            </span>
                                                        )
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-3 text-center">
                                             {executionStatus === 'FINISHED' && !hasEv ? (
                                                 <span className="text-slate-500 font-mono text-xs">-</span>
                                             ) : (
                                                <span className={`px-1.5 py-0.5 rounded font-bold ${hasEv && evRaw > 5 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                    {hasEv ? `${evRaw >= 0 ? '+' : ''}${evRaw.toFixed(1)}%` : '0.0%'}
                                                </span>
                                             )}
                                        </td>
                                        <td className="p-3 text-center">
                                            {/* STAKE EN JUEGO VS VIRTUAL */}
                                            {executionStatus === 'FINISHED' || executionStatus === 'ACTIVE' ? (
                                                <div className="flex flex-col items-center">
                                                     <span className="font-mono text-xs text-slate-400 mb-0.5">Apostado</span>
                                                     <div className={`font-mono font-bold text-sm px-2 py-0.5 rounded ${executionStatus === 'ACTIVE' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-700 text-slate-300'}`}>
                                                        S/. {betData.stake ? betData.stake.toFixed(2) : op.kellyStake?.toFixed(2)}
                                                     </div>
                                                     {(stakeSyncFlags.recalcFromPrep || stakeSyncFlags.oddOnlyRecalc || stakeSyncFlags.providerAdjusted) && (
                                                        <div className="mt-1 flex items-center gap-1 flex-wrap justify-center">
                                                            {stakeSyncFlags.recalcFromPrep && (
                                                                <span
                                                                    className="text-[9px] font-bold bg-blue-500/15 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded uppercase tracking-wide"
                                                                    title="Stake/cuota recalculados al confirmar por cambio de mercado"
                                                                >
                                                                    RECALC
                                                                </span>
                                                            )}
                                                            {stakeSyncFlags.oddOnlyRecalc && (
                                                                <span
                                                                    className="text-[9px] font-bold bg-violet-500/15 text-violet-300 border border-violet-500/30 px-1.5 py-0.5 rounded uppercase tracking-wide"
                                                                    title="Solo cambió la cuota al confirmar; stake se mantuvo"
                                                                >
                                                                    CUOTA Δ
                                                                </span>
                                                            )}
                                                            {stakeSyncFlags.providerAdjusted && (
                                                                <span
                                                                    className="text-[9px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded uppercase tracking-wide"
                                                                    title="Booky ajustó stake final (mínimo/múltiplo/límite)"
                                                                >
                                                                    AJUSTE BOOKY
                                                                </span>
                                                            )}
                                                        </div>
                                                     )}

                                                     {executionStatus === 'ACTIVE' && (reentryAvailable || reentryBelowMinStake) && (
                                                        <div className="mt-2 w-full max-w-55 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-2 text-left">
                                                            <div className="text-[9px] uppercase tracking-wide text-emerald-300 font-bold mb-1">Re-Snipe disponible</div>
                                                            <div className="text-[10px] text-slate-300 flex justify-between">
                                                                <span>Cuota actual</span>
                                                                <span className="font-mono text-emerald-300">{Number.isFinite(candidateOdd) && candidateOdd > 1 ? candidateOdd.toFixed(2) : '--'}</span>
                                                            </div>
                                                            <div className="text-[10px] text-slate-300 flex justify-between">
                                                                <span>Mejora</span>
                                                                <span className="font-mono text-emerald-300">+{oddImprovementPct.toFixed(1)}%</span>
                                                            </div>
                                                            <div className="text-[10px] text-slate-300 flex justify-between">
                                                                <span>EV</span>
                                                                <span className="font-mono text-emerald-300">{Number.isFinite(candidateEv) ? `${candidateEv >= 0 ? '+' : ''}${candidateEv.toFixed(1)}%` : '--'}</span>
                                                            </div>
                                                            <div className="text-[10px] text-slate-300 flex justify-between mb-1.5">
                                                                <span>Stake sugerido</span>
                                                                <span className={`font-mono ${reentryMeetsStake ? 'text-emerald-300' : 'text-amber-300'}`}>S/. {Number.isFinite(candidateStake) ? candidateStake.toFixed(2) : '--'}</span>
                                                            </div>
                                                            {reentryAvailable ? (
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        const reentryOp = {
                                                                            ...liveCandidate,
                                                                            isReentry: true,
                                                                            reentryParentTicketId: ticketIdForRow || betData?.providerBetId || null,
                                                                            reentryParentBetId: betData?.id || null
                                                                        };
                                                                        handlePlaceBet(reentryOp);
                                                                    }}
                                                                    className="w-full rounded bg-emerald-600/25 hover:bg-emerald-600/35 border border-emerald-400/40 text-emerald-100 text-[10px] font-bold py-1"
                                                                    title="Reapostar esta misma selección con cuota mejorada"
                                                                >
                                                                    REAPOSTAR (S/. {candidateStake.toFixed(2)})
                                                                </button>
                                                            ) : (
                                                                <div className="text-[9px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-1">
                                                                    Bloqueado: {autoPlacementProviderPretty} no acepta apuestas &lt; S/. {REENTRY_MIN_STAKE_SOL.toFixed(2)}
                                                                </div>
                                                            )}
                                                        </div>
                                                     )}
                                                </div>
                                            ) : processingBets.has(getOpportunityId(op)) ? (
                                                <div className="flex flex-col items-center animate-pulse">
                                                    <span className="text-[10px] text-slate-400 font-bold">PROCESANDO...</span>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col items-center gap-1.5">
                                                    <span className="text-[9px] uppercase tracking-wide text-slate-500 font-bold">
                                                        Manual {autoPlacementProviderLabel}
                                                    </span>
                                                    {/* BOTÓN APOSTAR */}
                                                    <button 
                                                        onClick={(e) => { e.stopPropagation(); handlePlaceBet(op); }}
                                                        className="flex items-center gap-2 bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-500/50 hover:border-emerald-400 text-emerald-100 rounded px-3 py-1.5 w-full justify-between transition-all group cursor-pointer shadow-[0_0_10px_rgba(16,185,129,0.1)] hover:shadow-[0_0_15px_rgba(16,185,129,0.3)] active:scale-95"
                                                        title={betButtonTitle}
                                                    >
                                                        <span className="font-bold text-[10px] group-hover:text-white">APOSTAR</span>
                                                        <span className="font-mono font-bold text-sm">S/. {(op.kellyStake || 0).toFixed(2)}</span>
                                                    </button>
                                                    
                                                    {/* BOTÓN DESCARTAR (Solo si NO es una apuesta activa inyectada) */}
                                                    {!op.isActiveBet && (
                                                        <button 
                                                            onClick={(e) => { e.stopPropagation(); handleDiscard(op); }}
                                                            className="flex items-center justify-center gap-1 bg-slate-800 hover:bg-red-900/40 border border-slate-700 hover:border-red-500/50 text-slate-400 hover:text-red-400 rounded px-2 py-1 w-full transition-colors text-[10px]"
                                                            title="Descartar oportunidad"
                                                        >
                                                            <Trash2 className="w-3 h-3" />
                                                            <span>DESCARTAR</span>
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3 text-center">
                                            {op.manualStatus === 'WAIT_RES' ? (
                                                <div className="flex flex-col items-center group relative p-1">
                                                    <span className="text-[10px] text-amber-500 font-bold bg-amber-900/20 px-2 py-1 rounded border border-amber-500/20 animate-pulse">
                                                        VERIFICANDO
                                                    </span>
                                                    <span className="text-[9px] text-slate-500 mt-1">API RESULTADOS</span>
                                                    
                                                    {/* BOTONES DE ACCIÓN MANUAL (HOVER) */}
                                                    <div className="hidden group-hover:flex absolute inset-0 bg-slate-900/95 items-center justify-center gap-1 rounded z-10 border border-slate-700">
                                                         <button 
                                                            onClick={(e) => { e.stopPropagation(); requestSettle(betData.id, 'AUTO'); }} 
                                                            className="p-1 hover:bg-blue-500/20 text-blue-400 rounded"
                                                            title="Reintentar API"
                                                         >
                                                            <Search className="w-3 h-3" />
                                                         </button>
                                                         <button 
                                                            onClick={(e) => { e.stopPropagation(); requestSettle(betData.id, 'MANUAL'); }}
                                                            className="p-1 hover:bg-amber-500/20 text-amber-400 rounded"
                                                            title="Corregir Manualmente"
                                                         >
                                                            <Edit className="w-3 h-3" />
                                                         </button>
                                                    </div>
                                                </div>
                                            ) : (executionStatus === 'FINISHED' || op.isFinished) ? (
                                                <div className="flex flex-col items-center justify-center p-1 rounded bg-slate-800/50 group relative">
                                                    <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border mb-1 ${finishedOriginMeta.className}`}>
                                                        {finishedOriginMeta.label}
                                                    </span>
                                                    {op.isBookyHistory ? (
                                                        (() => {
                                                            const outcome = resolveBookyOutcome(betData);
                                                            return (
                                                                <>
                                                                    <span className={`font-bold text-xs ${outcome.colorClass}`}>
                                                                        {outcome.label}
                                                                    </span>
                                                                    <span className={`font-mono font-bold text-sm ${outcome.colorClass}`}>
                                                                        {outcome.pnl > 0 ? '+' : ''}{outcome.pnl.toFixed(2)}
                                                                    </span>
                                                                </>
                                                            );
                                                        })()
                                                    ) : (
                                                        <>
                                                            <span className={`font-bold text-xs ${betData.status === 'WON' ? 'text-emerald-400' : 'text-red-400'}`}>
                                                                {betData.status === 'WON' ? 'GANADA' : 'PERDIDA'}
                                                            </span>
                                                            <span className={`font-mono font-bold text-sm ${betData.profit > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                                {betData.profit > 0 ? '+' : ''}{betData.profit?.toFixed(2)}
                                                            </span>
                                                        </>
                                                    )}

                                                    {/* BOTONES DE CORRECCIÓN (HOVER) */}
                                                    {!op.isBookyHistory && (
                                                        <div className="hidden group-hover:flex absolute inset-0 bg-slate-900/95 items-center justify-center gap-1 rounded z-10 border border-slate-700">
                                                             <button 
                                                                onClick={(e) => { e.stopPropagation(); requestSettle(betData.id, 'MANUAL'); }}
                                                                className="p-1 hover:bg-amber-500/20 text-amber-400 rounded"
                                                                title="Corregir Resultado"
                                                             >
                                                                <Edit className="w-3 h-3" />
                                                             </button>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : executionStatus === 'ACTIVE' ? (
                                                <span className="text-[10px] text-amber-400 animate-pulse font-bold">EN JUEGO</span>
                                            ) : (
                                                <span className="text-[10px] text-slate-600">--</span>
                                            )}
                                        </td>
                                    </tr>
                                )})
                             )}
                        </tbody>
                        {/* FOOTER TOTALES */}
                        {filteredOps.length > 0 && (
                            <tfoot className="bg-slate-900 font-bold text-slate-300 border-t-2 border-slate-700">
                                <tr>
                                    <td colSpan="5" className="p-3 text-right uppercase text-xs tracking-wider text-slate-500">
                                        Total Apostado (Fecha):
                                    </td>
                                    <td className="p-3 text-center">
                                        <div className="font-mono text-emerald-400 bg-emerald-900/10 px-2 py-1 rounded border border-emerald-500/20">
                                            S/. {filteredOps.reduce((acc, op) => {
                                                // Calcular total apostado REAL (si ya se ejecutó) o SUGERIDO (si es pending)
                                                // Priorizar stake real de activeBets/history
                                                const opSelection = op.selection || op.action;
                                                const historyMatch = portfolio.history.find(h => h.eventId === op.eventId && h.selection === opSelection);
                                                const activeMatch = portfolio.activeBets.find(b => b.eventId === op.eventId && b.selection === opSelection);
                                                const betData = historyMatch || activeMatch || op;
                                                
                                                const stake = betData.stake || betData.kellyStake || 0;
                                                return acc + stake;
                                            }, 0).toFixed(2)}
                                        </div>
                                    </td>
                                    <td className="p-3 text-center text-xs text-slate-500">
                                        {activeTab === 'FINISHED' ? (
                                            <div className={`font-mono font-bold px-2 py-1 rounded border w-fit mx-auto ${finishedSubtotal >= 0 ? 'bg-emerald-900/10 text-emerald-400 border-emerald-500/20' : 'bg-red-900/10 text-red-400 border-red-500/20'}`}>
                                                S/. {finishedSubtotal >= 0 ? '+' : ''}{finishedSubtotal.toFixed(2)}
                                            </div>
                                        ) : (
                                            `${filteredOps.length} Ops`
                                        )}
                                    </td>
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
                )}
            </section>
        </div>
      </main>
    </div>
  );
}

export default App;
