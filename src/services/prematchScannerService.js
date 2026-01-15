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

        // 2. Iterar sobre Pinnacle (SOLO VÁLIDOS)
        for (const pinMatch of validPinnacleMatches) {
            
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

                const currentBankroll = db.data.portfolio.balance || db.data.config.bankroll || 1000;

                if (realProbs && altenarOdds) {
                     // Analizar Oportunidades (1x2)
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Home', altenarOdds.home, realProbs.home, currentBankroll);
                     // La lógica de evaluacion de empate y visita:
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Draw', altenarOdds.draw, realProbs.draw, currentBankroll);
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Away', altenarOdds.away, realProbs.away, currentBankroll);
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
            eventId: event.id, // ID Vital para tracking
            match: `${dbMatch.home} vs ${dbMatch.away}`,
            date: dbMatch.date,
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
