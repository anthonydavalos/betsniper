import { useState, useEffect } from 'react'
import axios from 'axios'
import { Trophy, RefreshCw, AlertTriangle, TrendingUp, DollarSign } from 'lucide-react'

// Configurar URL base del Backend
const API_URL = 'http://localhost:3000/api/opportunities';

function App() {
  const [prematchOps, setPrematchOps] = useState([])
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

  const fetchPrematch = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await axios.get(`${API_URL}/prematch`)
      // La data ya viene procesada, pero podríamos necesitar recalcular stakes si el usuario cambia el bankroll
      // En este caso simple, usaremos la data tal cual y recalcularemos en render o en un useEffect dependencia
      setPrematchOps(res.data.data) 
    } catch (err) {
      console.error(err)
      setError('Error conectando con el servidor BetSniper.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPrematch()
  }, [])

  // Derivamos los datos para renderizar (recalculando stakes si cambia el bankroll local)
  const displayedOps = prematchOps.map(op => ({
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

        <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg cursor-not-allowed opacity-60">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-slate-400 text-xs font-bold uppercase tracking-wider">Live Sniper (Pronto)</p>
              <h3 className="text-3xl font-bold mt-1 text-slate-500">--</h3>
              <p className="text-xs text-slate-600 mt-1">Esperando partidos en vivo...</p>
            </div>
            <div className="p-3 bg-red-500/10 rounded-lg text-red-400">
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
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <span className="w-2 h-8 bg-emerald-500 rounded-full inline-block shadow-lg shadow-emerald-500/50"></span>
            Value Bets (Pre-Match)
          </h2>
          <button 
            onClick={fetchPrematch}
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
                {displayedOps.length === 0 ? (
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
                  displayedOps.map((op, idx) => (
                    <tr key={idx} className="hover:bg-slate-700/30 transition-colors group">
                      <td className="p-4">
                        <div className="font-bold text-slate-200 text-lg">{op.match}</div>
                        <div className="text-xs text-slate-500 flex gap-2 items-center mt-1">
                            <span className="bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{op.league}</span>
                            <span>•</span>
                            <span>{new Date(op.date).toLocaleDateString()} {new Date(op.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="bg-slate-900 px-3 py-1.5 rounded-md text-xs font-mono font-bold text-slate-300 border border-slate-700">
                          {op.market}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="font-mono text-slate-400">{(100 / op.realProb).toFixed(2)}</div>
                        <div className="text-[10px] text-slate-600 font-bold">{op.realProb}%</div>
                      </td>
                      <td className="p-4 text-right bg-emerald-900/5 group-hover:bg-emerald-900/10 transition-colors">
                         <div className="font-mono text-emerald-400 font-bold text-2xl tracking-tighter shadow-emerald-500/20 drop-shadow-sm">
                            {op.odd.toFixed(2)}
                         </div>
                      </td>
                      <td className="p-4 text-center">
                        <span className={`inline-block px-2 py-1 rounded font-bold text-xs border ${op.ev > 5 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-blue-500/10 border-blue-500/30 text-blue-300'}`}>
                          +{op.ev.toFixed(2)}%
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="font-bold text-slate-100 text-lg">${op.kellyStake.toFixed(2)}</div>
                        <div className="text-[10px] text-slate-500">{(op.kellyPct).toFixed(2)}% Bank</div>
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
