import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { findMatch } from '../utils/teamMatcher.js'; // [NEW]

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
        if (details.score && Array.isArray(details.score) && details.score.length > 0) {
            event.score = details.score;
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

            if (altHome && pinLiveOdds.moneyline.home) checkAndAddOpp(opportunities, event, pinMatch, 'Match Winner', 'Home', altHome.price, pinLiveOdds.moneyline.home, pinLiveOdds.moneyline, pinLiveOdds);
            if (altAway && pinLiveOdds.moneyline.away) checkAndAddOpp(opportunities, event, pinMatch, 'Match Winner', 'Away', altAway.price, pinLiveOdds.moneyline.away, pinLiveOdds.moneyline, pinLiveOdds);
            if (altDraw && pinLiveOdds.moneyline.draw) checkAndAddOpp(opportunities, event, pinMatch, 'Match Winner', 'Draw', altDraw.price, pinLiveOdds.moneyline.draw, pinLiveOdds.moneyline, pinLiveOdds);
        }

        // >>> ESTRATEGIA B: DOUBLE CHANCE (DOBLE OPORTUNIDAD) <<<
        const marketDC = details.markets.find(m => m.typeId === 10);
        if (marketDC && pinLiveOdds.doubleChance) {
            const oddIds = (marketDC.desktopOddIds || []).flat();
            const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);

            const cand1X = oddsObjs.find(o => o.name.includes(event.name.split(' vs ')[0]) || o.name.includes('1X')); 
            const candX2 = oddsObjs.find(o => (event.name.split(' vs ')[1] && o.name.includes(event.name.split(' vs ')[1])) || o.name.includes('X2'));

            if (cand1X && pinLiveOdds.doubleChance.homeDraw) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', '1X', cand1X.price, pinLiveOdds.doubleChance.homeDraw, pinLiveOdds.doubleChance, pinLiveOdds);
            if (candX2 && pinLiveOdds.doubleChance.drawAway) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', 'X2', candX2.price, pinLiveOdds.doubleChance.drawAway, pinLiveOdds.doubleChance, pinLiveOdds);
        }

        // >>> ESTRATEGIA C: OVER/UNDER (TOTAL GOALS) <<<
        const totalMarkets = details.markets.filter(m => {
            // Strict Filter Logic (Copy of Monitor Logic)
            const n = (m.name || "").toLowerCase();
            const valid = ['total', 'over/under', 'línea de gol', 'goals', 'goles'];
            if (!valid.some(v => n.includes(v))) return false;
            
            // Extended Blacklist (SYNC WITH MONITOR LOGIC)
            const forbidden = [
                'corner', 'esquina', 'card', 'tarjeta', 'half', 'mitad', 'tiempo', '1st', '2nd', '1er', '2do',
                'team', 'equipo', 'player', 'doble', 'btts', 'result', 'handicap', 'asian', 'exact', 'rest',
                'both', 'ambos', 'marca', 'combinada', 'combo', 'winning', 'ganador', 'margin',
                '1x2', 'multi', 'escala', 'rango', 'range' 
            ];
            
            // [NEW] Block Markets containing Team Names (Team Totals)
            const homeParts = (event.name || "").split(' vs ')[0].toLowerCase().split(' ');
            const awayParts = (event.name || "").split(' vs ')[1]?.toLowerCase().split(' ') || [];
            
            // Check if market has significant part of team name (min length 4 to avoid 'fc')
            const hasTeamName = [...homeParts, ...awayParts].some(part => 
                part.length > 3 && n.includes(part)
            );
            if (hasTeamName) return false;

            if (forbidden.some(word => n.includes(word))) return false;
            return true;
        });
        
        if (totalMarkets.length > 0 && pinLiveOdds.totals && pinLiveOdds.totals.length > 0) {
            
            for (const mTotal of totalMarkets) {
                // [FIX] Soporte robusto para 'sv' (Special Value) y 'sn' usados por Altenar
                let line = parseFloat(mTotal.activeLine || mTotal.specialOddValue || mTotal.sv || mTotal.sn);
                
                // [FIX - REWRITE] Si no hay línea en propiedades, BUSCAR EN LOS ODDS
                // Altenar a veces agrupa odds (3.5, 4.5) bajo un market genérico sin 'activeLine'.
                if (!line || isNaN(line)) {
                    // Pre-scan odds to find true line (majority vote or explicit naming)
                    // Este es un entorno de trading, asumimos que iteramos sobre odds después.
                    // Pero para obtener el PINNACLE comparison, necesitamos la línea YA.
                    
                    // Estrategia Rapida: Mirar primer odd del market que tenga numero
                    const oddIds = (mTotal.desktopOddIds || []).flat();
                    // Buscar primer odd válido
                     for (const oid of oddIds) {
                         const o = altenarOddsMap.get(oid);
                         if (o && o.name) {
                             const match = o.name.match(/(\d+\.?\d*)/);
                             if (match) {
                                  line = parseFloat(match[0]);
                                  break;
                             }
                         }
                     }
                }

                if (!line || isNaN(line)) continue;

                // [MOD] Filtro estricto: Solo líneas .5 (0.5, 1.5, 2.5...)
                // Excluimos líneas enteras (2.0) o cuartos (2.25, 2.75) para reducir ruido
                if (line % 1 !== 0.5) continue;

                // Buscar linea equivalente en Pinnacle (Delta 0.1)
                const pinLineObj = pinLiveOdds.totals.find(t => Math.abs(t.line - line) < 0.1);
                
                if (pinLineObj) {
                    const oddIds = (mTotal.desktopOddIds || []).flat();
                    const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);

                    const altOver = oddsObjs.find(o => o.name.toLowerCase().includes('más') || o.name.toLowerCase().includes('over'));
                    const altUnder = oddsObjs.find(o => o.name.toLowerCase().includes('menos') || o.name.toLowerCase().includes('under'));

                    if (altOver && pinLineObj.over) checkAndAddOpp(opportunities, event, pinMatch, `Total Goals ${line}`, 'Over', altOver.price, pinLineObj.over, pinLineObj, pinLiveOdds);
                    if (altUnder && pinLineObj.under) checkAndAddOpp(opportunities, event, pinMatch, `Total Goals ${line}`, 'Under', altUnder.price, pinLineObj.under, pinLineObj, pinLiveOdds);
                } else {
                    // DEBUG: Loggear si no encontramos la linea exacta para diagnosticar
                    // console.log(`   🔸 Linea Altenar ${line} no encontrada en Pinnacle (Lines: ${pinLiveOdds.totals.map(t=>t.line).join(',')})`);
                }
            }
        }
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
    const kellyRes = calculateKellyStake(fairProb * 100, altOdd, db.data.portfolio.balance || 100); 

    // [DEBUG] Loggear Totals detectados aunque tengan poco EV para confirmar que la lógica funciona
    // if (marketName.includes('Total') && ev > -0.05) {
    //    console.log(`TYPE: ${marketName} ${selection} | Alt: ${altOdd} | Pin: ${pinOdd} | EV: ${(ev*100).toFixed(1)}%`);
    // }

    // Umbral estricto para producción: EV > 2%
    if (ev > 0.02 && kellyRes.amount > 0) {
        const safeStake = marketName.includes('Winner') ? kellyRes.amount : kellyRes.amount * 0.5;

        // [FILTER] Min Stake 1.00 PEN (Evitar centavos)
        if (safeStake < 1) return;

        // console.log(`   🔥 VALOR DETECTADO: ${event.name} | ${marketName} ${selection} | Alt: ${altOdd} vs Real: ${fairPrice.toFixed(2)} | EV: ${(ev*100).toFixed(1)}%`);
        
        // Priority Data Selection (Pinnacle > Altenar)
        const displayTime = pinLiveParent ? pinLiveParent.time : event.liveTime;
        const displayScore = pinLiveParent ? pinLiveParent.score : (event.score || []).join("-");

        // [NEW] Extract Prematch Odd from Pinnacle (Source of Truth) for comparison
        let pinPrematchPrice = null;
        if (pinMatch && pinMatch.odds) {
            
            // Normalize Market Name for Comparison
            const normalizedMarket = marketName.toLowerCase();

            if (normalizedMarket.includes('match winner') || normalizedMarket.includes('ganador')) {
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
            market: marketName,
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

        // [FIX] Actualizar visualización (Tiempo y Score) si los detalles traen mejor data
        if (details) {
             if (details.liveTime && details.liveTime !== event.liveTime && details.liveTime !== "0'" && details.liveTime !== "") {
                 event.liveTime = details.liveTime;
             }
             // A veces details trae clock con matchTime
             if (details.clock && details.clock.matchTime) {
                 event.liveTime = details.clock.matchTime + "'";
             }
             
             if (details.score && Array.isArray(details.score) && details.score.length > 0) {
                 event.score = details.score;
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
                // 1. ANÁLISIS POR NOMBRE (Name-First Approach)
                // Ignoramos TypeId por ahora porque a veces Type 18 se usa para mitades en ligas raras.
                const n = (m.name || "").toLowerCase();
                
                // A) LISTA BLANCA (Debe tener uno de estos)
                const validNames = ['total', 'over/under', 'línea de gol', 'goals', 'goles'];
                if (!validNames.some(v => n.includes(v))) return false;

                // B) LISTA NEGRA EXTENDIDA (No debe tener ninguno de estos)
                const forbidden = [
                    'corner', 'esquina', 'card', 'tarjeta', 'amarilla', 'roja', 'booking',
                    'half', 'mitad', 'tiempo', '1st', '2nd', '1er', '2do', 'primer', 'segundo', // Mitades
                    'team', 'equipo', 'local', 'visita', 'home', 'away', // Team Totals
                    'player', 'jugador', 'goleador', 'scorer',
                    'double', 'doble', 'chance', 'oportunidad', // 1x2 + Total
                    'both', 'ambos', 'btts', 'marca', // Total + BTTS
                    'result', 'resultado', // Resultado + Total
                    'handicap', 'hándicap', 'asiático', 'asian', // Handicap
                    'exact', 'exacto', 'range', 'rango', 'multi', // Goles exactos
                    'rest', 'resto', // Resto del partido
                    'odd/even', 'par/impar', // Par/Impar
                    'winning', 'margin', 'margen', // Margen de victoria,
                    '1x2', 'multi', 'escala', 'rango', 'range' 
                ];
                
                // [NEW] Block Markets containing Team Names (Team Totals)
                const homeParts = (event.name || "").split(' vs ')[0].toLowerCase().split(' ');
                const awayParts = (event.name || "").split(' vs ')[1]?.toLowerCase().split(' ') || [];
                
                // Check if market has significant part of team name (min length 4 to avoid 'fc')
                const hasTeamName = [...homeParts, ...awayParts].some(part => 
                    part.length > 3 && n.includes(part)
                );
                if (hasTeamName) return false;

                if (forbidden.some(word => n.includes(word))) return false;

                // 2. CHECK EXTRA: Si pasó el filtro de nombre, validamos que SEA un mercado de goles real
                // Muchos mercados basura tienen nombres limpios pero TypeIds raros.
                // Type 18 es el estándar. Si no es 18, mirar con mucho recelo.
                // Permitimos pasar si NO es 18 pero tiene nombre MUY CLARO ("Total gOALS").
                return true;
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
