
import { getLiveOddsComparison } from '../src/services/liveValueScanner.js';
import db, { initDB } from '../src/db/database.js';

async function run() {
    console.log("🔍 Diagnóstico de Monitor: ¿Por qué no aparecen cuotas de Arcadia?");
    await initDB();
    console.log(`📚 DB cargada: ${db.data.upcomingMatches?.length || 0} partidos.`);

    const report = await getLiveOddsComparison();
    
    console.log(`📊 Reporte generado: ${report.length} eventos.`);
    
    let linkedCount = 0;
    let pinnacleFound = 0;

    report.forEach(op => {
        if (op.linked) linkedCount++;
        if (op.pinnacle) pinnacleFound++;

        if (op.linked && !op.pinnacle) {
            console.warn(`⚠️  Linkeado pero SIN DATA PINNACLE: ${op.name} (ID: ${op.id})`);
        }
    });

    console.log(`\nRESUMEN:`);
    console.log(`- Eventos Totales: ${report.length}`);
    console.log(`- Linkeados (Match ID/Nombre): ${linkedCount}`);
    console.log(`- Con Cuotas Pinnacle: ${pinnacleFound}`);
    
    if (pinnacleFound === 0) {
        console.error("❌ ERROR CRÍTICO: Ningún evento tiene cuotas de Pinnacle.");
    }
}

run();
