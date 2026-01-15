import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
  Trophy, RefreshCw, Zap, TrendingUp, Calendar, Activity, RotateCcw, Archive, Clock, Volume2
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
                 <button 
                    onClick={resetPortfolio}
                    className="ml-2 p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors"
                    title="Resetear Simulación"
                >
                    <RotateCcw className="w-4 h-4" />
                </button>
            </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* --- LEFT COLUMN --- */}
        <div className="lg:col-span-2 space-y-8">
            
            {/* LIVE OPPORTUNITIES TABLE */}
            <section className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg">
                <div className="p-4 bg-slate-900/50 border-b border-slate-700 flex justify-between items-center">
                    <h2 className="font-bold flex items-center gap-2 text-white">
                        <Zap className="w-4 h-4 text-amber-400" />
                        Oportunidades en Vivo
                        <span className="text-xs bg-amber-500/10 text-amber-400 px-2 rounded-full border border-amber-500/20">{liveOps.length}</span>
                    </h2>
                    <div className="flex gap-2">
                        <button onClick={playAlert} className="p-1 hover:bg-slate-700 rounded text-slate-500 hover:text-amber-400 transition-colors" title="Probar Sonido">
                            <Volume2 className="w-3 h-3" />
                        </button>
                        {loading && <RefreshCw className="w-3 h-3 animate-spin text-slate-500" />}
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                        <thead>
                            <tr className="bg-slate-900 text-slate-400 uppercase tracking-wider">
                                <th className="p-3">Hora / Evento</th>
                                <th className="p-3">Selección (Pick)</th>
                                <th className="p-3 text-center">Cuota / EV</th>
                                <th className="p-3 text-center">Stake (Kelly) / Hora Det.</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                             {liveOps.length === 0 ? (
                                <tr><td colSpan="4" className="p-8 text-center text-slate-500 italic">Escaneando mercado en tiempo real...</td></tr>
                             ) : (
                                liveOps.map((op, idx) => (
                                    <tr key={idx} className="hover:bg-slate-700/50 transition-colors bg-amber-900/5">
                                        <td className="p-3">
                                            <div className="flex items-center gap-2 text-amber-400 font-mono font-bold mb-1">
                                                <Clock className="w-3 h-3" /> 
                                                {op.time} <span className="text-slate-500">|</span> {op.score}
                                                {op.redCards > 0 && (
                                                    <span className="ml-2 flex items-center gap-1 text-[10px] text-red-500 border border-red-500/30 bg-red-500/10 px-1 rounded animate-pulse">
                                                        🟥 {op.redCards}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="font-bold text-slate-200 text-sm">{op.match}</div>
                                            <div className="text-xs text-slate-500">{op.league}</div>
                                        </td>
                                        <td className="p-3">
                                             <div className="font-bold text-emerald-400">{op.action}</div>
                                             <div className="text-slate-500 text-[10px] mt-0.5">{op.reason}</div>
                                        </td>
                                        <td className="p-3 text-center">
                                            <div className="font-bold text-white font-mono">{op.odd.toFixed(2)}</div>
                                            <div className={`text-[10px] font-bold ${op.ev > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                EV: {op.ev}%
                                            </div>
                                        </td>
                                        <td className="p-3 text-center">
                                            <div className="font-mono text-white text-sm bg-slate-900/50 px-2 py-1 rounded inline-block">
                                                PEN {(op.kellyStake || 0).toFixed(2)}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                             )}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* PREMATCH OPPORTUNITIES TABLE */}
             <section className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg">
                <div className="p-4 bg-slate-900/50 border-b border-slate-700 flex justify-between items-center">
                    <h2 className="font-bold flex items-center gap-2 text-white">
                        <Calendar className="w-4 h-4 text-blue-400" />
                        Value Bets (Pre-Match)
                        <span className="text-xs bg-blue-500/10 text-blue-400 px-2 rounded-full border border-blue-500/20">{prematchOps.length}</span>
                    </h2>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                        <thead>
                            <tr className="bg-slate-900 text-slate-400 uppercase tracking-wider">
                                <th className="p-3">Fecha / Hora</th>
                                <th className="p-3">Evento</th>
                                <th className="p-3 text-center">Selección</th>
                                <th className="p-3 text-center">Cuota (Dorado)</th>
                                <th className="p-3 text-center">EV%</th>
                                <th className="p-3 text-center">Stake (Kelly)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                             {prematchOps.length === 0 ? (
                                <tr><td colSpan="5" className="p-8 text-center text-slate-500 italic">Sin oportunidades Pre-Match detectadas.</td></tr>
                             ) : (
                                prematchOps.map((op, idx) => (
                                    <tr key={idx} className="hover:bg-slate-700/50 transition-colors">
                                        <td className="p-3">
                                            <div className="flex flex-col">
                                                 <div className="font-mono text-emerald-400 font-bold">
                                                    {(() => {
                                                        const diff = new Date(op.date) - new Date();
                                                        const mins = Math.floor(diff / 60000);
                                                        const hours = Math.floor(mins / 60);
                                                        if (mins < 0) return "EN VIVO";
                                                        if (hours > 24) return `+${Math.floor(hours/24)}d`;
                                                        if (hours > 0) return `${hours}h ${mins%60}m`;
                                                        return `${mins} min`;
                                                    })()}
                                                </div>
                                                <div className="text-[10px] text-slate-500">
                                                    {new Date(op.date || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-3">
                                            <div className="text-slate-200 font-medium">{op.match}</div>
                                            <div className="text-slate-500 text-[10px]">{op.league}</div>
                                        </td>
                                        <td className="p-3 text-center">
                                            <span className="font-bold text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
                                                {op.selection === 'Home' ? 'LOCAL' : op.selection === 'Away' ? 'VISITA' : 'EMPATE'}
                                            </span>
                                        </td>
                                        <td className="p-3 text-center font-mono text-white font-bold bg-slate-900/30">
                                            {op.odd.toFixed(2)}
                                        </td>
                                        <td className="p-3 text-center">
                                            <span className={`px-1.5 py-0.5 rounded font-bold ${op.ev > 5 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                +{op.ev.toFixed(1)}%
                                            </span>
                                        </td>
                                        <td className="p-3 text-center">
                                            <div className="font-mono text-white text-sm bg-slate-900/50 px-2 py-1 rounded inline-block">
                                                PEN {(op.kellyStake || 0).toFixed(2)}
                                            </div>
                                        </td>
                                    </tr>
                                ))
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
