const axios = require('axios');
const fs = require('fs');
const { randomUUID } = require('crypto');

const MATCH_ID = 1622710363;
const API_KEY = 'PINNACLE_API_KEY_PLACEHOLDER'; // The real key

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'host': 'guest.api.arcadia.pinnacle.com',
    'X-API-Key': API_KEY,
    'X-Device-UUID': randomUUID()
};

// ORIGINAL ENDPOINT used in service
const url = `https://guest.api.arcadia.pinnacle.com/0.1/matchups/${MATCH_ID}/markets/related/straight`;

async function run() {
    try {
        console.log(`📡 Querying: ${url}`);
        const { data } = await axios.get(url, { headers: HEADERS });
        
        fs.writeFileSync('pinnacle_markets_dump.json', JSON.stringify(data, null, 2));
        console.log("💾 Saved markets dump.");
        
        // --- EXTRAER CUOTAS VISIBLES ---
        function americanToDecimal(american) {
            if (!american) return 0;
            if (american > 0) return (american / 100) + 1;
            return (100 / Math.abs(american)) + 1;
        }

        const ml = data.find(m => m.key === 's;0;m');
        if (ml) {
            console.log("\n💰 --- CUOTAS ACTUALES (Moneyline) ---");
            ml.prices.forEach(p => {
                const decimal = americanToDecimal(p.price).toFixed(2);
                console.log(`   🔸 ${p.designation.toUpperCase()}: ${decimal} (American: ${p.price})`);
            });
            console.log("---------------------------------------");
        } else {
            console.log("⚠️ No se encontró mercado Moneyline (s;0;m)");
        }

        if (Array.isArray(data)) {
            console.log("Response is an Array of length:", data.length);
            console.log("Sample Keys:", Object.keys(data[0]));
        } else {
             console.log("Response is Object. Keys:", Object.keys(data));
        }

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

run();
