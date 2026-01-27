import fs from 'fs';
const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));

const targets = [
    { p: 'Auckland', a: 'Bula', pName: 'Auckland FC II' },
    { p: 'Mahar', a: 'Sagaing', pName: 'Mahar United' },
    { p: 'WE SC', a: 'Telecom', pName: 'WE SC' }
];

console.log('--- Timestamp & Existence Check Round 4 (CORRECTED) ---');

const pinMatches = db.upcomingMatches || [];
const altMatches = db.altenarUpcoming || [];

console.log(`DB Counts: Pinnacle (${pinMatches.length}), Altenar (${altMatches.length})`);

targets.forEach(t => {
    console.log(`\nLooking for pair: ${t.p} / ${t.a}`);
    
    // Pinnacle Search (direct home/away keys)
    const pin = pinMatches.find(m => {
        const h = (m.home || '').toLowerCase();
        const a = (m.away || '').toLowerCase();
        return h.includes(t.p.toLowerCase()) || a.includes(t.p.toLowerCase());
    });
    
    // Altenar Search (uses homeName/awayName)
    const alt = altMatches.find(m => {
        const h = (m.homeName || '').toLowerCase();
        const a = (m.awayName || '').toLowerCase();
        const t_a = t.a.toLowerCase();
        const t_p = t.p.toLowerCase();
        const t_pname = t.pName.toLowerCase();
        return h.includes(t_a) || a.includes(t_a) || h.includes(t_p) || a.includes(t_p) || h.includes(t_pname);
    });

    if (pin) console.log(`  PIN: ${pin.home} vs ${pin.away} @ ${pin.date}`); // note: pinnacle uses 'date', not 'startTime'
    else console.log('  PIN: Not found');

    if (alt) console.log(`  ALT: ${alt.homeName} vs ${alt.awayName} @ ${alt.startTime}`);
    else console.log('  ALT: Not found');

    if (pin && alt) {
        const t1 = new Date(pin.date).getTime();
        const t2 = new Date(alt.startTime).getTime();
        const diff = (t1 - t2) / 60000;
        console.log(`  DIFF: ${diff.toFixed(1)} mins`);
    } else {
        console.log('  Cannot compare times');
    }
});
