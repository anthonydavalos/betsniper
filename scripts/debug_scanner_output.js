// Script para debuggear el output final del servicio de escaneo en memoria
import { scanLiveOpportunities, getLiveOverview } from '../src/services/liveValueScanner.js';
import db, { initDB } from '../src/db/database.js';

async function debugScan() {
    console.log("🛠️ Debugging Scanner Output...");
    await initDB();

    console.log("1. Fetching Live Overview...");
    const rawEvents = await getLiveOverview();
    
    // Dump liveTime of first 5 raw events
    console.log(`Found ${rawEvents.length} raw events.`);
    rawEvents.slice(0, 5).forEach((e,i) => {
        console.log(`[RAW ${i}] ${e.name} | Time: "${e.liveTime}" | Score: ${JSON.stringify(e.score)}`);
    });

    console.log("\n2. Scanning for opportunities...");
    try {
        const ops = await scanLiveOpportunities(rawEvents);
        
        console.log(`Found ${ops.length} opportunities.`);
        if (ops.length > 0) {
            console.log("\n3. Dumping Opportunity Times:");
            ops.forEach((op, i) => {
                console.log(`[OP ${i}] ${op.match} | OP.Time: "${op.time}" | OP.Score: "${op.score}" | Type: ${op.type} | Linked: ${op.linked}`);
            });
        }
    } catch (e) {
        console.error("Scan Error:", e);
    }
}

debugScan();
