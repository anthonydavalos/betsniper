
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DATA_PATH = path.join(__dirname, '../data/pinnacle_live.json');

function run() {
    console.log("🔍 Buscando partidos 'desaparecidos' en el feed de Pinnacle...");

    try {
        const fileContent = fs.readFileSync(LOCAL_DATA_PATH, 'utf-8');
        const feed = JSON.parse(fileContent);
        console.log(`✅ Feed cargado: ${feed.events.length} eventos.`);

        const targets = [
            { home: "FC Muza", away: "Konkola Blades" },
            { home: "Kipanga FC", away: "Mwembe Makumbi City" },
            { home: "AS Vallee", away: "FC Amitie" },
            { home: "Stjarnan Gardabae", away: "B93 Copenhague" },
            { home: "Al Ahli Jordan", away: "AL Salt" }
        ];

        targets.forEach(target => {
            console.log(`\n🔎 Testing: ${target.home} vs ${target.away}`);
            
            // Clean names for broader search
            const cleanHome = target.home.replace(/FC|AS|Al|Jordan|Gardabae/gi, "").trim();
            const cleanAway = target.away.replace(/FC|AS|AL|City|Blades|Copenhague/gi, "").trim();

            console.log(`   (Busqueda Fuzzy: "${cleanHome}" vs "${cleanAway}")`);

            const candidates = feed.events.filter(ev => {
                const pHome = ev.participants?.find(p => p.alignment === 'home')?.name || "";
                const pAway = ev.participants?.find(p => p.alignment === 'away')?.name || "";
                
                const matchHome = pHome.toLowerCase().includes(cleanHome.toLowerCase());
                const matchAway = pAway.toLowerCase().includes(cleanAway.toLowerCase());
                
                return matchHome || matchAway;
            });

            if (candidates.length > 0) {
                console.log(`   ✅ POSIBLE COINCIDENCIA EN PINNACLE:`);
                candidates.forEach(cand => {
                    const h = cand.participants?.find(p => p.alignment === 'home')?.name;
                    const a = cand.participants?.find(p => p.alignment === 'away')?.name;
                    console.log(`      - ID: ${cand.id} | ${h} vs ${a} (Inicio: ${cand.startTime})`);
                });
            } else {
                console.log(`   ❌ NO SE ENCONTRÓ NINGUNA COINCIDENCIA en el feed actual.`);
            }
        });

    } catch (e) {
        console.error("Error:", e.message);
    }
}

run();
