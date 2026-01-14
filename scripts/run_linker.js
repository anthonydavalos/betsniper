import { scanPrematchOpportunities } from '../src/services/prematchScannerService.js';
import { initDB } from '../src/db/database.js';

const run = async () => {
    await initDB();
    const opportunities = await scanPrematchOpportunities();
    
    if (opportunities.length > 0) {
        console.table(opportunities.map(op => ({
            Match: op.match,
            Market: op.market,
            Odd: op.odd,
            RealProb: op.realProb.toFixed(1) + '%',
            EV: op.ev.toFixed(1) + '%',
            Bankroll: '$' + op.kellyStake.toFixed(2)
        })));
    }
};

run();