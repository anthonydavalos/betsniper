import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { findMatch } from '../utils/teamMatcher.js'; // [NEW]
import { getKellyBankrollBase } from './bookyAccountService.js';

let liveKellyBankroll = 100;

const parsePositiveNumberOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

const LIVE_VALUE_MIN_EV = parsePositiveNumberOr(process.env.LIVE_VALUE_MIN_EV, 0.02);
const LIVE_VALUE_NON_1X2_STAKE_FACTOR = parsePositiveNumberOr(process.env.LIVE_VALUE_NON_1X2_STAKE_FACTOR, 1);
const LIVE_VALUE_MIN_DISPLAY_STAKE = parsePositiveNumberOr(process.env.LIVE_VALUE_MIN_DISPLAY_STAKE, 0.1);

const liveOpportunityStability = new Map();
const STABILITY_WINDOW_MS = 25000;
const STABILITY_MIN_HITS = 2;
const STABILITY_MIN_AGE_MS = 4000;

const shouldPublishStableOpportunity = (opKey) => {
    const now = Date.now();
    const prev = liveOpportunityStability.get(opKey);

    if (!prev || (now - prev.lastSeenAt) > STABILITY_WINDOW_MS) {
        liveOpportunityStability.set(opKey, {
            firstSeenAt: now,
            lastSeenAt: now,
            hits: 1
        });
        return false;
    }

    const next = {
        firstSeenAt: prev.firstSeenAt,
        lastSeenAt: now,
        hits: prev.hits + 1
    };
    liveOpportunityStability.set(opKey, next);

    const age = now - next.firstSeenAt;
    return next.hits >= STABILITY_MIN_HITS && age >= STABILITY_MIN_AGE_MS;
};

const pruneStabilityCache = () => {
    const now = Date.now();
    for (const [key, state] of liveOpportunityStability.entries()) {
        if ((now - state.lastSeenAt) > STABILITY_WINDOW_MS * 2) {
            liveOpportunityStability.delete(key);
        }
    }
};

const normalizeMarketText = (value = '') => String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeApiMarketLabel = (value = '') => {
    const normalized = normalizeMarketText(value);
    if (!normalized) return value;
    if (normalized === '1x2' || normalized.includes('match winner') || normalized.includes('match result') || normalized.includes('moneyline')) {
        return '1x2';
    }
    return value;
};

const is1x2MarketName = (value = '') => {
    const normalized = normalizeMarketText(value);
    return (
        normalized === '1x2' ||
        normalized === '1 x 2' ||
        normalized.includes('match winner') ||
        normalized.includes('match result') ||
        normalized.includes('moneyline')
    );
};

const tokenizeMarketText = (value = '') => normalizeMarketText(value).split(/\s+/).filter(Boolean);

const flattenMarketOddIds = (market = {}) => {
    if (Array.isArray(market.desktopOddIds)) return market.desktopOddIds.flat().filter(Boolean);
    if (Array.isArray(market.oddIds)) return market.oddIds.filter(Boolean);
    return [];
};

const resolveDoubleChanceSide = (odd = {}) => {
    const normalized = normalizeMarketText(odd?.name || '');
    const compact = normalized.replace(/\s+/g, '');

    if (compact.includes('1x')) return '1X';
    if (compact.includes('x2')) return 'X2';
    if (compact.includes('12')) return '12';

    if (normalized.includes('home draw') || normalized.includes('local empate')) return '1X';
    if (normalized.includes('draw away') || normalized.includes('empate visita')) return 'X2';
    if (normalized.includes('home away') || normalized.includes('local visita')) return '12';

    return null;
};

const parseScorePair = (value) => {
    if (Array.isArray(value) && value.length >= 2) {
        const home = parseInt(value[0], 10);
        const away = parseInt(value[1], 10);
        if (Number.isFinite(home) && Number.isFinite(away)) return [home, away];
    }

    if (typeof value === 'string') {
        const match = value.match(/(\d+)\s*[-:]\s*(\d+)/);
        if (match) {
            const home = parseInt(match[1], 10);
            const away = parseInt(match[2], 10);
            if (Number.isFinite(home) && Number.isFinite(away)) return [home, away];
        }
    }

    if (value && typeof value === 'object') {
        const home = Number(value.home ?? value.h ?? value.homeScore);
        const away = Number(value.away ?? value.a ?? value.awayScore);
        if (Number.isFinite(home) && Number.isFinite(away)) return [home, away];
    }

    return null;
};

const isScoreSynchronized = (altenarScore, pinnacleScore) => {
    const a = parseScorePair(altenarScore);
    const p = parseScorePair(pinnacleScore);

    if (!a || !p) return false;

    return a[0] === p[0] && a[1] === p[1];
};

