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

        // Helper para calcular Probabilidad Real (Sin Vig)
        // Pinnacle tiene margen muy bajo, pero igual hay que quitarlo para ser precisos.
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

        // 2. Iterar sobre Pinnacle
        for (const pinMatch of pinnacleMatches) {
            
            let altenarEvent = null;

            // ESTRATEGIA HÍBRIDA: ID CACHEADO vs BUSQUEDA FUZZY
            if (pinMatch.altenarId) {
                altenarEvent = altenarCachedEvents.find(e => e.id === pinMatch.altenarId);
            }

            // Si no tenemos ID o el ID ya no existe en el feed reciente, buscamos fuzzy
            if (!altenarEvent) {
                // pinMatch.home, pinMatch.date vienen de ingest-pinnacle.js nuevo formato
                const matchResult = findMatch(pinMatch.home, pinMatch.date, altenarCachedEvents);
                if (matchResult) {
                    altenarEvent = matchResult.match;
                    
                    // 🧠 LINKER MAGICO
                    pinMatch.altenarId = altenarEvent.id; 
                    pinMatch.altenarName = altenarEvent.name; 
                    newLinksCreated++;
                }
            }

            if (altenarEvent) {
                totalMatchesFound++;

                // Calcular Probabilidad Real desde las odds crudas de Pinnacle grabadas en DB
                const realProbs = getFairProbabilities(pinMatch.odds);
                const altenarOdds = altenarEvent.odds;

                if (realProbs && altenarOdds) {
                     // Analizar Oportunidades (1x2)
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Home', altenarOdds.home, realProbs.home, db.data.config.bankroll);
                     // La lógica de evaluacion de empate y visita:
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Draw', altenarOdds.draw, realProbs.draw, db.data.config.bankroll);
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Away', altenarOdds.away, realProbs.away, db.data.config.bankroll);
                }
            }
        }

        // 3. PERSISTIR LOS ENLACES
        if (newLinksCreated > 0) {
            await db.write();
            console.log(`   🔗 ${newLinksCreated} nuevos enlaces Pinnacle-Altenar guardados en DB.`);
        }

        console.log(`\n📊 ESTADÍSTICAS PRE-MATCH:`);
        console.log(`   - Partidos Pinnacle (48h): ${pinnacleMatches.length}`);
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
const evaluateOpportunity = (resultsArray, dbMatch, event, listSide, offeredOdd, realProb, bankroll) => {
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
            match: `${dbMatch.home} vs ${dbMatch.away}`,
            market: '1x2',
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
