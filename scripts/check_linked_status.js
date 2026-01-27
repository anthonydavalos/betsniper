import fs from 'fs';
const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const matches = db.upcomingMatches || [];
const mahar = matches.find(m => (m.home || '').includes('Mahar'));
console.log('Mahar Record:', JSON.stringify(mahar, null, 2));

const we = matches.find(m => (m.home || '').includes('WE SC'));
console.log('WE SC Record:', JSON.stringify(we, null, 2));

