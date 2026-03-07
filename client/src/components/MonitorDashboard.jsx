import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { RefreshCw, ExternalLink, Activity, AlertTriangle, ArrowUp, ArrowDown, Triangle } from 'lucide-react';

export default function MonitorDashboard() {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(false);
    const [lastUpdate, setLastUpdate] = useState(null);
    const [error, setError] = useState(null);
    const [monitorDisabled, setMonitorDisabled] = useState(false);
    const prevOddsRef = useRef({}); // Store previous odds for trend calculation

    const fetchData = async () => {
        if (monitorDisabled) return;
        setLoading(true);
        try {
            const res = await axios.get('/api/monitor/live-odds');
            if (res.data.success) {
                // Sort: Linked first, then by Time
                let sorted = res.data.data.sort((a, b) => {
                    if (a.linked === b.linked) return 0;
                    return a.linked ? -1 : 1;
                });

                // --- TREND CALCULATION ---
                sorted = sorted.map(row => {
                    const prev = prevOddsRef.current[row.id] || { pinnacle: {}, altenar: {} };
                    
                    // Pinnacle New
                    const pinHome = row.pinnacle?.moneyline?.home;
                    const pinDraw = row.pinnacle?.moneyline?.draw;
                    const pinAway = row.pinnacle?.moneyline?.away;
                    
                    // Altenar New
                    const altHome = row.altenar?.moneyline?.home;
                    const altDraw = row.altenar?.moneyline?.draw;
                    const altAway = row.altenar?.moneyline?.away;

                    const getTrend = (n, o) => {
                        // Ensure both are valid numbers
                        if (!n || !o) return null;
                        
                        // Parse floats just in case they are strings
                        const numN = parseFloat(n);
                        const numO = parseFloat(o);
                        
                        // Use a small epsilon for float comparison
                        if (Math.abs(numN - numO) < 0.001) return null; // No significant change

                        if (numN > numO) return 'up';
                        if (numN < numO) return 'down';
                        return null;
                    };

                    const trends = {
                        pinnacle: {
                            home: getTrend(pinHome, prev.pinnacle?.home),
                            draw: getTrend(pinDraw, prev.pinnacle?.draw),
                            away: getTrend(pinAway, prev.pinnacle?.away)
                        },
                        altenar: {
                            home: getTrend(altHome, prev.altenar?.home),
                            draw: getTrend(altDraw, prev.altenar?.draw),
                            away: getTrend(altAway, prev.altenar?.away)
                        }
                    };

                    // Update ref for this match
                    prevOddsRef.current[row.id] = {
                        pinnacle: { home: pinHome, draw: pinDraw, away: pinAway },
                        altenar: { home: altHome, draw: altDraw, away: altAway }
                    };

                    return { ...row, trends };
                });

                setData(sorted);
                setLastUpdate(new Date());
                setError(null);
            }
        } catch (err) {
            console.error(err);
            const code = err?.response?.data?.code;
            if (code === 'MONITOR_DISABLED') {
                setMonitorDisabled(true);
                setError('Monitor desactivado por configuración (DISABLE_MONITOR_DASHBOARD=true).');
            } else {
                setError("Error conectando con el servidor Monitor.");
            }
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        if (monitorDisabled) return undefined;
        const interval = setInterval(fetchData, 5000); // Poll every 5s (Standard Live)
        return () => clearInterval(interval);
    }, [monitorDisabled]);

    // Helper to format price
    const fmt = (p) => p ? p.toFixed(2) : '-';

    return (
        <div className="p-4 bg-gray-900 text-white min-h-screen font-mono text-sm">
            <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-4">
                <div className="flex items-center gap-3">
                    <Activity className="text-blue-400" size={24} />
                    <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-green-400">
                        MONITOR DE INTEGRIDAD DE CUOTAS
                    </h1>
                </div>
                <div className="flex items-center gap-4">
                    <span className="text-gray-400 text-xs">
                        Última act: {lastUpdate ? lastUpdate.toLocaleTimeString() : '...'}
                    </span>
                    <button 
                        onClick={fetchData} 
                        disabled={loading}
                        className="p-2 bg-gray-800 hover:bg-gray-700 rounded-full transition-all disabled:opacity-50"
                    >
                        <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
                    </button>
                </div>
            </div>

            {error && (
                <div className="bg-red-900/30 border border-red-500/50 p-4 rounded mb-4 text-red-200 flex items-center gap-2">
                    <AlertTriangle size={18} />
                    {error}
                </div>
            )}

            <div className="overflow-x-auto bg-gray-800 rounded-lg border border-gray-700 shadow-xl">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-gray-900 text-gray-400 text-xs uppercase tracking-wider">
                            <th className="p-3 border-b border-gray-700 sticky left-0 bg-gray-900 z-10 w-64">Partido / Tiempo</th>
                            {/* COMBINED PINNACLE HEADER */}
                            <th className="p-3 border-b border-gray-700 text-center bg-blue-900/20 border-r border-blue-800/30" colSpan={3}>PINNACLE (Live & Pre)</th>
                            <th className="p-3 border-b border-gray-700 text-center bg-green-900/20 border-l border-green-800/30" colSpan={3}>ALTENAR (Bookie)</th>
                            <th className="p-3 border-b border-gray-700 text-center" colSpan={2}>TOTALES</th>
                        </tr>
                        <tr className="bg-gray-800 text-gray-500 text-xs">
                            <th className="p-2 border-b border-gray-700 sticky left-0 bg-gray-800"></th>
                            
                            {/* Pinnacle Columns */}
                            <th className="p-2 border-b border-gray-700 text-center border-r border-gray-700 text-blue-300">1</th>
                            <th className="p-2 border-b border-gray-700 text-center border-r border-gray-700 text-blue-300">X</th>
                            <th className="p-2 border-b border-gray-700 text-center border-r border-gray-700 text-blue-300">2</th>
                            
                            {/* Altenar Columns */}
                            <th className="p-2 border-b border-gray-700 text-center border-l border-gray-700 text-green-300">1</th>
                            <th className="p-2 border-b border-gray-700 text-center border-l border-gray-700 text-green-300">X</th>
                            <th className="p-2 border-b border-gray-700 text-center border-l border-gray-700 text-green-300">2</th>

                            <th className="p-2 border-b border-gray-700 text-center border-l border-gray-700 w-32">PIN Goals</th>
                            <th className="p-2 border-b border-gray-700 text-center w-32">ALT Goals</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700">
                        {data.map((row) => (
                            <tr key={row.id} className={`hover:bg-gray-750 transition-colors ${!row.linked ? 'opacity-50 grayscale' : ''}`}>
                                <td className="p-3 sticky left-0 bg-gray-800 border-r border-gray-700">
                                    <div className="font-bold text-white truncate max-w-[200px]" title={row.name}>{row.name}</div>
                                    
                                    {/* PINNACLE (Truth Source) - NOW FIRST */}
                                    {row.linked && (
                                        <div className="flex items-center gap-2 mt-1 border-gray-700/50 pt-0.5">
                                            <span className="text-[9px] text-blue-400 font-bold w-6">PIN</span>
                                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-900/50 text-blue-200 border border-blue-500/30">
                                                {row.pinnacle?.time || '?'}
                                            </span>
                                            <span className="text-blue-300 text-xs font-mono">{row.pinnacle?.score || '0-0'}</span>
                                        </div>
                                    )}

                                    {/* ALTENAR (Local Bookie) - NOW SECOND */}
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[9px] text-green-500 font-bold w-6">ALT</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${row.time === 'HT' ? 'bg-yellow-600 text-black' : 'bg-red-600'}`}>
                                            {row.time}
                                        </span>
                                        <span className="text-gray-400 text-xs">{row.score}</span>
                                        {!row.linked && <span className="text-red-400 text-[10px] border border-red-500 px-1 rounded ml-auto">UNLINKED</span>}
                                    </div>
                                </td>

                                {/* PINNACLE (Pre & Live Combined) */}
                                <td className="p-3 text-center border-r border-gray-700 bg-blue-900/5 font-mono">
                                    <div className="flex flex-col items-center justify-center gap-1">
                                        {/* Pre-Match Badge */}
                                        {row.prematch?.home && (
                                            <span className="text-[10px] text-purple-300 font-bold bg-purple-900/40 px-1 py-px rounded border border-purple-500/20 leading-none">
                                                {fmt(row.prematch.home)}
                                            </span>
                                        )}
                                        {/* Live Odd with Pulse & Trend */}
                                        <div className="flex items-center gap-1 relative justify-center w-full">
                                            <span className={`text-sm font-bold ${row.pinnacle?.moneyline?.home ? 'text-blue-200' : 'text-gray-600'}`}>
                                                {row.pinnacle?.moneyline?.home ? Number(row.pinnacle.moneyline.home).toFixed(2) : '-'}
                                            </span>
                                            
                                            {/* TREND OR PULSE (Exclusive) */}
                                            {row.trends?.pinnacle?.home === 'up' ? (
                                                 <Triangle size={6} fill="currentColor" className="text-emerald-400 rotate-0" />
                                            ) : row.trends?.pinnacle?.home === 'down' ? (
                                                 <Triangle size={6} fill="currentColor" className="text-rose-500 rotate-180" />
                                            ) : row.pinnacle?.moneyline?.home ? (
                                                <span className="flex h-1.5 w-1.5 relative">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>
                                <td className="p-3 text-center border-r border-gray-700 bg-blue-900/5 font-mono">
                                     <div className="flex flex-col items-center justify-center gap-1">
                                        {/* Pre-Match Badge */}
                                        {row.prematch?.draw && (
                                            <span className="text-[10px] text-purple-300 font-bold bg-purple-900/40 px-1 py-px rounded border border-purple-500/20 leading-none">
                                                {fmt(row.prematch.draw)}
                                            </span>
                                        )}
                                        {/* Live Odd with Pulse & Trend */}
                                        <div className="flex items-center gap-1 relative justify-center w-full">
                                             <span className={`text-sm font-bold ${row.pinnacle?.moneyline?.draw ? 'text-blue-200' : 'text-gray-600'}`}>
                                                {row.pinnacle?.moneyline?.draw ? Number(row.pinnacle.moneyline.draw).toFixed(2) : '-'}
                                            </span>
                                            {/* TREND OR PULSE (Exclusive) */}
                                            {row.trends?.pinnacle?.draw === 'up' ? (
                                                 <Triangle size={6} fill="currentColor" className="text-emerald-400 rotate-0" />
                                            ) : row.trends?.pinnacle?.draw === 'down' ? (
                                                 <Triangle size={6} fill="currentColor" className="text-rose-500 rotate-180" />
                                            ) : row.pinnacle?.moneyline?.draw ? (
                                                <span className="flex h-1.5 w-1.5 relative">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>
                                <td className="p-3 text-center border-r border-gray-700 bg-blue-900/5 font-mono">
                                     <div className="flex flex-col items-center justify-center gap-1">
                                        {/* Pre-Match Badge */}
                                        {row.prematch?.away && (
                                            <span className="text-[10px] text-purple-300 font-bold bg-purple-900/40 px-1 py-px rounded border border-purple-500/20 leading-none">
                                                {fmt(row.prematch.away)}
                                            </span>
                                        )}
                                        {/* Live Odd with Pulse & Trend */}
                                        <div className="flex items-center gap-1 relative justify-center w-full">
                                             <span className={`text-sm font-bold ${row.pinnacle?.moneyline?.away ? 'text-blue-200' : 'text-gray-600'}`}>
                                                {row.pinnacle?.moneyline?.away ? Number(row.pinnacle.moneyline.away).toFixed(2) : '-'}
                                            </span>
                                            {/* TREND OR PULSE (Exclusive) */}
                                            {row.trends?.pinnacle?.away === 'up' ? (
                                                 <Triangle size={6} fill="currentColor" className="text-emerald-400 rotate-0" />
                                            ) : row.trends?.pinnacle?.away === 'down' ? (
                                                 <Triangle size={6} fill="currentColor" className="text-rose-500 rotate-180" />
                                            ) : row.pinnacle?.moneyline?.away ? (
                                                <span className="flex h-1.5 w-1.5 relative">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>


                                {/* ALTENAR ODDS */}
                                <td className="p-3 text-center border-l border-gray-700 bg-green-900/5 font-mono text-green-200">
                                    <div className="flex flex-col items-center justify-center gap-1">
                                        {/* Pre-Match Badge */}
                                        {row.altenar?.prematch?.home && (
                                            <span className="text-[10px] text-green-600 font-bold bg-green-900/40 px-1 py-px rounded border border-green-500/10 leading-none opacity-80">
                                                {fmt(row.altenar.prematch.home)}
                                            </span>
                                        )}
                                        <div className="flex items-center justify-center gap-1 w-full h-[18px]">
                                            <span>{fmt(row.altenar?.moneyline?.home)}</span>
                                            {row.trends?.altenar?.home === 'up' ? (
                                                <Triangle size={6} fill="currentColor" className="text-emerald-400 rotate-0" />
                                            ) : row.trends?.altenar?.home === 'down' ? (
                                                <Triangle size={6} fill="currentColor" className="text-rose-500 rotate-180" />
                                            ) : row.altenar?.moneyline?.home ? (
                                                <span className="flex h-1.5 w-1.5 relative">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>
                                <td className="p-3 text-center border-l border-gray-700 bg-green-900/5 font-mono text-green-200">
                                    <div className="flex flex-col items-center justify-center gap-1">
                                        {/* Pre-Match Badge */}
                                        {row.altenar?.prematch?.draw && (
                                            <span className="text-[10px] text-green-600 font-bold bg-green-900/40 px-1 py-px rounded border border-green-500/10 leading-none opacity-80">
                                                {fmt(row.altenar.prematch.draw)}
                                            </span>
                                        )}
                                        <div className="flex items-center justify-center gap-1 w-full h-[18px]">
                                            <span>{fmt(row.altenar?.moneyline?.draw)}</span>
                                            {row.trends?.altenar?.draw === 'up' ? (
                                                <Triangle size={6} fill="currentColor" className="text-emerald-400 rotate-0" />
                                            ) : row.trends?.altenar?.draw === 'down' ? (
                                                <Triangle size={6} fill="currentColor" className="text-rose-500 rotate-180" />
                                            ) : row.altenar?.moneyline?.draw ? (
                                                <span className="flex h-1.5 w-1.5 relative">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>
                                <td className="p-3 text-center border-l border-gray-700 bg-green-900/5 font-mono text-green-200">
                                    <div className="flex flex-col items-center justify-center gap-1">
                                        {/* Pre-Match Badge */}
                                        {row.altenar?.prematch?.away && (
                                            <span className="text-[10px] text-green-600 font-bold bg-green-900/40 px-1 py-px rounded border border-green-500/10 leading-none opacity-80">
                                                {fmt(row.altenar.prematch.away)}
                                            </span>
                                        )}
                                        <div className="flex items-center justify-center gap-1 w-full h-[18px]">
                                            <span>{fmt(row.altenar?.moneyline?.away)}</span>
                                            {row.trends?.altenar?.away === 'up' ? (
                                                <Triangle size={6} fill="currentColor" className="text-emerald-400 rotate-0" />
                                            ) : row.trends?.altenar?.away === 'down' ? (
                                                <Triangle size={6} fill="currentColor" className="text-rose-500 rotate-180" />
                                            ) : row.altenar?.moneyline?.away ? (
                                                <span className="flex h-1.5 w-1.5 relative">
                                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                </td>

                                {/* TOTALS COMPARISON */}
                                <td className="p-3 border-l border-gray-700 text-xs align-top">
                                    <div className="flex flex-col gap-2">
                                        {(row.pinnacle?.totals || []).slice(0,2).map((t, idx) => {
                                            // Find Pre-Match Line in Pinnacle Data
                                            const pre = row.prematch?.totals?.find(p => Math.abs(p.line - t.line) < 0.1);
                                            
                                            return (
                                            <div key={idx} className="flex gap-1 justify-center">
                                                {/* OVER PINNACLE */}
                                                <div className="flex flex-col items-center bg-blue-900/20 border border-blue-500/20 rounded-md overflow-hidden min-w-[45px]">
                                                    <div className="bg-blue-900/40 w-full text-center text-[9px] text-blue-300 font-bold px-1 py-0.5 border-b border-blue-500/10">
                                                        O {t.line}
                                                    </div>
                                                    <div className="flex flex-col items-center justify-center font-mono font-bold text-xs py-0.5 px-1 text-blue-100">
                                                        {pre && <span className="text-[8px] text-purple-300/60 leading-none mb-px">{fmt(pre.over)}</span>}
                                                        <span>{t.over}</span>
                                                    </div>
                                                </div>
                                                {/* UNDER PINNACLE */}
                                                <div className="flex flex-col items-center bg-blue-900/20 border border-blue-500/20 rounded-md overflow-hidden min-w-[45px]">
                                                    <div className="bg-blue-900/40 w-full text-center text-[9px] text-blue-300 font-bold px-1 py-0.5 border-b border-blue-500/10">
                                                        U {t.line}
                                                    </div>
                                                    <div className="flex flex-col items-center justify-center font-mono font-bold text-xs py-0.5 px-1 text-blue-100">
                                                        {pre && <span className="text-[8px] text-purple-300/60 leading-none mb-px">{fmt(pre.under)}</span>}
                                                        <span>{t.under}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )})}
                                    </div>
                                </td>
                                <td className="p-3 border-l border-gray-700 text-xs align-top">
                                    <div className="flex flex-col gap-2">
                                        {(row.altenar?.totals || []).slice(0,2).map((t, idx) => {
                                            const pre = row.altenar?.prematch?.totals?.find(p => Math.abs(p.line - t.line) < 0.1);
                                            return (
                                            <div key={idx} className="flex gap-1 justify-center">
                                                {/* OVER ALTENAR */}
                                                <div className={`flex flex-col items-center border rounded-md overflow-hidden min-w-[45px] ${t.over > 1.8 ? 'bg-green-900/20 border-green-500/40 shadow-[0_0_5px_rgba(16,185,129,0.1)]' : 'bg-gray-800 border-gray-700'}`}>
                                                    <div className={`w-full text-center text-[9px] font-bold px-1 py-0.5 border-b ${t.over > 1.8 ? 'bg-green-900/40 text-green-300 border-green-500/20' : 'bg-gray-700 text-gray-400 border-gray-600'}`}>
                                                        O {t.line}
                                                    </div>
                                                    <div className={`flex flex-col items-center justify-center font-mono font-bold text-xs py-0.5 px-1 ${t.over > 1.8 ? 'text-green-100' : 'text-gray-400'}`}>
                                                        {pre && <span className="text-[8px] text-green-500/60 leading-none mb-px">{fmt(pre.over)}</span>}
                                                        <span>{fmt(t.over)}</span>
                                                    </div>
                                                </div>
                                                {/* UNDER ALTENAR */}
                                                <div className={`flex flex-col items-center border rounded-md overflow-hidden min-w-[45px] ${t.under > 1.8 ? 'bg-green-900/20 border-green-500/40 shadow-[0_0_5px_rgba(16,185,129,0.1)]' : 'bg-gray-800 border-gray-700'}`}>
                                                    <div className={`w-full text-center text-[9px] font-bold px-1 py-0.5 border-b ${t.under > 1.8 ? 'bg-green-900/40 text-green-300 border-green-500/20' : 'bg-gray-700 text-gray-400 border-gray-600'}`}>
                                                        U {t.line}
                                                    </div>
                                                    <div className={`flex flex-col items-center justify-center font-mono font-bold text-xs py-0.5 px-1 ${t.under > 1.8 ? 'text-green-100' : 'text-gray-400'}`}>
                                                        {pre && <span className="text-[8px] text-green-500/60 leading-none mb-px">{fmt(pre.under)}</span>}
                                                        <span>{fmt(t.under)}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )})}
                                        {(!row.altenar?.totals || row.altenar?.totals.length === 0) && row.linked && (
                                            <span className="text-gray-600 italic text-[10px]">No lines</span>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}

                        {data.length === 0 && !loading && (
                            <tr>
                                <td colSpan={12} className="p-8 text-center text-gray-500">
                                    No hay partidos en vivo con datos disponibles.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
