
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db.json');

function debugDuplicateLogic() {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const db = JSON.parse(raw);
    const bets = db.portfolio.activeBets.filter(b => b.match.includes('Al-Najma'));
    
    console.log(`Found ${bets.length} bets for Al-Najma.`);
    
    if (bets.length < 2) return;

    const b1 = bets[0];
    const b2 = bets[1];

    console.log("--- Bet 1 ---");
    console.log("ID:", b1.eventId, typeof b1.eventId);
    console.log("Pick:", b1.pick);
    console.log("Match:", b1.match);
    
    // Simulate Opportunity from Bet 2
    const opportunity = {
        eventId: b2.eventId,
        match: b2.match,
        // The check uses the *calculated* pick passed as arg, not opportunity.pick usually (in my new code)
        // But for simulation let's match the logic
    };
    const pick = b2.pick;

    console.log("\n--- Comparison Simulation ---");
    const isSameEvent = b1.eventId && opportunity.eventId 
        ? b1.eventId == opportunity.eventId 
        : b1.match === opportunity.match;
    
    console.log(`b1.eventId (${b1.eventId}) == opportunity.eventId (${opportunity.eventId}) => ${b1.eventId == opportunity.eventId}`);
    console.log(`isSameEvent: ${isSameEvent}`);
    
    const isSamePick = b1.pick === pick;
    console.log(`b1.pick (${b1.pick}) === pick (${pick}) => ${isSamePick}`);

    console.log(`Result: ${isSameEvent && isSamePick}`);
}

debugDuplicateLogic();
