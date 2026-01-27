const axios = require('axios');
const { randomUUID } = require('crypto');

// ID del evento solicitado
const MATCH_ID = 1622710363;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'application/json',
    'Origin': 'https://www.pinnacle.com',
    'Referer': 'https://www.pinnacle.com/',
    // This API Key is standard for guest/public access on their arcadia gateway
    'X-API-Key': 'PINNACLE_API_KEY_PLACEHOLDER', 
    'X-Device-UUID': randomUUID()
};

// Trying a different endpoint: The specific matchup metadata endpoint
// Strategy: Check /matchups/{id} directly without /markets/...
const url = `https://guest.api.arcadia.pinnacle.com/0.1/matchups/${MATCH_ID}`;

console.log(`📡 Querying Pinnacle API: ${url}`);

const fs = require('fs');

async function run() {
    try {
        const { data } = await axios.get(url, { headers: HEADERS });
        
        console.log("✅ Response Received!");
        
        fs.writeFileSync('pinnacle_full_dump.json', JSON.stringify(data, null, 2));
        console.log("💾 Saved full dump to pinnacle_full_dump.json");

        // Inspect for Score/Time
        console.log("FULL DATA KEYS:", Object.keys(data));
        
        // Check commonly used fields for score on Pinnacle
        if (data.periods) {
             console.log("📜 PERIODS FOUND:");
             console.log(JSON.stringify(data.periods, null, 2));
        }

        const info = {
            id: data.id,
            status: data.type, // e.g., "live", "prematch"
            startTime: data.startTime,
            liveStatus: data.liveStatus, // Might contain time?
            participants: data.participants ? data.participants.map(p => ({name: p.name, id: p.id})) : [],
        };

        console.log("🔍 Extract:", JSON.stringify(info, null, 2));
        
        // If we still don't see score, it might be in a unrelated endpoint related to keeping the scoreboard logic.
        // But usually /matchups/{id} has everything.
        
    } catch (error) {
        console.error("❌ Error fetching data:");
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(error.message);
        }
    }
}

run();
