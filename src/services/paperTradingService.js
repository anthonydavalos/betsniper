import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICIO DE PAPER TRADING (SIMULACIÓN REALISTA)
// - Apuestas Automáticas con criterio Kelly
// - Resolución basada en score REAL (Live Tracking)
// - NO USAR RESULTADOS ALEATORIOS
// =====================================================================

export const resetPortfolio = async () => {
    await initDB();
    db.data.portfolio = {
        balance: 1000,
        initialCapital: 1000,
        activeBets: [],
        history: []
    };
    await db.write();
    return db.data.portfolio;
};

export const getPortfolio = async () => {
    await initDB();
    return db.data.portfolio;
};

/**
 * Coloca una apuesta automática si no existe ya una para ese evento.
 */
export const placeAutoBet = async (opportunity) => {
    await initDB();
    const portfolio = db.data.portfolio;
    const config = db.data.config || { bankroll: 1000, kellyFraction: 0.25 };

    // 1. Evitar duplicados EXACTOS (mismo partido y misma selección)
    const selectionKey = opportunity.action || opportunity.selection;
    const alreadyBet = portfolio.activeBets.find(b => b.match === opportunity.match && b.selection === selectionKey);
    
    if (alreadyBet) {
        // console.log(`   Rechazado: Ya existe apuesta para ${opportunity.match} -> ${selectionKey}`);
        return null; // Ya tenemos esta apuesta específica
    }

    // 2. Calcular Stake (Kelly)
    const realProb = opportunity.realProb || 50;
    const odd = opportunity.odd || 2.0;          
    
    // Normalizar datos para Kelly
    const kellyResult = calculateKellyStake(
        realProb, 
        odd, 
        portfolio.balance, 
        config.kellyFraction || 0.25
    );

    const stake = kellyResult.amount;
    
    // Validación mínima y Fondos
    if (stake < 1) {
        console.log(`⚠️ Stake Kelly muy bajo (${stake.toFixed(2)} PEN). Omitiendo apuesta para ${opportunity.match}.`);
        return null; 
    }
    
    if (portfolio.balance < stake) {
        console.log("❌ Fondos insuficientes para apostar.");
        return null;
    }

    // 3. Determinar qué elegimos (Home/Away) para comprobar resultado después
    // LIVE: action suele tener "Apostar a LOCAL"
    // PRE: selection suele ser "Home", "Away", "Draw"
    let pick = 'unknown';
    const actionStr = (opportunity.action || "").toUpperCase();
    const selectionStr = (opportunity.selection || "").toUpperCase();

    if (actionStr.includes('LOCAL') || selectionStr === 'HOME') pick = 'home';
    else if (actionStr.includes('VISITA') || selectionStr === 'AWAY') pick = 'away';
    else if (actionStr.includes('EMPATE') || selectionStr === 'DRAW') pick = 'draw';

    // 4. Registrar Apuesta
    const newBet = {
        id: Date.now().toString(),
        createdAt: new Date().toISOString(), // Fecha de transacción
        matchDate: opportunity.date || null, // Fecha del partido (si disponible)
        eventId: opportunity.eventId, // ID Altenar para tracking robusto
        sportId: opportunity.sportId,
        catId: opportunity.catId,
        champId: opportunity.champId,
        match: opportunity.match,
        league: opportunity.league,
        type: opportunity.type, 
        selection: opportunity.action || opportunity.selection, // Texto legible
        pick: pick, // Código interno para settlement (home/away/draw)
        odd: odd,
        realProb: realProb,
        stake: stake,         
        status: 'PENDING',
        initialScore: opportunity.score || "0-0", // Guardamos score inicial
        lastKnownScore: opportunity.score || "0-0",
        lastUpdate: new Date().toISOString()
    };

    // 5. Actualizar DB
    portfolio.balance -= stake;
    portfolio.activeBets.push(newBet);
    await db.write();

    console.log(`💰 APUESTA KELLY COLOCADA: ${stake.toFixed(2)} PEN en ${opportunity.match} [PICK: ${pick}]`);
    return newBet;
};

import { getEventDetails, getEventResult } from './liveScannerService.js';

// ... (Resto del código)

/**
 * MONITOREO DE APUESTAS ACTIVAS (Llamado desde el loop del scanner)
 * Compara las apuestas activas con los datos en vivo para actualizar scores y cerrar apuestas.
 * @param {Array} liveEvents - Array de eventos actuales de Altenar
 */
