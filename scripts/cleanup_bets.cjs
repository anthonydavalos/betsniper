const fs = require('fs');

try {
    const dbPath = './db.json';
    const dbData = fs.readFileSync(dbPath, 'utf8');
    const db = JSON.parse(dbData);

    const initialActive = db.portfolio.activeBets.length;
    
    // Filter out Tzeirey Tamra from activeBets
    db.portfolio.activeBets = db.portfolio.activeBets.filter(b => 
        !b.match.includes('Tzeirey Tamra')
    );

    // Also filter from history just in case
    const initialHistory = db.portfolio.history.length;
    db.portfolio.history = db.portfolio.history.filter(b => 
        !b.match.includes('Tzeirey Tamra')
    );

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    console.log(`✅ Removed ${initialActive - db.portfolio.activeBets.length} active bets.`);
    console.log(`✅ Removed ${initialHistory - db.portfolio.history.length} history bets.`);

} catch (err) {
    console.error('Error:', err);
}