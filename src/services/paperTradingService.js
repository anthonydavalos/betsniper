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
        balance: 100,
        initialCapital: 100,
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


// Global Set to track bets currently being processed (Prevent Race Conditions)
const processingBets = new Set();

/**
 * Coloca una apuesta automática si no existe ya una para ese evento.
 */
const isDuplicateBet = (b, opportunity, pick) => {
    // Match por ID (más seguro) o Nombre
    // IMPORTANTE: Asegurar tipos iguales (numbers vs strings)
    let isSameEvent = false;

    if (b.eventId && opportunity.eventId) {
        isSameEvent = String(b.eventId) === String(opportunity.eventId);
    } else {
        isSameEvent = b.match === opportunity.match;
    }
        
    // Validar Selección usando el PICK normalizado (más robusto que string 'selection')
    const isSamePick = b.pick === pick;

    return isSameEvent && isSamePick;
};

export const placeAutoBet = async (opportunity) => {
    // 0. Pre-cálculo del PICK (Necesario para deduplicación robusta)
    let pick = 'unknown';
    const actionStr = (opportunity.action || "").toUpperCase();
    const selectionStr = (opportunity.selection || "").toUpperCase();

    // A) 1X2 Standard
    if (actionStr.includes('LOCAL') || selectionStr === 'HOME') pick = 'home';
    else if (actionStr.includes('VISITA') || selectionStr === 'AWAY') pick = 'away';
    else if (actionStr.includes('EMPATE') || selectionStr === 'DRAW') pick = 'draw';

    // B) Totals (Over/Under)
    if (selectionStr.includes('OVER') || selectionStr.includes('MÁS')) {
        let line = parseFloat(selectionStr.match(/\d+(\.\d+)?/)?.[0] || 0);
        // Fallback: Mirar en Market Name si la selección no tiene número (ej. "Over")
        if (line === 0 && opportunity.market) {
             line = parseFloat(opportunity.market.match(/\d+(\.\d+)?/)?.[0] || 0);
        }
        pick = `over_${line}`; 
    } else if (selectionStr.includes('UNDER') || selectionStr.includes('MENOS')) {
        let line = parseFloat(selectionStr.match(/\d+(\.\d+)?/)?.[0] || 0);
        // Fallback: Mirar en Market Name si la selección no tiene número (ej. "Under")
        if (line === 0 && opportunity.market) {
             line = parseFloat(opportunity.market.match(/\d+(\.\d+)?/)?.[0] || 0);
        }
        pick = `under_${line}`; 
    }

    // C) BTTS
    if (selectionStr.includes('BTTS PRE') || selectionStr.includes('AMBOS SI') || (selectionStr.includes('BTTS') && selectionStr.includes('YES'))) {
        pick = 'btts_yes';
    } else if (selectionStr.includes('BTTS NO') || (selectionStr.includes('BTTS') && selectionStr.includes('NO'))) {
        pick = 'btts_no';
    }

    if (pick === 'unknown') {
        // console.log(`⚠️ No se pudo determinar el PICK para: ${opportunity.match}. Omitiendo.`);
        return null;
    }

    // Identificador único para control de concurrencia
    const lockKey = `${opportunity.eventId || opportunity.match}_${pick}`;
    if (processingBets.has(lockKey)) {
        // console.log(`🔒 Bloqueo de concurrencia: ${lockKey} ya se está procesando.`);
        return null;
    }

    // AÑADIR LOCK
    processingBets.add(lockKey);

    try {
        await initDB();
        // FORCE READ AGAIN TO BE SAFE (Paranoia Mode for Duplicates)
        await db.read(); 
        
        const portfolio = db.data.portfolio;
        const config = db.data.config || { bankroll: 100, kellyFraction: 0.25 };

        // 1. Evitar duplicados EXACTOS (activeBets O history)
        
        // Verificar si existe en ACTIVAS
        const activeDuplicate = portfolio.activeBets.find(b => isDuplicateBet(b, opportunity, pick));
        
        // Verificar si existe en HISTORIAL
        const historyDuplicate = portfolio.history.find(b => isDuplicateBet(b, opportunity, pick));

        if (activeDuplicate || historyDuplicate) {
             // console.log(`🔁 Duplicado detectado para ${lockKey}. Ignorando.`);
             return null; 
        }

        // 2. Calcular Bankroll Total (Net Asset Value - NAV)
        // MEJOR PRÁCTICA: Usar (Balance Disponible + Stake Invertido en Activas)
        // Esto evita penalizar oportunidades simultáneas. El riesgo se controla con Fractional Kelly.
        const currentNAV = (portfolio.balance || 0) + (portfolio.activeBets || []).reduce((sum, b) => sum + (b.stake || 0), 0);

        // Calcular Stake (Kelly Dinámico)
        const realProb = opportunity.realProb || 50;
        const odd = opportunity.odd || opportunity.price || 2.0;          
        
        // Estrategia Detectada (Live vs Prematch)
        const strategyType = opportunity.strategy || opportunity.type || 'DEFAULT';

        // Usar NAV en lugar de Balance Líquido
        const kellyResult = calculateKellyStake(
            realProb, 
            odd, 
            currentNAV, 
            strategyType
        );

        const stake = kellyResult.amount;
        
        // Validación de Fondos Reales (Líquidez)
        // Aunque calculamos sobre NAV, no podemos apostar dinero que no tenemos líquido.
        if (stake > portfolio.balance) {
            console.log(`⚠️ Stake ideal (${stake.toFixed(2)}) excede balance líquito (${portfolio.balance.toFixed(2)}). Ajustando a All-In.`);
            // Opcional: Ajustar a balance restante o cancelar. 
            // En gestión conservadora, si no hay liquidez, se cancela o se reduce. Vamos a reducir.
            // stake = portfolio.balance; // (Si quisieras All-In)
            return null; // Mejor no apostar si estamos sin liquidez real
        }

        // 4. Registrar Apuesta
        const newBet = {
            id: Date.now().toString(),
            createdAt: new Date().toISOString(), // Fecha de transacción
            matchDate: opportunity.date || null, // Fecha del partido (si disponible)
            eventId: opportunity.eventId, // ID Altenar para tracking robusto
            pinnacleId: opportunity.pinnacleId, // ID Arcadia/Pinnacle (si disponible)
            pinnaclePrice: opportunity.pinnaclePrice, // [FIX] Persist Pinnacle Live Price for UI reference
            sportId: opportunity.sportId,
            catId: opportunity.catId,
            champId: opportunity.champId,
            match: opportunity.match,
            league: opportunity.league,
            market: opportunity.market, // [FIX] Guardar mercado para referencia UI (Display Line)
            type: opportunity.type, 
            selection: opportunity.action || opportunity.selection, // Texto legible
            pick: pick, // Código interno calculado arriba
            odd: odd,
            realProb: realProb,
            stake: stake,         
            status: 'PENDING',
            initialScore: opportunity.score || "0-0", // Guardamos score inicial
            lastKnownScore: opportunity.score || "0-0",
            lastUpdate: new Date().toISOString(),
            // [NEW] Persist Pinnacle Context for UI Badges in Active Bets tab
            pinnacleInfo: opportunity.pinnacleInfo,
            // [NEW] Persist LiveTime for UI sorting
            liveTime: opportunity.time || opportunity.liveTime
        };

        // 5. Actualizar DB
        portfolio.balance -= stake;
        portfolio.activeBets.push(newBet);
        await db.write();

        console.log(`💰 APUESTA KELLY COLOCADA: ${stake.toFixed(2)} PEN en ${opportunity.match} [PICK: ${pick}]`);
        return newBet;

    } catch (e) {
        console.error("Error placing bet:", e);
        return null;
    } finally {
        // LIBERAR LOCK (Retraso opcional para evitar rebote inmediato)
        setTimeout(() => processingBets.delete(lockKey), 5000);
    }
};

