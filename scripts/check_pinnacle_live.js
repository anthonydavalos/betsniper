
import { getPinnacleLiveOdds } from '../src/services/pinnacleService.js';

const MATCH_ID = 1622710363;

const run = async () => {
    console.log(`📡 Consultando Pinnacle Live para ID: ${MATCH_ID}...`);
    try {
        const odds = await getPinnacleLiveOdds(MATCH_ID);
        if (!odds) {
            console.log("⚠️ No se encontraron datos en vivo para este evento.");
        } else {
            console.log("\n--- RESULTADOS PINNACLE LIVE ---");
            console.log(JSON.stringify(odds, null, 2));
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
};

run();
