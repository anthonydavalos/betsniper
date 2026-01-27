
import axios from 'axios';

const MATCH_ID = 1622710363;

const run = async () => {
    // URL base recuperada de pinnacleService.js
    const url = `https://guest.api.arcadia.pinnacle.com/0.1/sports/29/markets?eventIds=${MATCH_ID}&isPrimary=false`;
    
    console.log(`📡 Fetching RAW Pinnacle data from: ${url}`);

    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        // Imprimimos una estructura resumida para no inundar la terminal, 
        // pero buscando pistas de 'score', 'period', 'elapsed'.
        const firstLeague = data.leagues ? data.leagues[0] : null;
        
        if (firstLeague && firstLeague.events) {
            const ev = firstLeague.events[0];
            console.log("\n--- EVENT DATA ---");
            console.log("ID:", ev.id);
            console.log("Status:", ev.status); // ej. 1 = live?
            console.log("Live Status:", ev.liveStatus); 
            console.log("Parent ID:", ev.parentId);
            console.log("Period:", ev.period); 
            console.log("Score:", ev.score); // A veces viene aquí
            
            // Si hay 'periods' detallados
            if (ev.periods) {
                console.log("Periods Info:", JSON.stringify(ev.periods, null, 2));
            }
        } else {
            console.log("Estructura de ligas/eventos no encontrada. Imprimiendo root keys:");
            console.log(Object.keys(data));
        }

        console.log("\n--- FULL FILTERED DUMP (Uncomment to see) ---");
        // console.log(JSON.stringify(data, null, 2));

    } catch (error) {
        console.error("❌ AXIOS ERROR:", error.message);
        if (error.response) {
             console.log("Status:", error.response.status);
             console.log("Data:", error.response.data);
        }
    }
};

run();
