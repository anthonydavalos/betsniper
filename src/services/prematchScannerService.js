import db from '../db/database.js';
import { findMatch } from '../utils/teamMatcher.js';
import { calculateEV, calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: PRE-MATCH VALUE SCANNER & LINKER
// =====================================================================

export const scanPrematchOpportunities = async () => {
    try {
        console.log(`\n📡 [Pre-Match Scanner] Buscando Value Bets y Enlazando IDs...`);

        // 1. Leer DB
        await db.read();
        
        const pinnacleMatches = db.data.upcomingMatches || [];
        const altenarCachedEvents = db.data.altenarUpcoming || [];

        if (pinnacleMatches.length === 0 || altenarCachedEvents.length === 0) {
            console.log('   ⚠️ Faltan datos en DB. Ejecuta los scripts de ingesta.');
            return [];
        }

        const valueBets = [];
        let totalMatchesFound = 0;
        let newLinksCreated = 0; // Contador de nuevos enlaces

        // 2. Iterar sobre Pinnacle
        for (const pinMatch of pinnacleMatches) {
            
            let altenarEvent = null;

            // ESTRATEGIA HÍBRIDA: ID CACHEADO vs BUSQUEDA FUZZY
            // Si ya tenemos el ID guardado de un escaneo anterior, lo usamos directo.
            if (pinMatch.altenarId) {
                altenarEvent = altenarCachedEvents.find(e => e.id === pinMatch.altenarId);
            }

            // Si no tenemos ID o el ID ya no existe en el feed reciente, buscamos fuzzy
            if (!altenarEvent) {
                const matchResult = findMatch(pinMatch.home, pinMatch.date, altenarCachedEvents);
                if (matchResult) {
                    altenarEvent = matchResult.match;
                    
                    // 🧠 LINKER MAGICO: Guardamos el ID para el futuro (Live Scanner)
                    pinMatch.altenarId = altenarEvent.id; 
                    pinMatch.altenarName = altenarEvent.name; // Útil para debug
                    newLinksCreated++;
                }
            }

            if (altenarEvent) {
                totalMatchesFound++;

                // Analizar Oportunidades (1x2)
                evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Home', altenarEvent.odds.home, pinMatch.realProbabilities.home, db.data.config.bankroll);
                evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Draw', altenarEvent.odds.draw, pinMatch.realProbabilities.draw, db.data.config.bankroll);
                evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Away', altenarEvent.odds.away, pinMatch.realProbabilities.away, db.data.config.bankroll);
            }
        }

        // 3. PERSISTIR LOS ENLACES (Guardar IDs en db.json)
        if (newLinksCreated > 0) {
            await db.write();
            console.log(`   🔗 ${newLinksCreated} nuevos enlaces Pinnacle-Altenar guardados en DB.`);
        }

        console.log(`\n📊 ESTADÍSTICAS PRE-MATCH:`);
        console.log(`   - Partidos Totales: ${pinnacleMatches.length}`);
        console.log(`   - Enlazados (Ready for Live): ${totalMatchesFound}`);

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
            kellyStake: kelly.amount,
            kellyPct: kelly.percentage,
            bookmaker: 'DoradoBet (Cached)',
            timestamp: Date.now()
        });
    }
};
