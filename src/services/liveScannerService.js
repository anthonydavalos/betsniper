import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';

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
            params: { sportId: 66, categoryId: 0, eventCount: 100 }
        });
        
        // Normalización de Tiempos (Fix Visual 103' -> 90'+ y estado)
        // Usamos la propiedad 'ls' (Live Status) para detectar tiempos extra
        return (data.events || []).map(ev => {
             const status = ev.ls || ""; 
             let cleanTime = ev.liveTime;
             const minutes = parseInt((ev.liveTime || "0").replace("'", "")) || 0;

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
    // 1. Validar Tiempo de Juego (15' a 70')
    const timeStr = liveEvent.liveTime || "";
    const cleanTime = parseInt(timeStr.replace("'", "")) || 0;
    
    // Si no hay tiempo numérico o está fuera de rango
    if (cleanTime < 15 || cleanTime > 75) return null;

    // 2. Validar Marcador (Diferencia de 1 gol)
    const [scoreHome, scoreAway] = liveEvent.score || [0, 0];
    const diff = scoreHome - scoreAway;

    if (Math.abs(diff) !== 1) return null; 

    // 3. Identificar Favorito según Pinnacle
    // Antes > 0.60 (Cuota < 1.67). Ajustamos a > 0.55 (Cuota < 1.81) para ser más permisivos.
    if (!pinnacleMatch || !pinnacleMatch.odds) return null;

    const pHome = 1 / pinnacleMatch.odds.home;
    const pAway = 1 / pinnacleMatch.odds.away;

    const MIN_PROB_FAVORITE = 0.55;

    // CASO A: Favorito Local va perdiendo (Score: 0-1, 1-2...) => diff negativo
    if (diff === -1 && pHome > MIN_PROB_FAVORITE) { 
        return { 
            side: 'home', 
            favorite: pinnacleMatch.home, 
            currentScore: `${scoreHome}-${scoreAway}`,
            prematchProb: pHome * 100 // %
        };
    }

    // CASO B: Favorito Visita va perdiendo (Score: 1-0, 2-1...) => diff positivo
    if (diff === 1 && pAway > MIN_PROB_FAVORITE) {
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
export const scanLiveOpportunities = async () => {
    await initDB(); 
    const pinnacleDb = db.data.upcomingMatches || [];
    
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(m.altenarId, m);
    });

    console.log(`📡 Escaneando en vivo... (DB tiene ${linkedMatches.size} partidos enlazados)`);

    const liveEvents = await getLiveOverview();
    const opportunities = [];

    for (const event of liveEvents) {
        const pinMatch = linkedMatches.get(event.id);

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
                        
                        // A) Obtener Cuota Altenar (Value)
                        let altenarOdd = 0;
                        const targetSide = condition.side; // 'home' o 'away'

                        if (details.markets && details.markets.length > 0) {
                            const market1x2 = details.markets.find(m => m.typeId === 1 || m.name === '1x2' || m.name === 'Match Result');
                            if (market1x2 && market1x2.odds) {
                                const targetOddId = targetSide === 'home' ? 1 : 3; 
                                const oddObj = market1x2.odds.find(o => o.typeId === targetOddId);
                                if (oddObj) altenarOdd = oddObj.price;
                            }
                        }

                        // B) Obtener Probabilidad Real (Pinnacle Arcadia Live)
                        let realProb = 0;
                        let isLivePinnacle = false;

                        // Import dinámico para evitar ciclos si fuera necesario, o directo arriba
                        const { getPinnacleLiveOdds, calculateNoVigProb } = await import('./pinnacleService.js');
                        
                        if (pinMatch.id) {
                            const pinLiveOdds = await getPinnacleLiveOdds(pinMatch.id);
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
                            db.data.portfolio.balance || 1000
                        );
                        
                        // Solo push si hay valor positivo
                        if (kellyResult.amount > 0) {
                             opportunities.push({
                                type: 'LIVE_SNIPE',
                                eventId: event.id,
                                match: event.name,
                                league: pinMatch.league.name,
                                sportId: event.sportId || 66,
                                catId: event.catId || event.categoryId,
                                champId: event.champId || event.championshipId,
                                time: event.liveTime,
                                score: condition.currentScore,
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
                                kellyStake: kellyResult.amount
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
                        // Buscar mercado de Totales (Over/Under)
                        // Altenar suele llamarlo "Total Goals", "Goals Over/Under", etc. typeId suele ser 2 o similar.
                        const totalMarket = details.markets.find(m => 
                            m.name.includes('Over/Under') || m.name.includes('Total Goals') || 
                            m.name.includes('Total')
                        );

                        if (totalMarket && totalMarket.odds) {
                            // Buscar la linea especifica (ej. 0.5, 1.5, 2.5)
                            // Altenar prices tienen "line": 2.5
                            // Ojo: "typeId": 4 suele ser Over, 5 Under (varía según config).
                            // Confiamos en el "name" o estructura.
                            
                            // Filtrar por linea
                            // Muchos mercados están agrupados. Buscamos el odd que tenga line == goalValue.line
                            const overOdd = totalMarket.odds.find(o => 
                                Math.abs(o.line - goalValue.line) < 0.1 && 
                                (o.name || "").toLowerCase().includes("over") 
                            );

                            if (overOdd) {
                                realOdd = overOdd.price;
                            }
                        }
                    }

                    if (realOdd > 1.2) { // Filtro minimo de cuota
                        const estimatedProb = 55; // Mantenemos prob fija por ahora (TODO: Calcular real based on Live Vig)
                        
                        opportunities.push({
                            type: 'LIVE_VALUE',
                            eventId: event.id,
                            match: event.name,
                            league: pinMatch.league.name,
                            sportId: event.sportId || 66,
                            catId: event.catId || event.categoryId,
                            champId: event.champId || event.championshipId,
                            time: event.liveTime,
                            score: goalValue.currentScore,
                            market: 'Total',
                            selection: `Apostar MÁS DE ${goalValue.line} GOLES`, // Action name for uniqueness
                            pick: `over_${goalValue.line}`,
                            reason: goalValue.reason,
                            action: `Apostar MÁS DE ${goalValue.line} GOLES`,
                            
                            realProb: estimatedProb,
                            odd: realOdd, // Cuota real obtenida
                            ev: ((estimatedProb/100 * realOdd) - 1) * 100,
                            kellyStake: calculateKellyStake(estimatedProb, realOdd, db.data.portfolio.balance || 1000).amount * 0.25 
                        });
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
