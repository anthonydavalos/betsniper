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

const formatTimeSafe = (candidate) => {
    const date = candidate ? new Date(candidate) : null;
    if (!date || !Number.isFinite(date.getTime())) return '--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
        fetchedAt: null
    });
    const [tokenHealth, setTokenHealth] = useState(null);
  
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
  
  // [NEW] Local optimismo state: IDs recently interacted with (USING REFS TO AVOID STALE CLOSURES IN INTERVAL)
  const localDiscardedIdsRef = useRef(new Set());
  const localPlacedBetIdsRef = useRef(new Set());
  const pendingBetDetailsRef = useRef({});

  // Trigger re-render when we update refs (hacky but works for instant feedback)
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick(t => t + 1);

  // --- API CALLS ---

    const fetchData = async ({ forceBookyRefresh = false } = {}) => {
    setLoading(true);
    try {
                        const bookyAccountUrl = forceBookyRefresh
                                ? '/api/booky/account?refresh=1&historyLimit=120'
                                : '/api/booky/account?historyLimit=120';

            const [liveReq, prematchReq, portfolioReq, bookyReq] = await Promise.allSettled([
                axios.get('/api/opportunities/live'),
                axios.get('/api/opportunities/prematch'),
                axios.get('/api/portfolio'),
                                axios.get(bookyAccountUrl)
            ]);

            if (bookyReq.status === 'fulfilled' && bookyReq.value?.data?.success) {
                    setBookyAccount(bookyReq.value.data);
            }

            if (liveReq.status !== 'fulfilled' || prematchReq.status !== 'fulfilled' || portfolioReq.status !== 'fulfilled') {
                    throw new Error('No se pudieron cargar los datos principales del dashboard.');
            }

            const liveRes = liveReq.value;
            const prematchRes = prematchReq.value;
            const portfolioRes = portfolioReq.value;

            try {
                    const tokenRes = await axios.get('/api/booky/token-health');
                    if (tokenRes?.data?.success) setTokenHealth(tokenRes.data.token);
            } catch (_) {
                    setTokenHealth(null);
            }

      // 1. First capture server active bets to use in filtering
      // Crear Set de IDs con formato único (eventId_selection) para filtrado granular
      let serverActiveBetIds = new Set();
      if (portfolioRes.data?.activeBets) {
          serverActiveBetIds = new Set(
              portfolioRes.data.activeBets.map(b => {
                  const eventId = String(b.eventId);
                  return `${eventId}_${normalizePick(b)}`;
              })
          );
      }

      if (liveRes.data?.data) {
          // [FIX] Filtrar con blacklist local para evitar parpadeo
          // Si el servidor aun trae un evento que acabamos de descartar o apostar, lo ocultamos
          const serverOps = liveRes.data.data;
          const cleanOps = serverOps.filter(op => {
              const id = getOpportunityId(op); // ID único por selección
              
              // A. Si está descartado localmente
              if (localDiscardedIdsRef.current.has(id)) return false;
              
              // B. Si está apostado localmente (optimistic)
              if (localPlacedBetIdsRef.current.has(id)) return false;
              
              // C. Si YA está en el portfolio del servidor (real)
              // Comparar ID completo (eventId + selection) para filtrado granular
              if (serverActiveBetIds.has(id)) return false;

              return true;
          });

          // [NEW] Calcular Tendencias de Cuotas (Flechas Arriba/Abajo)
          const enrichedOps = cleanOps.map(op => {
              const currentOdd = parseFloat(op.price || op.odd);
              if (!currentOdd) return op;

              const opKey = `${op.eventId}-${op.selection || op.action}`;
              const prevData = prevOddsRef.current[opKey];
              
              let trend = 'SAME'; // Valores: 'UP', 'DOWN', 'SAME'
              
              if (prevData) {
                  if (currentOdd > prevData.odd) trend = 'UP';
                  else if (currentOdd < prevData.odd) trend = 'DOWN';
                  else trend = prevData.trend; // Mantener estado anterior visualmente si no cambia
              }

              // Actualizar cache solo si cambió el valor o es nuevo
              if (!prevData || currentOdd !== prevData.odd) {
                  prevOddsRef.current[opKey] = { odd: currentOdd, trend, timestamp: Date.now() };
              }

              return { ...op, trend: prevOddsRef.current[opKey].trend };
          });

          setLiveOps(enrichedOps);
      }
      
      if (prematchRes.data?.data) {
           const serverOps = prematchRes.data.data;
           const cleanOps = serverOps.filter(op => {
              const id = getOpportunityId(op); // ID único por selección
              
              if (localDiscardedIdsRef.current.has(id)) return false;
              if (localPlacedBetIdsRef.current.has(id)) return false;
              if (serverActiveBetIds.has(id)) return false; // Comparar ID completo
              return true;
           });
           setPrematchOps(cleanOps);
      }

      if (portfolioRes.data) {
          // [MOD] Optimistic merge: Si tenemos apuestas locales pendientes que aun no estan en el server, las mantenemos
          const serverActiveBets = portfolioRes.data.activeBets || [];
          
          // Crear Set de IDs con formato único (eventId_selection) para matching correcto
          const serverIds = new Set(
              serverActiveBets.map(b => {
                  const eventId = String(b.eventId);
                  return `${eventId}_${normalizePick(b)}`;
              })
          );
          
          // Mantener locales solo si NO han llegado del server aun
          const stillPendingLocalIds = [];
          localPlacedBetIdsRef.current.forEach(id => {
              if (!serverIds.has(id)) stillPendingLocalIds.push(id);
              else localPlacedBetIdsRef.current.delete(id); // Limpiar si ya llegó
          });
          
          setPortfolio(prevPortfolio => ({
              ...portfolioRes.data,
              // Fucionar las apuestas reales con las "fantasma" locales para que sigan apareciendo en la UI como "Apostadas"
              activeBets: [
                  ...serverActiveBets,
                  // Reconstruir objetos "Fake/Optimistic" para la UI
                  ...stillPendingLocalIds.map(id => {
                        // Intentar recuperar la data original del evento si es posible
                        const originalOp = pendingBetDetailsRef.current[id];
                        return {
                            eventId: id,
                            match: originalOp ? originalOp.match : "Procesando...",
                            league: originalOp ? originalOp.league : "...",
                            selection: originalOp?.selection || originalOp?.action || "...",
                            market: originalOp?.market || "...",
                            type: originalOp?.type || "LIVE_SNIPE",
                            odd: originalOp?.odd || originalOp?.price || 0,
                            price: originalOp?.price || originalOp?.odd || 0,
                            stake: originalOp?.kellyStake || 0,
                            kellyStake: originalOp?.kellyStake || 0,
                            ev: originalOp?.ev || 0,
                            realProb: originalOp?.realProb || 0,
                            potentialReturn: (originalOp?.kellyStake || 0) * (originalOp?.odd || originalOp?.price || 1),
                            isOptimistic: true, // Flag para UI
                            liveTime: originalOp?.time || originalOp?.liveTime || "Live",
                            score: originalOp?.score,
                            pinnacleInfo: originalOp?.pinnacleInfo,
                            pinnaclePrice: originalOp?.pinnaclePrice,
                            createdAt: new Date().toISOString()
                        };
                  })
              ]
          }));
      }

    } catch (err) {
      console.error("Error fetching data", err);
    } finally {
      setLoading(false);
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
    fetchData(); // Initial load
    const interval = setInterval(fetchData, 2000); // UI Polling rapido (2s) para recibir data del backend
    return () => clearInterval(interval);
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
    const newOps = liveOps.filter(op => !prevLiveOpsIdsRef.current.has(getOpportunityId(op)));

    if (newOps.length > 0) {
        const hasSnipe = newOps.some(op => op.type === 'LIVE_SNIPE' || op.strategy === 'LIVE_SNIPE');
        console.log(`🔔 ${newOps.length} Nueva(s) Oportunidad(es) Detectada(s) - Sonido: ${hasSnipe ? 'SNIPE' : 'DEFAULT'}`);
        playAlert(hasSnipe ? 'SNIPE' : 'DEFAULT');
    }

    prevLiveOpsIdsRef.current = currentIds;
  }, [liveOps]);

    const realBalanceAmount = Number(bookyAccount?.balance?.amount);
    const realBalanceCurrency = String(bookyAccount?.balance?.currency || 'PEN').toUpperCase();
    const activeBookyLabel = String(bookyAccount?.profile || bookyAccount?.integration || 'booky').toUpperCase();
    const settledStatuses = new Set([1, 2, 4, 8, 18]);
    const realBookyPnL = (Array.isArray(bookyAccount?.history) ? bookyAccount.history : []).reduce((acc, row) => {
        const status = Number(row?.status);
        if (!Number.isFinite(status) || !settledStatuses.has(status)) return acc;

        const stake = Number(row?.stake);
        const payout = Number(row?.payout);
        const potentialReturn = Number(row?.potentialReturn);

        const safeStake = Number.isFinite(stake) ? stake : 0;
        let returnAmount = 0;

        if (Number.isFinite(payout) && payout > 0) {
            returnAmount = payout;
        } else if (Number.isFinite(potentialReturn) && potentialReturn > 0) {
            returnAmount = potentialReturn;
        } else if (status === 4 || status === 18) {
            returnAmount = safeStake;
        }

        return acc + (returnAmount - safeStake);
    }, 0);
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
    const [tokenRenewing, setTokenRenewing] = useState(false);
    const tokenRenewingRef = useRef(false);

  const handleTokenRenewGuide = async () => {
      if (tokenRenewingRef.current) return;
      tokenRenewingRef.current = true;
      setTokenRenewing(true);

      try {
          const renewRes = await axios.post('/api/booky/token/renew', undefined, { timeout: 3500 });
          if (renewRes?.data?.busy) {
              alert(
                  '⏳ Ya hay una renovación iniciándose en segundo plano.\n\n' +
                  'Si Chrome no aparece en ~10s, cierra ventanas de Chrome bloqueadas y reintenta.'
              );
              return;
          }
          if (renewRes?.data?.success && renewRes?.data?.started) {
              alert(
                  '🚀 Se abrió Chrome automáticamente para renovar token.\n\n' +
                  '1) Inicia sesión en Altenar\n' +
                  '2) Navega por sportsbook\n' +
                  '3) Cierra Chrome para completar captura\n\n' +
                  `Perfil detectado: ${renewRes?.data?.profile || tokenProfile || 'desconocido'}`
              );
              return;
          }
      } catch (_) {}

      try {
          await navigator.clipboard.writeText(tokenRenewCommand);
          alert(
              '📋 Comando copiado al portapapeles.\n\n' +
              `Pégalo en tu terminal:\n${tokenRenewCommand}\n\n` +
              `Perfil detectado: ${tokenProfile || 'desconocido'}\n\n` +
              '1) Inicia sesión en Chrome\n' +
              '2) Navega por sportsbook\n' +
              '3) Cierra Chrome para completar captura'
          );
      } catch (_) {
          alert(
              'No se pudo copiar automáticamente.\n\n' +
              `Ejecuta manualmente:\n${tokenRenewCommand}`
          );
      } finally {
          tokenRenewingRef.current = false;
          setTokenRenewing(false);
      }
  };

  // --- MANUAL PLACEMENT ---
  const [processingBets, setProcessingBets] = useState(new Set());
    const processingBetsRef = useRef(new Set());

  const handlePlaceBet = async (opportunity) => {
    const id = getOpportunityId(opportunity); // ID único por selección (eventId + selection)
    
        // Evitar doble clic (lock inmediato con ref para evitar race de setState)
        if (processingBetsRef.current.has(id)) return;
        processingBetsRef.current.add(id);
    
    // UI Optimista: Añadir a procesando
    setProcessingBets(prev => new Set(prev).add(id));
    
    // [NEW] Añadir a localPlacedBetIds (REF) para que fetchData lo filtre de la lista de oportunidades inmediatamente
    localPlacedBetIdsRef.current.add(id);
    pendingBetDetailsRef.current[id] = opportunity;
    forceUpdate(); // Forzar re-render inmediato para ocultarlo de la lista

    try {
        // Optimización UX: no bloquear el flujo por token-health lento.
        // El backend vuelve a validar token en confirmación real.
        const tokenHealthPromise = axios
            .get('/api/booky/token-health', { timeout: 3500 })
            .catch(() => null);

        const prepRes = await axios.post('/api/booky/prepare', opportunity, { timeout: 12000 });
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
            ...(ticket?.opportunity || {})
        };
        forceUpdate();

        const odd = Number(ticket?.opportunity?.price || ticket?.opportunity?.odd || 0);
        const stake = Number(ticket?.opportunity?.kellyStake || 0);
        const tokenMins = Number(token?.remainingMinutes || 0);
        const tokenLine = tokenCheckAvailable
            ? `Token restante: ${tokenMins.toFixed(1)} min\n\n`
            : 'Token: verificación rápida no disponible (se validará al confirmar)\n\n';

        const ok = window.confirm(
            `Apuesta REAL Booky\n\n` +
            `Partido: ${ticket?.opportunity?.match || '-'}\n` +
            `Selección: ${ticket?.opportunity?.selection || '-'}\n` +
            `Cuota: ${odd.toFixed(2)}\n` +
            `Stake: S/. ${stake.toFixed(2)}\n` +
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
        const confirmRes = await axios.post(`/api/booky/real/${confirmMode}/${ticket.id}`, undefined, { timeout: 30000 });
        if (confirmRes.data?.success) {
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
                confirmedAt: new Date().toISOString()
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
                await fetchData();
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
                    await fetchData();
                } else {
                    const normalizedMsg = String(msg || '').toLowerCase();
                    if (normalizedMsg.includes('ticket no encontrado')) {
                        alert('⚠️ El ticket ya no existe (posible doble clic o desincronización temporal).\nActualiza datos y vuelve a intentar con la oportunidad vigente.');
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

        const bookyHistoryData = settledBookyHistory.map((h, idx) => ({
            ...h,
            id: h.ticketId || `booky_${idx}`,
            date: h.placedAt || new Date().toISOString(),
            isFinished: true,
            isBookyHistory: true,
            type: String(h.type || h.strategy || h.opportunityType || 'BOOKY_REAL').toUpperCase(),
            finalScore: resolveBookyFinalScore(h),
            liveTime: resolveBookyGameTime(h)
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

  const getFilteredData = () => {
    let data = [];
    
    if (activeTab === 'LIVE') {
        // 1. Oportunidades detectadas (Scanner)
        const ops = [...liveOps];

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

        return [...ops, ...activePlayingBets].sort((a,b) => {
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
        const dayPrematch = prematchOps.filter(op => {
             if (!isSameDay(new Date(op.date), dateFilter)) return false;
             
             // Evitar que aparezca en "Todos" si ya está en "Live"
             const isLive = liveOps.some(liveOp => 
                 String(liveOp.eventId) === String(op.eventId) || 
                 String(liveOp.pinnacleId) === String(op.pinnacleId)
             );
             return !isLive;
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
             const existsInLive = liveOps.some(op => op.eventId === bet.eventId);
             const existsInPrematch = dayPrematch.some(op => op.eventId === bet.eventId);
             
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

        data = [...data, ...dayPrematch, ...dayActiveBets];
        
        // Ordenar por hora
        data.sort((a,b) => new Date(a.date) - new Date(b.date));

        return data;
    }
  };

    const filteredOps = getFilteredData();
    const finishedTabCount = getFinishedDataForSelectedDate().length;

    const finishedSubtotal = activeTab === 'FINISHED'
        ? filteredOps.reduce((acc, op) => acc + resolveFinishedOpPnl(op), 0)
        : 0;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6 font-sans text-sm">
      
      {/* --- HEADER --- */}
      <header className="max-w-7xl mx-auto mb-8">
        <div className="flex flex-col md:flex-row justify-between items-center border-b border-slate-700 pb-6 gap-6">
            <div className="flex items-center gap-3">
                <Trophy className="w-8 h-8 text-emerald-400" />
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">BetSniper <span className="text-emerald-400">Pro</span></h1>
                    <p className="text-slate-400 text-xs">Algorithmic Trading System</p>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <div className="flex gap-4 items-center bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-xl">
                    <div className="text-right border-r border-slate-700 pr-4">
                        <p className="text-[10px] text-slate-500 uppercase font-bold">Capital Actual</p>
                        <p className="text-2xl font-mono font-bold text-white flex items-center justify-end">
                            <span className="text-base text-slate-500 mr-1">{realBalanceCurrency}</span>
                            {Number.isFinite(realBalanceAmount) ? realBalanceAmount.toFixed(2) : '--'}
                        </p>
                    </div>
                    <div className="text-left pl-2">
                        <p className="text-[10px] text-slate-500 uppercase font-bold">PnL Real ({activeBookyLabel})</p>
                        <p className={`text-lg font-mono font-bold flex items-center ${realBookyPnLClass}`}>
                            {realBookyPnL >= 0 ? '+' : ''}{realBookyPnL.toFixed(2)}
                            <TrendingUp className="w-4 h-4 ml-1" />
                        </p>
                    </div>
                    
                    <div className="flex gap-1 ml-2 pl-4 border-l border-slate-700">
                         <button 
                            onClick={playAlert} 
                            className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-amber-400 transition-colors"
                            title="Probar Sonido"
                        >
                            <Volume2 className="w-4 h-4" />
                        </button>
                        <button 
                            onClick={() => fetchData({ forceBookyRefresh: true })} 
                            className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors relative"
                            title="Actualizar Datos"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
                        </button>
                        <button 
                            onClick={resetPortfolio}
                            className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-red-400 transition-colors"
                            title="Resetear Simulación"
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className={`flex items-center justify-between px-3 py-2 rounded-lg border ${tokenHealthy ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                    <div className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${tokenHealthy ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
                        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-200">Booky Token</span>
                    </div>
                    <div className="flex items-center gap-3">
                        {!tokenHealthy && (
                            <button
                                onClick={handleTokenRenewGuide}
                                disabled={tokenRenewing}
                                className={`px-2 py-1 rounded border text-[10px] font-bold uppercase tracking-wide transition-colors ${tokenRenewing ? 'border-amber-400/20 text-amber-200/60 bg-amber-500/10 cursor-not-allowed' : 'border-amber-400/50 text-amber-300 hover:bg-amber-500/20'}`}
                                title="Copiar comando de renovación"
                            >
                                {tokenRenewing ? 'Abriendo...' : 'Renovar Token'}
                            </button>
                        )}
                        <div className="text-right">
                        <p className={`text-xs font-bold ${tokenHealthy ? 'text-emerald-300' : 'text-amber-300'}`}>
                            {tokenHealthy ? 'Listo para apostar' : 'Renovar token'}
                        </p>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide">
                            Perfil:{' '}
                            <span className={`font-bold ${tokenProfile === 'acity' ? 'text-blue-300' : tokenProfile === 'doradobet' ? 'text-emerald-300' : 'text-slate-300'}`}>
                                {tokenProfile ? tokenProfile.toUpperCase() : 'N/A'}
                            </span>
                        </p>
                        <p className="text-[10px] text-slate-400 font-mono">
                            {Number.isFinite(tokenRemainingMinutes) ? `${tokenRemainingMinutes.toFixed(1)} min` : 'sin datos'}
                        </p>
                        </div>
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
                    Todos <span className="text-[10px] bg-slate-900 px-1.5 rounded-full text-slate-400" title="Oportunidades Pre-Match">{prematchOps.length}</span>
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
                                    
                                    const isLive =
                                        activeTab !== 'FINISHED' &&
                                        !op.isBookyHistory &&
                                        !isBookySettledByStatus &&
                                        !isStatusCompleted &&
                                        !isExplicitlyFinished &&
                                        (isReallyLiveType || (new Date(op.date) < new Date() && !op.isFinished && minutesElapsed < 150));
                                    
                                    // Búsqueda en historial para ver si esta operación fue ejecutada
                                    // Fix: Linkeo robusto por eventId + selection (manejo de fallback)
                                    const opSelection = op.selection || op.action;
                                    const historyMatch = portfolio.history.find(h => h.eventId === op.eventId && h.selection === opSelection);
                                    const activeMatch = portfolio.activeBets.find(b => b.eventId === op.eventId && b.selection === opSelection);
                                    
                                    const executionStatus = op.isBookyHistory ? 'FINISHED' : (historyMatch ? 'FINISHED' : (activeMatch ? 'ACTIVE' : 'PENDING'));
                                    const betData = op.isBookyHistory ? op : (historyMatch || activeMatch || op);
                                    const eventStartIso = op.isBookyHistory ? (resolveBookyEventStartIso(op) || resolveOpEventStartIso(op)) : resolveOpEventStartIso(op);
                                    const ticketIdForRow = resolveOpTicketId(betData) || resolveOpTicketId(op);
                                    const betTimeIso = resolveOpBetTimeIso(betData, op);
                                    const marketLabel = normalizeMarketLabel(op.market);
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
                                        (typeUnknown && hasLiveSignal);
                                    const showPrematchBadge =
                                        effectiveType === 'PREMATCH_VALUE' ||
                                        (typeUnknown && !hasLiveSignal);
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
                                                       {op.liveTime || op.pinnacleInfo?.time || op.time || (
                                                            (minutesElapsed > 90 ? `90'+` : `${minutesElapsed}'`)
                                                       )}
                                                    </span>
                                                    {/* SCORE con Prioridad a lastKnownScore (actualizado en tiempo real) */}
                                                    <span className="font-mono font-bold text-white text-xs pl-0.5">
                                                        {op.lastKnownScore || op.pinnacleInfo?.score || (Array.isArray(op.score) ? op.score.join(' - ') : op.score || '0 - 0')}
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
                                            {(isLive || showFinished || executionStatus === 'FINISHED') && (
                                                <div className="mb-1">
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
                                                </div>
                                            )}
                                            <div className="text-slate-200 font-bold text-sm text-wrap max-w-50 md:max-w-none">{op.match}</div>
                                            {(op.isBookyHistory || activeTab === 'LIVE' || ticketIdForRow) ? (
                                                <div className="text-slate-500 text-[10px] flex gap-2 flex-wrap items-center">
                                                    <span>{op.league || '-'}</span>
                                                    <span className="text-slate-600">|</span>
                                                    <span>{formatTimeSafe(betTimeIso || op.date)}</span>
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
                                            {(op.pinnacleInfo?.prematchContext) && (
                                                <div className="flex flex-wrap gap-1 mt-1.5 opacity-90">
                                                    {/* 1x2 Badge */}
                                                    {(op.pinnacleInfo.prematchContext.home || op.pinnacleInfo.prematchContext.draw || op.pinnacleInfo.prematchContext.away) && (
                                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50 text-[9px] font-mono text-slate-300" title="Pre-Match 1x2 Odds (Pinnacle)">
                                                            <span className="text-blue-400 font-sans font-bold">1x2</span>
                                                            <span className={op.pinnacleInfo.prematchContext.home < 2.0 ? "text-blue-300 font-bold" : ""}>{op.pinnacleInfo.prematchContext.home?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={op.pinnacleInfo.prematchContext.draw < 3.0 ? "text-amber-400" : ""}>{op.pinnacleInfo.prematchContext.draw?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={op.pinnacleInfo.prematchContext.away < 2.0 ? "text-blue-300 font-bold" : ""}>{op.pinnacleInfo.prematchContext.away?.toFixed(2) || '-'}</span>
                                                        </div>
                                                    )}
                                                    
                                                    {/* Totals 2.5 Badge */}
                                                    {(op.pinnacleInfo.prematchContext.over25 || op.pinnacleInfo.prematchContext.under25) && (
                                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50 text-[9px] font-mono text-slate-300" title="Pre-Match Over/Under 2.5 (Pinnacle)">
                                                            <span className="text-blue-400 font-sans font-bold">2.5</span>
                                                            <span className={op.pinnacleInfo.prematchContext.over25 < 1.8 ? "text-blue-300 font-bold" : ""}>O:{op.pinnacleInfo.prematchContext.over25?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={op.pinnacleInfo.prematchContext.under25 < 1.8 ? "text-blue-300 font-bold" : ""}>U:{op.pinnacleInfo.prematchContext.under25?.toFixed(2) || '-'}</span>
                                                        </div>
                                                    )}
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
                                                    {(op.pinnaclePrice && op.pinnaclePrice > 1) ? (
                                                        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/20 w-fit relative overflow-visible shadow-[0_0_10px_rgba(59,130,246,0.05)]" title="Pinnacle (Cuota en Vivo - Snapshot)">
                                                            <span className="text-[9px] font-bold text-blue-400 tracking-tighter">PIN</span>
                                                            <span className="font-mono font-bold text-sm text-blue-300 leading-none">{op.pinnaclePrice.toFixed(2)}</span>
                                                            
                                                            {/* INDICADORES LIVE O TENDENCIA (MISMA POSICIÓN) - Modificado para parpadear igual que Altenar */}
                                                            {op.trend === 'UP' ? (
                                                                <span className="absolute -top-1 -right-1 text-emerald-400 text-[8px] z-50 drop-shadow-sm font-bold animate-pulse leading-none">
                                                                    ▲
                                                                </span>
                                                            ) : op.trend === 'DOWN' ? (
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
                                                    {isLive && (
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
                                             {executionStatus === 'FINISHED' ? (
                                                 <span className="text-slate-500 font-mono text-xs">-</span>
                                             ) : (
                                                <span className={`px-1.5 py-0.5 rounded font-bold ${op.ev > 5 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                    +{op.ev ? op.ev.toFixed(1) : '0.0'}%
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
