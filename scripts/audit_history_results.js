
import db, { initDB } from '../src/db/database.js';
import { getEventResult } from '../src/services/liveScannerService.js';
import fs from 'fs';
import path from 'path';

// Copiado de paperTradingService para no importar todo y causar efectos secundarios
const settleBetLogic = (bet, score) => {
    const homeGoals = parseInt(score[0]);
    const awayGoals = parseInt(score[1]);
    const totalGoals = homeGoals + awayGoals;
    
    let outcome = 'LOSE';
    let pick = bet.pick || "";
    
    // Normalization fallback
    if (pick === 'unknown' && bet.selection) {
         if (bet.selection.includes('Under') || bet.selection.includes('Menos')) {
             const line = bet.selection.match(/\d+(\.\d+)?/)?.[0];
             if (line) pick = `under_${line}`;
         } else if (bet.selection.includes('Over') || bet.selection.includes('Más')) {
             const line = bet.selection.match(/\d+(\.\d+)?/)?.[0];
             if (line) pick = `over_${line}`;
         } else if (bet.selection.includes('LOCAL') || bet.selection.includes('Home')) pick = 'home';
         else if (bet.selection.includes('VISITA') || bet.selection.includes('Away')) pick = 'away';
    }

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
    
    return outcome === 'WIN' ? 'WON' : 'LOST';
};

const delay = ms => new Promise(res => setTimeout(res, ms));

async function runAudit() {
    console.log("🕵️‍♂️  AUDITANDO HISTORIAL DE APUESTAS (Validando con API Resultados)...");
    
    await initDB();
    const portfolio = db.data.portfolio;
    const history = portfolio.history;
    
    console.log(`📋 Total en historial: ${history.length}`);
    
    let updatedCount = 0;
    let balanceAdjustment = 0;

    // Solo revisar las últimas 50 para no saturar, y solo las de hoy/ayer.
    // Filtrar por apuestas que quizás están mal (ej. score 0-0 y LOST en over, o score dudoso)
    // O simplemente revisar todas las recientes.
    
    // Vamos a revisar las ultimas 20 sin importar que.
    const betsCheck = history.slice(-20); 

    for (const bet of betsCheck) {
        // Skip si no tiene ID o ya auditado
        if (!bet.eventId || !bet.catId) continue;
        
        console.log(`\n🔍 Verificando: ${bet.match} (${bet.status}) - Score DB: ${bet.finalScore}`);
        
        try {
            await delay(500); // Rate limiter
            const dateStr = bet.matchDate || bet.createdAt;
            
            // Llamar API Resultados
            // Intento 1: Fecha exacta
            let resultData = await getEventResult(bet.sportId || 66, bet.catId, dateStr);
            
            // Intento 2: Fecha anterior (por Timezone differences)
            if (!resultData || !resultData.events || resultData.events.length === 0) {
                 const prevDate = new Date(new Date(dateStr).getTime() - 86400000).toISOString();
                 // console.log(`   🔄 Reintentando con fecha anterior: ${prevDate}`);
                 resultData = await getEventResult(bet.sportId || 66, bet.catId, prevDate);
            }
            
            // Intento 3: Fecha siguiente
            if (!resultData || !resultData.events || resultData.events.length === 0) {
                 const nextDate = new Date(new Date(dateStr).getTime() + 86400000).toISOString();
                 // console.log(`   🔄 Reintentando con fecha siguiente: ${nextDate}`);
                 resultData = await getEventResult(bet.sportId || 66, bet.catId, nextDate);
            }

            // Intento 4: Sin fecha (si la API lo permite, o fecha default hoy)
            if (!resultData || !resultData.events || resultData.events.length === 0) {
                 // console.log(`   🔄 Reintentando con fecha HOY (Default)`);
                 resultData = await getEventResult(bet.sportId || 66, bet.catId, new Date().toISOString());
            }

            const matchEvent = resultData?.events?.find(e => String(e.id) === String(bet.eventId) || e.name === bet.match);
            
            if (matchEvent) {
                const apiScore = matchEvent.score; // [h, a]
                // Convertir a string "H-A"
                const apiScoreStr = (apiScore && apiScore.length >= 2) ? `${apiScore[0]}-${apiScore[1]}` : null;
                
                if (apiScoreStr) {
                    console.log(`   📡 API Dice: ${apiScoreStr}`);
                    
                    // Comparar con DB
                    if (apiScoreStr !== bet.finalScore) {
                        console.log(`   ⚠️ DIFERENCIA DETECTADA! DB=${bet.finalScore} vs API=${apiScoreStr}`);
                        
                        // Recalcular resultado
                        const newStatus = settleBetLogic(bet, apiScore);
                        console.log(`   🏁 Nuevo Status calculado: ${newStatus} (Antes: ${bet.status})`);
                        
                        // Si cambia el status, ajustar dinero
                        if (newStatus !== bet.status) {
                            console.log(`   💰 CORRIGIENDO RESULTADO FINANCIERO...`);
                            
                            // Revertir efecto anterior
                            // Si antes era WON, habiamos sumado return. Restamos return.
                            // Si antes era LOST, habiamos restado stake (al inicio). Nada que restar del balance (return fue 0).
                            
                            if (bet.status === 'WON') {
                                // Era WON, ahora LOST.
                                // Debemos quitar el return que se le dio.
                                balanceAdjustment -= (bet.return || 0);
                                bet.return = 0;
                                bet.profit = -bet.stake;
                            } else {
                                // Era LOST, ahora WON.
                                // Debemos dar el return.
                                const newReturn = parseFloat((bet.stake * bet.odd).toFixed(2));
                                balanceAdjustment += newReturn;
                                bet.return = newReturn;
                                bet.profit = newReturn - bet.stake;
                            }
                            
                            bet.status = newStatus;
                            updatedCount++;
                        } 
                        
                        // Actualizar score siempre
                        bet.finalScore = apiScoreStr;
                        // Forzar update si solo fue score cambio
                        if (newStatus === bet.status) updatedCount++; // Marcar que hubo cambio (de score al menos)
                        
                    } else {
                        console.log(`   ✅ Coincide.`)
                    }
                } else {
                    console.log(`   ⚠️ Evento encontrado pero sin score en API.`);
                }
            } else {
                console.log(`   🚫 Evento no encontrado en API Resultados.`);
            }
            
        } catch (e) {
            console.error(`Error procesando ${bet.id}:`, e.message);
        }
    }
    
    if (updatedCount > 0) {
        console.log(`\n💾 Guardando cambios en DB...`);
        console.log(`   Apuestas corregidas: ${updatedCount}`);
        if (balanceAdjustment !== 0) {
             console.log(`   Ajuste de Balance: ${balanceAdjustment > 0 ? '+' : ''}${balanceAdjustment.toFixed(2)}`);
             portfolio.balance += balanceAdjustment;
        }
        await db.write();
        console.log(`✅ Base de datos actualizada.`);
    } else {
        console.log(`\n👍 Todo parece correcto. Ninguna discrepancia encontrada en los últimos items.`);
    }
}

runAudit();
