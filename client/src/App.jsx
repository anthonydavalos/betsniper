import { useState, useEffect } from 'react'
import axios from 'axios'
import { Trophy, RefreshCw, AlertTriangle, TrendingUp, DollarSign } from 'lucide-react'

// Configurar URL base del Backend
const API_URL = 'http://localhost:3000/api/opportunities';

function App() {
  const [prematchOps, setPrematchOps] = useState([])
  const [liveOps, setLiveOps] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [bankroll, setBankroll] = useState(1000)

  // En una app real, esto debería venir del backend/config
  // Pero lo calculamos dinámicamente en el frontend para respuesta inmediata al input
  const calculateDynamicKelly = (ops, currentBankroll) => {
    return ops.map(op => {
      // Recalcular Kelly basado en el nuevo bankroll input
      // Kelly Stake = (Bankroll * Kelly%) 
       // op.kellyPct viene del backend como porcentaje (ej: 2.5)
       const dynamicStake = (currentBankroll * op.kellyPct) / 100;
       return { ...op, kellyStake: dynamicStake };
    });
  }

  const fetchAll = async () => {
    setLoading(true)
    setError(null)
    try {
      // 1. Fetch Prematch
      const preRes = await axios.get(`${API_URL}/prematch`)
      setPrematchOps(preRes.data.data) 
      
      // 2. Fetch Live
      const liveRes = await axios.get(`${API_URL}/live`)
      setLiveOps(liveRes.data.data)

    } catch (err) {
      console.error(err)
      setError('Error conectando con el servidor BetSniper.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
    
    // Auto-refresh Live cada 30s
    const interval = setInterval(() => {
        axios.get(`${API_URL}/live`)
            .then(res => setLiveOps(res.data.data))
            .catch(console.error);
    }, 30000);

    return () => clearInterval(interval);
  }, [])

  // Derivamos los datos para renderizar (recalculando stakes si cambia el bankroll local)
  const displayedPrematch = prematchOps.map(op => ({
      ...op,
      kellyStake: (bankroll * op.kellyPct) / 100
  }));

  const displayedLive = liveOps.map(op => ({
      ...op,
      kellyStake: (bankroll * op.kellyPct) / 100
  }));

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans p-6">
      
      {/* HEADER */}
      <header className="flex justify-between items-center mb-8 border-b border-slate-700 pb-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2 text-emerald-400">
            <Trophy className="w-8 h-8" />
            BetSniper V3
          </h1>
          <p className="text-slate-400 text-sm mt-1">Sistema de Arbitraje & Value Betting</p>
        </div>
        
        <div className="flex items-center gap-4 bg-slate-800 p-3 rounded-lg border border-slate-700">
          <div className="flex items-center gap-2 text-emerald-300">
            <DollarSign size={18} />
            <input 
              type="number" 
              value={bankroll}
              onChange={(e) => setBankroll(Number(e.target.value))}
              className="bg-transparent w-24 font-mono font-bold outline-none border-b border-emerald-500/30 focus:border-emerald-500 text-right"
            />
          </div>
          <span className="text-xs text-slate-500 font-bold">BANKROLL (USD/PEN)</span>
        </div>
      </header>

      {/* STATS CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg relative overflow-hidden">
          <div className="absolute top-0 right-0 w-20 h-20 bg-emerald-500/10 rounded-bl-full -mr-4 -mt-4 pointer-events-none"></div>
          <div className="flex justify-between items-start">
            <div>
              <p className="text-slate-400 text-xs font-bold uppercase tracking-wider">Oportunidades Pre-Match</p>
              <h3 className="text-3xl font-bold mt-1 text-white">{prematchOps.length}</h3>
              <p className="text-xs text-emerald-400 mt-1 font-mono">EV+ Detectado</p>
            </div>
            <div className="p-3 bg-emerald-500/10 rounded-lg text-emerald-400">
              <TrendingUp size={24} />
            </div>
          </div>
        </div>

        <div className={`bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg ${liveOps.length > 0 ? 'ring-2 ring-red-500/50' : ''}`}>
          <div className="flex justify-between items-start">
            <div>
              <p className="text-slate-400 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                 Live Sniper 
                 <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                 </span>
              </p>
              <h3 className="text-3xl font-bold mt-1 text-white">{liveOps.length}</h3>
              <p className="text-xs text-slate-400 mt-1">Escaneando tiempo real...</p>
            </div>
            <div className={`p-3 rounded-lg ${liveOps.length > 0 ? 'bg-red-500 text-white shadow-lg shadow-red-500/50 animate-pulse' : 'bg-red-500/10 text-red-400'}`}>
              <AlertTriangle size={24} />
            </div>
          </div>
        </div>
        
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-4 rounded-xl border border-slate-700 shadow-lg flex flex-col justify-center items-center text-center">
            <p className="text-slate-400 text-xs mb-1">Última Actualización</p>
            <p className="text-sm font-mono text-emerald-300">
                {new Date().toLocaleTimeString()}
            </p>
        </div>
      </div>

      {/* MAIN CONTENT Area */}
      <main>

        {/* LIVE OPS SECTION */}
        {displayedLive.length > 0 && (
          <div className="mb-12 animate-fade-in-down">
             <h2 className="text-xl font-bold flex items-center gap-2 mb-4 text-red-500 animate-pulse">
                <AlertTriangle className="fill-red-500 text-slate-900" />
                🔥 LIVE OPPORTUNITIES ({displayedLive.length})
             </h2>
             
             <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {displayedLive.map((op, idx) => (
                    <div key={idx} className="bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-red-500/50 rounded-xl p-5 shadow-2xl shadow-red-900/20 relative overflow-hidden group hover:scale-[1.02] transition-transform">
                        {/* BADGE TIPO */}
                        <div className="absolute top-0 right-0 bg-red-600 text-white text-[10px] uppercase font-bold px-3 py-1 rounded-bl-lg shadow-lg z-10">
                            {op.type === 'LA_VOLTEADA' ? '🔄 LA VOLTEADA' : '⚡ LIVE VALUE'}
                        </div>
                        
                        {/* HEADER MATCH */}
                        <div className="mb-4 pr-16">
                            <h3 className="text-lg font-bold text-white leading-tight">{op.match}</h3>
                            <div className="flex items-center gap-2 mt-2 text-sm">
                                <span className="bg-slate-700 text-slate-300 px-2 py-0.5 rounded text-xs font-bold">{op.league}</span>
                                <span className="font-mono text-red-400 font-bold bg-red-900/20 px-2 rounded flex items-center gap-1">
                                    ⏱ {op.time} <span className="text-slate-500">|</span> ⚽ {op.score}
                                </span>
                            </div>
                        </div>

                        {/* METRICS GRID */}
                        <div className="grid grid-cols-2 gap-3 mb-4">
                            <div className="bg-slate-950/50 p-2 rounded border border-slate-700/50">
                                <p className="text-[10px] text-slate-500 uppercase font-bold">Mercado</p>
                                <p className="text-sm font-bold text-slate-200 truncate">{op.market}</p>
                            </div>
                            <div className="bg-emerald-900/10 p-2 rounded border border-emerald-500/20">
                                <p className="text-[10px] text-emerald-500 uppercase font-bold">Cuota Actual</p>
                                <p className="text-xl font-bold text-emerald-400 font-mono">{op.odd.toFixed(2)}</p>
                            </div>
                            <div className="bg-blue-900/10 p-2 rounded border border-blue-500/20">
                                <p className="text-[10px] text-blue-500 uppercase font-bold">EV Estimado</p>
                                <p className="text-lg font-bold text-blue-300">+{op.ev.toFixed(1)}%</p>
                            </div> 
                             <div className="bg-yellow-900/10 p-2 rounded border border-yellow-500/20">
                                <p className="text-[10px] text-yellow-500 uppercase font-bold">Kelly Stake</p>
                                <p className="text-lg font-bold text-yellow-300">${op.kellyStake.toFixed(1)}</p>
                            </div> 
                        </div>

                        {/* ACTION */}
                        <a 
                          href="https://doradobet.com" 
                          target="_blank" 
                          rel="noreferrer"
                          className="block w-full text-center bg-red-600 hover:bg-red-500 text-white font-bold py-2 rounded-lg transition-colors shadow-lg shadow-red-600/20"
                        >
                          APOSTAR AHORA
                        </a>
                    </div>
                ))}
             </div>
          </div>
        )}

        {/* PREMATCH SECTION */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <span className="w-2 h-8 bg-emerald-500 rounded-full inline-block shadow-lg shadow-emerald-500/50"></span>
            Value Bets (Pre-Match)
          </h2>
          <button 
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-sm px-4 py-2 rounded-lg transition-all border border-slate-600 hover:border-emerald-500/50 text-slate-300 hover:text-white"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            {loading ? 'Actualizando...' : 'Escanear Ahora'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-200 p-4 rounded-lg mb-6 flex items-center gap-3 animate-pulse">
            <AlertTriangle />
            {error}
          </div>
        )}

        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-900/50 text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
                  <th className="p-4 font-semibold">Evento / Liga</th>
                  <th className="p-4 font-semibold">Mercado</th>
                  <th className="p-4 font-semibold text-right">Prob. Real (Pin)</th>
                  <th className="p-4 font-semibold text-right text-emerald-400 bg-emerald-900/10">Cuota Dorado</th>
                  <th className="p-4 font-semibold text-center">EV%</th>
                  <th className="p-4 font-semibold text-right">Kelly Stake</th>
                  <th className="p-4 font-semibold text-center">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {displayedPrematch.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="p-12 text-center text-slate-500 italic">
                      {loading ? (
                        <span className="flex items-center justify-center gap-2">
                            <RefreshCw className="animate-spin" /> Buscando oportunidades de oro...
                        </span>
                      ) : 'No se encontraron Value Bets (>2% EV) por el momento.'}
                    </td>
                  </tr>
                ) : (
                  displayedPrematch.map((op, idx) => (
                    <tr key={idx} className="hover:bg-slate-700/30 transition-colors group">
                      <td className="p-4">
                        <div className="font-bold text-slate-200 text-lg">{op.match}</div>
                        <div className="text-xs text-slate-500 flex gap-2 items-center mt-1">
                            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{op.league || 'Liga Desconocida'}</span>
                            <span>•</span>
                            <span>{new Date(op.date || Date.now()).toLocaleDateString()} {new Date(op.date || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="bg-slate-900 px-3 py-1.5 rounded-md text-xs font-mono font-bold text-slate-300 border border-slate-700">
                          {op.market || '1x2'}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="font-mono text-slate-400">{(100 / (op.realProb || 1)).toFixed(2)}</div>
                        <div className="text-[10px] text-slate-600 font-bold">{op.realProb || 0}%</div>
                      </td>
                      <td className="p-4 text-right bg-emerald-900/5 group-hover:bg-emerald-900/10 transition-colors">
                         <div className="font-mono text-emerald-400 font-bold text-2xl tracking-tighter shadow-emerald-500/20 drop-shadow-sm">
                            {(op.odd || 0).toFixed(2)}
                         </div>
                      </td>
                      <td className="p-4 text-center">
                        <span className={`inline-block px-2 py-1 rounded font-bold text-xs border ${op.ev > 5 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-blue-500/10 border-blue-500/30 text-blue-300'}`}>
                          +{(op.ev || 0).toFixed(2)}%
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="font-bold text-slate-100 text-lg">${(op.kellyStake || 0).toFixed(2)}</div>
                        <div className="text-[10px] text-slate-500">{(op.kellyPct || 0).toFixed(2)}% Bank</div>
                      </td>
                      <td className="p-4 text-center">
                        <a 
                          href="https://doradobet.com" 
                          target="_blank" 
                          rel="noreferrer"
                          className="bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white text-xs font-bold px-4 py-2 rounded-lg transition-all shadow-lg shadow-emerald-500/20 opacity-80 group-hover:opacity-100 flex items-center justify-center gap-1 mx-auto w-max"
                        >
                          APOSTAR <TrendingUp size={14} />
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
