import db, { initDB } from '../src/db/database.js';
import { findMatch, isTimeMatch, normalizeName, getSimilarity } from '../src/utils/teamMatcher.js';

const DEBUG_TOLERANCE_MINUTES = 5; // Ver candidatos a la misma hora exacta (+/- 5m por variaciones de reloj)

const run = async () => {
    console.log("🔍 Iniciando Debug de Matching...");
    await initDB();

    // 1. Cargar Datos
    const pinnacleMatches = db.data.upcomingMatches || [];
    const altenarMatches = db.data.altenarUpcoming || [];

    console.log(`📊 Pinnacle Matches: ${pinnacleMatches.length}`);
    console.log(`📊 Altenar Matches: ${altenarMatches.length}`);

    if (pinnacleMatches.length === 0 || altenarMatches.length === 0) {
        console.log("⚠️ Base de datos vacía. Ejecuta ingest-pinnacle e ingest-altenar primero.");
        return;
    }

    let linkedCount = 0;
    let failedCount = 0;

    // console.log("\n________________________________________________________________________________");
    // console.log("🛠️  ANÁLISIS DE FALLOS DE MATCHING");
    // console.log("________________________________________________________________________________\n");

    for (const pMatch of pinnacleMatches) {
        // Ignorar partidos viejos (> 24h)
        const matchTime = new Date(pMatch.date).getTime();
        const now = Date.now();
        // if (matchTime < now - 86400000) continue; 

        // 2. Intentar Match Oficial
        const matchResult = findMatch(pMatch.home, pMatch.date, altenarMatches);

        if (matchResult) {
            linkedCount++;
        } else {
            failedCount++;
            
            /*
            // 3. Análisis Forense del Fallo
            console.log(`❌ SIN MATCH: [${pMatch.home} vs ${pMatch.away}]`);
            console.log(`   📅 Fecha Pin: ${pMatch.date} (${new Date(pMatch.date).toLocaleString()})`);
            
            // 3.1 Buscar candidatos cercanos en tiempo (Tolerance Ampliada)
            const timeCandidates = altenarMatches.filter(a => 
                isTimeMatch(pMatch.date, a.startDate, DEBUG_TOLERANCE_MINUTES)
            );

            if (timeCandidates.length === 0) {
                console.log("   🚫 No hay eventos Altenar cercanos en tiempo (+/- 3h). Faltan en el feed o hora errónea.");
            } else {
                console.log(`   🔎 ${timeCandidates.length} Candidatos por Tiempo (+/- 3h):`);
                
                const candidatesWithScore = timeCandidates.map(c => {
                    let cName = c.name || c.home;
                    // Limpieza básica igual que en matcher
                     if (cName.includes(' vs ')) cName = cName.split(' vs ')[0]; 
                     if (cName.includes(' vs. ')) cName = cName.split(' vs. ')[0];

                    const nTarget = normalizeName(pMatch.home);
                    const nCandidate = normalizeName(cName);
                    const score = getSimilarity(nTarget, nCandidate);
                    
                    const timeDiff = Math.round((new Date(c.startDate).getTime() - new Date(pMatch.date).getTime()) / 60000);

                    return { raw: c, cleanName: nCandidate, score, timeDiff };
                }).sort((a,b) => b.score - a.score); // Mejores scores primero

                // Mostrar Top 5
                candidatesWithScore.slice(0, 5).forEach(c => {
                    const icon = c.score > 0.6 ? '🔸' : '▫️';
                    console.log(`      ${icon} Score: ${(c.score*100).toFixed(0)}% | Time: ${c.timeDiff > 0 ? '+'+c.timeDiff : c.timeDiff}m | Name: "${c.raw.name}"`);
                    if (c.score > 0.6) {
                        console.log(`          (Norm: "${normalizeName(pMatch.home)}" vs "${c.cleanName}")`);
                    }
                });
            }
            console.log("-".repeat(50));
            */
        }
    }

    // --- NUEVA SECCIÓN: ANÁLISIS DE HUÉRFANOS DE ALTENAR ---
    console.log("\n________________________________________________________________________________");
    console.log("🔄 ANÁLISIS INVERSO: HUÉRFANOS EN ALTENAR (Altenar -> ¿Pinnacle?)");
    console.log("________________________________________________________________________________");
    console.log("ℹ️  Buscando partidos de Altenar que NO fueron linkeados a ninguno de Pinnacle...");
    console.log("ℹ️  Filtros: Hora Exacta (+/- 5 Min) y Similitud > 50% (Equivalente al Matcher)\n");

    const usedAltenarIds = new Set(pinnacleMatches.map(p => p.altenarId).filter(id => id));
    let altenarOrphanCount = 0;

    for (const aMatch of altenarMatches) {
        if (usedAltenarIds.has(aMatch.id)) continue;
        
        // Filtro opcional: ignorar eventos muy viejos para no llenar la consola
        const matchTime = new Date(aMatch.startDate).getTime();
        if (matchTime < Date.now() - 43200000) continue; // Solo últimas 12h

        altenarOrphanCount++;
        
        // Extraer nombre limpio de Altenar (suele venir "Home vs Away" en .name)
        let aName = aMatch.name || "";
        if (aName.includes(' vs ')) aName = aName.split(' vs ')[0];
        if (aName.includes(' vs. ')) aName = aName.split(' vs. ')[0];
        
        console.log(`⚠️ HUÉRFANO ALTENAR: [${aName}] (ID: ${aMatch.id})`);
        console.log(`   📅 Fecha Alt: ${aMatch.startDate} (${new Date(aMatch.startDate).toLocaleString()})`);

        // Buscar candidatos en Pinnacle (Inverso)
        const timeCandidates = pinnacleMatches.filter(p => 
            isTimeMatch(p.date, aMatch.startDate, DEBUG_TOLERANCE_MINUTES)
        );

        if (timeCandidates.length === 0) {
            console.log("   🚫 No hay eventos Pinnacle cercanos en tiempo.");
        } else {
             const candidatesWithScore = timeCandidates.map(p => {
                const nTarget = normalizeName(aName);
                const nCandidate = normalizeName(p.home);
                const score = getSimilarity(nTarget, nCandidate);
                const timeDiff = Math.round((new Date(p.date).getTime() - new Date(aMatch.startDate).getTime()) / 60000);
                return { raw: p, cleanName: nCandidate, score, timeDiff };
            }).sort((a,b) => b.score - a.score);

            // Mostrar candidatos con score > 0.30 (Bajamos la vara para detectar casos difíciles como abreviaturas extremas)
            const viableCandidates = candidatesWithScore.filter(c => c.score > 0.30).slice(0, 5);
            
            if (viableCandidates.length > 0) {
                console.log(`   🔎 Posibles Candidatos Pinnacle (Score > 30%):`);
                viableCandidates.forEach(c => {
                    const icon = c.score > 0.6 ? '✅' : (c.score > 0.4 ? '🤔' : '❓');
                    console.log(`      ${icon} Score: ${(c.score*100).toFixed(0)}% | Diff: ${c.timeDiff}m | "${c.raw.home}" (Liga: ${c.raw.league?.name})`);
                    if (c.score < 0.6) console.log(`          (Comparando: "${normalizeName(c.raw.home)}" vs "${normalizeName(aName)}")`);
                });
            } else {
                // console.log("   🚫 Candidatos por hora existen, pero NINGUNO tiene nombre similar (>50%).");
            }
        }
        // console.log("-".repeat(50));
    }

    console.log("\n________________________________________________________________________________");
    console.log("📋 RESUMEN FINAL");
    console.log(`✅ Matches Linkeados (Pinnacle -> Altenar): ${linkedCount}`);
    console.log(`❌ Fallos Pinnacle (Sin Match): ${failedCount}`);
    console.log(`🍂 Huérfanos Altenar (Sin dueño): ${altenarOrphanCount}`);
    console.log(`📈 Tasa de Cobertura Pinnacle: ${((linkedCount / (linkedCount + failedCount)) * 100).toFixed(1)}%`);
};

run();
