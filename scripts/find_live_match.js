
import { pinnacleClient } from '../src/config/pinnacleClient.js';

async function findLiveMatches() {
    console.log("🔍 Buscando partidos en vivo (Metadata + Cuotas) [Camaleón]...");

    try {
        // 1. Obtener METADATA (Nombres, Score, Tiempo)
        // Endpoint: /matchups/live
        const matchups = await pinnacleClient.get('/sports/29/matchups/live', { brandId: 0 });
        console.log(`✅ Metadata recibida: ${matchups.length} partidos.`);

        // 2. Obtener ODDS (Cuotas Globales)
        // Endpoint: /markets/live/straight
        const markets = await pinnacleClient.get('/sports/29/markets/live/straight', { primaryOnly: false, withSpecials: false });
        console.log(`✅ Mercados recibidos: ${markets.length} items.`);


        // 3. Cruzar informacion y mostrar 5 ejemplos
        const liveWithOdds = [];

        // DEBUG: Imprimir estructura RAW de un partido específico para encontrar el Score verdadero
        const debugMatchName = "Kapfenberger";
        const targetParentId = 1622601619; // ID Padre detectado previamente

        // Buscar por nombre O por ID explícito (Padre o Hijo)
        const debugMatches = matchups.filter(m => 
            m.participants.some(p => p.name.includes(debugMatchName)) || 
            m.id === targetParentId || 
            m.parentId === targetParentId
        );

        console.log(`\n🕵️ DEBUG: Encontrados ${debugMatches.length} objetos relacionados a '${debugMatchName}' (o ID ${targetParentId}):`);
        
        debugMatches.forEach(m => {
            const home = m.participants.find(p => p.alignment === 'home');
            const away = m.participants.find(p => p.alignment === 'away');
            console.log(`\n   🔸 ID: ${m.id} [Parent: ${m.parentId || 'ROOT'}]`);
            console.log(`      Type: ${m.type} | Units: ${m.units} | Mode: ${m.liveMode}`);
            console.log(`      Score: ${home?.state?.score}-${away?.state?.score} | Time: ${m.state?.minutes}' (Period: ${m.period})`);
            
            // Imprimir todo el objeto solo si es el ROOT para ver si ahí está el score real
            if (m.id === targetParentId) {
                 console.log("      🚨 ANALIZANDO PADRE (ROOT):");
                 console.log(JSON.stringify(m, null, 2));
            }
        });

        for (const m of matchups) {
            // 🛑 FILTRO CRÍTICO: Solo procesar unidades "Regular" (Match Winner)
            // Ignorar "Corners", "Yellow Cards", " 1st Half", etc. para evitar scores parciales/stale.
            if (m.units && m.units !== 'Regular') continue;

            // Filtrar solo los que estan In Running (period 1 o 2)
            // if (!(m.period === 1 || m.period === 2)) continue;

            // Buscar cuotas moneyline asociadas
            // Relaxed filter: type moneyline OR key s;0;m
            // Relaxed period: sometimes period 0 covers live match winner too
            const market = markets.find(mk => mk.matchupId === m.id && (mk.type === 'moneyline' || mk.key === 's;0;m'));
            
            if (market) {
                // Parsear estado (Score y Tiempo)
                // Correct Path: participants[].state.score
                const home = m.participants.find(p => p.alignment === 'home');
                const away = m.participants.find(p => p.alignment === 'away');
                const homeScore = home?.state?.score || 0;
                const awayScore = away?.state?.score || 0;

                // Correct Path: m.state.state (Phase) & m.state.minutes
                // 1=1st Half, 2=Halftime, 3=2nd Half
                const stateMap = { 1: '1T', 2: 'HT', 3: '2T' };
                const phase = stateMap[m.state?.state] || 'Live';
                const minutes = m.state?.minutes || 0;
                
                // Parsear cuotas
                const homePrice = market.prices.find(p => p.designation === 'home')?.price;
                const drawPrice = market.prices.find(p => p.designation === 'draw')?.price;
                const awayPrice = market.prices.find(p => p.designation === 'away')?.price;

                // Solo agregar si tiene cuotas
                if(homePrice) {
                    liveWithOdds.push({
                        id: m.id,
                        match: `${home?.name} vs ${away?.name}`,
                        score: `${homeScore} - ${awayScore}`,
                        time: `${phase} ${minutes}'`, 
                        odds: `1: ${homePrice} | X: ${drawPrice} | 2: ${awayPrice}`,
                        league: m.league?.name
                    });
                }
            }
        }

        console.log("\n⚽ EJEMPLOS DE PARTIDOS EN VIVO AHORA MISMO:\n");
        if(liveWithOdds.length === 0) {
            console.log("⚠️ No se encontraron partidos con cuotas activas (Match Winner) en este momento.");
            console.log("Probablemente solo hay tiempos de descanso o ligas menores sin mercado principal.");
        }

        // Mostrar los primeros 5
        liveWithOdds.slice(0, 10).forEach(live => {
            console.log(`🔹 [${live.id}] ${live.match}`);
            console.log(`   🏆 ${live.league}`);
            console.log(`   ⏱️ ${live.score} (${live.time})`);
            console.log(`   💰 Cuotas Americanas: ${live.odds}`);
            console.log("   ------------------------------------------------");
        });

    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

findLiveMatches();
