import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { findMatch } from '../utils/teamMatcher.js'; // [NEW] Import Matcher
import { getAllPinnacleLiveOdds } from './pinnacleService.js'; // [NEW] Static import for matcher fallback

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER"
// Estrategia: "La Volteada" (Favorito perdiendo por 1 gol)
// =====================================================================

/**
 * Obtiene un resumen ligero de TODOS los partidos en vivo de fútbol.
 * Actualizado a /GetLivenow para soporte de tiempo extra y más mercados.
 */
export const getLiveOverview = async () => {
    try {
        // sportId=66 (Fútbol), categoryId=0 (Mundo)
        // Usamos GetLivenow en lugar de GetLiveOverview
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { 
                sportId: 66, 
                categoryId: 0,
                _: Date.now() // Cache buster
            } // Eliminado limit eventCount para ver todo
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
        
        // Normalización de Tiempos (Fix Visual 103' -> 90'+ y estado)
        // Usamos la propiedad 'ls' (Live Status) para detectar tiempos extra
        return (data.events || []).map(ev => {
             // [NEW] Enriquecer con nombres reales
             const leagueName = champsMap.get(ev.champId) || "";
             const countryName = catsMap.get(ev.catId) || "";

             const status = ev.ls || ""; 
             let cleanTime = ev.liveTime;
             
             // [FALLBACK IMPROVED] Si tiempo es inválido o 0, calculamos desde startDate
             const isInvalidTime = !cleanTime || cleanTime === "0'" || cleanTime === "" || cleanTime === 0 || cleanTime === "0";
             
             if (isInvalidTime && ev.startDate) {
                 const startedAt = new Date(ev.startDate).getTime();
                 const now = Date.now();
                 let diffMins = Math.floor((now - startedAt) / 60000);
                 
                 if (diffMins < 0) diffMins = 0; // Evitar negativos
                 
                 // Solo aplicamos corrección si hace sentido (entre 0 y 130 mins)
                 if (diffMins >= 0 && diffMins < 130) {
                     if (status.toLowerCase().includes('2nd') || status.toLowerCase().includes('2t')) {
                         cleanTime = `${Math.max(46, diffMins)}'`; // Force 46+ if 2nd half
                     } else if (diffMins === 0) { // Si es 0 pero está activo
                         cleanTime = "1'"; 
                     } else {
                         cleanTime = `${diffMins}'`;
                     }
                 }
             }

             const minutes = parseInt((cleanTime || "0").replace("'", "")) || 0;
             const statusLower = (status || "").toLowerCase();

             // [FIX] Mostrar "HT" claramente en el frontend
             if (statusLower.includes('half') || statusLower.includes('descanso') || statusLower.includes('ht') || statusLower.includes('intermedio')) {
                 cleanTime = "HT";
             }

             // Detectar Extra Time / Prórrogas (>90 min)
             // El usuario prefiere marcar como "Finalizado" (Settled) si entramos a tiempos extra.
             // Updated: >= 90 para capturar también el "90'+" y forzar cierre visual.
             const isExtraTime = minutes >= 90 || 
                               status.toLowerCase().includes('adicional') || 
                               status.toLowerCase().includes('prórroga') ||
                               status.toLowerCase().includes('penal');

             if (isExtraTime) {
                 cleanTime = "Final"; // "Final" triggerea settlement inmediato en paperTradingService y se muestra limpio en UI.
             }
             
             return {
                 ...ev,
                 league: leagueName,   // [NEW]
                 country: countryName, // [NEW]
                 liveTime: cleanTime,
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
            params: { eventId }
        });
        return data; // Retorna objeto completo con markets, odds, etc.
    } catch (error) {
        console.error(`❌ Error en GetEventDetails (${eventId}):`, error.message);
        return null;
    }
};

/**
 * Obtiene el resultado final de un evento desde el API de Resultados.
 * Útil para partidos que ya no están en el feed en vivo (Zombie Matches).
 */
export const getEventResult = async (sportId, catId, dateISO) => {
    try {
         // Endpoint: https://sb2ris-altenar2.biahosted.com/api/WidgetResults/GetEventResults
         const resultsBaseURL = 'https://sb2ris-altenar2.biahosted.com/api/WidgetResults';
         
         // Asegurar que la fecha esté en formato correcto (start of day often works best for filtering)
         // El usuario usó: date=2026-01-15T00:00:00.000Z
         // Si dateISO viene con hora, quizás cortarlo al día.
         const dateParam = dateISO ? new Date(dateISO).toISOString().split('T')[0] + 'T00:00:00.000Z' : new Date().toISOString().split('T')[0] + 'T00:00:00.000Z';

         const { data } = await altenarClient.get('/GetEventResults', {
            baseURL: resultsBaseURL, 
            params: {
                sportId: sportId || 66,
                categoryId: catId,
                date: dateParam
            }
         });
         return data;
    } catch (error) {
        console.error(`❌ Error en GetEventResult (Cat: ${catId}):`, error.message);
        return null;
    }
};

/**
 * Analiza el marcador para ver si cumple la condición de "Favorito Perdiendo".
 * @param {Object} liveEvent - Evento de Altenar
 * @param {Object} pinnacleMatch - Datos guardados de Pinnacle (Source of Truth)
 */
const checkTurnaroundCondition = (liveEvent, pinnacleMatch) => {
    const timeStr = (liveEvent.liveTime || "").toLowerCase();
    
    // 1. Validar Tiempo de Juego (15' a 70')
    let cleanTime = parseInt(timeStr.replace("'", "")) || 0;
    
    // [FIX] Tratar "Descanso" (HT) como minuto 45 para no perder oportunidades de medio tiempo
    if (timeStr.includes("descanso") || timeStr.includes("half") || timeStr.includes("so") || timeStr.includes("ht")) {
        cleanTime = 45;
    }
    
    // Si no hay tiempo numérico o está fuera de rango
    // Extendemos rango hasta 80 para los "Late Snipes"
    if (cleanTime < 15 || cleanTime > 80) return null;

    // 2. Validar Marcador (Diferencia de 1 gol)
    // Altenar score comes as array [home, away]
    const [scoreHome, scoreAway] = liveEvent.score || [0, 0];
    const diff = scoreHome - scoreAway;

    if (Math.abs(diff) !== 1) return null; 

    // 3. ESTRATEGIA "UN CEREBRO": 
    // Ya no exigimos que sea el súper favorito pre-match (>55%).
    // Cualquier equipo perdiendo por 1 gol es candidato SI las cuotas en vivo tienen valor (EV+).
    // La filtración real ocurre después con calculateKellyStake.

    if (!pinnacleMatch || !pinnacleMatch.odds) return null;

    const pHome = 1 / pinnacleMatch.odds.home;
    const pAway = 1 / pinnacleMatch.odds.away;

    // CASO A: Local va perdiendo (Buscamos remontada local)
    if (diff === -1) { 
        // console.log(`       ✅ Match Candidate: ${liveEvent.name} (Home losing)`);
        return { 
            side: 'home', 
            favorite: pinnacleMatch.home, // Reference name only
            currentScore: `${scoreHome}-${scoreAway}`,
            prematchProb: pHome * 100 // % (Reference only)
        };
    }

    // CASO B: Visita va perdiendo (Buscamos remontada visita)
    if (diff === 1) {
        // console.log(`       ✅ Match Candidate: ${liveEvent.name} (Away losing)`);
        return { 
            side: 'away', 
            favorite: pinnacleMatch.away, 
            currentScore: `${scoreHome}-${scoreAway}`,
            prematchProb: pAway * 100 // %
        };
    }

    return null;
};

/**
 * Función Principal del Sniper
 */
export const scanLiveOpportunities = async (preFetchedEvents = null) => {
    await initDB(); 
    const pinnacleDb = db.data.upcomingMatches || [];
    
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(m.altenarId, m);
    });

    // Usar eventos inyectados si existen, si no, buscar frescos
    const liveEvents = preFetchedEvents || await getLiveOverview();
    const opportunities = [];

    // [NEW] Cargar Pinnacle Live para Fallback (Matcher en caliente)
    let pinnacleLiveFeed = [];
    try {
        const pinMap = await getAllPinnacleLiveOdds();
        if (pinMap) pinnacleLiveFeed = Array.from(pinMap.values());
    } catch(e) { /* ignore */ }

    // [DEBUG LOG]
    console.log(`📡 Recibidos ${liveEvents.length} eventos live. (PinLive: ${pinnacleLiveFeed.length} cands)`);
    // liveEvents.forEach(e => console.log(`   - ${e.name} (ID: ${e.id}) [Linked? ${linkedMatches.has(e.id)}]`));

    for (const event of liveEvents) {
        let pinMatch = linkedMatches.get(event.id);

        // [FALLBACK] Intentar Match Dinámico si no hay link previo
        if (!pinMatch && pinnacleLiveFeed.length > 0) {
            const parts = (event.name || "").split(/ vs\.? /i);
            const homeName = parts[0]; 
            
            if (homeName) {
                // Usamos startDate del evento Altenar. Si es null, usamos ahora.
                const targetDate = event.startDate || new Date().toISOString(); 
                
                // Buscamos coincidencia en el feed en vivo de Pinnacle
                const matchResult = findMatch(homeName, targetDate, pinnacleLiveFeed, null, event.league); 

                if (matchResult && matchResult.score >= 0.6) { // Umbral razonable
                     const m = matchResult.match;
                     
                     if (m && m.match) {
                        
                        // [FIX] Recuperación Inversa: Intentar buscar en DB (Prematch) usando el ID Dinámico
                        const dbMatch = pinnacleDb.find(pm => String(pm.id) === String(m.id));
                        
                        if (dbMatch) {
                            pinMatch = dbMatch;
                            // console.log(`   🔗 RE-LINKED LIVE->PRE: ${pinMatch.home} vs ${pinMatch.away}`);
                        } else {
                            // Construimos un objeto pinMatch temporal "Duck Typed"
                            pinMatch = {
                                id: m.id,
                                home: m.match.split(' vs ')[0] || m.match,
                                away: m.match.split(' vs ')[1] || "Away",
                                league: m.league || { name: "Unknown League" }, // [FIX] Proporcionar objeto league por defecto
                                odds: m.moneyline // Pasamos las cuotas LIVE como "base" si no hay prematch
                            };
                        }
                        // console.log(`   🔗 LIVE MATCHED: ${event.name} -> ${pinMatch.home} vs ${pinMatch.away}`);
                     }
                }
            }
        }

        if (pinMatch) {
            const condition = checkTurnaroundCondition(event, pinMatch);
            
            if (condition) {
                console.log(`   🧐 Candidato detectado: ${event.name} (${condition.currentScore})`);
                
                try {
                    const details = await getEventDetails(event.id);
                    
                    // Nota: Eliminamos el filtro estricto de !details.rc para mostrar info de tarjetas
                    if (details) { 
                        
                        // NOTA: Para Live Sniper "La Volteada", estimamos la probabilidad
                        // de remontada. En modelo simple, usamos una fracción de la prob original 
                        // o un valor fijo conservador para el cálculo Kelly.
                        // Para V1, asumimos que la cuota actual en vivo paga MUCHO más que la pre-match.
                        // Usaremos la prob original como "target confidence".
                        
                        // -----------------------------------------------------------
                        // 4. ESTRATEGIA PURA (ARCADIA LIVE TRUTH)
                        // -----------------------------------------------------------
                        
                        // [MEJORA: CORRECCIÓN DE TIEMPO Y SCORE DESDE PINNACLE SI EXISTE]
                        if (pinMatch && pinMatch.id && pinnacleLiveFeed.length > 0) {
                            // Buscar el objeto Pinnacle original en el feed en vivo
                            const realPinLive = pinnacleLiveFeed.find(p => String(p.id) === String(pinMatch.id));
                            if (realPinLive) {
                                // Inyectar datos de Tiempo/Score oficiales de Pinnacle
                                // Pinnacle Status: 1=Live 1H, 2=Live 2H.
                                // Period 0 = Match
                                // Period 1 = 1st Half
                                // Period 2 = 2nd Half
                                
                                // Score
                                const homeScore = realPinLive.score?.home || 0;
                                const awayScore = realPinLive.score?.away || 0;
                                condition.currentScore = `${homeScore}-${awayScore}`; // Actualizar condición
                                details.score = [homeScore, awayScore]; // Actualizar objeto Altenar (simulado)

                                // Time [FIX CRUCIAL] Priorizar reloj de Pinnacle
                                if (realPinLive.time && realPinLive.time.length > 2) {
                                    event.liveTime = realPinLive.time;
                                    pinMatch.time = realPinLive.time; // Persistir en el objeto auxiliar
                                    pinMatch.score = condition.currentScore;
                                }
                            }
                        }

                        // NOTA: Si llegamos aquí es porque GetEventDetails funcionó. 
                        // Usamos sus datos para refinar el tiempo si era 0.
                        if (details.clock && details.clock.matchTime) {
                            event.liveTime = details.clock.matchTime + "'"; 
                            // Update condition score too just in case
                        } else if (event.liveTime === "0'" || event.liveTime === "1'") {
                             // Fallback final: Si GetEventDetails no trae reloj, mantenemos el cálculo de GetLiveOverview
                        }

                        // A) Obtener Cuota Altenar (Value) - FIXED RELATIONAL MAPPING
                        let altenarOdd = 0;
                        const targetSide = condition.side; // 'home' or 'away'
                        
                        // Map de Odds para búsqueda rápida
                        const oddsMap = new Map();
                        if (details.odds && Array.isArray(details.odds)) {
                            details.odds.forEach(o => oddsMap.set(o.id, o));
                        }

                        if (details.markets && details.markets.length > 0) {
                            const market1x2 = details.markets.find(m => m.typeId === 1 || m.name === '1x2' || m.name === 'Match Result');
                            
                            if (market1x2) { 
                                const targetOddId = targetSide === 'home' ? 1 : 3; 
                                
                                // Buscar IDs en desktopOddIds (Array de Arrays)
                                const marketOddIds = (market1x2.desktopOddIds || []).flat(); 
                                
                                // Buscar el odd que coincida con el typeId y esté en este mercado
                                const oddObj = marketOddIds.map(id => oddsMap.get(id)).find(o => o && o.typeId === targetOddId);
                                
                                if (oddObj) {
                                    altenarOdd = oddObj.price;
                                    console.log(`       ✅ Cuota Encontrada: ${altenarOdd} (Side: ${targetSide})`);
                                } else {
                                    console.log(`       ⚠️ Cuota NO encontrada para ${targetSide} en mercado 1x2`);
                                }
                            } else {
                                console.log("       ⚠️ Mercado 1x2 NO encontrado en detalles.");
                            }
                        }

                        // B) Obtener Probabilidad Real (Pinnacle Arcadia Live)
                        let realProb = 0;
                        let isLivePinnacle = false;

                        // Import dinámico para evitar ciclos si fuera necesario, o directo arriba
                        const { getPinnacleLiveOdds, calculateNoVigProb } = await import('./pinnacleService.js');
                        
                        if (pinMatch.id) {
                            const pinData = await getPinnacleLiveOdds(pinMatch.id);
                            const pinLiveOdds = pinData ? pinData.moneyline : null;

                            if (pinLiveOdds) {
                                // Calcular Total Implied Prob (Suma de inversas)
                                const invHome = 1 / pinLiveOdds.home;
                                const invAway = 1 / pinLiveOdds.away;
                                const invDraw = pinLiveOdds.draw > 1 ? (1 / pinLiveOdds.draw) : 0; // Draw puede no existir o ser bajo
                                const totalImplied = invHome + invAway + invDraw;
                                
                                // Seleccionar cuota objetivo
                                const targetPinOdd = targetSide === 'home' ? pinLiveOdds.home : pinLiveOdds.away;
                                
                                // Calcular Prob Real sin Vig
                                realProb = calculateNoVigProb(targetPinOdd, totalImplied);
                                isLivePinnacle = true;
                                console.log(`   🎯 Pinnacle Live Found: Home=${pinLiveOdds.home}, Away=${pinLiveOdds.away} -> RealProb(${targetSide})=${realProb.toFixed(1)}%`);
                            }
                        }

                        // FALLBACK: Si Pinnacle no da live odds, usar lógica antigua de decaimiento sobre prematch
                        if (!isLivePinnacle) {
                            // Aplicar penalización por tiempo transcurrido si no tenemos dato real
                            const minute = parseInt((event.liveTime||"0").replace("'", ""));
                            const timeDecayFactor = Math.max(0.3, 1 - (minute / 120)); // Reduce prob conforme avanza tiempo
                            realProb = condition.prematchProb * timeDecayFactor;
                        }

                        // C) Validar EV+ y Kelly
                        // Si no hay cuota Altenar, no podemos apostar
                        if (altenarOdd <= 1) {
                            // console.log("   ❌ Altenar Odd no disponible o bloqueada.");
                            continue; 
                        }

                        // Cálculo Kelly
                        const kellyResult = calculateKellyStake(
                            realProb, 
                            altenarOdd, 
                            db.data.portfolio.balance || 100
                        );
                        
                        // Solo push si hay valor positivo y min 1 Sol
                        if (kellyResult.amount >= 1) {
                             opportunities.push({
                                type: 'LIVE_SNIPE',
                                eventId: event.id,
                                pinnacleId: pinMatch.id, // ID de Arcadia/Pinnacle para referencia
                                match: event.name,
                                league: pinMatch.league?.name || "Live League", // [FIX] Safe access
                                sportId: event.sportId || 66,
                                catId: event.catId || event.categoryId,
                                champId: event.champId || event.championshipId,
                                time: pinMatch.time || event.liveTime, // [FIX] Prioritize Pin Time
                                score: condition.currentScore,
                                date: event.startDate, // Fecha de inicio real para la DB
                                market: 'Match Winner', // [FIX] Explicit Market Name needed for oddsService
                                favorite: condition.favorite,
                                selection: condition.side === 'home' ? 'Home' : 'Away',
                                
                                reason: isLivePinnacle 
                                    ? `EV+ Real detectado (Pin Live: ${(100/realProb).toFixed(2)})` 
                                    : `Favorito perdiendo (Prob Est: ${realProb.toFixed(1)}%)`,
                                    
                                action: `Apostar a ${condition.side === 'home' ? 'LOCAL' : 'VISITA'}`,
                                redCards: details.rc || 0,
                                
                                realProb: realProb, 
                                odd: altenarOdd,
                                ev: (((realProb)/100 * altenarOdd) - 1) * 100,
                                kellyStake: kellyResult.amount,

                                // [NEW] Enhanced Pinnacle Info for Frontend
                                pinnacleInfo: {
                                    id: pinMatch.id,
                                    time: pinMatch.time || event.liveTime,
                                    score: condition.currentScore,
                                    // [NEW] Add Prematch Odds Context for UI
                                    prematchPrice: condition.side === 'home' ? pinMatch.odds?.home : pinMatch.odds?.away,
                                    // [NEW] Full Context for Badges
                                    prematchContext: {
                                        home: pinMatch.odds?.home,
                                        draw: pinMatch.odds?.draw,
                                        away: pinMatch.odds?.away,
                                        over25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.over,
                                        under25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.under,
                                    }
                                }
                            });
                        }
                    }
                } catch(error) {
                    console.error(`Error details ${event.id}`, error);
                }
            }

            // --- NUEVA ESTRATEGIA: NEXT GOAL VALUE (TOTALS) ---
            const goalValue = checkGoalPressure(event, pinMatch);
            if (goalValue) {
                try {
                    console.log(`   ⚽ Posible Gol Próximo: ${event.name} (Buscando Over ${goalValue.line})...`);
                    
                    // fetch details si no existían
                    const details = await getEventDetails(event.id);
                    let realOdd = 0;

                    if (details && details.markets) {
                        // Map de Odds para búsqueda
                        const oddsMap = new Map();
                        if (details.odds && Array.isArray(details.odds)) {
                            details.odds.forEach(o => oddsMap.set(o.id, o));
                        }

                        // Buscar mercado de Totales (Over/Under)
                        // Altenar suele llamarlo "Total Goals", "Goals Over/Under", etc. typeId suele ser 2 o similar.
                        const totalMarket = details.markets.find(m => 
                            m.name.includes('Over/Under') || m.name.includes('Total Goals') || 
                            m.name.includes('Total')
                        );

                        if (totalMarket) { // && totalMarket.odds REMOVED
                            // Relational Logic
                            const marketOddIds = (totalMarket.desktopOddIds || []).flat();

                            // Filtrar por linea
                            // Muchos mercados están agrupados. Buscamos el odd que tenga line == goalValue.line
                            // Y que sea Over (Name match or typeId 12 approx)
                            const overOdd = marketOddIds.map(id => oddsMap.get(id)).find(o => 
                                o && Math.abs((o.line || totalMarket.line || 0) - goalValue.line) < 0.1 && 
                                (o.name || "").toLowerCase().includes("over") 
                            );

                            if (overOdd) {
                                realOdd = overOdd.price;
                            }
                        }
                    }

                    if (realOdd > 1.2) { // Filtro minimo de cuota
                        const estimatedProb = 55; // Mantenemos prob fija por ahora (TODO: Calcular real based on Live Vig)
                        
                        // [FILTER] Min Stake
                        const kRes = calculateKellyStake(estimatedProb, realOdd, db.data.portfolio.balance || 100);
                        const kStake = kRes.amount * 0.25; // Fracción conservadora para Next Goal

                        if (kStake >= 1) {
                            opportunities.push({
                                type: 'LIVE_VALUE',
                                eventId: event.id,
                                pinnacleId: pinMatch.id, // ID de Arcadia/Pinnacle para referencia
                                match: event.name,
                                league: pinMatch.league?.name || "Live League",
                                sportId: event.sportId || 66,
                                catId: event.catId || event.categoryId,
                                champId: event.champId || event.championshipId,
                                time: event.liveTime,
                                score: goalValue.currentScore,
                                date: event.startDate, // Fecha de inicio real para la DB
                                market: 'Total',
                                selection: `Apostar MÁS DE ${goalValue.line} GOLES`, // Action name for uniqueness
                                pick: `over_${goalValue.line}`,
                                reason: goalValue.reason,
                                action: `Apostar MÁS DE ${goalValue.line} GOLES`,
                                
                                realProb: estimatedProb,
                                odd: realOdd, // Cuota real obtenida
                                ev: ((estimatedProb/100 * realOdd) - 1) * 100,
                                kellyStake: kStake,
                                
                                pinnacleInfo: {
                                    id: pinMatch?.id,
                                    time: pinMatch?.time || event.liveTime,
                                    score: goalValue.currentScore,
                                    // [NEW] Add Prematch Odds Context for Totals
                                    prematchPrice: (pinMatch?.odds?.totals || []).find(t => Math.abs(t.line - goalValue.line) < 0.1)?.over,
                                    // [NEW] Full Context for Badges
                                    prematchContext: {
                                        home: pinMatch.odds?.home,
                                        draw: pinMatch.odds?.draw,
                                        away: pinMatch.odds?.away,
                                        over25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.over,
                                        under25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.under,
                                    }
                                }
                            });
                        }
                    } else {
                        // console.log(`   ❌ Cuota para Over ${goalValue.line} no encontrada o muy baja.`);
                    }

                } catch (e) {
                    console.error("Error fetching details for Goal Value", e);
                }
            }
        }
    }
    
    return opportunities;
};

