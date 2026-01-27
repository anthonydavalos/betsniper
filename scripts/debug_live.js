
import { getLiveOverview } from '../src/services/liveScannerService.js';
import db, { initDB } from '../src/db/database.js';

const debugLiveScan = async () => {
    console.log("🔍 [DEBUG] Iniciando Diagnóstico de Eventos en Vivo...");
    await initDB();
    
    // 1. Obtener eventos en vivo reales de Altenar
    console.log("📡 Solicitando /GetLivenow a Altenar...");
    const liveEvents = await getLiveOverview();
    console.log(`📦 Eventos en Vivo recibidos: ${liveEvents.length}`);

    if (liveEvents.length === 0) {
        console.log("⚠️ Altenar no retorna eventos. ¿VPN? ¿Config?");
        return;
    }

    // 2. Mapear Partidos en DB
    const pinnacleDb = db.data.upcomingMatches || [];
    const dbLinked = pinnacleDb.filter(m => m.altenarId);
    console.log(`📂 Partidos en DB 'Upcoming': ${pinnacleDb.length}`);
    console.log(`🔗 Partidos enlazados (con altenarId): ${dbLinked.length}`);

    // Map para búsqueda rápida
    const linkedMap = new Map();
    dbLinked.forEach(m => linkedMap.set(m.altenarId, m));

    // 3. Iterar y Diagnosticar
    let foundLinked = 0;
    
    console.log("\n--- ANÁLISIS POR PARTIDO (Muestra de 20) ---");

    for (const ev of liveEvents.slice(0, 20)) {
        const dbMatch = linkedMap.get(ev.id);
        const prefix = dbMatch ? "✅ [LINKED]" : "❌ [UNLINKED]";
        const name = ev.name || "Sin Nombre";
        const score = Array.isArray(ev.score) ? ev.score.join('-') : '0-0';
        const time = ev.liveTime || "0'";

        console.log(`${prefix} ${name} | Score: ${score} | Time: ${time} | ID: ${ev.id}`);
        
        if (dbMatch) {
            foundLinked++;
            // Check Conditions
            // A. Time Check
            const min = parseInt((time || "0").replace("'", ""));
            if (min < 15 || min > 75) {
                console.log(`       -> Rechazado: Tiempo fuera de rango (15-75).`);
                continue;
            }

            // B. Score Diff Check
            const [h, a] = ev.score || [0,0];
            const diff = h - a;
            if (Math.abs(diff) !== 1) {
                console.log(`       -> Rechazado: Diferencia de goles no es 1.`);
                continue;
            }

            // C. Favorite Check
            console.log(`       -> CANDIDATO TÉCNICO. Verificando cuotas Pinnacle Favorito...`);
            const pHome = 1 / dbMatch.odds.home;
            const pAway = 1 / dbMatch.odds.away;
            
            if (diff === -1) { // Va perdiendo Local
                if (pHome > 0.55) console.log(`       ⭐ OPORTUNIDAD: Local Favorito (${(pHome*100).toFixed(1)}%) perdiendo.`);
                else console.log(`       -> Rechazado: Local no es suficientemente favorito (${(pHome*100).toFixed(1)}% < 55%).`);
            } else if (diff === 1) { // Va perdiendo Visita
                 if (pAway > 0.55) console.log(`       ⭐ OPORTUNIDAD: Visita Favorito (${(pAway*100).toFixed(1)}%) perdiendo.`);
                 else console.log(`       -> Rechazado: Visita no es suficientemente favorito (${(pAway*100).toFixed(1)}% < 55%).`);
            }
        }
    }

    console.log(`\n📊 RESULTADO DIAGNÓSTICO:`);
    console.log(`   - Total Live Events: ${liveEvents.length}`);
    console.log(`   - Linked Events Found: ${foundLinked}`);
    if (foundLinked === 0) {
        console.log("   🚩 PROBLEMA CRÍTICO: Ningún evento en vivo coincide con los IDs cacheados de Pinnacle.");
        console.log("   Solución Sugerida: Ejecutar 'npm run ingest:pinnacle' y 'ingest:altenar' de nuevo, o revisar 'linker'.");
    }
};

debugLiveScan();