const isMatchTotalMarket = (market, eventName, oddsMap) => {
    const n = normalizeMarketText(market?.name || '');
    if (!n) return false;

    const whitelist = ['total', 'over under', 'linea de gol', 'goals', 'goles'];
    if (!whitelist.some(v => n.includes(v))) return false;

    const forbidden = [
        'corner', 'esquina', 'card', 'tarjeta', 'amarilla', 'roja', 'booking',
        'half', 'mitad', 'tiempo', '1st', '2nd', '1er', '2do', 'primer', 'segundo',
        'team', 'equipo', 'player', 'jugador', 'goleador', 'scorer',
        'doble', 'chance', 'btts', 'both', 'ambos', 'marca',
        'result', 'resultado', 'handicap', 'asian', 'asiatico', 'exact', 'range', 'rango',
        'rest', 'odd even', 'par impar', 'winning', 'margin', 'margen',
        '1x2', 'multi', 'escala', 'team total', 'total del equipo', 'total de equipo',
        'goles del equipo', 'equipo total', 'equipo 1', 'equipo 2', 'home total', 'away total',
        'local', 'visitante', 'home', 'away', 'casa', 'fuera', 'anota', 'score', 'porteria', 'arco'
    ];
    if (forbidden.some(word => n.includes(word))) return false;

    const hasCompetitorBinding = Number.isFinite(Number(market?.competitorId)) ||
        (Array.isArray(market?.competitorIds) && market.competitorIds.length > 0);
    if (hasCompetitorBinding) return false;

    const eventParts = String(eventName || '').split(/\s+vs\.?\s+/i);
    const homeParts = tokenizeMarketText(eventParts[0] || '').filter(w => w.length >= 3);
    const awayParts = tokenizeMarketText(eventParts[1] || '').filter(w => w.length >= 3);
    const stopWords = new Set([
        'fc', 'sc', 'cd', 'ca', 'club', 'de', 'la', 'el', 'los', 'al',
        'united', 'city', 'real', 'sport', 'res', 'u21', 'u20', 'u19', 'women', 'femenino', 'b'
    ]);
    const teamTokens = [...new Set([...homeParts, ...awayParts].filter(t => !stopWords.has(t)))];

    if (teamTokens.some(t => n.includes(t))) return false;

    const oddTexts = flattenMarketOddIds(market)
        .map(id => oddsMap.get(id))
        .filter(Boolean)
        .map(o => normalizeMarketText(o.name || ''));

    if (oddTexts.some(txt => teamTokens.some(t => txt.includes(t)))) return false;

    return true;
};

// =====================================================================
// SERVICE: LIVE VALUE SCANNER v2
// Estrategia: Value Investing Live (Pinnacle como Source of Truth)
// Soporta: Match Result (1x2), Double Chance, Totals (Over/Under)
// =====================================================================

/**
 * Obtiene un resumen ligero de TODOS los partidos en vivo de fútbol.
 */
export const getLiveOverview = async () => {
    try {
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { 
                sportId: 66, 
                categoryId: 0,
                _: Date.now() // [MOD] Cache Buster
            }
        });

        // [NEW] Mapas de búsqueda rápida para Ligas y Países (Relational Data)
        const champsMap = new Map();
        if (Array.isArray(data.champs)) {
            data.champs.forEach(c => champsMap.set(c.id, c.name));
        }

        const catsMap = new Map();
        if (Array.isArray(data.categories)) {
            data.categories.forEach(c => catsMap.set(c.id, c.name));
        }
        
        return (data.events || []).map(ev => {
             // [NEW] Enriquecer con nombres reales
             const leagueName = champsMap.get(ev.champId) || "";
             const countryName = catsMap.get(ev.catId) || "";

             const status = ev.ls || ""; 
             let cleanTime = ev.liveTime;
             
             // [FALLBACK IMPROVED] Si tiempo es inválido o 0, calculamos desde startDate
             // Eliminamos dependencia de ev.clock que no existe fiablemente
             const isInvalidTime = !cleanTime || cleanTime === "0'" || cleanTime === "" || cleanTime === 0 || cleanTime === "0";
             
             if (isInvalidTime && ev.startDate) {
                 const startedAt = new Date(ev.startDate).getTime();
                 const now = Date.now();
                 let diffMins = Math.floor((now - startedAt) / 60000);
                 
                 if (diffMins < 0) diffMins = 0; // Evitar negativos
                 
                 // Solo aplicamos corrección si hace sentido (entre 0 y 130 mins)
                 if (diffMins >= 0 && diffMins < 130) {
                     if (status.toLowerCase().includes('2nd') || status.toLowerCase().includes('2t')) {
                         cleanTime = `${Math.max(46, diffMins)}'`;
                     } else if (diffMins === 0) { // Si es 0 pero está activo
                         cleanTime = "1'"; 
                     } else {
                         cleanTime = `${diffMins}'`;
                     }
                 }
             }

             // Formato final: Siempre devolver string con '
             if (cleanTime && !String(cleanTime).includes("'") && !String(cleanTime).includes(":") && cleanTime !== "HT" && cleanTime !== "Final") {
                cleanTime = `${cleanTime}'`;
             }

             const statusLower = (status || "").toLowerCase();

             // [FIX] Mostrar "HT" claramente en el frontend
             if (statusLower.includes('half') || statusLower.includes('descanso') || statusLower.includes('ht') || statusLower.includes('intermedio')) {
                 cleanTime = "HT";
             }

             // Detectar Extra Time / Prórrogas / Penales
             const isExplicitEnd = statusLower.includes('ended') || statusLower.includes('fin') || statusLower.includes('ft');
             if (isExplicitEnd) {
                 cleanTime = "Final"; 
             }
             
             return {
                 ...ev,
                 league: leagueName,   // [NEW]
                 country: countryName, // [NEW]
                 liveTime: cleanTime || "0'", // Fallback final
                 score: ev.score || [], // Asegurar score
                 rawStatus: status
             };
        });
    } catch (error) {
        console.error('❌ Error en GetLivenow:', error.message);
        return [];
    }
};

/**
 * Obtiene detalles profundos de un partido específico (Stats, Tarjetas).
 */