export const updateActiveBetsWithLiveData = async (liveEvents) => {
    await initDB();
    const portfolio = db.data.portfolio;
    let hasChanges = false;

    // Mapa rápido para buscar eventos live por ID (o nombre como fallback)
    const liveMap = new Map();
    liveEvents.forEach(e => {
        liveMap.set(e.id, e);
        liveMap.set(e.name, e); // Fallback por nombre
    });

    const settledBets = [];
    const updatedActiveBets = [];

    for (const bet of portfolio.activeBets) {
        
        // Intentar encontrar por ID primero, luego por Nombre
        let liveEvent = bet.eventId ? liveMap.get(bet.eventId) : liveMap.get(bet.match);

        // Validar si el evento, aunque presente en el feed, ya indicó final (FT/Ended)
        let isFinishedInFeed = false;
        if (liveEvent) {
            const tStr = (liveEvent.liveTime || "").toUpperCase();
            if (tStr.includes("FT") || tStr.includes("END") || tStr.includes("FIN")) {
                isFinishedInFeed = true;
            }
        }

        if (liveEvent && !isFinishedInFeed) {
            // A) EL PARTIDO ESTÁ EN VIVO Y JUGANDO
            const currentScoreStr = `${liveEvent.score[0]}-${liveEvent.score[1]}`;
            
            if (bet.lastKnownScore !== currentScoreStr) {
                bet.lastKnownScore = currentScoreStr;
                bet.lastUpdate = new Date().toISOString();
                hasChanges = true;
            }

            // [NUEVO] Actualizar tiempo de juego si está disponible
            if (liveEvent.liveTime) {
                if (bet.liveTime !== liveEvent.liveTime) {
                    bet.liveTime = liveEvent.liveTime;
                    hasChanges = true;
                }
            }
            
            // Actualizar ID si no lo teníamos (apuestas viejas)
            if (!bet.eventId && liveEvent.id) {
                bet.eventId = liveEvent.id;
                hasChanges = true;
            }

            updatedActiveBets.push(bet);

        } else {
            // B) NO ESTÁ EN VIVO ACTIVAMENTE (O TERMINÓ)
            
            // Caso Especial: Terminó y sigue en feed con estado FT/Ended
            if (isFinishedInFeed && liveEvent) {
                 let finalScore = liveEvent.score;
                 // Validar score sospechoso (0-0) al finalizar: Intentar Deep Check
                 const isZeroZero = finalScore[0] === 0 && finalScore[1] === 0;
                 
                 if (isZeroZero && bet.eventId) {
                    try {
                        const details = await getEventDetails(bet.eventId);
                        if (details && details.score && details.score.length >= 2) {
                             // Solo sobreescribir si es diferente y válido
                             const dScore = details.score;
                             if (dScore[0] !== 0 || dScore[1] !== 0) {
                                 finalScore = dScore;
                             }
                        }
                    } catch (e) {
                        console.error("Error verifying final score", e);
                    }
                 }

                 const result = settleBet(bet, finalScore);
                 settledBets.push(result);
                 hasChanges = true;
                 continue;
            }

            // Si es Pre-Match muy futuro, lo dejamos quieto.
            // Solo verificamos resultado si YA DEBIÓ TERMINAR (ej. pasaron más de 2h desde el inicio)
            let shouldCheckResult = false;
            const now = Date.now();

            if (bet.matchDate) {
                const matchTime = new Date(bet.matchDate).getTime();
                const hoursSinceStart = (now - matchTime) / (1000 * 60 * 60); // Horas pasadas
                
                // Si pasaron más de 2.2 horas (aprox 135 mins) y NO está en vivo -> Probablemente terminó
                if (hoursSinceStart > 2.2) {
                    shouldCheckResult = true;
                }
            } else {
                // Si no tiene fecha (Live Snipe) y desaparece del feed, 
                // asumimos que acaba de terminar. Verificación inmediata (sin espera).
                shouldCheckResult = true;
            }
            
            if (shouldCheckResult) {
                // Intentar obtener resultado final via API Detalles (si tenemos ID)
                let finalScore = null;
                let isFinished = false;

                if (bet.eventId) {
                    try {
                        const details = await getEventDetails(bet.eventId);
                        if (details) {
                             // Intentar leer score de detalles
                             // Altenar suele devolver score en structure similar
                             if (details.score && details.score.length >= 2) {
                                 finalScore = details.score;
                                 bet.lastKnownScore = `${finalScore[0]}-${finalScore[1]}`;
                             }
                             // Status 3 suele ser Ended? Depende API. Asumimos si no está en LiveOverview y tiene data...
                             // Si no está en LiveOverview pero GetEventDetails devuelve data, 
                             // puede que esté 'Ended' o en un estado no-live.
                             // VAMOS A ASUMIR FINISHED SI NO ESTA EN LIVE OVERVIEW Y PASO TIEMPO
                             isFinished = true; 
                        } else {
                            // Si returns null, el evento ya no existe en Altenar (borrado post-partido)

                            // 1. Intentar resolver con API de Resultados (Zombie Fix)
                            // Consultamos oficialmente si el partido terminó y tiene resultado final.
                            if (bet.catId) {
                                try {
                                    const dateToCheck = bet.matchDate || bet.createdAt;
                                    // sportId default 66 (Fútbol)
                                    const rData = await getEventResult(bet.sportId || 66, bet.catId, dateToCheck);
                                    
                                    if (rData && rData.events) {
                                        const found = rData.events.find(e => e.id === bet.eventId);
                                        if (found) {
                                            console.log(`✅ Zombie Match Resuelto (Results API): ${bet.match}`);
                                            // Altenar Results trae score array [home, away]
                                            if (found.score && found.score.length >= 2) {
                                                finalScore = found.score;
                                                bet.lastKnownScore = `${finalScore[0]}-${finalScore[1]}`;
                                            }
                                            isFinished = true;
                                        }
                                    }
                                } catch (e) { 
                                    console.error("Error check results", e.message); 
                                }
                            }

                            // 2. Si aún no está resuelto, aplicar lógica de tiempo límite
                            if (!isFinished && !bet.matchDate) { 
                                let safeToClose = false;
                                try {
                                    const timeVal = parseInt((bet.liveTime || "0").toString().replace("'", "")) || 0;
                                    const lastUpdateDate = new Date(bet.lastUpdate || bet.createdAt);
                                    const minsSinceUpdate = (Date.now() - lastUpdateDate.getTime()) / 60000;
                                    
                                    // 1. Si el último tiempo registrado ya era >= 90
                                    // 2. O si el tiempo estimado (registrado + transcurrido) > 100 mins
                                    if (timeVal >= 90 || (timeVal + minsSinceUpdate) > 100) {
                                        safeToClose = true;
                                    }

                                    // 3. Backup: Si la apuesta tiene más de 3 horas de creada (seguro de vida)
                                    const hoursSinceCreation = (Date.now() - new Date(bet.createdAt).getTime()) / 3600000;
                                    if (hoursSinceCreation > 3) safeToClose = true;
                                    
                                } catch (err) {
                                    safeToClose = true; // Ante error de cálculo, asumir cerrado para evitar bloqueos
                                }

                                if (safeToClose) {
                                    console.log(`⚠️ Evento ${bet.eventId} no encontrado y tiempo cumplido. Asumiendo finalizado (Zombie Bet).`);
                                    isFinished = true;
                                } else {
                                    // Si desaparece al minuto 80, NO cerramos aún. Esperamos que el reloj virtual avance.
                                    // console.log(`⏳ Evento ${bet.eventId} fuera de feed, esperando tiempo prudente (Est: ${bet.liveTime}).`);
                                }
                            }
                        }
                    } catch (e) {
                        console.log(`Failed to fetch details for ${bet.eventId}`);
                    }
                } else {
                    // Sin ID, lógica antigua por tiempo
                    isFinished = true; // Forzamos cierre por tiempo
                    // Parse lastKnownScore
                    const parts = bet.lastKnownScore.split('-');
                    finalScore = [parseInt(parts[0]), parseInt(parts[1])];
                }

                if (isFinished) {
                    if (!finalScore) {
                        // Usar ultimo conocido si falla fetch
                        const parts = bet.lastKnownScore.split('-');
                        finalScore = [parseInt(parts[0]), parseInt(parts[1])];
                    }
                    
                    const result = settleBet(bet, finalScore);
                    settledBets.push(result);
                    hasChanges = true;
                    continue; // No agregamos a updatedActiveBets porque ya se cerró
                }
            }
            
            // Si no se cerró, lo mantenemos activo (ej. prematch que aun no empieza)
            updatedActiveBets.push(bet);
        }
    }
    
    // ... Guardar cambios
    if (hasChanges || settledBets.length > 0) {
        portfolio.activeBets = updatedActiveBets;
        portfolio.history.push(...settledBets);
        portfolio.balance += settledBets.reduce((acc, b) => acc + (b.return || 0), 0);
        await db.write();
        
        if (settledBets.length > 0) {
            console.log(`✅ ${settledBets.length} Apuestas Finalizadas/Liquidadas.`);
        }
    }
};

// Helper interno para liquidar
const settleBet = (bet, score) => {
    // [0] = home, [1] = away
    const homeGoals = score[0];
    const awayGoals = score[1];
    
    let outcome = 'LOSE';
    if (homeGoals > awayGoals && bet.pick === 'home') outcome = 'WIN';
    else if (awayGoals > homeGoals && bet.pick === 'away') outcome = 'WIN';
    else if (homeGoals === awayGoals && bet.pick === 'draw') outcome = 'WIN';
    
    const profit = outcome === 'WIN' ? (bet.stake * bet.odd) - bet.stake : -bet.stake;
    const returnAmt = outcome === 'WIN' ? (bet.stake * bet.odd) : 0;

    return {
        ...bet,
        status: outcome === 'WIN' ? 'WON' : 'LOST',
        finalScore: `${homeGoals}-${awayGoals}`,
        profit: profit,
        return: returnAmt,
        closedAt: new Date().toISOString()
    };
};



