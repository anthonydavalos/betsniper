
import db, { initDB } from '../src/db/database.js';
import { getEventResult } from '../src/services/liveScannerService.js';

// Argumento de fecha: node scripts/audit_date.js 2025-02-15
const targetDateArg = process.argv[2];

// Helper para colores en consola
const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m"
};

const settleBetLogic = (bet, scoreStr) => {
    // Score string format "H-A"
    const scoreParts = scoreStr.split('-').map(Number);
    if (scoreParts.length < 2 || isNaN(scoreParts[0]) || isNaN(scoreParts[1])) return null;

    const homeGoals = scoreParts[0];
    const awayGoals = scoreParts[1];
    const totalGoals = homeGoals + awayGoals;
    
    let outcome = 'LOSE';
    let pick = (bet.pick || "").toLowerCase();
    
    // Normalization fallback (si pick no está claro)
    if ((pick === 'unknown' || !pick) && bet.selection) {
         const sel = bet.selection.toUpperCase();
         if (sel.includes('UNDER') || sel.includes('MENOS')) {
             const line = sel.match(/\d+(\.\d+)?/)?.[0];
             if (line) pick = `under_${line}`;
         } else if (sel.includes('OVER') || sel.includes('MÁS')) {
             const line = sel.match(/\d+(\.\d+)?/)?.[0];
             if (line) pick = `over_${line}`;
         } else if (sel.includes('LOCAL') || sel.includes('HOME')) pick = 'home';
         else if (sel.includes('VISITA') || sel.includes('AWAY')) pick = 'away';
         else if (sel.includes('EMPATE') || sel.includes('DRAW')) pick = 'draw';
    }

    // Lógica 1X2
    if (pick === 'home') outcome = (homeGoals > awayGoals) ? 'WIN' : 'LOSE';
    else if (pick === 'away') outcome = (awayGoals > homeGoals) ? 'WIN' : 'LOSE';
    else if (pick === 'draw') outcome = (homeGoals === awayGoals) ? 'WIN' : 'LOSE';

    // Lógica Over/Under
    else if (pick.startsWith('over_')) {
        const line = parseFloat(pick.split('_')[1]);
        outcome = (totalGoals > line) ? 'WIN' : 'LOSE';
    }
    else if (pick.startsWith('under_')) {
        const line = parseFloat(pick.split('_')[1]);
        outcome = (totalGoals < line) ? 'WIN' : 'LOSE';
    }

    // Lógica BTTS
    else if (pick === 'btts_yes') outcome = (homeGoals > 0 && awayGoals > 0) ? 'WIN' : 'LOSE';
    else if (pick === 'btts_no') outcome = (homeGoals === 0 || awayGoals === 0) ? 'WIN' : 'LOSE';
    
    return outcome === 'WIN' ? 'WON' : 'LOST';
};

const delay = ms => new Promise(res => setTimeout(res, ms));

