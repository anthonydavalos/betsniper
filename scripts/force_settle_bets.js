
import db, { initDB } from '../src/db/database.js';
import { getEventResult, getEventDetails } from '../src/services/liveScannerService.js';

// Simple delay helper
const delay = ms => new Promise(res => setTimeout(res, ms));

async function settleBet(bet, finalScore) {
    if (!finalScore || finalScore.length < 2) return null;
    
    const [h, a] = finalScore;
    let won = false;
    let pick = bet.pick;
    
    // Normalize pick parsing
    if (pick === 'unknown' && bet.selection) {
         const sel = bet.selection.toUpperCase();
         if (sel.includes('HOME')) pick = 'home';
         else if (sel.includes('AWAY')) pick = 'away';
         else if (sel.includes('DRAW')) pick = 'draw';
         else if (sel.includes('OVER')) pick = `over_${parseFloat(sel.match(/\d+(\.\d+)?/)?.[0]||0)}`;
         else if (sel.includes('UNDER')) pick = `under_${parseFloat(sel.match(/\d+(\.\d+)?/)?.[0]||0)}`;
    }

    if (pick === 'home') won = h > a;
    else if (pick === 'away') won = a > h;
    else if (pick === 'draw') won = h === a;
    else if (pick && pick.startsWith('over_')) {
        const line = parseFloat(pick.split('_')[1]);
        won = (h + a) > line;
    }
    else if (pick && pick.startsWith('under_')) {
        const line = parseFloat(pick.split('_')[1]);
        won = (h + a) < line;
    }
    else if (pick === 'btts_yes') won = (h > 0 && a > 0);
    else if (pick === 'btts_no') won = (h === 0 || a === 0);

    const profit = won ? (bet.stake * bet.odd) - bet.stake : -bet.stake;
    const returnAmt = won ? (bet.stake * bet.odd) : 0;

    // Update Bet Object
    bet.status = won ? 'WON' : 'LOST';
    bet.profit = profit;
    bet.return = returnAmt;
    bet.finalScore = `${h}-${a}`;
    bet.settledAt = new Date().toISOString();

    return { bet, won, returnAmt };
}

async function run() {
    console.log("🛠️  Iniciando Liquidación Forzada de Apuestas de Ayer...");
    await initDB();
    const portfolio = db.data.portfolio;
    
    const activeBets = portfolio.activeBets || [];
    if (activeBets.length === 0) {
        console.log("✅ No hay apuestas activas para procesar.");
        return;
    }

    console.log(`📋 ${activeBets.length} apuestas activas encontradas.`);
    const now = Date.now();
    let settledCount = 0;
    const pendingBets = [];

    // [MOD] Definir límite de tiempo para considerar una apuesta como "Ayer" o "Pasado"
    // Cualquier apuesta con más de 6 horas de antigüedad
    const RECENT_THRESHOLD = 4 * 60 * 60 * 1000; // 4 Horas

    for (const bet of activeBets) {
        // [Filtro] Si la apuesta es muy reciente (menos de 4 horas), la ignoramos para este script "force"
        // para dar oportunidad al proceso natural.
        const betTime = new Date(bet.createdAt).getTime();
        const age = now - betTime;

        if (age < RECENT_THRESHOLD) {
             console.log(`\n⏳ Saltando: ${bet.match} (Muy reciente: ${(age/60000).toFixed(0)} mins)`);
             pendingBets.push(bet); // Se mantiene en activas sin cambios
             continue; // Pasamos a la siguiente
        }

        console.log(`\n🔍 Analizando: ${bet.match} [${bet.date || bet.createdAt}]`);
        
        let finalScore = null;
        let isResolved = false;

        // 1. Intentar por Detalles (si ID existe)
        if (bet.eventId) {
            try {
                // Pequeña pausa para no saturar
                await delay(200);
                const details = await getEventDetails(bet.eventId);
                
                if (details) {
                    if (details.score && details.score.length >= 2) {
                        finalScore = details.score;
                        console.log(`   📡 Score desde Detalles (Live/Recent): ${finalScore.join('-')}`);
                        
                        // Si el estado indica final explicitly
                        const status = (details.statusName || details.ls || "").toLowerCase();
                        if (status.includes('end') || status.includes('fin') || status.includes('ft')) {
                            isResolved = true;
                        }
                    }
                } else {
                    console.log(`   ⚠️ Evento no encontrado en Detalles (posiblemente borrado). Buscando en Resultados...`);
                }
            } catch (e) {
                console.log(`   ❌ Error fetching details: ${e.message}`);
            }
        }

        // 2. Si no se resolvió, buscar en API de Resultados (Zombies)
        if (!isResolved && (bet.catId || bet.sportId)) {
            try {
                await delay(200);
                const dateToCheck = bet.matchDate || bet.createdAt;
                console.log(`   📚 Consultando API Resultados para CatID: ${bet.catId} en Fecha: ${dateToCheck}`);
                
                const rData = await getEventResult(bet.sportId || 66, bet.catId || 0, dateToCheck);
                
                if (rData && rData.events) {
                    const found = rData.events.find(e => e.id === bet.eventId || e.name === bet.match); // Fallback por nombre peligroso pero util
                    if (found) {
                        console.log(`   ✅ ENCONTRADO EN RESULTADOS: ${found.name}`);
                        if (found.score && found.score.length >= 2) {
                            finalScore = found.score;
                            console.log(`   🏁 Score Final Oficial: ${finalScore.join('-')}`);
                            isResolved = true;
                        } else if (found.status === 3) {
                            // A veces status 3 es Ended sin score en listado? 
                            // Normalmente results trae score.
                        }
                    } else {
                        console.log("   🚫 No encontrado en el listado de resultados de esa fecha/categoría.");
                    }
                }
            } catch(e) {
                console.error("   ❌ Error fetching results:", e.message);
            }
        }

        // 3. Forzar resolución por tiempo si han pasado > 4 horas y tenemos un score "conocido"
        if (!isResolved && finalScore) {
             const created = new Date(bet.createdAt).getTime();
             if ((now - created) > 4 * 60 * 60 * 1000) {
                 console.log("   ⏳ Han pasado > 4 horas y tenemos score. Asumiendo finalizado.");
                 isResolved = true;
             }
        }

        // LIQUIDACIÓN
        if (isResolved && finalScore) {
            const result = await settleBet(bet, finalScore);
            if (result) {
                console.log(`   💰 LIQUIDADO: ${result.won ? 'GANADA (+'+result.returnAmt.toFixed(2)+')' : 'PERDIDA'}`);
                
                if (result.won) {
                    portfolio.balance += result.returnAmt;
                }
                
                portfolio.history.push(result.bet);
                settledCount++;
            } else {
                pendingBets.push(bet); // No se pudo liquidar (error logico)
            }
        } else {
            console.log("   ⏭️  Pendiente (Sin confirmación de resultado).");
            pendingBets.push(bet);
        }
    }

    // Guardar cambios en DB
    if (settledCount > 0) {
        portfolio.activeBets = pendingBets;
        await db.write();
        console.log(`\n💾 Base de datos actualizada. ${settledCount} apuestas liquidadas.`);
        console.log(`💳 Nuevo Balance: ${portfolio.balance.toFixed(2)}`);
    } else {
        console.log("\n💤 No se liquidó ninguna apuesta.");
    }
}

run();
