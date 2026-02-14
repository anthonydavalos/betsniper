
import fs from 'fs';
import path from 'path';

const pinPath = path.resolve('data/pinnacle_live.json');

try {
    if (!fs.existsSync(pinPath)) {
        console.log("No data/pinnacle_live.json found.");
        process.exit(1);
    }
    const raw = fs.readFileSync(pinPath, 'utf-8');
    const data = JSON.parse(raw);
    
    // Check structure
    console.log("Root keys:", Object.keys(data));
    
    let events = [];
    if (Array.isArray(data)) events = data;
    else if (data.events) events = data.events;
    
    if (events.length > 0) {
        console.log("SAMPLE EVENT:", JSON.stringify(events[0], null, 2));
    }
    
    const names = events.map(ev => {
        const home = ev.participants?.find(p => p.alignment === 'home')?.name || '???';
        const away = ev.participants?.find(p => p.alignment === 'away')?.name || '???';
        return `${home} vs ${away} [League: ${ev.leagueId}]`;
    });
    
    names.sort();
    
    console.log(`--- LISTADO DE ${names.length} EVENTOS EN VIVO EN PINNACLE ---`);
    names.forEach(n => console.log(n));

} catch (e) {
    console.error(e);
}