export const getEventDetails = async (eventId) => {
    try {
        const { data } = await altenarClient.get('/GetEventDetails', {
            params: { 
                eventId,
                _: Date.now() // [MOD] Cache Buster para asegurar datos frescos siempre
            }
        });
        return data; 
    } catch (error) {
        return null; 
    }
};

/**
 * ESCÁNER DE OPORTUNIDADES LIVE
 * @param {Array} preFetchedEvents - (Opcional) Eventos raw ya obtenidos para ahorrar calls.
 */
export const scanLiveOpportunities = async (preFetchedEvents = null) => {
    await initDB(); 
    pruneStabilityCache();
    const bankrollBase = await getKellyBankrollBase();
    liveKellyBankroll = bankrollBase.amount;
    const pinnacleDb = db.data.upcomingMatches || [];
    
    // Mapa: AltenarID -> PinnacleMatchData
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(m.altenarId, m);
    });

    // Obtener vista general (Usar pre-fetched o llamar API)
    const liveEvents = preFetchedEvents || await getLiveOverview();
    const opportunities = [];

    console.log(`📡 Escaneando en vivo (V2 Value)... (${liveEvents.length} eventos, ${linkedMatches.size} links)`);

    // Import dinámico de servicios Pinnacle
    const { getAllPinnacleLiveOdds } = await import('./pinnacleService.js');

    // Filtramos partidos finalizados
    const activeEvents = liveEvents.filter(e => e.liveTime !== 'Final');

    if (activeEvents.length === 0) return [];

    // --- OBTENER SNAPSHOT MASIVO (Estrategia "The Firehose") ---
    const globalPinnacleOdds = await getAllPinnacleLiveOdds();
    const pinLiveArray = globalPinnacleOdds ? Array.from(globalPinnacleOdds.values()) : [];

    for (const event of activeEvents) {
        let pinMatch = linkedMatches.get(event.id);
        let pinLiveOdds = null;

        if (pinMatch) {
            // Caso 1: Existe link Pre-Match (Ideal)
            pinLiveOdds = globalPinnacleOdds ? globalPinnacleOdds.get(Number(pinMatch.id)) : null;
        } else {
            // Caso 2: Intento de Match Dinámico (Live-to-Live)
            // Útil para partidos que entraron tarde o no estaban en Pre-Match DB
            const parts = (event.name || "").split(/ vs\.? /i);
            const homeName = parts[0];
            const awayName = parts[1]; // Capture Away Name for reverse check

            if (homeName && pinLiveArray.length > 0) {
                 const targetDate = event.startDate || new Date().toISOString(); 
                 
                 // Intento 1: Match Directo (Home vs Home)
                 let matchResult = findMatch(homeName, targetDate, pinLiveArray, null, event.league);
                 
                 // Intento 2: Match Inverso (Away vs Home) - Caso Stjarnan vs B93 (Altenar) vs B93 vs Stjarnan (Pinnacle)
                 if ((!matchResult || matchResult.score < 0.6) && awayName) {
                     // Buscamos si el equipo visitante de Altenar es el local en Pinnacle
                     const reverseMatch = findMatch(awayName, targetDate, pinLiveArray, null, event.league);
                     if (reverseMatch && reverseMatch.score >= 0.7) { // Unbral más estricto para inverso
                         matchResult = reverseMatch;
                         // console.log(`🔄 LINK INVERSO DETECTADO: ${awayName} -> ${reverseMatch.match.home}`);
                     }
                 }
                 
                 if (matchResult && matchResult.score >= 0.6) {
                     pinLiveOdds = matchResult.match; // El objeto del mapa YA CONTIENE las cuotas
                     
                     if (pinLiveOdds && pinLiveOdds.match) {
                        
                        // [FIX] Recuperación Inversa: Intentar buscar en DB (Prematch) usando el ID encontrado dinámicamente
                        // Esto permite recuperar las PREMATCH ODDS aunque el linker inicial haya fallado.
                        const dbMatch = pinnacleDb.find(m => String(m.id) === String(pinLiveOdds.id));
                        
                        if (dbMatch) {
                            pinMatch = dbMatch;
                            // console.log(`   🔗 Recuperado Prematch por ID Dinámico: ${pinMatch.home} vs ${pinMatch.away}`);
                        } else {
                            // Si no existe en DB, creamos un objeto temporal (Sin prematch odds)
                            pinMatch = {
                                id: pinLiveOdds.id,
                                home: (pinLiveOdds.match).split(' vs ')[0] || "Unknown",
                                away: (pinLiveOdds.match).split(' vs ')[1] || "Unknown",
                                isDynamic: true,
                                league: { name: pinLiveOdds.league || "Dynamic Link" }
                            };
                        }
                     } else {
                        pinLiveOdds = null;
                     }
                 }
            }
        }
        
        if (!pinLiveOdds) {
             // Si no hay cuotas de Pinnacle (ni por ID ni por nombre), skip.
             continue; 
        } 

        // --- PASO 2: ALTENAR DETAILS (BOOKMAKER) --- 

        // --- PASO 2: ALTENAR DETAILS (BOOKMAKER) ---
        let details;
        try {
            details = await getEventDetails(event.id);
        } catch (e) { continue; }

        if (!details || !details.markets) continue;

        // [MOD] Actualizar liveTime y score usando details si están disponibles y más completos
        // details.clock suele tener { matchTime: "45:00", status: 2 } o similar
        if (details.liveTime && details.liveTime !== event.liveTime) {
            // console.log(`   ⏱️ Actualizando tiempo ${event.name}: ${event.liveTime} -> ${details.liveTime}`);
            event.liveTime = details.liveTime;
        }

        // [FIX] Sincronización de Tiempos Robusta (Reloj Ganador) para Evitar Congelamiento
        // Comparamos el tiempo que trae Pinnacle (pinLiveOdds.time) vs el de Altenar (event.liveTime/details)
        const pinTimeMin = pinLiveOdds ? (parseInt(String(pinLiveOdds.time).replace(/[^0-9]/g, "")) || 0) : 0;
        const evtTimeMin = (event.liveTime && event.liveTime !== "0'") ? (parseInt(String(event.liveTime).replace(/[^0-9]/g, "")) || 0) : 0;

        // Si Pinnacle está congelado (es menor que Altenar), forzar que el objeto Pinnacle tenga el tiempo de Altenar
        if (pinLiveOdds && evtTimeMin > pinTimeMin) {
            pinLiveOdds.time = event.liveTime;
        }
        // Si Pinnacle está adelantado (pero coherente, ej. feed oficial más rápido), actualizar Altenar
        else if (pinLiveOdds && pinTimeMin > evtTimeMin && pinTimeMin < evtTimeMin + 15) {
             event.liveTime = pinLiveOdds.time;
        }

        if (details.score && Array.isArray(details.score) && details.score.length > 0) {
            event.score = details.score;
        }

        // [ANTI-FALSO-POSITIVO] Si marcador Altenar y Pinnacle no están sincronizados,
        // NO evaluamos oportunidades en este ciclo para evitar alertas falsas post-gol.
        const scoreInSync = isScoreSynchronized(event.score, pinLiveOdds.score);
        if (!scoreInSync) {
            const altScore = parseScorePair(event.score);
            const pinScore = parseScorePair(pinLiveOdds.score);
            console.log(`⏸️ [SYNC-GUARD] Skip ${event.name}: marcador desincronizado Alt=${altScore ? `${altScore[0]}-${altScore[1]}` : 'N/A'} vs Pin=${pinScore ? `${pinScore[0]}-${pinScore[1]}` : 'N/A'}`);
            continue;
        }

        const altenarOddsMap = new Map();
        if (details.odds && Array.isArray(details.odds)) {
            details.odds.forEach(o => altenarOddsMap.set(o.id, o));
        }

        // --- PASO 3: ANÁLISIS POR ESTRATEGIA ---

        // >>> ESTRATEGIA A: 1X2 (MATCH RESULT) <<<
        const market1x2 = details.markets.find(m => m.typeId === 1); 
        if (market1x2 && pinLiveOdds.moneyline) {
            const oddIds = (market1x2.desktopOddIds || []).flat(); 
            const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);
            
            const altHome = oddsObjs.find(o => o.typeId === 1);
            const altDraw = oddsObjs.find(o => o.typeId === 2);
            const altAway = oddsObjs.find(o => o.typeId === 3);

            if (altHome && pinLiveOdds.moneyline.home) checkAndAddOpp(opportunities, event, pinMatch, '1x2', 'Home', altHome.price, pinLiveOdds.moneyline.home, pinLiveOdds.moneyline, pinLiveOdds);
            if (altAway && pinLiveOdds.moneyline.away) checkAndAddOpp(opportunities, event, pinMatch, '1x2', 'Away', altAway.price, pinLiveOdds.moneyline.away, pinLiveOdds.moneyline, pinLiveOdds);
            if (altDraw && pinLiveOdds.moneyline.draw) checkAndAddOpp(opportunities, event, pinMatch, '1x2', 'Draw', altDraw.price, pinLiveOdds.moneyline.draw, pinLiveOdds.moneyline, pinLiveOdds);
        }

        // >>> ESTRATEGIA B: DOUBLE CHANCE (DOBLE OPORTUNIDAD) <<<
        const marketDC = details.markets.find(m => {
            if (m.typeId === 10) return true;
            const name = normalizeMarketText(m.name || '');
            return name.includes('double chance') || name.includes('doble oportunidad') || name.includes('doble chance');
        });
        if (marketDC && pinLiveOdds.doubleChance) {
            const oddIds = (marketDC.desktopOddIds || []).flat();
            const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);

            const cand1X = oddsObjs.find(o => resolveDoubleChanceSide(o) === '1X');
            const cand12 = oddsObjs.find(o => resolveDoubleChanceSide(o) === '12');
            const candX2 = oddsObjs.find(o => resolveDoubleChanceSide(o) === 'X2');

            if (cand1X && pinLiveOdds.doubleChance.homeDraw) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', '1X', cand1X.price, pinLiveOdds.doubleChance.homeDraw, pinLiveOdds.doubleChance, pinLiveOdds);
            if (cand12 && pinLiveOdds.doubleChance.homeAway) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', '12', cand12.price, pinLiveOdds.doubleChance.homeAway, pinLiveOdds.doubleChance, pinLiveOdds);
            if (candX2 && pinLiveOdds.doubleChance.drawAway) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', 'X2', candX2.price, pinLiveOdds.doubleChance.drawAway, pinLiveOdds.doubleChance, pinLiveOdds);
        }

        // >>> ESTRATEGIA C: OVER/UNDER (TOTAL GOALS) <<<
        const totalMarkets = details.markets.filter(m => {
            return isMatchTotalMarket(m, event.name, altenarOddsMap);
        });
        
            // --- NUEVO ENFOQUE: AGRUPAR POR LÍNEAS (Igual que Monitor) ---
            // Iteramos sobre TODOS los mercados de totales, y luego sobre TODAS sus cuotas internas.
            // Agrupamos por la línea que diga SU NOMBRE ("Más de 2.5", "Menos de 2.5"), no la del mercado padre.

            const totalsBuffer = new Map(); // Map<Line, {over, under}>

            for (const mTotal of totalMarkets) {
                const oddIds = (mTotal.desktopOddIds || []).flat();
                
                for (const oid of oddIds) {
                    const o = altenarOddsMap.get(oid);
                    if (!o || !o.name) continue; // Skip inválidos

                    const name = o.name.toLowerCase();
                    const price = o.price;
                    
                    // 1. Extraer línea del nombre del pick (Ej: "Más de 3.5" -> 3.5)
                    // Esta es la Fuente de la Verdad Definitiva.
                    const match = name.match(/(\d+\.?\d*)/);
                    if (!match) continue; 
                    
                    const line = parseFloat(match[0]);
                    if (isNaN(line)) continue;

                    // 2. Filtros de Negocio
                    if (line % 1 !== 0.5) continue; // Solo asiáticos puros (.5)

                    // 3. Inicializar grupo en Buffer
                    if (!totalsBuffer.has(line)) totalsBuffer.set(line, { line });
                    const entry = totalsBuffer.get(line);

                    // 4. Asignar Over/Under
                    if (name.includes('más') || name.includes('over')) entry.over = { price, obj: o };
                    else if (name.includes('menos') || name.includes('under')) entry.under = { price, obj: o };
                }
            }

            // --- PROCESAR EL BUFFER Y COMPARAR CON PINNACLE ---
            totalsBuffer.forEach((altData, line) => {
                 // Buscar linea equivalente en Pinnacle (Delta 0.1)
                const pinLineObj = pinLiveOdds.totals.find(t => Math.abs(t.line - line) < 0.1);
                
                if (pinLineObj) {
                    // Validar Over
                    if (altData.over && pinLineObj.over) {
                        checkAndAddOpp(opportunities, event, pinMatch, `Total Goals ${line}`, 'Over', altData.over.price, pinLineObj.over, pinLineObj, pinLiveOdds);
                    }
                    // Validar Under
                    if (altData.under && pinLineObj.under) {
                        checkAndAddOpp(opportunities, event, pinMatch, `Total Goals ${line}`, 'Under', altData.under.price, pinLineObj.under, pinLineObj, pinLiveOdds);
                    }
                }
            });
    } 

    if (opportunities.length > 0) {
        console.log(`✅ ${opportunities.length} OPORTUNIDADES ENCONTRADAS.`);
        // Resumen de tipos
        const types = opportunities.reduce((acc, curr) => {
            acc[curr.market] = (acc[curr.market] || 0) + 1;
            return acc;
        }, {});
        console.log(`   Tipos: ${JSON.stringify(types)}`);
    }

    return opportunities;
};


