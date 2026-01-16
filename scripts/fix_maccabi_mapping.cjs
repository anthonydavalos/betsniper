
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db.json');

function cleanBadMapping() {
    console.log("Starting cleanup of Bad Mapping (Maccabi Yavne vs Maccabi Ramla)...");
    
    if (!fs.existsSync(DB_PATH)) {
        console.error("db.json not found");
        return;
    }

    const rawData = fs.readFileSync(DB_PATH, 'utf-8');
    const db = JSON.parse(rawData);

    let modifications = 0;

    // Bad IDs to clean
    const BAD_EVENT_IDS = [
        15263701, // Maccabi Ramla (Bad match for Maccabi Yavne)
        15263710  // Maccabi Ironi Netivot vs Maccabi Beer Sheva (User requested removal)
    ];

    // 1. Clean Portfolio Bets (History & Active)
    
    // Check History default (array)
    if (db.portfolio && Array.isArray(db.portfolio.history)) {
        const initialLen = db.portfolio.history.length;
        db.portfolio.history = db.portfolio.history.filter(bet => {
            if (BAD_EVENT_IDS.includes(bet.eventId)) {
                console.log(`Removing History Bet: ${bet.match} (${bet.pick}) - ID: ${bet.id}`);
                return false; 
            }
            return true;
        });
        if (db.portfolio.history.length !== initialLen) modifications++;
    }

    // Check Active Bets (array)
    if (db.portfolio && Array.isArray(db.portfolio.activeBets)) {
        const initialLen = db.portfolio.activeBets.length;
        db.portfolio.activeBets = db.portfolio.activeBets.filter(bet => {
             if (BAD_EVENT_IDS.includes(bet.eventId)) {
                console.log(`Removing Active Bet: ${bet.match} (${bet.pick}) - ID: ${bet.id}`);
                return false; 
            }
            return true;
        });
        if (db.portfolio.activeBets.length !== initialLen) modifications++;
    }

    // 2. Clean Mapping in Lists (upcomingMatches, liveEvents, etc)
    const listKeys = ['upcomingMatches', 'liveEvents', 'prematchEvents'];
    
    listKeys.forEach(key => {
        if (db[key] && Array.isArray(db[key])) {
            db[key].forEach(match => {
                // Check by Altenar ID directly
                if (BAD_EVENT_IDS.includes(match.altenarId)) {
                        console.log(`Unlinking Altenar ID ${match.altenarId} from ${match.home} vs ${match.away} in ${key}`);
                        match.altenarId = null;
                        match.altenarName = null;
                        modifications++;
                }
            });
        }
    });

    if (modifications > 0) {
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        console.log(`\nCleanup Complete. ${modifications} changes saved to db.json`);
    } else {
        console.log("\nNo matching bad data found.");
    }
}

cleanBadMapping();
