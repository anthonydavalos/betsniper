import { pinnacleClient } from '../src/config/pinnacleClient.js';
import { americanToDecimal } from '../src/utils/oddsConverter.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function checkLiveOdds() {
    console.log("🔍 Consultando partido ESPECÍFICO por ID (RÁFAGA DE 3)...");
    
    // ID obtenido de la URL del usuario
    const TARGET_MATCH_ID = 1623888597;

    for (let i = 1; i <= 3; i++) {
        try {
            console.log(`\n--- INTENTO ${i} ---`);

            // 0. Fetch Match Metadata (Tiempo/Score)
            try {
                const matchMeta = await pinnacleClient.get(`/matchups/${TARGET_MATCH_ID}`);
                if (matchMeta) {
                     const home = matchMeta.participants.find(p => p.alignment === 'home');
                     const away = matchMeta.participants.find(p => p.alignment === 'away');
                     
                     // Mapeo de Estados Pinnacle: 1=1st Half, 2=Halftime, 3=2nd Half, 4=ET, etc.
                     const stateMap = { 1: '1T', 2: 'HT', 3: '2T', 4: 'ET', 5: 'Pks' };
                     const periodCurrent = stateMap[matchMeta.state?.state] || `Period ${matchMeta.state?.state}`;
                     const minutes = matchMeta.state?.minutes || 0;

                     console.log(`⏱️  TIEMPO: ${periodCurrent} - ${minutes}'`);
                     console.log(`⚽ SCORE: ${home?.name} (${home?.state?.score}) - (${away?.state?.score}) ${away?.name}`);
                }
            } catch (metaError) {
                console.log("⚠️ No se pudo obtener metadata de tiempo/score (Endpoint directo falló).");
            }

            const markets = await pinnacleClient.get(`/matchups/${TARGET_MATCH_ID}/markets/related/straight`);
            
            if (!markets || markets.length === 0) {
                console.log("⚠️ Sin mercados.");
            } else {
                console.log("✅ Mercados recibidos:");
            console.log(`🕒 Server Date: ${new Date().toISOString()}`); // Hora local nuestra
            // Intentar mostrar si hay algun timestamp en la respuesta
            
            const formatPrice = (p) => {
                const dec = americanToDecimal(p.price);
                return `Dec: ${dec.toFixed(2)} (Am: ${p.price})`;
            };

            // Filtrar y mostrar TODOS los moneylines disponibles (Period 0 = Full Time, 1 = 1st Half, etc)
            const moneylines = markets.filter(m => m.type === 'moneyline');
            if (moneylines.length > 0) {
                moneylines.forEach(ml => {
                    console.log(`💰 1x2 [Period: ${ml.period}] [Key: ${ml.key}] [Cutoff: ${ml.cutoffAt}] (Status: ${ml.status}):`);
                    ml.prices.forEach(p => console.log(`   - ${p.designation}: ${formatPrice(p)}`));
                });
            } else {
                console.log("⚠️ No Moneyline markets found.");
            }

            // Mostrar Totales y Handicaps para contexto
            const spread = markets.find(m => m.type === 'spread' && m.period === 0);
            if (spread) {
                console.log(`⚖️ Handicap [Period: 0] (Status: ${spread.status}):`);
                    spread.prices.forEach(p => console.log(`   - ${p.designation} (${p.points}): ${formatPrice(p)}`));
                }

                const total = markets.find(m => m.type === 'total');
                if (total) {
                    console.log(`🔢 Over/Under (Status: ${total.status}):`);
                    total.prices.forEach(p => console.log(`   - ${p.designation} (${p.points}): ${formatPrice(p)}`));
                }
            }
            
        } catch (error) {
            console.error("❌ Error:", error.message);
        }
        
        if (i < 3) await sleep(1500); // Esperar 1.5s entre intentos
    }
}

checkLiveOdds();