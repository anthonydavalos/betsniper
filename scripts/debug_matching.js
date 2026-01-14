import db, { initDB } from '../src/db/database.js';
import { normalizeName, getSimilarity } from '../src/utils/teamMatcher.js';

const runDebug = async () => {
    await initDB();
    const pinnacleMatches = db.data.upcomingMatches || [];
    const altenarEvents = db.data.altenarUpcoming || [];

    if (pinnacleMatches.length === 0) {
        console.log("❌ No hay partidos de Pinnacle en DB.");
        return;
    }

    // Filtrar solo los NO enlazados
    const unlinked = pinnacleMatches.filter(p => !p.altenarId || !altenarEvents.some(e => e.id === p.altenarId));

    console.log(`\n🔍 AUDITORÍA DE PARTIDOS SIN ENLACE`);
    console.log(`   Total Pinnacle: ${pinnacleMatches.length}`);
    console.log(`   Sin Enlace:     ${unlinked.length}`);
    console.log(`   (Mostrando posibles candidatos similares en Altenar dentro de +/- 24h)\n`);

    const TIME_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h tolerancia

    for (const pMatch of unlinked) {
        const pTime = new Date(pMatch.date).getTime();
        const normPHome = normalizeName(pMatch.home);
        
        // 1. Filtrar por tiempo (amplio)
        const candidates = altenarEvents.filter(aEvent => {
            const aTime = new Date(aEvent.startDate || aEvent.date).getTime();
            return Math.abs(pTime - aTime) < TIME_WINDOW_MS;
        });

        // 2. Calcular similitud y ordenar
        const ranked = candidates.map(c => {
            // Altenar name es "Home vs Away", extraemos Home para comparar mejor
            let cHome = c.name.split(' vs ')[0]; 
            cHome = normalizeName(cHome);
            
            return {
                event: c,
                similarity: getSimilarity(normPHome, cHome),
                cleanName: cHome
            };
        }).sort((a, b) => b.similarity - a.similarity);

        // 3. Mostrar solo si hay algo relevante (Top 3)
        const topCandidates = ranked.slice(0, 3);
        
        // Solo imprimir si hay un candidato con al menos algo de similitud (> 0.3)
        // O si el usuario quiere ver todo, pero por defecto filtremos ruido.
        if (topCandidates.length > 0 && topCandidates[0].similarity > 0.3) {
            console.log(`🔴 [${pMatch.league.name}] ${pMatch.home} vs ${pMatch.away}`);
            console.log(`   📅 Pinn: ${pMatch.date}`);
            
            topCandidates.forEach(cand => {
                const icon = cand.similarity > 0.7 ? '✅' : '❓';
                console.log(`   ${icon} (${(cand.similarity * 100).toFixed(0)}%) [${cand.event.leagueName || '?'}] ${cand.event.name} (${cand.event.startDate})`);
            });
            console.log('---------------------------------------------------');
        }
    }
};

runDebug();
