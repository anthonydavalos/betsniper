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
    .replace(/\bphilippines\b/g, 'filipinas')
    .replace(/\bpfl\b/g, 'liga futbol filipina')
    .replace(/\bclub friendlies\b/g, 'amistosos clubes')
    .replace(/\bamistosos de clubes\b/g, 'amistosos clubes')
    .replace(/\bturkey\b/g, 'turquia')
    .replace(/\b2nd\b/g, '2')
    .replace(/\bleague\b/g, 'lig')
    .replace(/\bpraha\b/g, 'prague')
    .replace(/\bsjk\b/g, 'seinajoen jk')
    .replace(/\btiffy army\b/g, 'national defense')
    .replace(/\bkisvarda 2\b/g, 'kisvarda bteam')
    .replace(/\bkisvarda fc ii\b/g, 'kisvarda bteam')
    .replace(/\bkomaromi vse\b/g, 'komarom')
    .replace(/\bfosfat\b/g, ' ')
    .replace(/\bspor\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(ii|iii|iv)\b/g, ' bteam ')
    .replace(/\b(b|res|reserve|reserves)\b/g, ' bteam ')
    .replace(/\b(fk|sk|fc|cf|sc|ac|mfk|fotbal|club)\b/g, ' ')
    .replace(/\(f\)|\(res\.?\)|\bu\d{2}\b|\bres\b|\breserves\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const resolveAliasName = (normalizedValue = '', aliases = {}) => {
    let current = String(normalizedValue || '');
    if (!current) return current;

    const visited = new Set();
    while (aliases[current] && !visited.has(current)) {
        visited.add(current);
        current = aliases[current];
    }

    return current;
};

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

const levenshteinDistance = (a = '', b = '') => {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    const m = s.length;
    const n = t.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i += 1) dp[i][0] = i;
    for (let j = 0; j <= n; j += 1) dp[0][j] = j;

    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }

    return dp[m][n];
};

const tokenScore = (a = '', b = '', aliases = {}) => {
    const na = resolveAliasName(normalizeText(a), aliases);
    const nb = resolveAliasName(normalizeText(b), aliases);
    const ta = na.split(' ').filter(Boolean);
    const tb = nb.split(' ').filter(Boolean);
    if (!ta.length || !tb.length) return 0;
    const sa = new Set(ta);
    const sb = new Set(tb);
    let overlap = 0;
    for (const w of sa) {
        if (sb.has(w)) overlap += 1;
    }
    return Math.max(overlap / sa.size, overlap / sb.size);
};

const textSimilarity = (a = '', b = '', aliases = {}) => {
    const na = resolveAliasName(normalizeText(a), aliases);
    const nb = resolveAliasName(normalizeText(b), aliases);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const tok = tokenScore(na, nb, aliases);
    const dist = levenshteinDistance(na, nb);
    const lev = 1 - (dist / Math.max(na.length, nb.length, 1));
    return Math.max(tok, lev);
};

const evaluatePairConfidence = (pin = {}, alt = {}, aliases = {}) => {
    const pinHome = pin?.home || splitSides(pin?.match || '').home;
    const pinAway = pin?.away || splitSides(pin?.match || '').away;
    const altSides = splitSides(alt?.name || `${alt?.home || ''} vs ${alt?.away || ''}`);

    const directHome = textSimilarity(pinHome, altSides.home, aliases);
    const directAway = textSimilarity(pinAway, altSides.away, aliases);
    const swappedHome = textSimilarity(pinHome, altSides.away, aliases);
    const swappedAway = textSimilarity(pinAway, altSides.home, aliases);

    const directScore = Math.min(directHome, directAway);
    const swappedScore = Math.min(swappedHome, swappedAway);

    return {
        directHome,
        directAway,
        swappedHome,
        swappedAway,
        directScore,
        swappedScore,
        orientation: directScore >= swappedScore ? 'direct' : 'swapped'
    };
};

