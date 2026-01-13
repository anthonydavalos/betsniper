import db from '../db/database.js';
import { findMatch } from '../utils/teamMatcher.js';
import { calculateEV, calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: PRE-MATCH VALUE SCANNER (CACHED)
// =====================================================================

/**
 * Escanea los próximos partidos usando la data en Caché de Altenar (db.altnearUpcoming)
 * y la cruza con nuestras Probabilidades Reales (Pinnacle) almacenadas en DB autocompletada.
 * 
 * NOTA: Ya no hace fetch a la API de Altenar en tiempo real para ahorrar recursos.
 * Se debe ejecutar el script de ingesta (ingest-altenar.js) periódicamente.
 */
export const scanPrematchOpportunities = async () => {
    try {
        console.log(`\n📡 [Pre-Match Scanner] Buscando Value Bets en caché local...`);

        // 1. Leer DB Completa (Source of Truth)
        await db.read();
        
        const pinnacleMatches = db.data.upcomingMatches || [];
        const altenarCachedEvents = db.data.altenarUpcoming || [];

        if (pinnacleMatches.length === 0 || altenarCachedEvents.length === 0) {
            console.log('   ⚠️ Faltan datos en DB (Pinnacle o Altenar). Ejecuta los scripts de ingesta.');
            return [];
        }

        const valueBets = [];

        let totalMatchesFound = 0;

        // 2. Iterar sobre la data de Pinnacle (Nuestra Verdad)
        // Iteramos sobre Pinnacle porque es la lista "Master" con timestamps fiables.
        for (const pinMatch of pinnacleMatches) {
            
            // 3. Buscar coincidencia en Altenar usando el Nuevo Matcher Avanzado
            // Buscamos dentro de la lista de candidatos de Altenar
            const matchResult = findMatch(pinMatch.home, pinMatch.date, altenarCachedEvents);

            if (matchResult) {
                totalMatchesFound++;
                const altenarEvent = matchResult.match;
                
                // Debug Opcional: Ver qué encontró
                // console.log(`🔗 Match Found: ${pinMatch.home} <-> ${altenarEvent.name} (${matchResult.score.toFixed(2)})`);

                // Analizar HOME
                evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Home', altenarEvent.odds.home, pinMatch.realProbabilities.home, db.data.config.bankroll);
                
                // Analizar DRAW
                evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Draw', altenarEvent.odds.draw, pinMatch.realProbabilities.draw, db.data.config.bankroll);

                // Analizar AWAY
                evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Away', altenarEvent.odds.away, pinMatch.realProbabilities.away, db.data.config.bankroll);
            }
        }

        console.log(`\n📊 ESTADÍSTICAS DE ESCANEO:`);
        console.log(`   - Partidos en Pinnacle (DB): ${pinnacleMatches.length}`);
        console.log(`   - Partidos en DoradoBet (DB): ${altenarCachedEvents.length}`);
        console.log(`   - CRUCES EXITOSOS (Matches): ${totalMatchesFound}`);

        if (valueBets.length > 0) {
            console.log(`💎 ${valueBets.length} VALUE BETS PRE-MATCH DETECTADAS (DESDE CACHÉ)`);
        } else {
            console.log('   ✅ Escaneo completado. Sin oportunidades claras por ahora.');
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

    const ev = calculateEV(realProb, offeredOdd);
    
    // Filtro de Valor (> 2% EV por defecto)
    if (ev > 2.0) {
        // Calcular Stake Kelly
        const kelly = calculateKellyStake(realProb, offeredOdd, bankroll);
        
        resultsArray.push({
            type: 'PREMATCH_VALUE',
            match: event.name,
            league: dbMatch.league.name,
            date: event.startDate,
            market: `1x2 - ${listSide}`,
            odd: offeredOdd,
            realProb: realProb,
            ev: ev,
            kellyStake: kelly.stakeAmount,
            kellyPct: kelly.percentage,
            bookmaker: 'DoradoBet (Cached)',
            timestamp: Date.now()
        });
    }
};
