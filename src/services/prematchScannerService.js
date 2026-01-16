import db from '../db/database.js';
import { findMatch } from '../utils/teamMatcher.js';
import { calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: PRE-MATCH VALUE SCANNER & LINKER
// =====================================================================

export const scanPrematchOpportunities = async () => {
    try {
        console.log(`\n📡 [Pre-Match Scanner] Buscando Value Bets y Enlazando IDs...`);

        // 1. Leer DB (Ahora poblada por ingesta Pinnacle y Altenar)
        await db.read();
        
        const pinnacleMatches = db.data.upcomingMatches || [];
        const altenarCachedEvents = db.data.altenarUpcoming || [];

        if (pinnacleMatches.length === 0 || altenarCachedEvents.length === 0) {
            console.log('   ⚠️ Faltan datos en DB. Ejecuta los scripts de ingesta (node scripts/ingest-pinnacle.js y node scripts/ingest-altenar.js).');
            return [];
        }

        const valueBets = [];
        let totalMatchesFound = 0;
        let newLinksCreated = 0; // Contador de nuevos enlaces
        let expiredCount = 0;

        // Limpieza de partidos pasados (Started)
        const now = new Date();
        const validPinnacleMatches = pinnacleMatches.filter(m => {
            const matchDate = new Date(m.date);
            // Permitimos un margen de 5 min después del inicio por si hay delay en "En Vivo"
            // Pero idealmente, si ya empezó, es Live.
            const isFuture = matchDate > new Date(now.getTime() - 5 * 60000); 
            if (!isFuture) expiredCount++;
            return isFuture;
        });

        if (expiredCount > 0) {
            // Actualizar DB para remover expirados si se desea
            // Por ahora solo filtramos en memoria para no borrar data histórica útil para debug
             console.log(`   🧹 Filtrando ${expiredCount} partidos que ya comenzaron o terminaron.`);
        }

        // Helper para calcular Probabilidad Real (Sin Vig) - 3 WAY (1x2)
        const getFairProbabilities = (odds) => {
            if (!odds || !odds.home || !odds.draw || !odds.away) return null;
            const impliedHome = 1 / odds.home;
            const impliedDraw = 1 / odds.draw;
            const impliedAway = 1 / odds.away;
            const sum = impliedHome + impliedDraw + impliedAway;
            
            return {
                home: impliedHome / sum,
                draw: impliedDraw / sum,
                away: impliedAway / sum
            };
        };

        // Helper para calcular Probabilidad Real - 2 WAY (Over/Under, BTTS, Handicap)
        const getFair2Way = (o1, o2) => {
            if (!o1 || !o2) return null;
            const i1 = 1 / o1;
            const i2 = 1 / o2;
            const sum = i1 + i2;
            return { p1: i1 / sum, p2: i2 / sum };
        };

        // 2. Iterar sobre Pinnacle (SOLO VÁLIDOS)
        for (const pinMatch of validPinnacleMatches) {
            
            let altenarEvent = null;

            // ESTRATEGIA HÍBRIDA: ID CACHEADO vs BUSQUEDA FUZZY
            if (pinMatch.altenarId) {
                altenarEvent = altenarCachedEvents.find(e => e.id === pinMatch.altenarId);
            }

            // Si no tenemos ID o el ID ya no existe en el feed reciente, buscamos fuzzy
            if (!altenarEvent) {
                const matchResult = findMatch(pinMatch.home, pinMatch.date, altenarCachedEvents);
                if (matchResult) {
                    altenarEvent = matchResult.match;
                    pinMatch.altenarId = altenarEvent.id; 
                    pinMatch.altenarName = altenarEvent.name; 
                    newLinksCreated++;
                }
            }

            if (altenarEvent) {
                totalMatchesFound++;

                const currentBankroll = db.data.portfolio.balance || db.data.config.bankroll || 1000;
                const altenarOdds = altenarEvent.odds;

                // A) Analizar Oportunidades 1x2
                // ==========================================
                const realProbs1x2 = getFairProbabilities(pinMatch.odds);
                if (realProbs1x2 && altenarOdds) {
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Home', altenarOdds.home, realProbs1x2.home, currentBankroll, '1x2');
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Draw', altenarOdds.draw, realProbs1x2.draw, currentBankroll, '1x2');
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Away', altenarOdds.away, realProbs1x2.away, currentBankroll, '1x2');
                }

                // B) Analizar Totals (Over/Under)
                // ==========================================
                if (pinMatch.odds.totals && Array.isArray(pinMatch.odds.totals) && 
                    altenarOdds.totals && Array.isArray(altenarOdds.totals)) {
                    
                    for (const pinTotal of pinMatch.odds.totals) {
                        // Buscamos la misma linea en Altenar (margen error 0.1 para floats 2.5 vs 2.50)
                        const altTotal = altenarOdds.totals.find(t => Math.abs(t.line - pinTotal.line) < 0.1);
                        
                        if (altTotal) {
                            const realProbsTotal = getFair2Way(pinTotal.over, pinTotal.under);
                            if (realProbsTotal) {
                                // Over (p1)
                                evaluateOpportunity(valueBets, pinMatch, altenarEvent, `Over ${pinTotal.line}`, altTotal.over, realProbsTotal.p1, currentBankroll, 'Total');
                                // Under (p2)
                                evaluateOpportunity(valueBets, pinMatch, altenarEvent, `Under ${pinTotal.line}`, altTotal.under, realProbsTotal.p2, currentBankroll, 'Total');
                            }
                        }
                    }
                }

                // C) Analizar BTTS (Ambos Marcan)
                // ==========================================
                // Verificamos que existan ambos mercados en ambas casas
                if (pinMatch.odds.btts && pinMatch.odds.btts.yes && 
                    altenarOdds.btts && altenarOdds.btts.yes) {
                    
                    const realProbsBTTS = getFair2Way(pinMatch.odds.btts.yes, pinMatch.odds.btts.no);
                    
                    if (realProbsBTTS) {
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'BTTS Yes', altenarOdds.btts.yes, realProbsBTTS.p1, currentBankroll, 'BTTS');
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'BTTS No', altenarOdds.btts.no, realProbsBTTS.p2, currentBankroll, 'BTTS');
                    }
                }
            }
        }

        // 3. PERSISTIR LOS ENLACES
        if (newLinksCreated > 0) {
            await db.write();
            console.log(`   🔗 ${newLinksCreated} nuevos enlaces Pinnacle-Altenar guardados en DB.`);
        }

        // ORDENAMIENTO CRÍTICO: Partidos más cercanos primero
        // Esto responde a la necesidad de ver "lo más reciente/próximo" arriba en la UI.
        valueBets.sort((a, b) => new Date(a.date) - new Date(b.date));

        console.log(`\n📊 ESTADÍSTICAS PRE-MATCH:`);
        console.log(`   - Partidos Pinnacle (48h): ${pinnacleMatches.length}`);
        console.log(`   - Filtrados (Ya iniciaron): ${expiredCount}`);
        console.log(`   - Enlazados con Altenar:   ${totalMatchesFound}`);

        if (valueBets.length > 0) {
            console.log(`💎 ${valueBets.length} VALUE BETS DETECTADAS`);
        } else {
            console.log('   ✅ Escaneo completado. Sin value bets por ahora.');
        }

        return valueBets;

    } catch (error) {
        console.error('❌ Error en Pre-Match Scanner:', error.message);
        return [];
    }
};

// Helper interno para evaluar y agregar oportunidad
const evaluateOpportunity = (resultsArray, dbMatch, event, listSide, offeredOdd, realProb, bankroll, marketName = '1x2') => {
    if (!offeredOdd || offeredOdd <= 1) return;

    // EV Formula: (ProbReal * CuotaOfrecida) - 1
    const evPercentage = (realProb * offeredOdd - 1) * 100;
    
    // Filtro de Valor (> 2% EV por defecto)
    if (evPercentage > 2.0) {
        // Calcular Stake Kelly
        // IMPORTANTE: calculateKellyStake espera porcentaje (0-100)
        const kellyResult = calculateKellyStake(realProb * 100, offeredOdd, bankroll);
        
        resultsArray.push({
            type: 'PREMATCH_VALUE',
            eventId: event.id, // ID Vital para tracking
            match: `${dbMatch.home} vs ${dbMatch.away}`,
            date: dbMatch.date,
            market: marketName,
            selection: listSide,
            odd: offeredOdd,
            realProb: realProb * 100,
            ev: evPercentage,
            kellyStake: kellyResult.amount, // Extraer el monto ($) del objeto devuelto
            bookmaker: 'Altenar',
            snapshotTime: new Date().toISOString()
        });
    }
};