/**
 * HELPER: Evaluar EV y Kelly
 */
const checkAndAddOpp = (opsArray, event, pinMatch, marketName, selection, altOdd, pinOdd, contextGroup, pinLiveParent) => {
    // 1. Validar Cuotas
    if (altOdd < 1.05 || altOdd > 100) return;
    if (!pinOdd || pinOdd <= 1) return;

    // 2. Calcular Probabilidad Real (Fair)
    let totalImplied = 0;
    
    if (contextGroup.home !== undefined && contextGroup.away !== undefined) {
        // [FIX] Validar que draw existe y es mayor a 1, si no usar valor seguro
        const dPrice = contextGroup.draw > 1 ? contextGroup.draw : 999;
        const dImp = 1/dPrice;
        totalImplied = (1/contextGroup.home) + (1/contextGroup.away) + dImp;
    } else if (contextGroup.homeDraw !== undefined) {
        totalImplied = (1/contextGroup.homeDraw) + (1/contextGroup.homeAway) + (1/contextGroup.drawAway);
    } else if (contextGroup.over !== undefined) {
        totalImplied = (1/contextGroup.over) + (1/contextGroup.under);
    }
    
    if (totalImplied === 0) totalImplied = 1.05;

    const rawProb = 1 / pinOdd;
    const fairProb = rawProb / totalImplied; 
    const fairPrice = 1 / fairProb;

    // 3. EV y Kelly
    const ev = (fairProb * altOdd) - 1;
    // ESTRATEGIA: LIVE_VALUE (Perfil Medio Riesgo)
    // Usamos 'LIVE_VALUE' como identificador para mathUtils
    const kellyRes = calculateKellyStake(fairProb * 100, altOdd, liveKellyBankroll || 100, 'LIVE_VALUE'); 

    // [DEBUG] Loggear Totals detectados aunque tengan poco EV para confirmar que la lógica funciona
    // if (marketName.includes('Total') && ev > -0.05) {
    //    console.log(`TYPE: ${marketName} ${selection} | Alt: ${altOdd} | Pin: ${pinOdd} | EV: ${(ev*100).toFixed(1)}%`);
    // }

    // Umbral configurable por entorno (default 2%)
    if (ev > LIVE_VALUE_MIN_EV && kellyRes.amount > 0) {
        const isMain1x2 = is1x2MarketName(marketName);
        const stakeFactor = isMain1x2 ? 1 : LIVE_VALUE_NON_1X2_STAKE_FACTOR;
        const safeStake = kellyRes.amount * stakeFactor;

        // Filtro mínimo para visualización (default 0.10)
        if (safeStake < LIVE_VALUE_MIN_DISPLAY_STAKE) return;

        // [ANTI-FAKE-SPIKE] Requerir confirmación temporal en 2 ticks antes de publicar.
        // Evita falsas oportunidades cuando un feed actualiza antes que el otro por unos segundos.
        const oppKey = `${event.id}|${marketName}|${selection}`;
        if (!shouldPublishStableOpportunity(oppKey)) return;

        // console.log(`   🔥 VALOR DETECTADO: ${event.name} | ${marketName} ${selection} | Alt: ${altOdd} vs Real: ${fairPrice.toFixed(2)} | EV: ${(ev*100).toFixed(1)}%`);
        
        // Priority Data Selection (Pinnacle > Altenar)
        const displayTime = pinLiveParent ? pinLiveParent.time : event.liveTime;
        const displayScore = pinLiveParent ? pinLiveParent.score : (event.score || []).join("-");

        // [NEW] Extract Prematch Odd from Pinnacle (Source of Truth) for comparison
        let pinPrematchPrice = null;
        if (pinMatch && pinMatch.odds) {
            
            // Normalize Market Name for Comparison
            const normalizedMarket = marketName.toLowerCase();

            if (is1x2MarketName(normalizedMarket) || normalizedMarket.includes('ganador')) {
                if (selection === 'Home') pinPrematchPrice = pinMatch.odds.home;
                if (selection === 'Draw') pinPrematchPrice = pinMatch.odds.draw;
                else if (selection === 'Away') pinPrematchPrice = pinMatch.odds.away;
            
            } else if (normalizedMarket.includes('total goals') || normalizedMarket.includes('total') || normalizedMarket.includes('goles')) {
                // Extract line: "Total Goals 2.5" -> 2.5
                const lineMatch = marketName.match(/(\d+\.?\d*)/);
                if (lineMatch && pinMatch.odds.totals) {
                    const line = parseFloat(lineMatch[0]);
                    const preTotal = pinMatch.odds.totals.find(t => Math.abs(t.line - line) < 0.1);
                    if (preTotal) {
                        const sel = selection.trim().toLowerCase();
                        if (sel.includes('over') || sel.includes('más')) pinPrematchPrice = preTotal.over;
                        else if (sel.includes('under') || sel.includes('menos')) pinPrematchPrice = preTotal.under;
                    }
                }
            }
        }
        
        // [DEBUG TEMP]
        // if (pinPrematchPrice) console.log(`[DEBUG_PM] Found Prematch: ${event.name} [${marketName}] -> ${pinPrematchPrice}`);

        // [DEBUG] Diagnóstico de Oportunidad
        console.log(`[DEBUG_OPP] event=${event.name} | hasPinParent=${!!pinLiveParent}`);
        if (pinLiveParent) {
            console.log(`   > PinData: Time="${pinLiveParent.time}" Score="${pinLiveParent.score}" ID=${pinLiveParent.id}`);
        } else {
            // console.log(`   > PinData: NULL (Using Altenar: Time=${event.liveTime})`);
        }
        
        // [DEBUG] Diagnóstico de Oportunidad
        opsArray.push({
            type: 'LIVE_VALUE',
            eventId: event.id,
            pinnacleId: pinMatch.id,
            match: event.name,
            league: (pinMatch.league && pinMatch.league.name) ? pinMatch.league.name : (pinMatch.isDynamic ? "Dynamic Link" : "Unknown"),
            market: normalizeApiMarketLabel(marketName),
            selection: selection,
            price: altOdd,
            pinnaclePrice: pinOdd, // Raw Pinnacle Odds (With Vig)
            realPrice: Number(fairPrice.toFixed(2)),
            
            ev: Number((ev * 100).toFixed(2)),
            kellyStake: Number(safeStake.toFixed(2)),
            
            // CRITICAL FIX: Pass realProb (as Percentage) to paperTradingService
            realProb: Number((fairProb * 100).toFixed(2)), 

            time: displayTime,
            score: displayScore,
            
            // [NEW] Enhanced Pinnacle Sync Info for UI
            pinnacleInfo: {
                id: pinMatch.id,
                time: displayTime,
                score: displayScore,
                lastUpdate: new Date().toISOString(),
                // [NEW] Pass Pre-Match Odd to UI
                prematchPrice: pinPrematchPrice,
                // [NEW] Full Context for Badges
                prematchContext: {
                    home: pinMatch.odds?.home,
                    draw: pinMatch.odds?.draw,
                    away: pinMatch.odds?.away,
                    over25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.over,
                    under25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.under,
                }
            },

            foundAt: new Date().toISOString(),
            action: `BET ${selection} @ ${altOdd}`
        });
    }
};

