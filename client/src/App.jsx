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
        return portfolio.history.map(h => ({
            ...h,
            date: h.closedAt, // Adapter
            isFinished: true
        }));
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

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* --- LEFT COLUMN --- */}
        <div className="lg:col-span-2 space-y-0">
            
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
            {activeTab === 'ALL' && (
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
                                <th className="p-3 text-center">Cuota (Dorado)</th>
                                <th className="p-3 text-center">EV%</th>
                                <th className="p-3 text-center">Stake (Kelly)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                             {filteredOps.length === 0 ? (
                                <tr>
                                    <td colSpan="6" className="p-12 text-center text-slate-500 italic flex flex-col items-center justify-center gap-2">
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
                                    const isLive = isReallyLiveType || (new Date(op.date) < new Date() && !op.isFinished && minutesElapsed < 150);
                                    
                                    return (
                                    <tr key={idx} className={`hover:bg-slate-700/50 transition-colors ${isLive ? 'bg-slate-800/80 border-l-2 border-red-500' : ''}`}>
                                        <td className="p-3">
                                            {/* LOGICA DE STATUS/HORA */}
                                            {isLive ? (
                                                <div className="flex flex-col gap-1">
                                                    <span className="flex items-center gap-1 text-red-500 animate-pulse font-bold bg-red-500/10 px-2 py-0.5 rounded w-fit">
                                                       <Clock className="w-3 h-3" />
                                                       {typeof op.time === 'string' ? op.time : `${minutesElapsed}'`}
                                                    </span>
                                                    {op.score && <span className="font-mono font-bold text-white pl-1">{op.score}</span>}
                                                </div>
                                            ) : op.isFinished ? (
                                                <span className="text-emerald-500 font-bold bg-emerald-500/10 px-2 py-1 rounded text-[10px] border border-emerald-500/20">FIN</span>
                                            ) : (minutesElapsed > 150) ? (
                                                <div className="flex flex-col gap-1">
                                                     <span className="text-amber-500 font-bold bg-amber-500/10 px-2 py-1 rounded text-[10px] w-fit">
                                                        PEND
                                                     </span>
                                                     <span className="text-[10px] text-slate-500">Esperando Res.</span>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col">
                                                    <span className="text-slate-200 font-mono font-bold">
                                                        {new Date(op.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                                    </span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="p-3">
                                            <div className="text-slate-200 font-bold text-sm">{op.match}</div>
                                            <div className="text-slate-500 text-[10px] flex gap-2">
                                                <span>{op.league}</span>
                                            </div>
                                        </td>
                                        <td className="p-3 text-center">
                                            <span className={`font-bold px-2 py-1 rounded border text-[10px] ${
                                                op.selection?.includes('Home') || op.action?.includes('LOCAL') ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                                                op.selection?.includes('Away') || op.action?.includes('VISITA') ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 
                                                'bg-slate-700 text-slate-300 border-slate-600'
                                            }`}>
                                                {op.selection === 'Home' || op.action?.includes('LOCAL') ? 'LOCAL (1)' : 
                                                 op.selection === 'Away' || op.action?.includes('VISITA') ? 'VISITA (2)' : 'EMPATE (X)'}
                                            </span>
                                        </td>
                                        <td className="p-3 text-center">
                                            <span className="font-mono text-white font-bold bg-slate-900/40 px-2 py-1 rounded">
                                                {(op.odd || 0).toFixed(2)}
                                            </span>
                                        </td>
                                        <td className="p-3 text-center">
                                             {op.isFinished ? (
                                                 <span className={`font-bold ${op.status === 'WON' ? 'text-emerald-400' : 'text-red-400'}`}>
                                                    {op.status}
                                                 </span>
                                             ) : (
                                                <span className={`px-1.5 py-0.5 rounded font-bold ${op.ev > 5 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                    +{op.ev ? op.ev.toFixed(1) : '0.0'}%
                                                </span>
                                             )}
                                        </td>
                                        <td className="p-3 text-center">
                                            {op.isFinished ? (
                                                <span className={`font-mono font-bold ${op.profit > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                    {op.profit > 0 ? '+' : ''}{op.profit?.toFixed(2)}
                                                </span>
                                            ) : (
                                                <div className="font-mono text-white text-sm bg-slate-900/50 px-2 py-1 rounded inline-block">
                                                    S/. {(op.kellyStake || 0).toFixed(2)}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                )})
                             )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>

        {/* --- RIGHT COLUMN --- */}
        <div className="space-y-6">
            
            {/* ACTIVE BETS */}
            <section className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg">
                <div className="p-4 bg-slate-900/50 border-b border-slate-700">
                    <h2 className="font-bold flex items-center gap-2 text-white text-xs uppercase tracking-wider">
                        <Activity className="w-4 h-4 text-emerald-400" />
                        Apuestas en Juego ({portfolio.activeBets.length})
                    </h2>
                </div>
                <div className="max-h-80 overflow-y-auto">
                    {portfolio.activeBets.length === 0 ? (
                        <div className="p-6 text-center text-slate-500 text-xs">Esperando entrada automática...</div>
                    ) : (
                        <div className="divide-y divide-slate-700">
                            {portfolio.activeBets.map((bet) => (
                                <div className="p-3 hover:bg-slate-700/50 transition-colors">
                                    <div className="flex justify-between items-start mb-1">
                                         <div className="flex flex-col w-3/4">
                                            {/* Si está en Vivo (tiene liveTime), mostramos tiempo actual */}
                                            {bet.liveTime ? (
                                                <div className="flex items-center gap-1 text-[10px] text-red-400 font-mono font-bold mb-0.5 animate-pulse">
                                                     <Clock className="w-3 h-3" />
                                                     LIVE {bet.liveTime}
                                                </div>
                                            ) : bet.matchDate ? (
                                                /* Si es futuro, mostramos hora de inicio */
                                                <div className="flex items-center gap-1 text-[10px] text-amber-500 font-mono mb-0.5">
                                                     <Clock className="w-3 h-3" />
                                                     {new Date(bet.matchDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                                </div>
                                            ) : null}

                                            <span className="font-bold text-white text-xs truncate" title={bet.match}>{bet.match}</span>
                                        </div>
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${bet.status === 'PENDING' ? 'bg-yellow-500/20 text-yellow-400' : 'text-slate-300'}`}>
                                            {bet.status}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-xs text-slate-400 mb-2">
                                        <span>Pick: <b className="text-emerald-400">{bet.selection}</b></span>
                                        <span className="font-mono">@{bet.odd.toFixed(2)}</span>
                                    </div>
                                    <div className="flex justify-between items-center text-[10px] bg-slate-900/50 p-2 rounded">
                                        <span>Score Actual: <b className="text-white">{bet.lastKnownScore}</b></span>
                                        <span>Stake: {bet.stake.toFixed(2)}</span>
                                    </div>
                                    {/* Progress Bar (Simulated or Real Tracking) */}
                                    <div className="mt-2 w-full bg-slate-700 h-1 rounded-full overflow-hidden">
                                        <div className="bg-emerald-500 h-full w-1/3 animate-[shimmer_3s_infinite]"></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>

             {/* HISTORY LOG */}
             <section className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg flex-1">
                <div className="p-4 bg-slate-900/50 border-b border-slate-700">
                    <h2 className="font-bold flex items-center gap-2 text-white text-xs uppercase tracking-wider">
                        <Archive className="w-4 h-4 text-slate-400" />
                        Bitácora (Resueltas)
                    </h2>
                </div>
                <div className="max-h-80 overflow-y-auto">
                     {portfolio.history.length === 0 ? (
                        <div className="p-6 text-center text-slate-500 text-xs">Sin historial de operaciones.</div>
                    ) : (
                        <div className="divide-y divide-slate-700">
                            {portfolio.history.map((bet) => (
                                <div key={bet.id} className="p-3 hover:bg-slate-700/50 transition-colors border-l-2 border-transparent hover:border-slate-500">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${bet.status === 'WON' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                                            {bet.status} {bet.finalScore ? `(${bet.finalScore})` : ''}
                                        </span>
                                        <span className="text-[10px] text-slate-500 font-mono">
                                            {new Date(bet.closedAt).toLocaleTimeString()}
                                        </span>
                                    </div>
                                    <div className="font-medium text-slate-300 text-xs mb-1 truncate">{bet.match}</div>
                                    <div className="flex justify-between items-center text-xs">
                                        <span className="text-emerald-500/70">{bet.selection}</span>
                                        <span className={`font-mono font-bold ${bet.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {bet.profit >= 0 ? '+' : ''}{bet.profit.toFixed(2)} PEN
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>

        </div>
      </main>
    </div>
  );
}

export default App;