/**
 * [NUEVO] Analiza si hay presión para un gol inminente (Especulativo basado en Pinnacle Pre-Match)
 * Un favorito claro + marcador bajo/empate + tiempo avanzando = Probabilidad de gol subiendo.
 */
const checkGoalPressure = (liveEvent, pinnacleMatch) => {
    
    // 1. Filtrar Tiempo: Partidos "maduros" donde el gol apremia (35'-45' o 65'-85')
    const timeStr = liveEvent.liveTime || "";
    const min = parseInt(timeStr.replace("'", "")) || 0;
    const isPressureTime = (min >= 35 && min <= 45) || (min >= 65 && min <= 85);
    
    if (!isPressureTime) return null;

    // 2. ¿Se espera gol? (Over 2.5 Pinnacle era bajo aka < 1.90?)
    // Si Pinnacle pre-match daba Over 2.5 < 1.80, es un partido de goles.
    let expectedGoalsHigh = false;
    if (pinnacleMatch.odds && pinnacleMatch.odds.totals) {
         // Buscar linea 2.5
         const line25 = pinnacleMatch.odds.totals.find(t => Math.abs(t.line - 2.5) < 0.1);
         if (line25) {
             // Convertir prob implicita
             const probOver = 1 / line25.over; 
             if (probOver > 0.55) expectedGoalsHigh = true; // > 55% de esperanza de over
         }
    }

    if (!expectedGoalsHigh) return null;

    // 3. Marcador Actual Bajo
    // Si se esperaban goles y vamos 0-0 o 1-0/0-1, hay presión.
    const [h, a] = liveEvent.score || [0, 0];
    const totalGoals = h + a;
    
    if (totalGoals > 2) return null; // Ya hubo fiesta, riesgo de que se cierren

    // 4. Determinar Línea a Atacar (Current Total + 0.5)
    // Altenar suele ofrecer Over X.5. Si van 1-0 (Total 1), buscamos Over 1.5.
    const targetLine = totalGoals + 0.5;

    return {
        line: targetLine,
        currentScore: `${h}-${a}`,
        reason: `Partido de alta expectativa de gol (Prematch) con marcador bajo en minuto ${min}'.`
    };
};
