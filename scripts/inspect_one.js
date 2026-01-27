import fs from 'fs';
const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const match = db.upcomingMatches[0];
console.log(JSON.stringify(match, null, 2));
