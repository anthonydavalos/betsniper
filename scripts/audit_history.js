
import db, { initDB } from '../src/db/database.js';
import { getEventResult } from '../src/services/liveScannerService.js';

// Simple delay helper
const delay = ms => new Promise(res => setTimeout(res, ms));

async function verifyBetOutcome(bet, finalScore) {
    if (!finalScore || finalScore.length < 2) return null;
    
    const [h, a] = finalScore;
    let won = false;
    let pick = bet.pick;
    
    // Normalize pick parsing (Same logic as settled)
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

    return { won, score: `${h}-${a}` };
}

async function run() {
    console.log("🕵️  AUDITORÍA DE HISTORIAL (Re-verificación de Resultados)");
    await initDB();
    const portfolio = db.data.portfolio;
    const history = portfolio.history || [];
    
    // Definir rango: Últimas 48 horas (Ayer y Hoy)
    const TWO_DAYS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    
    const targetBets = history.filter(b => {
        const t = new Date(b.createdAt).getTime();
        return (now - t) < TWO_DAYS;
    });

    if (targetBets.length === 0) {
        console.log("✅ No hay apuestas en el historial de las últimas 48 horas.");
        return;
    }

    console.log(`📋 ${targetBets.length} apuestas encontradas en historial reciente.`);
    let corrections = 0;

    for (const bet of targetBets) {
        console.log(`\n🔍 Auditando: ${bet.match} [${bet.status}] (${bet.date || bet.createdAt})`);
        
        if (!bet.eventId) {
            console.log("   ⚠️ Sin EventID. Saltando.");
            continue;
        }

        try {
            await delay(300); // Rate limit friendly
            const dateToCheck = bet.matchDate || bet.createdAt;
            
            // Consultar Resultado Oficial
            const rData = await getEventResult(bet.sportId || 66, bet.catId || 0, dateToCheck);
            
            let officialEvent = null;
            if (rData && rData.events) {
                officialEvent = rData.events.find(e => e.id === bet.eventId);
            }

            if (officialEvent && officialEvent.score && officialEvent.score.length >= 2) {
                const check = await verifyBetOutcome(bet, officialEvent.score);
                const shouldBeStatus = check.won ? 'WON' : 'LOST';
                
                console.log(`   📡 Oficial: ${check.score} | Status Real: ${shouldBeStatus}`);

                if (bet.status !== shouldBeStatus) {
                    console.log(`   ❌ DISCREPANCIA DETECTADA! (DB: ${bet.status} vs REAL: ${shouldBeStatus})`);
                    console.log(`   🛠️  CORRIGIENDO...`);
                    
                    // REVERTIR TRANSACCIÓN ANTERIOR
                    if (bet.status === 'WON') {
                        // Estaba ganada, pero perdió -> Restar ganancia + stake (no, solo la ganancia neta o el retorno total?)
                        // Si era WON, sumamos returnAmt al balance. Hay que RESTARLO.
                        const amountToDeduct = bet.return || (bet.stake * bet.odd);
                        portfolio.balance -= amountToDeduct;
                        console.log(`      ➖ Balance ajustado: -${amountToDeduct.toFixed(2)}`);
                    } else if (bet.status === 'LOST') {
                        // Estaba perdida, pero ganó -> Sumar retorno
                        const amountToAdd = bet.stake * bet.odd;
                        portfolio.balance += amountToAdd;
                        console.log(`      ➕ Balance ajustado: +${amountToAdd.toFixed(2)}`);
                    }

                    // ACTUALIZAR APUESTA
                    bet.status = shouldBeStatus;
                    bet.finalScore = check.score;
                    bet.profit = check.won ? (bet.stake * bet.odd) - bet.stake : -bet.stake;
                    bet.return = check.won ? (bet.stake * bet.odd) : 0;
                    bet.auditNote = "Auto-corrected by Audit Script";
                    
                    corrections++;
                } else {
                    console.log("   ✅ Status Correcto.");
                }
            } else {
                console.log("   ⚠️ No se encontró resultado oficial en la API.");
            }

        } catch (e) {
            console.error(`   ❌ Error auditando: ${e.message}`);
        }
    }

    if (corrections > 0) {
        await db.write();
        console.log(`\n💾 Base de datos actualizada. ${corrections} correcciones aplicadas.`);
        console.log(`💳 Nuevo Balance: ${portfolio.balance.toFixed(2)}`);
    } else {
        console.log("\n✨ Auditoría completada. Todo parece en orden.");
    }
}

run();