import { getEventDetails, getEventResult } from './liveScannerService.js';

// ... (Resto del código)

/**
 * MONITOREO DE APUESTAS ACTIVAS (Llamado desde el loop del scanner)
 * Compara las apuestas activas con los datos en vivo para actualizar scores y cerrar apuestas.
 * @param {Array} liveEvents - Array de eventos actuales de Altenar
 * @param {Array} pinnacleLiveFeed - [NEW] Array de eventos de Pinnacle (Source of Truth) para time/score
 */
export const updateActiveBetsWithLiveData = async (liveEvents, pinnacleLiveFeed = []) => {
    await initDB();
    const portfolio = db.data.portfolio;
    let hasChanges = false;

    // Mapa rápido para buscar eventos live por ID (o nombre como fallback)
    const liveMap = new Map();
    liveEvents.forEach(e => {
        liveMap.set(e.id, e);
        liveMap.set(e.name, e); // Fallback por nombre
    });
    
    // [NEW] Mapa Rápido Pinnacle Live (ID -> Data)
    const pinLiveMap = new Map();
    const pinLiveByName = new Map();
    
    if (Array.isArray(pinnacleLiveFeed)) {
        pinnacleLiveFeed.forEach(p => {
             pinLiveMap.set(String(p.id), p);
             if (p.match) pinLiveByName.set(p.match, p); 
        });
    }

    const settledBets = [];
    const updatedActiveBets = [];

    for (const bet of portfolio.activeBets) {
        
        // [SELF-HEALING] Reparar picks corruptos o legacy ("unknown")
        if (bet.pick === 'unknown' && bet.selection) {
            const sel = bet.selection.toUpperCase();
            if (sel.includes('OVER') || sel.includes('MÁS')) {
                const line = parseFloat(sel.match(/\d+(\.\d+)?/)?.[0] || 0);
                bet.pick = `over_${line}`;
                hasChanges = true;
            } else if (sel.includes('UNDER') || sel.includes('MENOS')) {
                const line = parseFloat(sel.match(/\d+(\.\d+)?/)?.[0] || 0);
                bet.pick = `under_${line}`;
                hasChanges = true;
            } else if (sel.includes('HOME') || sel.includes('LOCAL')) {
                bet.pick = 'home';
                hasChanges = true;
            } else if (sel.includes('AWAY') || sel.includes('VISITA')) {
                bet.pick = 'away';
                hasChanges = true;
            } else if (sel.includes('DRAW') || sel.includes('EMPATE')) {
                bet.pick = 'draw';
                hasChanges = true;
            }
            if (bet.pick !== 'unknown') console.log(`🔧 Pick reparado para ${bet.match}: ${bet.pick}`);
        }

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

            // [NEW] PINNACLE SYNC LOGIC FOR ACTIVE BETS
            let pinSynced = false;
            let pinData = null;

            // 1. Try to find Pinnacle Data for Truth
            if (bet.pinnacleId && pinLiveMap.has(String(bet.pinnacleId))) {
                 pinData = pinLiveMap.get(String(bet.pinnacleId));
            } 
            // 2. Try by Name Matching if ID missing
            else if (pinLiveByName.has(bet.match)) {
                 pinData = pinLiveByName.get(bet.match);
            }

            // --- DATA EXTRACTION ---
            let currentScoreStr = bet.lastKnownScore || "0-0";
            let currentTimeStr = liveEvent.liveTime || bet.liveTime || "0'";

            // Prioritize Pinnacle Data
            if (pinData) {
                // Time
                if (pinData.time && pinData.time.length > 2) {
                    currentTimeStr = pinData.time;
                }
                // Score
                if (pinData.score) {
                    if (typeof pinData.score === 'string') currentScoreStr = pinData.score;
                    else if (pinData.score.home !== undefined) currentScoreStr = `${pinData.score.home}-${pinData.score.away}`;
                }
                pinSynced = true;
            } else {
                // Fallback to Altenar
                 if (Array.isArray(liveEvent.score) && liveEvent.score.length >= 2) {
                    currentScoreStr = `${liveEvent.score[0]}-${liveEvent.score[1]}`;
                }
            }
            
            // --- UPDATE DB IF CHANGED ---
            
            // Score Update
            if (bet.lastKnownScore !== currentScoreStr || !bet.lastKnownScore) {
                bet.lastKnownScore = currentScoreStr;
                bet.lastUpdate = new Date().toISOString();
                hasChanges = true;
            }

            // Time Update
            if (currentTimeStr !== bet.liveTime) {
                // Validate quality (avoid overwriting good time with "0'" unless it's HT)
                // If current is "88'" and new is "0'", ignore unless HT
                const isBadUpdate = (currentTimeStr === "0'" || currentTimeStr === "0") && (bet.liveTime && bet.liveTime.includes("'") && bet.liveTime !== "0'");
                
                if (!isBadUpdate || currentTimeStr === "HT") {
                     bet.liveTime = currentTimeStr;
                     bet.lastUpdate = new Date().toISOString(); 
                     hasChanges = true;
                }
            } else if (!bet.liveTime && liveEvent.minutes) {
                // Legacy Fallback for Altenar Minutes
                const newTime = `${liveEvent.minutes}'`;
                if (bet.liveTime !== newTime) {
                     bet.liveTime = newTime;
                     bet.lastUpdate = new Date().toISOString();
                     hasChanges = true;
                }
            }
            
            // Actualizar ID si no lo teníamos
            if (!bet.eventId && liveEvent.id) {
                bet.eventId = liveEvent.id;
                hasChanges = true;
            }

            // [NUEVO] Early Settlement Check (Liquidación Anticipada)
            // Si la apuesta ya se ganó matemáticamente (ej. Over 2.5 y van 3-0), cerramos YA.
            let earlyWin = false;
            
            // Parse safe ints from currentScoreStr
            const [scH, scA] = currentScoreStr.split('-').map(x => parseInt(x) || 0);
            const currentTotal = scH + scA;
            
            // 1. Check Over
            if (bet.pick && bet.pick.startsWith('over_')) {
                const line = parseFloat(bet.pick.split('_')[1]);
                if (currentTotal > line) earlyWin = true;
            }
            
            // 2. Check BTTS Yes
            if (bet.pick === 'btts_yes') {
                 if (scH > 0 && scA > 0) earlyWin = true;
            }

            // [NUEVO] Si ya se pagó (Early Payout), no recalcular trigger, solo mantener activo
            if (bet.payoutReceived) {
                updatedActiveBets.push(bet);
                continue;
            }

            if (earlyWin) {
                console.log(`⚡ EARLY SETTLEMENT (PAYOUT): ${bet.match} - ${bet.pick} [Score: ${currentScoreStr}]. Keeping active.`);
                
                // Calcular retorno
                const returnAmt = (bet.stake * bet.odd);
                const profit = returnAmt - bet.stake;
                
                // 1. Pagar YA (Actualizar Balance en Memoria)
                portfolio.balance += returnAmt; 
                
                // 2. Marcar como pagada pero MANTENER ACTIVA (para tracking visual)
                bet.payoutReceived = true;
                bet.earlyPayoutCollected = true;
                bet.status = 'WON'; 
                bet.profit = profit;
                bet.return = returnAmt;
                
                updatedActiveBets.push(bet);
                hasChanges = true;
                continue; 
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

            // [FIX] Si ya teníamos tracking en vivo (minutos > 0) y desapareció del feed,
            // asumimos interrupción o fin. Verificar resultado.
            const wasLive = bet.liveTime && bet.liveTime !== "0'" && bet.liveTime !== "";

            if (bet.matchDate) {
                const matchTime = new Date(bet.matchDate).getTime();
                const hoursSinceStart = (now - matchTime) / (1000 * 60 * 60); 
                
                // CRITICAL FIX: Prioridad de Re-conexión
                // Si el partido "desapareció" pero estamos dentro del tiempo lógico de juego (ej. < 2.5 horas)
                // NO asumir finalizado inmediatamente, podría ser un fallo de paginación del feed.
                // Esperar a que pasen > 2.5 horas O que tengamos confirmación explicita de final.
                
                if (hoursSinceStart > 2.5) {
                    shouldCheckResult = true; // Ya debió acabar sí o sí
                } else if (wasLive && hoursSinceStart > 2.0) {
                     shouldCheckResult = true; // Estaba vivo y ya pasó tiempo razonable
                }
                // Si hoursSinceStart es 0.5 (30 mins) y desapareció, NO checkear resultado, 
                // esperar a que el feed lo recupere (re-conexión).
            } else {
                // Si no tiene fecha (Live Snipe) O YA ESTABA VIVO y desaparece, 
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
                                    
                                    // [MOD] Lógica más estricta: NO liquidar con marcador congelado si el partido desapareció temprano
                                    // Solo liquidar por tiempo si:
                                    // A. Ya estaba en el minuto 88+ cuando desapareció
                                    // B. O han pasado más de 3.5 horas desde la última actualización (abandono total)
                                    
                                    if (timeVal >= 88) {
                                         // Si desapareció al 90', es seguro asumir que terminó con ese marcador
                                         safeToClose = true;
                                    } else if (minsSinceUpdate > 240) { // 4 Horas
                                         // Si desapareció hace 4 horas y no hay resultados oficiales, liquidar forzosamente (evitar zombies eternos)
                                         safeToClose = true;
                                    } else {
                                         console.log(`⏳ Evento ${bet.eventId} desaparecido del feed al min ${timeVal}. Esperando resultado oficial (NO liquidar aun).`);
                                    }

                                    // 3. Backup de seguridad extrema: 5 horas desde creación
                                    const hoursSinceCreation = (Date.now() - new Date(bet.createdAt).getTime()) / 3600000;
                                    if (hoursSinceCreation > 5) safeToClose = true;
                                    
                                } catch (err) {
                                    // Si hay error calculando, mejor dejar abierto
                                    safeToClose = false;
                                }

                                if (safeToClose) {
                                    console.log(`⚠️ Evento ${bet.eventId} (${bet.match}) tiempo cumplido/no encontrado. Cerrando.`);
                                    isFinished = true;
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
                    const parts = (bet.lastKnownScore || "0-0").split('-');
                    const s1 = parseInt(parts[0]);
                    const s2 = parseInt(parts[1]);
                    finalScore = (!isNaN(s1) && !isNaN(s2)) ? [s1, s2] : [0,0];
                }

                if (isFinished) {
                    if (!finalScore) {
                        // Usar ultimo conocido si falla fetch
                        const parts = (bet.lastKnownScore || "0-0").split('-');
                        const s1 = parseInt(parts[0]);
                        const s2 = parseInt(parts[1]);
                        finalScore = (!isNaN(s1) && !isNaN(s2)) ? [s1, s2] : [0,0];
                    }
                    
                    if (bet.payoutReceived) {
                        // Ya se cobró. Cierre administrativo.
                        bet.finalScore = `${finalScore[0]}-${finalScore[1]}`;
                        bet.closedAt = new Date().toISOString();
                        
                        // Validar profit por integridad
                        if (bet.profit === undefined) {
                             const ret = bet.stake * bet.odd;
                             bet.profit = ret - bet.stake;
                             bet.return = ret;
                        }

                        // Push a settledBets para mover a history
                        settledBets.push(bet);
                    } else {
                        // Liquidación Estandar (Late Win o Loss)
                        const result = settleBet(bet, finalScore);
                        settledBets.push(result);
                    }
                    
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

        // Sumar SOLO los returns que no se hayan cobrado anticipadamente
        const pendingReturns = settledBets
            .filter(b => !b.earlyPayoutCollected)
            .reduce((acc, b) => acc + (b.return || 0), 0);

        portfolio.balance += pendingReturns;
        await db.write();
        
        if (settledBets.length > 0) {
            console.log(`✅ ${settledBets.length} Apuestas Finalizadas/Liquidadas.`);
        }
    }
};

// Helper interno para liquidar
const settleBet = (bet, score) => {
    // [0] = home, [1] = away
    // Asegurar que sean números
    const homeGoals = parseInt(score[0]);
    const awayGoals = parseInt(score[1]);
    const totalGoals = homeGoals + awayGoals;
    
    let outcome = 'LOSE';
    const pick = bet.pick || "";

    // A) 1x2 Logic
    if (pick === 'home' && homeGoals > awayGoals) outcome = 'WIN';
    else if (pick === 'away' && awayGoals > homeGoals) outcome = 'WIN';
    else if (pick === 'draw' && homeGoals === awayGoals) outcome = 'WIN';

    // B) Totals Logic (over_2.5, under_3.5)
    else if (pick.startsWith('over_')) {
        const line = parseFloat(pick.split('_')[1]);
        if (totalGoals > line) outcome = 'WIN';
    }
    else if (pick.startsWith('under_')) {
        const line = parseFloat(pick.split('_')[1]);
        if (totalGoals < line) outcome = 'WIN';
    }

    // C) BTTS Logic
    else if (pick === 'btts_yes') {
        if (homeGoals > 0 && awayGoals > 0) outcome = 'WIN';
    }
    else if (pick === 'btts_no') {
        if (homeGoals === 0 || awayGoals === 0) outcome = 'WIN';
    }
    
    // Calcular Profit (Solo si ganamos, descontamos base si perdemos ya se descontó al inicio)
    // PEROO JOJO: En paperTrading al inicio restamos portfolio.balance -= stake.
    // Así que si perdemos, profit es -stake (ya descontado) y returnAmount es 0.
    // Si ganamos, returnAmount es (stake * odd).
    
    let returnAmt = 0;
    let profit = -bet.stake;

    if (outcome === 'WIN') {
        returnAmt = parseFloat((bet.stake * bet.odd).toFixed(2));
        profit = parseFloat((returnAmt - bet.stake).toFixed(2));
    }

    return {
        ...bet,
        status: outcome === 'WIN' ? 'WON' : 'LOST',
        finalScore: `${homeGoals}-${awayGoals}`,
        profit: profit,
        return: returnAmt,
        closedAt: new Date().toISOString()
    };
};

/**
 * LIQUIDACIÓN MANUAL / CORRECCIÓN
 * Permite al usuario forzar un resultado (score) o re-intentar la validación API.
 */
export const manualSettleBet = async (betId, manualScoreStr) => {
    await initDB();
    const portfolio = db.data.portfolio;
    
    // 1. Buscar Apuesta (Active o History)
    let bet = portfolio.activeBets.find(b => b.id === betId);
    let isHistory = false;
    
    if (!bet) {
        bet = portfolio.history.find(b => b.id === betId);
        isHistory = true;
    }

    if (!bet) throw new Error("Apuesta no encontrada");

    let finalScore = null;

    // A) MODO MANUAL (User input)
    if (manualScoreStr) {
        const parts = manualScoreStr.split('-');
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
             finalScore = [parseInt(parts[0]), parseInt(parts[1])];
        } else {
             throw new Error("Formato de marcador inválido. Use 'Local-Visita' (ej. 2-1)");
        }
    } 
    // B) MODO AUTO-RETRY (API Fetch)
    else {
        // Intentar fetch details o results
        try {
            if (!bet.eventId) throw new Error("Sin Event ID para consultar API.");
            
            // 1. Probar Post-Game Results
            // (Si no tenemos catId, intentamos con sportId y date generico, pero es dificil)
            if (bet.catId) {
                const results = await getEventResult(bet.sportId || 66, bet.catId, bet.matchDate || bet.createdAt);
                const found = results?.events?.find(e => e.id === bet.eventId);
                if (found && found.score && found.score.length >= 2) {
                    finalScore = found.score;
                }
            }

            // 2. Si falló, probar Live Details (a veces sigue ahí como Ended)
            if (!finalScore) {
                 const details = await getEventDetails(bet.eventId);
                 if (details && details.score && details.score.length >= 2) {
                     // Solo si parece finalizado
                     finalScore = details.score;
                 }
            }

            if (!finalScore) throw new Error("No se pudo obtener resultado oficial de la API. Intente corrección manual.");

        } catch (e) {
            throw new Error(`Error consultando API: ${e.message}`);
        }
    }

    // 3. APLICAR LIQUIDACIÓN
    // Si ya estaba en History, necesitamos revertir el impacto anterior en el balance
    if (isHistory) {
         // Revertir return anterior
         const oldReturn = bet.return || 0;
         portfolio.balance -= oldReturn;
         
         // Calcular nuevo estado
         const updatedBet = settleBet(bet, finalScore);
         
         // Actualizar en array
         Object.assign(bet, updatedBet); // Mutar objeto existente en array
         
         // Aplicar nuevo return
         portfolio.balance += updatedBet.return;
         
         console.log(`🔧 Corrección Manual en Historial: ${bet.match} -> Score: ${bet.finalScore}, PnL: ${bet.profit}`);
    } else {
         // Estaba Activa -> Liquidar normal y mover a historial
         const updatedBet = settleBet(bet, finalScore);
         
         // Remover de active
         portfolio.activeBets = portfolio.activeBets.filter(b => b.id !== betId);
         
         // Agregar a history
         portfolio.history.push(updatedBet);
         
         // Sumar return
         portfolio.balance += updatedBet.return;

         console.log(`🔧 Liquidación Manual Forzada: ${bet.match} -> Score: ${bet.finalScore}`);
    }

    await db.write();
    return bet;
};
