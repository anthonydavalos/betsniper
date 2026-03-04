import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Search, Link, Unlink, RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react';

const splitSides = (value = '') => {
    const parts = String(value || '').split(/\s+vs\.?\s+/i);
    return {
        home: String(parts[0] || '').trim(),
        away: String(parts[1] || '').trim()
    };
};

const normalizeText = (value = '') => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(f\)|\(res\.?\)|\bu\d{2}\b|\bres\b|\breserves\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const isSwappedRisk = (pin = {}, alt = {}) => {
    const pinHome = normalizeText(pin?.home || splitSides(pin?.match || '').home);
    const pinAway = normalizeText(pin?.away || splitSides(pin?.match || '').away);
    const altSides = splitSides(alt?.name || `${alt?.home || ''} vs ${alt?.away || ''}`);
    const altHome = normalizeText(altSides.home);
    const altAway = normalizeText(altSides.away);

    if (!pinHome || !pinAway || !altHome || !altAway) return false;

    const direct = pinHome === altHome && pinAway === altAway;
    const swapped = pinHome === altAway && pinAway === altHome;

    return swapped && !direct;
};

const ManualMatcher = () => {
    const [pinnacleData, setPinnacleData] = useState([]);
    const [altenarData, setAltenarData] = useState([]);
    const [loading, setLoading] = useState(false);
    
    const [filterPin, setFilterPin] = useState('');
    const [filterAlt, setFilterAlt] = useState('');
    const [showOnlyUnlinked, setShowOnlyUnlinked] = useState(true);
    const [filterTime, setFilterTime] = useState(false); // New State for Time Filtering

    const [selectedPin, setSelectedPin] = useState(null);
    const [selectedAlt, setSelectedAlt] = useState(null);
    const [linking, setLinking] = useState(false);
    const [unlinkingIds, setUnlinkingIds] = useState(new Set());

    const fetchData = async () => {
        setLoading(true);
        try {
            const res = await axios.get('http://localhost:3000/api/matcher/data');
            setPinnacleData(res.data.pinnacle);
            setAltenarData(res.data.altenar);
        } catch (e) {
            console.error("Error fetching matcher data:", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    // Filtrar Pinnacle
    const filteredPinnacle = pinnacleData.filter(p => {
        const matchesName = (p.home + ' ' + p.away).toLowerCase().includes(filterPin.toLowerCase());
        const isUnlinked = !p.altenarId;
        return matchesName && (showOnlyUnlinked ? isUnlinked : true);
    });

    // Identificar IDs de Altenar ya ocupados
    const linkedAltenarIds = new Set(pinnacleData.map(p => p.altenarId).filter(id => id != null));

    // Filtrar Altenar
    // Si hay un seleccionado en Pinnacle, sugerir por nombre
    const filteredAltenar = altenarData.filter(a => {
        // Ocultar si ya está linkeado (salvo que sea el match actual, aunque aquí buscamos NEW links)
        if (linkedAltenarIds.has(a.id)) return false;

        const matchesName = (a.name || '').toLowerCase().includes(filterAlt.toLowerCase());
        
        let matchesTime = true;
        if (filterTime && selectedPin) {
             // Exact Time Match (ignoring seconds/ms)
             const pinTime = new Date(selectedPin.date).setSeconds(0,0);
             const altTime = new Date(a.date).setSeconds(0,0);
             matchesTime = pinTime === altTime;
        }

        return matchesName && matchesTime;
    }).sort((a, b) => {
        // Advanced Sorting: If Pinnacle selected, sort by time proximity
        if (selectedPin) {
            const pinTime = new Date(selectedPin.date).getTime();
            const timeDiffA = Math.abs(pinTime - new Date(a.date).getTime());
            const timeDiffB = Math.abs(pinTime - new Date(b.date).getTime());
            return timeDiffA - timeDiffB;
        }
        // Default sort by date
        return new Date(a.date) - new Date(b.date);
    });

    // Auto-search Altenar cuando seleccionas Pinnacle
    useEffect(() => {
        if (selectedPin) {
            // Limpiar selección previa
            setSelectedAlt(null);
            // Pre-llenar búsqueda con el home team
            setFilterAlt(selectedPin.home.substring(0, 5)); 
            setFilterTime(true); // Auto-enable time filter when selecting a match
        }
    }, [selectedPin]);

    const handleLink = async () => {
        if (!selectedPin || !selectedAlt || linking) return;

        setLinking(true);

        try {
            const payload = {
                pinnacleId: selectedPin.id,
                altenarId: selectedAlt.id,
                altenarName: selectedAlt.name
            };

            const doLink = () => axios.post('http://localhost:3000/api/matcher/link', payload, { timeout: 15000 });

            try {
                await doLink();
            } catch (linkError) {
                const linkMsg = String(linkError?.response?.data?.error || linkError?.message || '').toLowerCase();
                const isTimeout = linkError?.code === 'ECONNABORTED' || linkMsg.includes('timeout');
                if (!isTimeout) throw linkError;

                await new Promise(resolve => setTimeout(resolve, 700));
                await doLink();
            }

            // Update local state locally to reflect change instantly
            setPinnacleData(prev => prev.map(p => {
                if (p.id === selectedPin.id) {
                    return { ...p, altenarId: selectedAlt.id, altenarName: selectedAlt.name };
                }
                return p;
            }));
            setSelectedPin(null);
            setSelectedAlt(null);
            setFilterAlt('');
        } catch (e) {
            alert("Error linking: " + e.message);
        } finally {
            setLinking(false);
        }
    };

    const handleUnlink = async (pinId) => {
        if (unlinkingIds.has(pinId)) return;
        if (!confirm("¿Romper enlace?")) return;

        setUnlinkingIds(prev => {
            const next = new Set(prev);
            next.add(pinId);
            return next;
        });

        try {
            await axios.post('http://localhost:3000/api/matcher/unlink', { pinnacleId: pinId }, { timeout: 10000 });
             setPinnacleData(prev => prev.map(p => {
                if (p.id === pinId) {
                    return { ...p, altenarId: null, altenarName: null };
                }
                return p;
            }));
        } catch (e) {
             alert("Error unlinking: " + e.message);
        } finally {
            setUnlinkingIds(prev => {
                const next = new Set(prev);
                next.delete(pinId);
                return next;
            });
        }
    };

    return (
        <div className="bg-gray-900 text-white min-h-[500px] p-4 rounded-lg shadow-xl">
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                    <Link className="text-blue-400" /> Manual Matcher
                </h2>
                <button onClick={fetchData} className="p-2 bg-gray-800 rounded hover:bg-gray-700">
                    <RefreshCw size={20} className={loading ? "animate-spin" : ""} />
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[75vh]">
                
                {/* COLUMNA IZQUIERDA: PINNACLE */}
                <div className="bg-gray-800 rounded-lg p-3 flex flex-col h-full overflow-hidden">
                    <h3 className="text-orange-400 font-bold mb-2 sticky top-0">1. Pinnacle Events ({filteredPinnacle.length})</h3>
                    
                    <div className="flex gap-2 mb-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2 top-2.5 text-gray-400" size={16} />
                            <input 
                                type="text" 
                                placeholder="Buscar Pinnacle..." 
                                className="w-full bg-gray-700 p-2 pl-8 rounded text-sm"
                                value={filterPin}
                                onChange={e => setFilterPin(e.target.value)}
                            />
                        </div>
                        <button 
                            onClick={() => setShowOnlyUnlinked(!showOnlyUnlinked)}
                            className={`px-3 py-1 rounded text-xs ${showOnlyUnlinked ? 'bg-blue-600' : 'bg-gray-600'}`}
                        >
                            {showOnlyUnlinked ? 'Unlinked Only' : 'Show All'}
                        </button>
                    </div>

                    <div className="overflow-y-auto flex-1 min-h-0 space-y-2 pr-2">
                        {filteredPinnacle.map(pin => (
                            <div 
                                key={pin.id} 
                                onClick={() => setSelectedPin(pin)}
                                className={`p-3 rounded cursor-pointer border-l-4 transition-all ${
                                    selectedPin?.id === pin.id 
                                        ? 'bg-blue-900/50 border-blue-500' 
                                        : pin.altenarId 
                                            ? 'bg-gray-700/50 border-green-500 opacity-60' 
                                            : 'bg-gray-700 border-red-500'
                                }`}
                            >
                                <div className="flex justify-between">
                                    <span className="font-bold text-sm">{pin.home} vs {pin.away}</span>
                                    {pin.altenarId && (
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); handleUnlink(pin.id); }}
                                            disabled={unlinkingIds.has(pin.id)}
                                            className={`text-red-400 hover:text-red-300 ${unlinkingIds.has(pin.id) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                        >
                                            <Unlink size={14} className={unlinkingIds.has(pin.id) ? 'animate-pulse' : ''} />
                                        </button>
                                    )}
                                </div>
                                <div className="text-xs text-gray-400 mt-1 flex justify-between">
                                    <span>{new Date(pin.date).toLocaleString()}</span>
                                    <span>{pin.league}</span>
                                </div>
                                {pin.altenarId && (
                                    <div className="text-xs text-green-400 mt-1 flex items-center gap-1">
                                        <Link size={10} /> Linked: {pin.altenarName}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* COLUMNA DERECHA: ALTENAR */}
                <div className="bg-gray-800 rounded-lg p-3 flex flex-col h-full relative overflow-hidden">
                     {/* OVERLAY SI NO HAY PINNACLE SELECCIONADO */}
                    {!selectedPin && (
                        <div className="absolute inset-0 bg-gray-900/80 z-10 flex flex-col items-center justify-center text-center p-6">
                            <AlertCircle size={48} className="text-gray-600 mb-4" />
                            <p className="text-gray-400">Selecciona un partido de Pinnacle a la izquierda para buscar su pareja en Altenar.</p>
                        </div>
                    )}

                    <h3 className="text-green-400 font-bold mb-2 sticky top-0">2. Altenar Candidates ({filteredAltenar.length})</h3>
                    
                    <div className="relative mb-2 flex gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2 top-2.5 text-gray-400" size={16} />
                            <input 
                                type="text" 
                                placeholder="Buscar en Altenar..." 
                                className="w-full bg-gray-700 p-2 pl-8 rounded text-sm"
                                value={filterAlt}
                                onChange={e => setFilterAlt(e.target.value)}
                            />
                        </div>
                        <button 
                            onClick={() => setFilterTime(!filterTime)}
                            className={`px-3 ml-2 rounded text-xs flex items-center gap-1 ${filterTime ? 'bg-orange-600 text-white' : 'bg-gray-600 text-gray-400'}`}
                            title="Filtrar por hora exacta (mismo minuto)"
                        >
                            <Clock size={14} />
                            {filterTime ? 'Time (Exact)' : 'Time OFF'}
                        </button>
                    </div>

                    <div className="overflow-y-auto flex-1 min-h-0 space-y-2 pr-2">
                        {filteredAltenar.slice(0, 50).map(alt => (
                            <div 
                                key={alt.id}
                                onClick={() => setSelectedAlt(alt)}
                                className={`p-3 rounded cursor-pointer border-l-4 transition-all ${
                                    selectedAlt?.id === alt.id 
                                        ? 'bg-green-900/50 border-green-500' 
                                        : 'bg-gray-700 border-gray-600 hover:bg-gray-600'
                                }`}
                            >
                                <div className="font-bold text-sm flex items-center gap-2">
                                    <span>{alt.name}</span>
                                    {selectedPin && isSwappedRisk(selectedPin, alt) && (
                                        <span className="text-[10px] border border-amber-500 text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded">
                                            SWAPPED RISK
                                        </span>
                                    )}
                                </div>
                                <div className="text-xs text-gray-400 mt-1 flex justify-between">
                                    <span>{new Date(alt.date).toLocaleString()}</span>
                                    <span>{alt.league} {alt.country ? `(${alt.country})` : ''}</span>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* ACTION BAR */}
                    <div className="mt-3 pt-3 border-t border-gray-700 bg-gray-800 z-20 sticky bottom-0">
                        <div className="flex gap-2">
                             <button 
                                onClick={() => { setSelectedPin(null); setSelectedAlt(null); }}
                                disabled={!selectedPin}
                                className="px-4 py-3 rounded font-bold text-gray-400 bg-gray-700 hover:bg-gray-600 disabled:opacity-0 transition-all"
                                title="Cancelar selección"
                            >
                                X
                            </button>
                            <button 
                                disabled={!selectedPin || !selectedAlt}
                                onClick={handleLink}
                                className={`flex-1 py-3 rounded font-bold flex items-center justify-center gap-2 transition-all ${
                                    !selectedPin || !selectedAlt || linking
                                        ? 'bg-gray-700 text-gray-500 border border-gray-600 cursor-not-allowed' 
                                        : 'bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/50'
                                }`}
                            >
                                {linking ? <RefreshCw size={20} className="animate-spin" /> : <Link size={20} />}
                                {linking ? 'LINKEANDO...' : 'CONFIRM LINK'}
                            </button>
                        </div>
                    </div>

                </div>

            </div>
        </div>
    );
};

export default ManualMatcher;