const contextSimilarity = (pinLeague = '', altLeague = '', altCountry = '', aliases = {}) => {
    const left = normalizeText(pinLeague);
    const right = normalizeText(`${altLeague || ''} ${altCountry || ''}`);
    if (!left || !right) return null;
    return textSimilarity(left, right, aliases);
};

const ManualMatcher = () => {
    const [pinnacleData, setPinnacleData] = useState([]);
    const [altenarData, setAltenarData] = useState([]);
    const [loading, setLoading] = useState(false);
    const [buildingSuggestions, setBuildingSuggestions] = useState(false);
    const [applyingSuggestions, setApplyingSuggestions] = useState(false);
    const [suggestedLinks, setSuggestedLinks] = useState([]);
    const [dynamicAliases, setDynamicAliases] = useState({});
    
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
            const rawAliases = (res.data.aliases && typeof res.data.aliases === 'object') ? res.data.aliases : {};
            const normalizedAliases = {};
            for (const [fromRaw, toRaw] of Object.entries(rawAliases)) {
                const from = normalizeText(fromRaw);
                const to = normalizeText(toRaw);
                if (!from || !to) continue;
                normalizedAliases[from] = to;
            }
            setDynamicAliases(normalizedAliases);
            setSuggestedLinks([]);
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

    const buildHighConfidenceSuggestions = () => {
        const HIGH_CONF_MIN_PAIR_SCORE = 0.84;
        const HIGH_CONF_MIN_MARGIN = 0.08;
        const HIGH_CONF_MAX_TIME_DIFF_MIN = 2;
        const HIGH_CONF_MIN_LEAGUE_SCORE = 0.20;
        const HIGH_CONF_LEAGUE_EPS = 1e-6;
        const HIGH_CONF_SECONDARY_MIN_SIDE = 0.60;
        const HIGH_CONF_SECONDARY_MAX_SIDE = 0.98;
        const HIGH_CONF_VERY_STRONG_PAIR = 0.98;
        const MAX_SUGGESTIONS = 120;

        const occupiedAltIds = new Set(pinnacleData.map(p => p.altenarId).filter(id => id != null));
        const stagedAltIds = new Set();
        const unlinkedPin = pinnacleData.filter(p => !p.altenarId);
        const suggestions = [];

        for (const pin of unlinkedPin) {
            const pinTs = new Date(pin.date).getTime();
            if (!Number.isFinite(pinTs)) continue;

            const scored = [];

            for (const alt of altenarData) {
                if (!alt?.id || occupiedAltIds.has(alt.id) || stagedAltIds.has(alt.id)) continue;

                const altTs = new Date(alt.date).getTime();
                if (!Number.isFinite(altTs)) continue;

                const timeDiffMin = Math.abs(pinTs - altTs) / 60000;
                if (timeDiffMin > HIGH_CONF_MAX_TIME_DIFF_MIN) continue;

                const pair = evaluatePairConfidence(pin, alt, dynamicAliases);
                if (pair.orientation !== 'direct') continue;
                if (pair.swappedScore >= 0.82) continue;

                const leagueScore = contextSimilarity(pin?.league || '', alt?.league || '', alt?.country || '', dynamicAliases);

                const sideMin = Math.min(pair.directHome, pair.directAway);
                const sideMax = Math.max(pair.directHome, pair.directAway);
                const strongPrimary = pair.directScore >= HIGH_CONF_MIN_PAIR_SCORE;
                const strongSecondary =
                    timeDiffMin === 0 &&
                    sideMin >= HIGH_CONF_SECONDARY_MIN_SIDE &&
                    sideMax >= HIGH_CONF_SECONDARY_MAX_SIDE &&
                    pair.swappedScore <= 0.25;
                if (!strongPrimary && !strongSecondary) continue;

                const skipLeagueGate =
                    timeDiffMin === 0 &&
                    pair.directScore >= HIGH_CONF_VERY_STRONG_PAIR &&
                    pair.swappedScore <= 0.25;
                if (
                    !skipLeagueGate &&
                    leagueScore !== null &&
                    (leagueScore + HIGH_CONF_LEAGUE_EPS) < HIGH_CONF_MIN_LEAGUE_SCORE
                ) {
                    continue;
                }

                if (timeDiffMin > 0 && pair.directScore < 0.93) continue;

                const timeScore = Math.max(0, 1 - (timeDiffMin / HIGH_CONF_MAX_TIME_DIFF_MIN));
                const contextScore = leagueScore === null ? 0.5 : leagueScore;
                const confidence = (pair.directScore * 0.72) + (timeScore * 0.18) + (contextScore * 0.10);

                scored.push({
                    pin,
                    alt,
                    pair,
                    timeDiffMin,
                    leagueScore,
                    confidence
                });
            }

            if (!scored.length) continue;
            scored.sort((a, b) => b.confidence - a.confidence);

            const best = scored[0];
            const second = scored[1] || null;
            const margin = second ? (best.confidence - second.confidence) : 1;
            if (margin < HIGH_CONF_MIN_MARGIN) continue;

            stagedAltIds.add(best.alt.id);
            suggestions.push({ ...best, margin });
            if (suggestions.length >= MAX_SUGGESTIONS) break;
        }

        suggestions.sort((a, b) => b.confidence - a.confidence);
        return suggestions;
    };

    const handleSuggestHighConfidence = () => {
        setBuildingSuggestions(true);
        try {
            const suggestions = buildHighConfidenceSuggestions();
            setSuggestedLinks(suggestions);
        } finally {
            setBuildingSuggestions(false);
        }
    };

    const handleApplySuggested = async (limit = null) => {
        if (!suggestedLinks.length || applyingSuggestions) return;

        const batch = Number.isFinite(Number(limit)) && Number(limit) > 0
            ? suggestedLinks.slice(0, Number(limit))
            : suggestedLinks;
        if (!batch.length) return;

        setApplyingSuggestions(true);
        let applied = 0;
        let failed = 0;
        const failedItems = [];
        const appliedByPinId = new Map();

        try {
            for (const suggestion of batch) {
                const payload = {
                    pinnacleId: suggestion.pin.id,
                    altenarId: suggestion.alt.id,
                    altenarName: suggestion.alt.name
                };

                const doLink = () => axios.post('http://localhost:3000/api/matcher/link', payload, { timeout: 45000 });

                try {
                    try {
                        await doLink();
                    } catch (linkError) {
                        const status = Number(linkError?.response?.status);
                        const linkMsg = String(linkError?.response?.data?.error || linkError?.message || '').toLowerCase();
                        const isTimeout = linkError?.code === 'ECONNABORTED' || linkMsg.includes('timeout');
                        const isRace409 = status === 409;
                        if (!isTimeout && !isRace409) throw linkError;

                        await new Promise(resolve => setTimeout(resolve, 900));
                        await doLink();
                    }

                    applied += 1;
                    appliedByPinId.set(suggestion.pin.id, {
                        altenarId: suggestion.alt.id,
                        altenarName: suggestion.alt.name
                    });
                } catch (error) {
                    failed += 1;
                    failedItems.push(
                        `${suggestion.pin.home} vs ${suggestion.pin.away} -> ${suggestion.alt.name}: ${error?.response?.data?.error || error?.message || 'Error desconocido'}`
                    );
                }
            }

            if (appliedByPinId.size > 0) {
                setPinnacleData(prev => prev.map(p => {
                    const linked = appliedByPinId.get(p.id);
                    if (!linked) return p;
                    return {
                        ...p,
                        altenarId: linked.altenarId,
                        altenarName: linked.altenarName
                    };
                }));
            }

            if (applied > 0) {
                setSuggestedLinks(prev => prev.filter(s => !appliedByPinId.has(s.pin.id)));
            }

            if (failed > 0) {
                alert(
                    `Auto-link High Confidence finalizado. Aplicados: ${applied}, Fallidos: ${failed}.` +
                    `\n\nPrimeros fallos:\n${failedItems.slice(0, 5).join('\n')}`
                );
            }
        } finally {
            setApplyingSuggestions(false);
        }
    };

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

            const doLink = () => axios.post('http://localhost:3000/api/matcher/link', payload, { timeout: 45000 });

            try {
                await doLink();
            } catch (linkError) {
                const status = Number(linkError?.response?.status);
                const linkMsg = String(linkError?.response?.data?.error || linkError?.message || '').toLowerCase();
                const isTimeout = linkError?.code === 'ECONNABORTED' || linkMsg.includes('timeout');
                const isRace409 = status === 409;
                if (!isTimeout && !isRace409) throw linkError;

                await new Promise(resolve => setTimeout(resolve, 900));
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
            const status = Number(e?.response?.status);
            const serverMsg = e?.response?.data?.error;
            const baseMsg = serverMsg || e?.message || 'Error desconocido';
            const helper = status === 409
                ? '\n\nTip: hubo una carrera de escritura; actualiza y vuelve a intentar en 1-2s.'
                : '';
            alert("Error linking: " + baseMsg + helper);
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
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSuggestHighConfidence}
                        disabled={buildingSuggestions || loading}
                        className="px-3 py-2 bg-indigo-700 rounded hover:bg-indigo-600 disabled:opacity-60 disabled:cursor-not-allowed text-xs font-bold"
                        title="Generar sugerencias seguras por nombre+tiempo+contexto"
                    >
                        {buildingSuggestions ? 'SUGIRIENDO...' : 'SUGERIR HIGH CONF'}
                    </button>
                    <button
                        onClick={() => handleApplySuggested()}
                        disabled={applyingSuggestions || suggestedLinks.length === 0}
                        className="px-3 py-2 bg-emerald-700 rounded hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-xs font-bold"
                        title="Aplicar en lote solo sugerencias de alta confianza"
                    >
                        {applyingSuggestions ? 'APLICANDO...' : `APLICAR (${suggestedLinks.length})`}
                    </button>
                    <button
                        onClick={() => handleApplySuggested(20)}
                        disabled={applyingSuggestions || suggestedLinks.length === 0}
                        className="px-3 py-2 bg-teal-700 rounded hover:bg-teal-600 disabled:opacity-60 disabled:cursor-not-allowed text-xs font-bold"
                        title="Aplicar solo las primeras 20 sugerencias de alta confianza"
                    >
                        {applyingSuggestions ? 'APLICANDO TOP 20...' : `APLICAR TOP 20 (${Math.min(20, suggestedLinks.length)})`}
                    </button>
                    <button onClick={fetchData} className="p-2 bg-gray-800 rounded hover:bg-gray-700">
                        <RefreshCw size={20} className={loading ? "animate-spin" : ""} />
                    </button>
                </div>
            </div>

            {suggestedLinks.length > 0 && (
                <div className="mb-4 bg-emerald-950/40 border border-emerald-700 rounded-lg p-3">
                    <div className="flex items-center justify-between">
                        <div className="text-sm font-bold text-emerald-300 flex items-center gap-2">
                            <CheckCircle size={16} />
                            Sugerencias High Confidence: {suggestedLinks.length}
                        </div>
                        <div className="text-[11px] text-emerald-200/80">
                            Solo se incluyen pares con orientación directa, score alto y sin ambigüedad
                        </div>
                    </div>
                    <div className="mt-2 max-h-40 overflow-y-auto text-xs space-y-1">
                        {suggestedLinks.slice(0, 25).map(item => (
                            <div key={`${item.pin.id}_${item.alt.id}`} className="flex justify-between gap-2">
                                <span className="text-emerald-100">
                                    {item.pin.home} vs {item.pin.away} → {item.alt.name}
                                </span>
                                <span className="text-emerald-300">
                                    conf={item.confidence.toFixed(3)} pair={item.pair.directScore.toFixed(3)} Δt={item.timeDiffMin.toFixed(1)}m
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

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