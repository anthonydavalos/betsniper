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

function playAlert() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1000, ctx.currentTime + 0.1);
    
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);

    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.error("Audio play failed", e);
  }
}

function App() {
  const [liveOps, setLiveOps] = useState([]);
  const [prematchOps, setPrematchOps] = useState([]);
  const [portfolio, setPortfolio] = useState({ balance: 100, activeBets: [], history: [] });
  
  const [loading, setLoading] = useState(false);
  
  // NAVEGACIÓN TIPO FLASHSCORE
  const [activeTab, setActiveTab] = useState('ALL'); // 'ALL', 'LIVE', 'FINISHED', 'MATCHER'
  const [dateFilter, setDateFilter] = useState(new Date());

  // Refs para control de notificaciones
  const isFirstLoad = useRef(true);
  const prevLiveOpsLength = useRef(0);
  const prevOddsRef = useRef({}); // [NEW] Cache para detectar tendencias de cuotas
  
  // [NEW] Local optimismo state: IDs recently interacted with (USING REFS TO AVOID STALE CLOSURES IN INTERVAL)
  const localDiscardedIdsRef = useRef(new Set());
  const localPlacedBetIdsRef = useRef(new Set());
  const pendingBetDetailsRef = useRef({});

  // Trigger re-render when we update refs (hacky but works for instant feedback)
  const [, setTick] = useState(0);
  const forceUpdate = () => setTick(t => t + 1);

  // --- API CALLS ---

  const fetchData = async () => {
    setLoading(true);
    try {
      const [liveRes, prematchRes, portfolioRes] = await Promise.all([
        axios.get('/api/opportunities/live'),
        axios.get('/api/opportunities/prematch'),
        axios.get('/api/portfolio')
      ]);

      // 1. First capture server active bets to use in filtering
      let serverActiveBetIds = new Set();
      if (portfolioRes.data?.activeBets) {
          serverActiveBetIds = new Set(portfolioRes.data.activeBets.map(b => String(b.eventId)));
      }

      if (liveRes.data?.data) {
          // [FIX] Filtrar con blacklist local para evitar parpadeo
          // Si el servidor aun trae un evento que acabamos de descartar o apostar, lo ocultamos
          const serverOps = liveRes.data.data;
          const cleanOps = serverOps.filter(op => {
              const id = String(op.eventId || op.id);
              
              // A. Si está descartado localmente
              if (localDiscardedIdsRef.current.has(id)) return false;
              
              // B. Si está apostado localmente (optimistic)
              if (localPlacedBetIdsRef.current.has(id)) return false;
              
              // C. [NEW] Si YA está en el portfolio del servidor (real)
              // Esto arregla el "flash" donde localPlaced se limpia pero liveOps aun trae la oportunidad vieja
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
              const id = String(op.eventId || op.id || op.matchId);
              if (localDiscardedIdsRef.current.has(id)) return false;
              if (localPlacedBetIdsRef.current.has(id)) return false;
              if (serverActiveBetIds.has(id)) return false; // [NEW] Filter strict checked
              return true;
           });
           setPrematchOps(cleanOps);
      }

      if (portfolioRes.data) {
          // [MOD] Optimistic merge: Si tenemos apuestas locales pendientes que aun no estan en el server, las mantenemos
          const serverActiveBets = portfolioRes.data.activeBets || [];
          const serverIds = new Set(serverActiveBets.map(b => String(b.eventId)));
          
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
                            strategy: "Procesando...",
                            type: "LIVE_SNIPE", // Default fake
                            stake: 0,
                            potentialReturn: 0,
                            isOptimistic: true, // Flag para UI
                            liveTime: originalOp?.time || "Live",
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

  // Effect para Notificaciones Sonoras (Nuevas Oportunidades Live)
  useEffect(() => {
    if (isFirstLoad.current) {
        isFirstLoad.current = false;
        prevLiveOpsLength.current = liveOps.length;
        return;
    }

    // Si hay más oportunidades que antes, sonó la campana
    if (liveOps.length > prevLiveOpsLength.current) {
        console.log("🔔 Nueva Oportunidad Detectada - Reproduciendo sonido...");
        playAlert();
    }

    prevLiveOpsLength.current = liveOps.length;
  }, [liveOps]);

  const initialCapital = portfolio.initialCapital || 1000;
  const totalProfit = portfolio.balance - initialCapital;
  const profitClass = totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400';

  // --- MANUAL PLACEMENT ---
  const [processingBets, setProcessingBets] = useState(new Set());

  const handlePlaceBet = async (opportunity) => {
    const id = String(opportunity.eventId || opportunity.id);
    
    // Evitar doble clic
    if (processingBets.has(id)) return;
    
    // UI Optimista: Añadir a procesando
    setProcessingBets(prev => new Set(prev).add(id));
    
    // [NEW] Añadir a localPlacedBetIds (REF) para que fetchData lo filtre de la lista de oportunidades inmediatamente
    localPlacedBetIdsRef.current.add(id);
    pendingBetDetailsRef.current[id] = opportunity;
    forceUpdate(); // Forzar re-render inmediato para ocultarlo de la lista

    try {
        const res = await axios.post('http://localhost:3000/api/portfolio/place-bet', opportunity);
        if (res.data.success) {
            // Sonido éxito
            const audio = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU..."); 
            // Mock sound, just UI Feedback needed
        } else {
            alert("⚠️ " + res.data.message);
            // Si falló, lo quitamos de la lista local para que reaparezca
            localPlacedBetIdsRef.current.delete(id);
            delete pendingBetDetailsRef.current[id];
            forceUpdate();
        }
    } catch (error) {
        console.error(error);
        alert("Error al conectar con el servidor.");
        // Si falló, lo quitamos de la lista local
        localPlacedBetIdsRef.current.delete(id);
        delete pendingBetDetailsRef.current[id];
        forceUpdate();
    } finally {
        setTimeout(() => {
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
      
      const eventId = String(op.eventId || op.id);
      if (!eventId) return;

      // Optimistic Updates: Remover de la UI inmediatamente
      // [NEW] Persistir en blacklist LOCAL (Ref) para que el próximo fetch no lo reviva
      localDiscardedIdsRef.current.add(eventId);

      if (activeTab === 'LIVE') {
          setLiveOps(prev => prev.filter(o => String(o.eventId || o.id) !== eventId));
      } else {
          setPrematchOps(prev => prev.filter(o => String(o.eventId || o.id) !== eventId));
      }

      try {
          await axios.post('http://localhost:3000/api/opportunities/discard', { id: eventId });
      } catch (e) {
          console.error("Error discarding opportunity:", e);
          // Si falla, revertimos el blacklist local
          localDiscardedIdsRef.current.delete(eventId);
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
        // 1. Historial Real (Ya liquidadas)
        const historyData = portfolio.history.map(h => ({
            ...h,
            // [FIX] Priorizar fecha de creación/evento real sobre fecha de cierre/liquidación
            // Para evitar que eventos viejos aparezcan en "Hoy" solo por haberse liquidado hoy.
            date: h.matchDate || h.createdAt || h.date || h.closedAt, 
            isFinished: true
        }));

        // 2. Activas "Maduras" (Probablemente finalizadas pero esperando API Results)
        // Criterio Mejorado: Usar liveTime y lastUpdate para ser más agresivos moviendo a "Finalizados"
        const pendingFinishData = (portfolio.activeBets || []).filter(b => {
             // Si el estado es explícitamente finalizado, mover
             if (b.liveTime === 'Final' || b.liveTime === 'FT') return true;

             const betTime = new Date(b.createdAt).getTime();
             const minutesSinceBet = (Date.now() - betTime) / 60000;
             
             // Si tiene liveTime (ej: "82'")
             if (b.liveTime) {
                 const lastKnownMinute = parseInt(b.liveTime) || 0;
                 // Tiempo desde la última actualización (feed vivo)
                 const lastUpdate = new Date(b.lastUpdate || b.createdAt).getTime();
                 const minutesSinceUpdate = (Date.now() - lastUpdate) / 60000;

                 // Si la última vez que lo vimos iba por el 15', 30'... es ACTIVE, no Finished.
                 // Solo mover a Finished si:
                 // A. Calculamos que ya pasó el minuto 105
                 const estimatedCurrentMinute = lastKnownMinute + minutesSinceUpdate;
                 // [FIX] Aumentar tolerancia para evitar mover partidos 90+ a finished prematuramente
                 if (estimatedCurrentMinute > 115) return true;
                 
                 // B. Estaba en min 80+ y hace más de 12 min no actualiza (se acabó feed)
                 // [FIX] Aumentar tolerancia de "feed perdido"
                 if (lastKnownMinute > 85 && minutesSinceUpdate > 15) return true;
             } else {
                // Fallback para PreMatch o Snipes sin tiempo capturado
                const eventStartTime = new Date(b.matchDate || b.createdAt).getTime();
                const minutesSinceStart = (Date.now() - eventStartTime) / 60000;
             
                // Si pasaron más de 140 minutos desde el inicio
                if (minutesSinceStart > 140) return true;
             }

             return false;
        }).map(b => ({
            ...b,
            date: b.createdAt,
            // Flag especial para que la tabla sepa renderizarlo diferente
            manualStatus: 'WAIT_RES' 
        }));

        // Ordenar por fecha reciente
        const allFinished = [...pendingFinishData, ...historyData].sort((a,b) => new Date(b.date) - new Date(a.date));
        
        // Filtro por fecha (solicitado por user)
        return allFinished.filter(op => isSameDay(new Date(op.date), dateFilter));
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

            <div className="flex gap-4 items-center bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-xl">
                <div className="text-right border-r border-slate-700 pr-4">
                    <p className="text-[10px] text-slate-500 uppercase font-bold">Capital Actual</p>
                    <p className="text-2xl font-mono font-bold text-white flex items-center justify-end">
                        <span className="text-base text-slate-500 mr-1">PEN</span>
                        {portfolio.balance.toFixed(2)}
                    </p>
                </div>
                <div className="text-left pl-2">
                    <p className="text-[10px] text-slate-500 uppercase font-bold">PnL Total</p>
                    <p className={`text-lg font-mono font-bold flex items-center ${profitClass}`}>
                        {totalProfit >= 0 ? '+' : ''}{totalProfit.toFixed(2)}
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
                        onClick={fetchData} 
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
                    <Layers className="w-4 h-4" /> Todos
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
                    <Archive className="w-4 h-4" /> Finalizados
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

            {/* 3. CONTENIDO PRINCIPAL */}
            <section className="bg-slate-800 rounded-b-xl border border-slate-700 border-t-0 overflow-hidden shadow-lg min-h-[400px]">
                
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
                                    
                                    const isLive = !isStatusCompleted && !isExplicitlyFinished && (isReallyLiveType || (new Date(op.date) < new Date() && !op.isFinished && minutesElapsed < 150));
                                    
                                    // Búsqueda en historial para ver si esta operación fue ejecutada
                                    // Fix: Linkeo robusto por eventId + selection (manejo de fallback)
                                    const opSelection = op.selection || op.action;
                                    const historyMatch = portfolio.history.find(h => h.eventId === op.eventId && h.selection === opSelection);
                                    const activeMatch = portfolio.activeBets.find(b => b.eventId === op.eventId && b.selection === opSelection);
                                    
                                    const executionStatus = historyMatch ? 'FINISHED' : (activeMatch ? 'ACTIVE' : 'PENDING');
                                    const betData = historyMatch || activeMatch || op; 

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
                                                       {/* Live Timer con Fallback a Pin Info (y op.liveTime si time falta) */}
                                                       {op.pinnacleInfo?.time || op.time || op.liveTime || (
                                                            (minutesElapsed > 90 ? `90'+` : `${minutesElapsed}'`)
                                                       )}
                                                    </span>
                                                    {/* SCORE con Prioridad Pinnacle si existe */}
                                                    <span className="font-mono font-bold text-white text-xs pl-0.5">
                                                        {op.pinnacleInfo?.score || (Array.isArray(op.score) ? op.score.join(' - ') : op.score || '0 - 0')}
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
                                                        {new Date(op.matchDate || op.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
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
                                                    <span className="text-slate-200 font-mono font-bold">
                                                        {new Date(op.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                                    </span>
                                                    <span className="text-[10px] text-slate-500">
                                                        {new Date(op.date).toLocaleDateString()}
                                                    </span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3">
                                            {/* STRATEGY BADGE */}
                                            {(isLive || showFinished || executionStatus === 'FINISHED') && (
                                                <div className="mb-1">
                                                    {op.type === 'LIVE_VALUE' ? (
                                                        <span className="text-[9px] font-bold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                            VALUE BET
                                                        </span>
                                                    ) : (op.type === 'LIVE_SNIPE' || op.type === 'LA_VOLTEADA') ? (
                                                        <span className="text-[9px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                            SNIPE
                                                        </span>
                                                    ) : (op.type === 'PREMATCH_VALUE' || (!isLive && !op.type?.includes('LIVE'))) ? (
                                                        <span className="text-[9px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-1.5 py-0.5 rounded tracking-wide uppercase">
                                                            PRE-MATCH
                                                        </span>
                                                    ) : null}
                                                </div>
                                            )}
                                            <div className="text-slate-200 font-bold text-sm text-wrap max-w-[200px] md:max-w-none">{op.match}</div>
                                            <div className="text-slate-500 text-[10px] flex gap-2">
                                                <span>{op.league}</span>
                                                <span className="text-slate-600">|</span>
                                                <span>{op.market || '1x2'}</span>
                                            </div>

                                            {/* PRE-MATCH CONTEXT BADGES */}
                                            {(op.pinnacleInfo?.prematchContext) && (
                                                <div className="flex flex-wrap gap-1 mt-1.5 opacity-90">
                                                    {/* 1x2 Badge */}
                                                    {(op.pinnacleInfo.prematchContext.home || op.pinnacleInfo.prematchContext.draw || op.pinnacleInfo.prematchContext.away) && (
                                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50 text-[9px] font-mono text-slate-300" title="Pre-Match 1x2 Odds">
                                                            <span className="text-emerald-500 font-sans font-bold">1x2</span>
                                                            <span className={op.pinnacleInfo.prematchContext.home < 2.0 ? "text-emerald-400 font-bold" : ""}>{op.pinnacleInfo.prematchContext.home?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={op.pinnacleInfo.prematchContext.draw < 3.0 ? "text-amber-400" : ""}>{op.pinnacleInfo.prematchContext.draw?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={op.pinnacleInfo.prematchContext.away < 2.0 ? "text-emerald-400 font-bold" : ""}>{op.pinnacleInfo.prematchContext.away?.toFixed(2) || '-'}</span>
                                                        </div>
                                                    )}
                                                    
                                                    {/* Totals 2.5 Badge */}
                                                    {(op.pinnacleInfo.prematchContext.over25 || op.pinnacleInfo.prematchContext.under25) && (
                                                        <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-700/50 border border-slate-600/50 text-[9px] font-mono text-slate-300" title="Pre-Match Over/Under 2.5">
                                                            <span className="text-blue-500 font-sans font-bold">2.5</span>
                                                            <span className={op.pinnacleInfo.prematchContext.over25 < 1.8 ? "text-blue-300 font-bold" : ""}>O:{op.pinnacleInfo.prematchContext.over25?.toFixed(2) || '-'}</span>
                                                            <span className="text-slate-600">|</span>
                                                            <span className={op.pinnacleInfo.prematchContext.under25 < 1.8 ? "text-blue-300 font-bold" : ""}>U:{op.pinnacleInfo.prematchContext.under25?.toFixed(2) || '-'}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3 text-center">
                                            <span className={`font-bold px-2 py-1 rounded border text-[10px] whitespace-nowrap ${
                                                op.selection?.includes('Home') || op.action?.includes('LOCAL') ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                                                op.selection?.includes('Away') || op.action?.includes('VISITA') ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 
                                                'bg-slate-700 text-slate-300 border-slate-600'
                                            }`}>
                                                {(() => {
                                                    let sel = op.selection?.replace(/^BET\s+/i, '').split('@')[0].trim();
                                                    // [MOD] Agregar línea de gol si es mercado Over/Under y falta en la selección
                                                    if ((sel === 'Over' || sel === 'Under') && op.market?.includes('Total')) {
                                                        const line = op.market.match(/(\d+\.?\d*)/)?.[0];
                                                        if (line) sel += ` ${line}`;
                                                    }
                                                    return sel;
                                                })()}
                                            </span>
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
                                                            
                                                            {/* INDICADORES LIVE O TENDENCIA (MISMA POSICIÓN) - Modificado para parpadear igual que Dorado */}
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
                                                        <div className="px-2 py-1 rounded bg-slate-800/30 border border-slate-700/30 min-w-[60px] flex justify-center opacity-50">
                                                            <span className="text-[8px] text-slate-600 font-bold">PIN OFF</span>
                                                        </div>
                                                    )}
                                                </div>

                                                {/* 2. DORADOBET (Color Distinto - Target) */}
                                                <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 w-fit relative shadow-[0_0_10px_rgba(16,185,129,0.05)]" title="DoradoBet (Altenar)">
                                                    <span className="text-[9px] font-bold text-emerald-600/80 tracking-tighter">DOR</span>
                                                    <span className="font-mono font-bold text-sm text-emerald-400 leading-none flex items-center gap-0.5">
                                                        {(op.price || op.odd || 0).toFixed(2)}
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
                                                </div>
                                            ) : processingBets.has(op.eventId) ? (
                                                <div className="flex flex-col items-center animate-pulse">
                                                    <span className="text-[10px] text-slate-400 font-bold">PROCESANDO...</span>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col items-center gap-1.5">
                                                    {/* BOTÓN APOSTAR */}
                                                    <button 
                                                        onClick={(e) => { e.stopPropagation(); handlePlaceBet(op); }}
                                                        className="flex items-center gap-2 bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-500/50 hover:border-emerald-400 text-emerald-100 rounded px-3 py-1.5 w-full justify-between transition-all group cursor-pointer shadow-[0_0_10px_rgba(16,185,129,0.1)] hover:shadow-[0_0_15px_rgba(16,185,129,0.3)] active:scale-95"
                                                        title="Apostar ahora"
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
                                                    <span className={`font-bold text-xs ${betData.status === 'WON' ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {betData.status === 'WON' ? 'GANADA' : 'PERDIDA'}
                                                    </span>
                                                    <span className={`font-mono font-bold text-sm ${betData.profit > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {betData.profit > 0 ? '+' : ''}{betData.profit?.toFixed(2)}
                                                    </span>

                                                    {/* BOTONES DE CORRECCIÓN (HOVER) */}
                                                    <div className="hidden group-hover:flex absolute inset-0 bg-slate-900/95 items-center justify-center gap-1 rounded z-10 border border-slate-700">
                                                         <button 
                                                            onClick={(e) => { e.stopPropagation(); requestSettle(betData.id, 'MANUAL'); }}
                                                            className="p-1 hover:bg-amber-500/20 text-amber-400 rounded"
                                                            title="Corregir Resultado"
                                                         >
                                                            <Edit className="w-3 h-3" />
                                                         </button>
                                                    </div>
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
                                        {filteredOps.length} Ops
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
