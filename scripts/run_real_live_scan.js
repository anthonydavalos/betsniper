
import { scanLiveOpportunities } from '../src/services/scannerService.js';
import { initDB } from '../src/db/database.js';

const run = async () => {
    await initDB();
    console.log('🏁 Iniciando Live Scanner (Ejecución Única)...');
    
    try {
        const opportunities = await scanLiveOpportunities();
        
        console.log('\n📊 RESULTADOS EN VIVO:');
        if (opportunities.length === 0) {
            console.log('   ✅ No se encontraron oportunidades activas por el momento.');
        } else {
            console.table(opportunities.map(op => ({
                Match: op.match,
                League: op.league,
                Time: op.time,
                Score: op.score,
                Market: op.market,
                Odd: op.odd,
                EV: op.ev.toFixed(1) + '%',
                Stake: '$' + op.kellyStake.toFixed(2)
            })));
        }
    } catch (e) {
        console.error('❌ Error fatal:', e);
    }
};

run();
