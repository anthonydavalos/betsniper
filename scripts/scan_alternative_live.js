
import { getLiveOverview, getEventDetails } from '../src/services/liveScannerService.js';
import fs from 'fs';

const TARGET_MARKETS = [
    { keywords: ['double', 'doble'], name: 'Double Chance' },
    { keywords: ['next goal', 'próximo gol', 'goal', 'gol'], name: 'Next Goal' }
];

const run = async () => {
    console.log("📡 Buscando mercados alternativos (Doble Oportunidad / Próximo Gol)...");
    
    try {
        const liveEvents = await getLiveOverview();
        console.log(`ℹ️ ${liveEvents.length} eventos en vivo encontrados.`);

        // Filtramos eventos de futbol (sportId 66 is usually soccer, or just check format)
        // Altenar mixed sports? Assuming soccer for now based on context.
        const soccerEvents = liveEvents.filter(e => e.sportId === 66); 

        for (const event of soccerEvents) {
            // Solo revisar si el partido está avanzado o interesante
            // if (event.liveTime...) 
            
            console.log(`\n⚽ Analizando: ${event.name} (${event.liveTime || 'Time?'})`);
            
            try {
                const details = await getEventDetails(event.id);
                if (!details || !details.markets) continue;

                // Crear mapa de odds
                const oddsMap = new Map();
                if (details.odds) details.odds.forEach(o => oddsMap.set(o.id, o));

                const interestingMarkets = details.markets.filter(m => {
                    const nameLower = m.name.toLowerCase();
                    return TARGET_MARKETS.some(tm => tm.keywords.some(k => nameLower.includes(k)));
                });

                if (interestingMarkets.length === 0) {
                    console.log("   ❌ Sin mercados de interés abiertos.");
                }

                for (const market of interestingMarkets) {
                    // Filtrar mercados irrelevantes que coincidan con "gol" (ej. "Total Goles")
                    // Queremos "Próximo Gol" o "Xº Gol" specifically if poss, but showing all matches allows user to decide
                    if (market.name.toLowerCase().includes("total")) continue; 

                    console.log(`   🛒 Mercado: [${market.name}] (ID: ${market.typeId})`);
                    
                    const oddIds = (market.desktopOddIds || []).flat();
                    const odds = oddIds.map(id => oddsMap.get(id)).filter(Boolean);

                    odds.forEach(o => {
                        console.log(`      🔹 ${o.name}: ${o.price}`);
                    });
                }

            } catch (err) {
                console.error(`   ⚠️ Error detalle: ${err.message}`);
            }
        }

    } catch (e) {
        console.error("Error general:", e);
    }
};

run();
