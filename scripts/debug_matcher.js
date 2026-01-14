import altenarClient from '../src/config/axiosClient.js';
import db from '../src/db/database.js';
import { findMatch, normalizeName, getSimilarity, isTimeMatch } from '../src/utils/teamMatcher.js';

const runDebug = async () => {
    // 1. Leer Pinnacle DB
    await db.read();
    const pinnacleMatches = db.data.upcomingMatches || [];
    console.log(`📚 Pinnacle Matches (DB): ${pinnacleMatches.length}`);

    // 2. Traer LIVE de Altenar
    console.log('📡 Fetching Altenar LIVE...');
    const response = await altenarClient.get('/GetLivenow', {
        params: { eventCount: 100, sportId: 66 }
    });
    const altenarEvents = response.data.events || [];
    console.log(`📡 Altenar Live Events: ${altenarEvents.length}`);

    // 3. Análisis de Cruces Fallidos
    console.log('\n🔍 --- ANÁLISIS DE CRUCES FALLIDOS ---');
    let matchesFound = 0;

    for (const pMatch of pinnacleMatches) {
        // Filtrar candidatos por tiempo primero (para reducir ruido)
        const timeCandidates = altenarEvents.filter(aEvent => 
             isTimeMatch(pMatch.date, aEvent.liveTime || aEvent.startDate || '', 120) // Tolerancia alta de 2h para debug
        );

        if (timeCandidates.length === 0) continue;

        // Buscar Match Oficial
        const match = findMatch(pMatch.home, pMatch.date, altenarEvents);
        
        if (match) {
            matchesFound++;
            console.log(`✅ MATCH: [${pMatch.home}] == [${match.match.name}] (Score: ${match.score.toFixed(2)})`);
        } else {
            // Si no hubo match, mostrar los candidatos más cercanos por tiempo
            console.log(`❌ NO MATCH: [${pMatch.home}] (${pMatch.league.name})`);
            
            // Ver por qué falló con los candidatos de tiempo
            for (const cand of timeCandidates) {
                let candName = cand.name;
                if (candName.includes(' vs ')) candName = candName.split(' vs ')[0];

                const normP = normalizeName(pMatch.home);
                const normA = normalizeName(candName);
                const score = getSimilarity(normP, normA);
                
                // Mostrar solo si tienen algo de sentido (score > 0.3)
                if (score > 0.3) {
                    console.log(`   Detailed: [${pMatch.home}] vs [${candName}] -> Norm: "${normP}" vs "${normA}" -> Score: ${score.toFixed(2)}`);
                }
            }
        }
    }

    console.log(`\n📊 Resumen: ${matchesFound} matches de ${pinnacleMatches.length} posibles.`);
};

runDebug();
