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
        const line = parseFloat((selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/) || [0])[0]);
        return `over_${Number.isNaN(line) ? 0 : line}`;
    }

    if (combined.includes('UNDER') || combined.includes('MENOS')) {
        const line = parseFloat((selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/) || [0])[0]);
        return `under_${Number.isNaN(line) ? 0 : line}`;
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
    const [tokenHealth, setTokenHealth] = useState(null);
    const [kellyDiagnostics, setKellyDiagnostics] = useState(null);
  
  const [loading, setLoading] = useState(false);
  
  // NAVEGACIÓN TIPO FLASHSCORE
  const [activeTab, setActiveTab] = useState('ALL'); // 'ALL', 'LIVE', 'FINISHED', 'MATCHER'
  const [dateFilter, setDateFilter] = useState(new Date());
  const [finishedSelectionView, setFinishedSelectionView] = useState(() => {
      try {
          const stored = localStorage.getItem('finishedSelectionView');
          if (stored === 'HYBRID' || stored === 'BOOKY' || stored === 'CANONICAL') return stored;
      } catch (_) {}
      return 'HYBRID';
  }); // HYBRID | BOOKY | CANONICAL

  // Refs para control de notificaciones
  const isFirstLoad = useRef(true);
    const prevLiveOpsIdsRef = useRef(new Set());
  const prevOddsRef = useRef({}); // [NEW] Cache para detectar tendencias de cuotas
        const latestLiveCandidatesByKeyRef = useRef(new Map());
          const stickyPinnacleByKeyRef = useRef(new Map());
        const lastAlertedLiveOpAtRef = useRef(new Map());
    const fetchInFlightRef = useRef(false);
    const prematchFetchInFlightRef = useRef(false);
    const lastBookyAccountFetchAtRef = useRef(0);
    const lastKellyDiagnosticsFetchAtRef = useRef(0);
    const lastPrematchFetchAtRef = useRef(0);
    const latestPortfolioActiveBetsRef = useRef([]);
    const latestBookyHistoryRef = useRef([]);
    const blockedBetIdsRef = useRef(new Set());
    const remoteOpenBetIdsRef = useRef(new Set());
    const remoteOpenEventIdsRef = useRef(new Set());

    const CORE_POLL_MS = 2000;
    const PREMATCH_POLL_MS = 30000;
    const BOOKY_HISTORY_LIMIT = 120;
  
  // [NEW] Local optimismo state: IDs recently interacted with (USING REFS TO AVOID STALE CLOSURES IN INTERVAL)
  const localDiscardedIdsRef = useRef(new Set());
  const localPlacedBetIdsRef = useRef(new Set());
  const pendingBetDetailsRef = useRef({});
    const optimisticWarnedIdsRef = useRef(new Set());

  // Trigger re-render when we update refs (hacky but works for instant feedback)
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick(t => t + 1);

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

  // --- API CALLS ---

        const fetchData = async ({ forceBookyRefresh = false } = {}) => {
        if (fetchInFlightRef.current) return;
        fetchInFlightRef.current = true;
        setLoading(true);

        try {
            const nowMs = Date.now();
            const shouldFetchBooky = forceBookyRefresh || (nowMs - lastBookyAccountFetchAtRef.current) >= 15000;
            const shouldFetchKellyDiagnostics = forceBookyRefresh || (nowMs - lastKellyDiagnosticsFetchAtRef.current) >= 60000;
            const bookyAccountUrl = forceBookyRefresh
                ? `/api/booky/account?refresh=1&historyLimit=${BOOKY_HISTORY_LIMIT}`
                : `/api/booky/account?historyLimit=${BOOKY_HISTORY_LIMIT}`;

            const settled = await Promise.allSettled([
                axios.get('/api/opportunities/live'),
                axios.get('/api/portfolio')
            ]);
            const [liveReq, portfolioReq] = settled;

            if (shouldFetchBooky) {
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
                    const hasFreshRemoteCheck = (Date.now() - Number(lastBookyAccountFetchAtRef.current || 0)) <= 25000;

                    const confirmedAtMs = new Date(optimisticMeta?.optimisticConfirmedAt || 0).getTime();
                    const hasConfirmedMark = Number.isFinite(confirmedAtMs) && confirmedAtMs > 0;
                    const shouldExpireByTtl = ageMs >= optimisticTtlMs;

                    if (isInFlight) {
                        stillPendingLocalIds.push(id);
                        return;
                    }

                    if (hasConfirmedMark) {
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
                            const reasonText = 'no apareció en Booky dentro de la ventana de gracia extendida.';
                            alert(
                                `⚠️ Apuesta no confirmada en Booky (${reasonText})\n\n` +
                                'Se retiró de EN JUEGO para evitar stake fantasma.\n' +
                                'Verifica Open Bets en Booky antes de reintentar.'
                            );
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
    };

    bootstrap();

    const coreInterval = setInterval(() => {
        fetchData();
    }, CORE_POLL_MS);

    const prematchInterval = setInterval(() => {
        fetchPrematchData();
    }, PREMATCH_POLL_MS);

    return () => {
        isUnmounted = true;
        clearInterval(coreInterval);
        clearInterval(prematchInterval);
    };
  }, []);

    useEffect(() => {
            try {
                    localStorage.setItem('finishedSelectionView', finishedSelectionView);
            } catch (_) {}
    }, [finishedSelectionView]);

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
    const pnlFromSnapshot = Number(bookyAccount?.pnl?.netAfterOpenStake);
    const pnlFromSnapshotTotal = Number(bookyAccount?.pnl?.total);
    const pnlFromSnapshotRealized = Number(bookyAccount?.pnl?.realized);
    const realBookyPnL = Number.isFinite(pnlFromSnapshot)
        ? pnlFromSnapshot
        : (Number.isFinite(pnlFromSnapshotTotal) ? pnlFromSnapshotTotal : (Number.isFinite(pnlFromSnapshotRealized) ? pnlFromSnapshotRealized : 0));
    const realBookyPnLClass = realBookyPnL >= 0 ? 'text-emerald-400' : 'text-red-400';
    const tokenRemainingMinutes = Number(tokenHealth?.remainingMinutes);
    const tokenProfile = String(tokenHealth?.profile || tokenHealth?.integration || '').toLowerCase();
    const tokenRenewCommand = tokenProfile === 'acity'
            ? 'npm run token:booky:acity:wait-close'
            : tokenProfile === 'doradobet'
                    ? 'npm run token:booky:dorado:wait-close'
                    : (tokenHealth?.renewalCommand || 'npm run token:booky:wait-close');
    const tokenHealthy = Boolean(
            tokenHealth?.exists &&
            tokenHealth?.jwtValid &&
            tokenHealth?.authenticated &&
            !tokenHealth?.expired &&
            Number.isFinite(tokenRemainingMinutes) &&
            tokenRemainingMinutes >= Number(tokenHealth?.minRequiredMinutes || 2)
    );
        const kellyBaseAmount = Number(kellyDiagnostics?.bankrollBase?.amount);
        const kellyBaseCurrency = String(bookyAccount?.balance?.currency || 'PEN').toUpperCase();
        const kellyBaseMode = String(kellyDiagnostics?.bankrollBase?.baseMode || '--').toUpperCase();
        const kellyExposurePressurePct = Number(kellyDiagnostics?.simultaneity?.exposurePressure);
        const kellyPrematchRuin = Number(kellyDiagnostics?.riskOfRuin?.PREMATCH_VALUE?.probability);
        const kellyLiveRuin = Number(kellyDiagnostics?.riskOfRuin?.LIVE_VALUE?.probability);
        const kellyRecPrematch = Number(kellyDiagnostics?.fractions?.recommended?.PREMATCH_VALUE);
        const kellyRecLive = Number(kellyDiagnostics?.fractions?.recommended?.LIVE_VALUE);
        const kellyDiagTime = kellyDiagnostics?.fetchedAt;
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
              const isHealthyToken = (token = null) => Boolean(
                  token?.exists &&
                  token?.jwtValid &&
                  token?.authenticated &&
                  !token?.expired &&
                  Number.isFinite(Number(token?.remainingMinutes)) &&
                  Number(token?.remainingMinutes) >= Number(token?.minRequiredMinutes || 2)
              );

              for (let i = 0; i < 12; i += 1) {
                  await new Promise(resolve => setTimeout(resolve, 1500));
                  try {
                      const tokenRes = await axios.get('/api/booky/token-health', { timeout: 3500 });
                      if (tokenRes?.data?.success) {
                          setTokenHealth(tokenRes.data.token);
                          if (isHealthyToken(tokenRes.data.token)) {
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

  const handlePlaceBet = async (opportunity) => {
    const id = getOpportunityId(opportunity); // ID único por selección (eventId + selection)
        const optimisticIsSnipe = String(opportunity?.type || opportunity?.strategy || '').toUpperCase() === 'LIVE_SNIPE';

        const releaseLocalOptimisticLock = () => {
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            optimisticWarnedIdsRef.current.delete(id);
            forceUpdate();
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
        optimisticInFlight: true,
        optimisticFlow: 'preparing',
        optimisticConfirmedAt: null,
        optimisticMissingRemoteChecks: 0
    };
    forceUpdate(); // Forzar re-render inmediato para ocultarlo de la lista

    try {
        // Optimización UX: no bloquear el flujo por token-health lento.
        // El backend vuelve a validar token en confirmación real.
        const tokenHealthPromise = axios
            .get('/api/booky/token-health', { timeout: 3500 })
            .catch(() => null);

        const prepareTimeoutMs = 45000;
        const doPrepare = () => axios.post('/api/booky/prepare', opportunity, { timeout: prepareTimeoutMs });
        const recoverPreparedTicket = async () => {
            const ticketsRes = await axios.get('/api/booky/tickets', { timeout: 7000 });
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

        if (tokenCheckAvailable && (!token?.authenticated || token?.expired)) {
            const reason = token?.expired ? 'token vencido' : 'token no autenticado';
            await axios.post(`/api/booky/cancel/${ticket.id}`).catch(() => {});
            alert(`⚠️ No se puede apostar en Booky: ${reason}. Renueva token y reintenta.`);
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
            return;
        }

        pendingBetDetailsRef.current[id] = {
            ...opportunity,
            ...(ticket?.opportunity || {}),
            optimisticCreatedAt: pendingBetDetailsRef.current[id]?.optimisticCreatedAt || Date.now(),
            optimisticTtlMs: pendingBetDetailsRef.current[id]?.optimisticTtlMs || (optimisticIsSnipe ? OPTIMISTIC_BET_TTL_SNIPE_MS : OPTIMISTIC_BET_TTL_MS),
            optimisticIsSnipe,
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
        const tokenMins = Number(token?.remainingMinutes || 0);
        const tokenLine = tokenCheckAvailable
            ? `Token restante: ${tokenMins.toFixed(1)} min\n\n`
            : 'Token: verificación rápida no disponible (se validará al confirmar)\n\n';

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

        const refreshBlock = `${refreshLines.join('\n')}\n\n`;

        const ok = window.confirm(
            `Apuesta REAL Booky\n\n` +
            `Partido: ${ticket?.opportunity?.match || '-'}\n` +
            `Selección: ${ticket?.opportunity?.selection || '-'}\n` +
            refreshBlock +
            tokenLine +
            `¿Confirmar envío REAL a Booky?`
        );

        if (!ok) {
            await axios.post(`/api/booky/cancel/${ticket.id}`);
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
            return;
        }

        const isLiveSnipe = String(ticket?.opportunity?.type || opportunity?.type || '').toUpperCase() === 'LIVE_SNIPE';
        const confirmMode = isLiveSnipe ? 'confirm-fast' : 'confirm';

        if (pendingBetDetailsRef.current[id]) {
            pendingBetDetailsRef.current[id] = {
                ...pendingBetDetailsRef.current[id],
                optimisticInFlight: true,
                optimisticFlow: 'confirming'
            };
            forceUpdate();
        }

        const confirmRes = await axios.post(`/api/booky/real/${confirmMode}/${ticket.id}`, undefined, { timeout: 30000 });
        if (confirmRes.data?.success) {
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
            const msg = confirmRes.data?.message || 'Error desconocido';
            alert(`⚠️ Confirmación real falló: ${msg}`);
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
                } else {
                    const normalizedMsg = String(msg || '').toLowerCase();
                    if (normalizedMsg.includes('ticket no encontrado')) {
                        alert('⚠️ El ticket ya no existe (posible doble clic o desincronización temporal).\nActualiza datos y vuelve a intentar con la oportunidad vigente.');
                        await fetchData({ forceBookyRefresh: true });
                    } else if (normalizedMsg.includes('timeout')) {
                        alert('⏳ La preparación del ticket tardó más de lo esperado (timeout).\nLa cuota puede seguir vigente: intenta nuevamente en 2-3 segundos.');
                        await fetchData({ forceBookyRefresh: true });
                    } else {
                    alert(`❌ Error de apuesta real: ${msg}${diagText}`);
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
        const settledBookyHistory = (Array.isArray(bookyAccount?.history) ? bookyAccount.history : [])
            .filter(h => BOOKY_SETTLED_STATUSES.has(Number(h?.status)));

        const portfolioHistoryRows = Array.isArray(portfolio?.history) ? portfolio.history : [];
        const historyByTicketId = new Map();
        const historyBySelectionKey = new Map();

        for (const row of portfolioHistoryRows) {
            const ticketId = resolveOpTicketId(row);
            if (ticketId) historyByTicketId.set(String(ticketId), row);

            const selectionKey = getOpportunityId(row);
            if (selectionKey) historyBySelectionKey.set(selectionKey, row);
        }

        const bookyHistoryData = settledBookyHistory.map((h, idx) => ({
            ...(() => {
                const ticketId = resolveOpTicketId(h);
                const selectionKey = getOpportunityId(h);
                const linkedByTicket = ticketId ? historyByTicketId.get(String(ticketId)) : null;
                const linkedBySelection = selectionKey ? historyBySelectionKey.get(selectionKey) : null;
                const linked = linkedByTicket || linkedBySelection || null;

                const evCandidate = Number(
                    h?.ev ??
                    linked?.ev ??
                    linked?.realPlacement?.ev ??
                    linked?.opportunity?.ev
                );

                return {
                    ...h,
                    id: h.ticketId || `booky_${idx}`,
                    date: h.placedAt || new Date().toISOString(),
                    isFinished: true,
                    isBookyHistory: true,
                    type: String(h.type || h.strategy || h.opportunityType || 'BOOKY_REAL').toUpperCase(),
                    finalScore: resolveBookyFinalScore(h),
                    liveTime: resolveBookyGameTime(h),
                    ev: Number.isFinite(evCandidate) ? evCandidate : null
                };
            })()
        }));

        if (bookyHistoryData.length > 0) {
            return bookyHistoryData
                .sort((a,b) => new Date(b.date) - new Date(a.date))
                .filter(op => isSameDay(new Date(op.date), dateFilter));
        }

        const historyData = portfolio.history.map(h => ({
            ...h,
            date: h.matchDate || h.createdAt || h.date || h.closedAt,
            isFinished: true
        }));

        const pendingFinishData = (portfolio.activeBets || []).filter(b => {
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
            manualStatus: 'WAIT_RES'
        }));

        const allFinished = [...pendingFinishData, ...historyData].sort((a,b) => new Date(b.date) - new Date(a.date));
        return allFinished.filter(op => isSameDay(new Date(op.date), dateFilter));
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
            // [MOD] Filtrar por TIPO: Solo mostrar apuestas de origen LIVE en la pestaña LIVE
            // PREMATCH bets que ya iniciaron se quedan en TODOS (User Request)
            const isLiveOrigin = bet.type === 'LIVE_SNIPE' || bet.type === 'LIVE_VALUE' || bet.type === 'LA_VOLTEADA' || bet.isLive;
            if (!isLiveOrigin) return false;

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
            const timingOrigin = resolvePlacementTimingOrigin(bet);
            const liveSignal = bet.liveTime || bet.time || '';
            const hasTrustedLiveClock = hasLiveClockSignal(liveSignal);
            const isLiveOrigin = isLiveOriginOpportunity(bet);

            // Si la apuesta fue realmente prematch y aún no hay señal de partido en juego,
            // no debe entrar a LIVE.
            if (timingOrigin.inferredPrematchByTiming && !hasTrustedLiveClock && !isLiveOrigin) return false;

            // Si ya hay señal live (timing o reloj), mostrarla en LIVE aunque el origen
            // histórico sea PREMATCH para evitar que "desaparezca" entre pestañas.
            return timingOrigin.inferredLiveByTiming || hasTrustedLiveClock || isLiveOrigin;
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

    } else if (activeTab === 'FINISHED') {
        return getFinishedDataForSelectedDate();
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
             // [MOD] User Request: Oportunidades Live NO deben salir en TOTALES (ALL), Solo en LIVE.
             // Así que filtramos y QUITAMOS las de origen Live aquí.
             const isLiveOrigin = bet.type === 'LIVE_SNIPE' || bet.type === 'LIVE_VALUE' || bet.type === 'LA_VOLTEADA' || bet.isLive;
             if (isLiveOrigin) return false;

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
    const remoteOpenBookyRows = (Array.isArray(bookyAccount?.history) ? bookyAccount.history : [])
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

    const finishedTabCount = getFinishedDataForSelectedDate().length;

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
                                <span className="text-sm text-slate-500 mr-1">{realBalanceCurrency}</span>
                                {Number.isFinite(realBalanceAmount) ? realBalanceAmount.toFixed(2) : '--'}
                            </p>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-0.5">PnL ({activeBookyLabel})</p>
                            <p className={`text-base font-mono font-bold flex items-center justify-end leading-none ${realBookyPnLClass}`}>
                                {realBookyPnL >= 0 ? '+' : ''}{realBookyPnL.toFixed(2)}
                            </p>
                        </div>
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
                <div className="bg-slate-800 border-b border-slate-700 px-3 py-2 flex items-center justify-end gap-2">
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
            )}

            {/* 3. CONTENIDO PRINCIPAL */}
            <section className="bg-slate-800 rounded-b-xl border border-slate-700 border-t-0 overflow-hidden shadow-lg min-h-100">
                
                {/* SI ESTAMOS EN MATCHER, RENDERIZAR COMPONENTE ESPECIAL */}
                {activeTab === 'MATCHER' ? (
                     <ManualMatcher />
                ) : activeTab === 'MONITOR' ? (
                     <MonitorDashboard />
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
                                    const isLive =
                                        activeTab !== 'FINISHED' &&
                                        !op.isBookyHistory &&
                                        !isBookySettledByStatus &&
                                        !isStatusCompleted &&
                                        !isExplicitlyFinished &&
                                        (isReallyLiveType || hasTrustedVisualLiveClock);
                                    const eventStartIso = op.isBookyHistory ? (resolveBookyEventStartIso(op) || resolveOpEventStartIso(op)) : resolveOpEventStartIso(op);
                                    const ticketIdForRow = resolveOpTicketId(betData) || resolveOpTicketId(op);
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
                                        (typeUnknown && !hasLiveSignal && inferredPrematchByTiming);
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
                                        'Enviar apuesta real a Booky',
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
                                                       {op.liveTime || effectivePinnacleInfo?.time || op.time || (
                                                            (minutesElapsed > 90 ? `90'+` : `${minutesElapsed}'`)
                                                       )}
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
                                                        {betData.finalScore || betData.lastKnownScore || betData.score || '?-?'}
                                                     </span>
                                                     {/* DATE BELOW SCORE */}
                                                     <span className="text-[9px] text-slate-500 leading-tight" title="Hora de Inicio">
                                                                          {formatTimeSafe(op.isBookyHistory ? (resolveBookyEventStartIso(op) || op.matchDate || op.date) : (op.matchDate || op.date))}
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
                                            {((isLive || showFinished || executionStatus === 'FINISHED') || (entryMeta && entryMeta.total > 1)) && (
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
                                            {(op.isBookyHistory || activeTab === 'LIVE' || ticketIdForRow) ? (
                                                <div className="text-slate-500 text-[10px] flex gap-2 flex-wrap items-center">
                                                    <span>{op.league || '-'}</span>
                                                    <span className="text-slate-600">|</span>
                                                    <span>{(entryMeta && entryMeta.total > 1) ? formatTimeWithSecondsSafe(betTimeIso || op.date) : formatTimeSafe(betTimeIso || op.date)}</span>
                                                    {ticketIdForRow && (
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
                                                                    Bloqueado: Booky no acepta apuestas &lt; S/. {REENTRY_MIN_STAKE_SOL.toFixed(2)}
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
                                                    <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border mb-1 ${
                                                        op.isBookyHistory
                                                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                                            : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                                                    }`}>
                                                        {op.isBookyHistory ? 'BOOKY' : 'API'}
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
