
import axios from 'axios';
import { randomUUID } from 'crypto';

const API_KEY = 'PINNACLE_API_KEY_PLACEHOLDER';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'host': 'guest.api.arcadia.pinnacle.com',
    'X-API-Key': API_KEY,
};

const DEVICE_UUID = randomUUID();

// ID Persis Solo: 1622458226 (from previous turn)
const MATCH_ID = 1622458226; 

async function compareEndpoints() {
    console.log("🔍 Comparando Endpoints Pinnacle para ID:", MATCH_ID);
    
    const headers = { ...HEADERS, 'X-Device-UUID': DEVICE_UUID };

    // 1. RELATED (El que usamos actualmente)
    try {
        console.log("\n1. Consultando RELATED/STRAIGHT...");
        const t0 = Date.now();
        const urlRelated = `https://guest.api.arcadia.pinnacle.com/0.1/matchups/${MATCH_ID}/markets/related/straight`;
        const resRelated = await axios.get(urlRelated, { headers, validateStatus: false });
        console.log(`   Status: ${resRelated.status} | Tiempo: ${Date.now() - t0}ms`);
        
        if (resRelated.status === 200) {
            const ml = resRelated.data.find(m => m.period === 0 && (m.type === 'moneyline' || m.key === 's;0;m') && m.status === 'open');
            console.log("   [RELATED] 1x2:", ml ? JSON.stringify(ml.prices) : "No Moneyline Open");
        }
    } catch (e) { console.error(e.message); }

    // 2. MASSIVE LIVE (El que sugiere el usuario)
    try {
        console.log("\n2. Consultando MARKETS/LIVE/STRAIGHT (Global)...");
        const t1 = Date.now();
        // Sport 29 = Soccer
        const urlGlobal = `https://guest.api.arcadia.pinnacle.com/0.1/sports/29/markets/live/straight?primaryOnly=false&withSpecials=false`;
        const resGlobal = await axios.get(urlGlobal, { headers, validateStatus: false });
        console.log(`   Status: ${resGlobal.status} | Tiempo: ${Date.now() - t1}ms`);
        
        if (resGlobal.status === 200) {
            console.log(`   Total Mercados Recibidos: ${resGlobal.data.length}`);
            // Buscar el partido
            const matchMarkets = resGlobal.data.filter(m => m.matchupId === MATCH_ID);
            console.log(`   Mercados encontrados para este partido: ${matchMarkets.length}`);
            
            const ml = matchMarkets.find(m => m.period === 0 && (m.type === 'moneyline' || m.key === 's;0;m'));
            console.log("   [GLOBAL] 1x2:", ml ? JSON.stringify(ml.prices) : "No Moneyline Open");
        }
    } catch (e) { console.error(e.message); }

}

compareEndpoints();
