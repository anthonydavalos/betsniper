
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db.json');

function cleanup() {
    if (!fs.existsSync(DB_PATH)) return;

    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const db = JSON.parse(raw);
    let removedCount = 0;

    if (db.portfolio) {
        const uniqueKeys = new Set();
        let removedCount = 0;

        // 1. Scan History First (to reserve keys)
        if (db.portfolio.history) {
            db.portfolio.history.forEach(bet => {
                const key = `${bet.eventId || bet.match}_${bet.pick || bet.selection}`;
                uniqueKeys.add(key);
            });
        }

        // 2. Clean Active Bets
        if (db.portfolio.activeBets) {
             const cleanActive = [];
             db.portfolio.activeBets.forEach(bet => {
                const key = `${bet.eventId || bet.match}_${bet.pick || bet.selection}`;
                
                // Allow duplicate if it's a diff eventId? No, key handles it.
                // Allow duplicate if status is different? No, we don't want 2 active bets on same match/pick.
                
                if (uniqueKeys.has(key)) {
                    console.log(`Duplicate Active (Exists in History or prev Active): ${bet.match} - ${bet.pick} (ID: ${bet.id})`);
                    removedCount++;
                } else {
                    uniqueKeys.add(key);
                    cleanActive.push(bet);
                }
             });
             db.portfolio.activeBets = cleanActive;
        }

        // 3. Clean Duplicates WITHIN History (Optional, but good hygiene)
        // Reset set for History self-scan
        const historyKeys = new Set();
        const cleanHistory = [];
        if (db.portfolio.history) {
            db.portfolio.history.forEach(bet => {
                const key = `${bet.eventId || bet.match}_${bet.pick || bet.selection}`;
                if (historyKeys.has(key)) {
                     console.log(`Duplicate History: ${bet.match} - ${bet.pick} (ID: ${bet.id})`);
                     removedCount++;
                } else {
                    historyKeys.add(key);
                    cleanHistory.push(bet);
                }
            });
            db.portfolio.history = cleanHistory;
        }

        if (removedCount > 0) {
            fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
            console.log(`\n✅ Cleaned ${removedCount} duplicates.`);
        } else {
             console.log("\n✅ No duplicates found.");
        }
    }
}

cleanup();
