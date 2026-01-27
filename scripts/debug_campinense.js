
import { getEventDetails } from '../src/services/liveScannerService.js';

const debugMatch = async () => {
    const MATCH_ID = 15208491; // Campinense ID
    console.log(`🔍 Inspecting details for Campinense (ID: ${MATCH_ID})...`);

    try {
        const details = await getEventDetails(MATCH_ID);
        
        if (!details) {
            console.log("❌ No details returned.");
            return;
        }

        console.log(`✅ Details found. Name: ${details.name}`);
        console.log("   Root Keys:", Object.keys(details));
        console.log(`   Markets Count: ${details.markets ? details.markets.length : 0}`);
        if(details.odds) console.log(`   Root Odds Count: ${details.odds.length}`);

        if (details.odds && details.odds.length > 0) {
            console.log("   Example Odd:", JSON.stringify(details.odds[0], null, 2));
        }

        if (details.markets) {
            const market1x2 = details.markets.find(m => m.typeId === 1 || m.name === '1x2' || m.name === 'Match Result');
            
            if (market1x2) {
                console.log(`✅ Market 1x2 found: ${market1x2.name} (ID: ${market1x2.id})`);
                console.log("   Full Market Object:", JSON.stringify(market1x2, null, 2));
            } else {
                console.log("❌ Market 1x2 NOT FOUND. Available markets:");
                details.markets.forEach(m => console.log(`   - [${m.typeId}] ${m.name}`));
            }
        }

    } catch (e) {
        console.error(e);
    }
};

debugMatch();