/**
 * [MONITOR] Obtiene comparación detallada de cuotas para el Dashboard
 */
export const getLiveOddsComparison = async () => {
    await initDB();
    const pinnacleDb = db.data.upcomingMatches || [];
    const altenarPrematchDb = db.data.altenarUpcoming || []; // [NEW] Load Altenar Prematch
    
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(String(m.altenarId), m);
    });

    const liveEvents = await getLiveOverview();
    const activeEvents = liveEvents.filter(e => e.liveTime !== 'Final');

    const { getAllPinnacleLiveOdds } = await import('./pinnacleService.js');
    const globalPinnacleOdds = await getAllPinnacleLiveOdds();
    const pinLiveArray = globalPinnacleOdds ? Array.from(globalPinnacleOdds.values()) : [];

    const comparisonData = [];

    // Limitamos a los primeros 20 para no saturar si hay muchos, o procesamos por lotes
    // Para monitor, priorizamos los que logramos linkear.
    
    for (const event of activeEvents) {
        let pinMatch = linkedMatches.get(String(event.id)); // [FIX] Ensure String lookup
        let pinLiveOdds = null;

        // 1. Linking Logic
        // A) Primero intentar por ID guardado en DB (Link Pre-Match)
        if (pinMatch) {
            pinLiveOdds = globalPinnacleOdds ? globalPinnacleOdds.get(Number(pinMatch.id)) : null;
        } 
        
        // B) FALLBACK: Si falló el ID (o no hay link), intentar Match Dinámico por Nombre
        // Esto recupera partidos donde el ID cambió o el Linker Pre-match falló
        if (!pinLiveOdds) {
            const parts = (event.name || "").split(/ vs\.? /i);
            const homeName = parts[0];
            if (homeName && pinLiveArray.length > 0) {
                 const targetDate = event.startDate || new Date().toISOString(); 
                 const matchResult = findMatch(homeName, targetDate, pinLiveArray, null, event.league);
                 
                 if (matchResult && matchResult.score >= 0.6) {
                     pinLiveOdds = matchResult.match;
                 }
            }
        }

        // [FIX] Recuperación "Inversa": Si encontramos match Live por nombre, re-intentamos buscar Pre-Match por ID
        if (!pinMatch && pinLiveOdds) {
            pinMatch = pinnacleDb.find(m => String(m.id) === String(pinLiveOdds.id));
        }

        // CLONE OBJECT to avoid mutation of global cache
        // [FIX] El clone definitivo se refresca luego de la sincronización de reloj para evitar lag visual en monitor.
        let monitorPinOdds = pinLiveOdds ? { ...pinLiveOdds, totals: [...(pinLiveOdds.totals || [])] } : null;

        // --- FILTRO DE INTEGRIDAD DE LÍNEAS (Anti-Zombies) ---
        // Si Pinnacle trae datos viejos (cache local), las líneas pueden ser absurdas (ej. O/U 1.5 con marcador 2-2)
        // Eliminamos líneas que ya están matemáticamente resueltas.
        if (monitorPinOdds && monitorPinOdds.totals) {
            let totalGoals = 0;
            const scoreStr = monitorPinOdds.score || event.score?.join("-") || "0-0";
            const parts = scoreStr.split("-").map(p => parseInt(p));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                totalGoals = parts[0] + parts[1];
            }

            // Filtrar líneas
            monitorPinOdds.totals = monitorPinOdds.totals.filter(t => {
                // --- FILTRO VISUAL: Solo líneas Asiáticas (.5) ---
                if (t.line % 1 !== 0.5) return false;

                // Si la línea es menor o igual a los goles actuales, es un mercado muerto (Zombie)
                // [DEBUG] Si eliminamos una línea, ver por qué
                if (t.line <= totalGoals) {
                    // console.log(`[Zombie Filter] Removing Line ${t.line} due to score ${totalGoals} (${scoreStr})`);
                }
                
                // Allow current line + 0.5 leeway just in case of intense live action or data desync
                // e.g. Score 1-0 (1). Line 1.5 is valid. Line 0.5 is invalid.
                return t.line > totalGoals;
            });
        }


        // 2. Fetch Details (SIEMPRE intentar extraer Altenar para diagnóstico)
        let details = null;
        try {
            details = await getEventDetails(event.id);
        } catch (e) {
             // console.error(`Err detail ${event.id}`); 
        }

        // [FIX] Actualizar visualización (Tiempo y Score) con lógica de "Reloj Ganador"
        if (details) {
             const pinTimeMin = pinLiveOdds ? (parseInt(String(pinLiveOdds.time).replace(/[^0-9]/g, "")) || 0) : 0;
             const detTimeMin = (details.clock && details.clock.matchTime) ? (parseInt(String(details.clock.matchTime).replace(/[^0-9]/g, "")) || 0) : 0;
             const evtTimeMin = (event.liveTime && event.liveTime !== "0'") ? (parseInt(String(event.liveTime).replace(/[^0-9]/g, "")) || 0) : 0;
             
             // 1. Si Altenar Detail tiene mejor tiempo, usarlo
             if (detTimeMin > evtTimeMin) {
                 event.liveTime = details.clock.matchTime + "'";
             }
             
             // 2. Si Pinnacle está ADELANTADO a Altenar, usar Pinnacle (pero solo si es coherente no más de 5 mins diff para evitar desync masivo)
             // Y si Pinnacle está ATRASADO, asegurar que el objeto `pinLiveOdds` se actualice para la UI.
             if (pinLiveOdds && pinTimeMin > detTimeMin + 1) {
                 if (pinTimeMin < detTimeMin + 10) { // Coherencia check
                     event.liveTime = pinLiveOdds.time; 
                 }
             } else if (pinLiveOdds && detTimeMin > pinTimeMin) {
                 // CASE: Altenar is fresher. Update Pin object for UI consistency
                 pinLiveOdds.time = event.liveTime;
             }
             
             if (details.score && Array.isArray(details.score) && details.score.length > 0) {
                 event.score = details.score;
             }

             // [FIX] Refrescar clone del monitor con el tiempo/score ya sincronizado.
             if (monitorPinOdds) {
                 monitorPinOdds.time = pinLiveOdds?.time || event.liveTime || monitorPinOdds.time;
                 if (pinLiveOdds?.score) {
                    monitorPinOdds.score = pinLiveOdds.score;
                 } else if (Array.isArray(event.score) && event.score.length >= 2) {
                    monitorPinOdds.score = `${event.score[0]}-${event.score[1]}`;
                 }
             }
        }

        const altenarData = {
            moneyline: {}, // 1, X, 2
            totals: [] // { line, over, under }
        };

        if (details && details.markets) {
            const altenarOddsMap = new Map();
            if (details.odds) details.odds.forEach(o => altenarOddsMap.set(o.id, o));

            // 1x2
            const m1x2 = details.markets.find(m => m.typeId === 1);
            if (m1x2) {
                const oddIds = (m1x2.desktopOddIds || []).flat();
                const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);
                const h = oddsObjs.find(o => o.typeId === 1);
                const d = oddsObjs.find(o => o.typeId === 2);
                const a = oddsObjs.find(o => o.typeId === 3);
                if(h) altenarData.moneyline.home = h.price;
                if(d) altenarData.moneyline.draw = d.price;
                if(a) altenarData.moneyline.away = a.price;
            }

            // Totals
            
            // [REWRITE] Estrategia "Agrupada": Un mercado puede contener múltiples líneas (Bag of Odds)
            // Agrupamos todas las cuotas (desktopOddIds) de todos los mercados Totales seleccionados
            // y las organizamos por línea extraida de SU NOMBRE, no del mercado.
            const totalMarkets = details.markets.filter(m => {
                return isMatchTotalMarket(m, event.name, altenarOddsMap);
            });
            
            const totalsBuffer = new Map(); // Map<Line, {over, under}>

            totalMarkets.forEach(m => {
                const oddIds = (m.desktopOddIds || []).flat();
                const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);
                
                oddsObjs.forEach(odd => {
                    const name = (odd.name || "").toLowerCase();
                    const price = odd.price;
                    
                    // Extraer línea del nombre del pick (Ej: "Más de 3.5" -> 3.5)
                    // Regex busca decimal al final o en medio
                    const match = name.match(/(\d+\.?\d*)/);
                    if (!match) return;
                    
                    const line = parseFloat(match[0]);
                    if (isNaN(line)) return;

                    // Inicializar grupo
                    if (!totalsBuffer.has(line)) totalsBuffer.set(line, { line });
                    const entry = totalsBuffer.get(line);

                    if (name.includes('más') || name.includes('over')) entry.over = price;
                    if (name.includes('menos') || name.includes('under')) entry.under = price;
                });
            });

            // Procesar el Buffer y aplicar filtros
            totalsBuffer.forEach((data, line) => {
                // 1. Integridad: Debe tener ambos lados (Over y Under) o al menos uno para mostrar
                // [MOD] Permitir mostrar aunque falte un lado para diagnóstico visual
                // if (!data.over && !data.under) return;

                // 2. Filtro .5 (Asiáticos puros) - MANTENER ESTRICTO PARA EVITAR RUIDO
                if (line % 1 !== 0.5) return;

                // 3. [DISABLED] Filtro Coherencia Pinnacle
                // Queremos ver la línea de Altenar aunque Pinnacle no la tenga (Feedback visual de "Solo en DoradoBet")
                /*
                if (monitorPinOdds && monitorPinOdds.totals) {
                    const existsInPin = monitorPinOdds.totals.some(t => Math.abs(t.line - line) < 0.1);
                    if (!existsInPin) return; 
                }
                */

                // 4. Integridad Básica
                if (!data.over && !data.under) return;

                // [Fix Duplicados] Evitar meter la misma línea dos veces si venía de mercados distintos
                const alreadyExists = altenarData.totals.some(t => t.line === line);
                if (!alreadyExists) {
                    altenarData.totals.push({ line, over: data.over, under: data.under });
                }
            });

            // Ordenar visualmente
            altenarData.totals.sort((a,b) => a.line - b.line);
        }

        // [NEW] Inject Altenar Pre-Match Odds
        const altPrematch = altenarPrematchDb.find(u => String(u.id) === String(event.id));
        if (altPrematch && altPrematch.odds) {
             altenarData.prematch = altPrematch.odds;
        }

        // [DEBUG] Check Pre-Match injection
        if (pinMatch && !pinLiveOdds) {
             // console.log(`   🔸 [Monitor] Show Pre-Match only for: ${event.name}`);
        }
        
        // Si no hay link, lo agregamos como "Unlinked" (o Linked pero sin datos Live)
        if (!pinLiveOdds) {
            comparisonData.push({
                id: event.id,
                name: event.name,
                time: event.liveTime,
                score: (event.score || []).join("-"),
                linked: !!pinMatch, 
                pinnacle: null,
                prematch: pinMatch ? pinMatch.odds : null, 
                altenar: altenarData 
            });
            continue;
        }

        comparisonData.push({
            id: event.id,
            name: event.name,
            time: event.liveTime,
            score: (event.score || []).join("-"),
            linked: true,
            pinnacle: {
                id: monitorPinOdds.id,
                score: monitorPinOdds.score, 
                time: monitorPinOdds.time,   
                moneyline: monitorPinOdds.moneyline,
                totals: monitorPinOdds.totals
            },
            prematch: pinMatch ? pinMatch.odds : null, 
            altenar: altenarData, 
            lastUpdate: new Date().toISOString()
        });
    }

    return comparisonData;
};
