import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
  Trophy, RefreshCw, Zap, TrendingUp, Calendar, Activity, RotateCcw, Archive, Clock, Volume2, 
  ChevronLeft, ChevronRight, Filter, Layers
} from 'lucide-react';

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
  const [portfolio, setPortfolio] = useState({ balance: 1000, activeBets: [], history: [] });
  
  const [loading, setLoading] = useState(false);
  
  // NAVEGACIÓN TIPO FLASHSCORE
  const [activeTab, setActiveTab] = useState('ALL'); // 'ALL', 'LIVE', 'FINISHED'
  const [dateFilter, setDateFilter] = useState(new Date());

  // Refs para control de notificaciones
  const isFirstLoad = useRef(true);
  const prevLiveOpsLength = useRef(0);

  // --- API CALLS ---

  const fetchData = async () => {
    setLoading(true);
    try {
      const [liveRes, prematchRes, portfolioRes] = await Promise.all([
        axios.get('/api/opportunities/live'),
        axios.get('/api/opportunities/prematch'),
        axios.get('/api/portfolio')
      ]);

      if (liveRes.data?.data) setLiveOps(liveRes.data.data);
      if (prematchRes.data?.data) setPrematchOps(prematchRes.data.data);
      if (portfolioRes.data) setPortfolio(portfolioRes.data);

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
    const interval = setInterval(fetchData, 3000); // Polling cada 3s
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
        return liveOps; // Siempre muestra todo lo live
    } else if (activeTab === 'FINISHED') {
        // 1. Historial Real (Ya liquidadas)
        const historyData = portfolio.history.map(h => ({
            ...h,
            date: h.closedAt, 
            isFinished: true
        }));

        // 2. Activas "Maduras" (Probablemente finalizadas pero esperando API Results)
        // Criterio Mejorado: Usar liveTime y lastUpdate para ser más agresivos moviendo a "Finalizados"
        const pendingFinishData = (portfolio.activeBets || []).filter(b => {
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
                 if (estimatedCurrentMinute > 105) return true;
                 
                 // B. Estaba en min 80+ y hace más de 7 min no actualiza (se acabó feed)
                 if (lastKnownMinute > 80 && minutesSinceUpdate > 7) return true;
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
    } else {
        // TAB: ALL o PRÓXIMOS
        // Comportamiento Flashscore: Mostrar Live + Prematch del día seleccionado
        
        // 1. Si es HOY, incluimos Live Ops al principio
        if (isSameDay(dateFilter, new Date())) {
            data = [...liveOps];
        }

        // 2. Filtrar Pre-Match por fecha seleccionada
        const dayPrematch = prematchOps.filter(op => isSameDay(new Date(op.date), dateFilter));
        data = [...data, ...dayPrematch];
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

            {/* 3. MAIN TABLE */}
            <section className="bg-slate-800 rounded-b-xl border border-slate-700 border-t-0 overflow-hidden shadow-lg min-h-[400px]">
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
                                    
                                    const isLive = !isExplicitlyFinished && (isReallyLiveType || (new Date(op.date) < new Date() && !op.isFinished && minutesElapsed < 150));
                                    
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
                                                       {/* Live Timer */}
                                                       {typeof op.time === 'string' && op.time.length < 10 
                                                            ? op.time
                                                            : (minutesElapsed > 90 ? `90'+` : `${minutesElapsed}'`)}
                                                    </span>
                                                    {/* SCORE MOVED HERE BELOW TIMER */}
                                                    <span className="font-mono font-bold text-white text-xs pl-0.5">
                                                        {Array.isArray(op.score) ? op.score.join(' - ') : op.score || '0 - 0'}
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
                                                     <span className="text-[9px] text-slate-500 leading-tight">
                                                        {new Date(op.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
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
                                            <div className="text-slate-200 font-bold text-sm text-wrap max-w-[200px] md:max-w-none">{op.match}</div>
                                            <div className="text-slate-500 text-[10px] flex gap-2">
                                                <span>{op.league}</span>
                                                <span className="text-slate-600">|</span>
                                                <span>{op.market || '1x2'}</span>
                                            </div>
                                        </td>
                                        <td className="p-3 text-center">
                                            <span className={`font-bold px-2 py-1 rounded border text-[10px] whitespace-nowrap ${
                                                op.selection?.includes('Home') || op.action?.includes('LOCAL') ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                                                op.selection?.includes('Away') || op.action?.includes('VISITA') ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 
                                                'bg-slate-700 text-slate-300 border-slate-600'
                                            }`}>
                                                {op.selection}
                                            </span>
                                        </td>
                                        <td className="p-3 text-center">
                                            <div className="flex flex-col items-center">
                                                <span className="font-mono text-white font-bold bg-slate-900/40 px-2 py-1 rounded">
                                                    {/* Mostrar LIVE ODD si disponible y es live */}
                                                    {(op.odd || 0).toFixed(2)}
                                                </span>
                                                {isLive && (
                                                    <span className="text-[8px] text-red-400 font-bold uppercase tracking-wider mt-0.5 animate-pulse">
                                                        LIVE
                                                    </span>
                                                )}
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
                                            ) : (
                                                <div className="flex flex-col items-center opacity-70">
                                                    <span className="font-mono text-xs text-slate-500 mb-0.5">Sugerido</span>
                                                    <div className="font-mono text-white text-sm bg-slate-900/50 px-2 py-0.5 rounded inline-block border border-dashed border-slate-600">
                                                        S/. {(op.kellyStake || 0).toFixed(2)}
                                                    </div>
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3 text-center">
                                            {op.manualStatus === 'WAIT_RES' ? (
                                                <div className="flex flex-col items-center">
                                                    <span className="text-[10px] text-amber-500 font-bold bg-amber-900/20 px-2 py-1 rounded border border-amber-500/20 animate-pulse">
                                                        VERIFICANDO
                                                    </span>
                                                    <span className="text-[9px] text-slate-500 mt-1">API RESULTADOS</span>
                                                </div>
                                            ) : (executionStatus === 'FINISHED' || op.isFinished) ? (
                                                <div className="flex flex-col items-center justify-center p-1 rounded bg-slate-800/50">
                                                    <span className={`font-bold text-xs ${betData.status === 'WON' ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {betData.status === 'WON' ? 'GANADA' : 'PERDIDA'}
                                                    </span>
                                                    <span className={`font-mono font-bold text-sm ${betData.profit > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                        {betData.profit > 0 ? '+' : ''}{betData.profit?.toFixed(2)}
                                                    </span>
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
            </section>
        </div>
      </main>
    </div>
  );
}

export default App;
