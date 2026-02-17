import { scanLiveOpportunities } from '../src/services/liveScannerService.js';

// Argumentos consola
const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

const run = async () => {
    console.log(`🟢 INICIANDO LIVE SNIPER (Intervalo: 60s) [MODO: ${isDryRun ? 'OBSERVADOR (Dry Run)' : 'ACTIVO'}]...`);
    
    if (isDryRun) {
        console.log("   🛡️  Dry Run: No se ejecutarán apuestas, solo detección.");
    }
    
    const loop = async () => {
        // Pasamos el flag al servicio (aunque por ahora solo devuelve ops)
        const opportunities = await scanLiveOpportunities(null, { dryRun: isDryRun });

        if (opportunities.length > 0) {
            console.log("\n🔥 OPORTUNIDADES EN VIVO DETECTADAS 🔥");
            console.table(opportunities.map(o => ({
                Match: o.match,
                Score: o.score,
                Time: o.time,
                Strategy: o.strategy || 'VALUE',
                'Real %': o.realProb.toFixed(1) + '%',
                Odd: o.odd.toFixed(2),
                'Kelly $': o.kellyStake.toFixed(2),
                EV: o.ev.toFixed(1) + '%'
            })));
        } else {
            process.stdout.write("."); // Heartbeat visual
        }
    };


    // Ejecutar inmediatamente y luego intervalar
    await loop();
    
    setInterval(async () => {
        await loop();
    }, 60000); // Cada 60 segundos
};

run();