async function runAudit() {
    console.log(`${colors.cyan}🕵️‍♂️  HERRAMIENTA DE AUDITORÍA HISTÓRICA${colors.reset}`);
    
    if (!targetDateArg) {
        console.error(`${colors.red}❌ Error: Debes especificar una fecha (YYYY-MM-DD).${colors.reset}`);
        console.log(`Ejemplo: node scripts/audit_date.js 2025-02-16`);
        process.exit(1);
    }

    // Validar formato fecha simple
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateArg)) {
        console.error(`${colors.red}❌ Error: Formato de fecha inválido.${colors.reset}`);
        process.exit(1);
    }

    await initDB();
    const portfolio = db.data.portfolio;
    const history = portfolio.history || [];
    
    // Filtrar apuestas del historial que coincidan con la fecha (matchDate o createdAt)
    // Buscamos apuestas que se jugaron ese día.
    const betsToCheck = history.filter(b => {
        const bDate = (b.matchDate || b.createdAt || "").split('T')[0];
        return bDate === targetDateArg;
    });

    if (betsToCheck.length === 0) {
        console.log(`⚠️ No se encontraron apuestas en el historial para la fecha: ${targetDateArg}`);
        return;
    }

    console.log(`📋 Analizando ${betsToCheck.length} apuestas del día ${targetDateArg}...`);
    
    // Cache de resultados para no llamar a la API repetidamente por la misma liga/categoría
    // Key: "catId_date" -> Value: ResultData
    const resultsCache = new Map();

    const report = {
        total: betsToCheck.length,
        corrected: 0,
        confirmed: 0,
        missing: 0,
        details: []
    };

    let balanceAdjustment = 0;

    for (const bet of betsToCheck) {
        process.stdout.write(`\r🔍 Revisando: ${bet.match.padEnd(30)} `);
        
        if (!bet.eventId || !bet.catId) {
            report.missing++;
            console.log(`${colors.red}❌ [SKIP] Sin Event ID${colors.reset}`);
            continue;
        }

        try {
            // Estrategia de Cache
            const cacheKey = `${bet.catId}_${targetDateArg}`;
            let resultData = resultsCache.get(cacheKey);

            if (!resultData) {
                // Fetch API si no está en caché
                await delay(300); // Rate limiter
                // Buscamos para la fecha exacta
                const dateISO = new Date(targetDateArg).toISOString();
                resultData = await getEventResult(bet.sportId || 66, bet.catId, dateISO);
                
                if (resultData && resultData.events) {
                    resultsCache.set(cacheKey, resultData);
                }
            }

            // Buscar evento específico
            // PRIMERO: Busqueda estricta por ID
            let matchEvent = resultData?.events?.find(e => String(e.id) === String(bet.eventId));

            // SEGUNDO: Si no hay match por ID, busqueda por NOMBRE (Solo si no hay ID match)
            if (!matchEvent) {
                console.log(`${colors.red}❌ No ID Match for ${bet.match} (ID: ${bet.eventId}). Checking names...${colors.reset}`);
                matchEvent = resultData?.events?.find(e => 
                    e.name.toLowerCase().includes(bet.match.split('vs')[0].trim().toLowerCase())
                );
                if (matchEvent) {
                     console.log(`${colors.yellow}⚠️ Match por Nombre (ID mismatch): ${matchEvent.id} vs ${bet.eventId} (${matchEvent.name})${colors.reset}`);
                }
            } else {
                 // console.log(`✅ ID Match Found: ${matchEvent.id}`);
            }

            if (matchEvent) {
                // Verificar Score
                // La API suele devolver score array [H, A]
                const apiScore = matchEvent.score; 
                if (apiScore && apiScore.length >= 2) {
                    const apiScoreStr = `${apiScore[0]}-${apiScore[1]}`;
                    
                    // Comparar con lo que tenemos
                    if (apiScoreStr !== bet.finalScore) {
                        // DISCREPANCIA ENCONTRADA
                        const oldStatus = bet.status;
                        const newStatus = settleBetLogic(bet, apiScoreStr);
                        
                        console.log(`${colors.yellow}⚠️ CORRIGIENDO: ${bet.finalScore} -> ${apiScoreStr}${colors.reset}`);
                        
                        // Ajuste Financiero
                        if (newStatus && newStatus !== oldStatus) {
                            console.log(`   💰 Ajustando Status: ${oldStatus} -> ${newStatus}`);
                            
                            if (oldStatus === 'WON' && newStatus === 'LOST') {
                                // Quitar ganancias previas
                                const profitToRemove = (bet.return || 0) - bet.stake; 
                                // O más simple: revertir la operación original.
                                // Si ganó, sumamos return. Ahora restamos return.
                                balanceAdjustment -= (bet.return || 0);
                                bet.return = 0;
                                bet.profit = -bet.stake;
                            } else if (oldStatus === 'LOST' && newStatus === 'WON') {
                                // Dar ganancias
                                const newReturn = parseFloat((bet.stake * bet.odd).toFixed(2));
                                balanceAdjustment += newReturn;
                                bet.return = newReturn;
                                bet.profit = newReturn - bet.stake;
                            }
                            
                            bet.status = newStatus;
                            report.corrected++;
                        } else {
                             // Solo cambió el score, el resultado (WON/LOST) sigue igual
                             // (Ej. Over 2.5 gana con 3-0 y con 4-0)
                             report.confirmed++; 
                        }
                        
                        bet.finalScore = apiScoreStr;
                        // Marcar como "Auditado"
                        bet.auditDate = new Date().toISOString();

                    } else {
                        console.log(`${colors.green}✅ Correcto (${apiScoreStr})${colors.reset}`);
                        report.confirmed++;
                    }
                } else {
                    console.log(`${colors.red}❓ Sin Score en API${colors.reset}`);
                    report.missing++;
                }
            } else {
                console.log(`${colors.red}🚫 Evento no encontrado en API${colors.reset}`);
                report.missing++;
                report.details.push(`No encontrado: ${bet.match} (CatID: ${bet.catId})`);
            }

        } catch (e) {
            console.error(`Error procesando ${bet.id}:`, e.message);
        }
    }
    
    console.log("\n" + "=".repeat(50));
    console.log(`${colors.cyan}📊 REPORTE FINAL (${targetDateArg})${colors.reset}`);
    console.log("=".repeat(50));
    console.log(`Total Analizado : ${report.total}`);
    console.log(`✅ Confirmados  : ${report.confirmed}`);
    console.log(`🛠️  Corregidos   : ${report.corrected}`);
    console.log(`❓ Sin Datos    : ${report.missing}`);
    
    if (balanceAdjustment !== 0) {
        console.log(`${colors.yellow}💰 AJUSTE DE BALANCE: ${balanceAdjustment > 0 ? '+' : ''}${balanceAdjustment.toFixed(2)} PEN${colors.reset}`);
        portfolio.balance += balanceAdjustment;
    }

    if (report.corrected > 0 || balanceAdjustment !== 0) {
        await db.write();
        console.log(`\n💾 Base de datos actualizada correctamente.`);
    } else {
        console.log(`\n✨ No se requirieron cambios en la base de datos.`);
    }

    if (report.details.length > 0) {
        console.log("\n⚠️ Detalles de Falta de Datos:");
        report.details.forEach(d => console.log(` - ${d}`));
    }
}

runAudit();
