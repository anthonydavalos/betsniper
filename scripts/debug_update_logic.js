import { updateActiveBetsWithLiveData } from '../src/services/paperTradingService.js';
import { getLiveOverview } from '../src/services/liveScannerService.js';
import db, { initDB } from '../src/db/database.js';

const debugUpdate = async () => {
    console.log("🛠️ Debugging Update Logic...");
    await initDB();

    console.log("1. Fetching Live Data...");
    const liveEvents = await getLiveOverview();
    console.log(`   Fetched ${liveEvents.length} events.`);

    const targetId = 14738504;
    const liveEvent = liveEvents.find(e => e.id === targetId);

    if (liveEvent) {
        console.log("   ✅ Event found in live feed:", liveEvent.name, liveEvent.score);
    } else {
        console.log("   ❌ Event NOT found in live feed.");
    }
    
    // Simulate updating active bets
    const bet = db.data.portfolio.activeBets.find(b => b.eventId === targetId);
    if (!bet) {
        console.log("   ❌ Bet not found in DB activeBets.");
        return;
    }

    console.log("2. Testing Map Logic...");
    const liveMap = new Map();
    liveEvents.forEach(e => {
        liveMap.set(e.id, e);
        liveMap.set(e.name, e);
    });

    const match = bet.eventId ? liveMap.get(bet.eventId) : liveMap.get(bet.match);
    console.log(`   Lookup Result for ID ${bet.eventId}:`, match ? "FOUND" : "NOT FOUND");

    if (match) {
        console.log("   -> Match Data:", match.score, match.liveTime);
        
        // Manual Update for verification
        bet.lastKnownScore = `${match.score[0]}-${match.score[1]}`;
        bet.liveTime = match.liveTime;
        bet.lastUpdate = new Date().toISOString();
        
        console.log("   📝 Manually updating bet in memory to:", bet.lastKnownScore, bet.liveTime);
        // await db.write(); // Uncomment to force write if needed
    }
};

debugUpdate();