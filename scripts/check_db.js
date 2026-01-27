import fs from 'fs';
const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
console.log('Keys:', Object.keys(db));
if (db.pinnacle) console.log('Pinnacle Count:', db.pinnacle.length);
if (db.matches) console.log('Matches Count:', db.matches.length);
if (db.events) console.log('Events Count:', db.events.length);
if (db.scanned_prematch) console.log('Scanned Prematch Count:', db.scanned_prematch.length);

