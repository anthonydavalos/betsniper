import fs from 'fs';
const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const alts = db.altenarUpcoming || [];
console.log('Total Altenar:', alts.length);
const sag = alts.filter(e => JSON.stringify(e).toLowerCase().includes('sagaing'));
console.log('Sagaing matches:', JSON.stringify(sag, null, 2));
const tel = alts.filter(e => JSON.stringify(e).toLowerCase().includes('telecom'));
console.log('Telecom matches:', JSON.stringify(tel, null, 2));

