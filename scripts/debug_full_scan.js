
import { scanLiveOpportunities } from '../src/services/liveValueScanner.js';
import db, { initDB } from '../src/db/database.js';

const runFullScan = async () => {
    console.log("🚀 Running FULL Live Scan simulation...");
    await initDB();

    try {
        const opportunities = await scanLiveOpportunities();
        console.log(`\n🏁 Scan Finished. Opportunities Found: ${opportunities ? opportunities.length : 0}`);
        
        if (opportunities && opportunities.length > 0) {
            console.log(JSON.stringify(opportunities, null, 2));
        } else {
            console.log("⚠️ No opportunities found in this run.");
        }

    } catch (e) {
        console.error("❌ CRITICAL ERROR:", e);
    }
};

runFullScan();
