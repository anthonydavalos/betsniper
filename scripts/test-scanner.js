import { scanPrematchOpportunities } from '../src/services/prematchScannerService.js';
import db, { initDB } from '../src/db/database.js';

const run = async () => {
    console.log('🏁 Iniciando Test Manual del Scanner...');
    await initDB();
    await scanPrematchOpportunities();
};

run();