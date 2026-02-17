
import { getEventResult } from '../src/services/liveScannerService.js';

const run = async () => {
    // FECHA CORRECTA: 16 FEB (Ayer)
    // El partido fue "Gimnasia vs. Ferrocarril Midland". CatID: 574.
    const dateISO = "2026-02-16T00:00:00.000Z";
    const catId = 574;  
    
    console.log(`🔍 Buscando Resultados en Cat ${catId} para fecha ${dateISO}...`);
    
    const res = await getEventResult(66, catId, dateISO);
    
    if (res && res.events) {
        console.log(`\n✅ ${res.events.length} Eventos encontrados:`);
        res.events.forEach(e => {
            const scoreStr = (e.score && e.score.length >= 2) ? `${e.score[0]}-${e.score[1]}` : '?-?';
            console.log(` - ID:${e.id} | ${e.name.padEnd(40)} | Score: ${scoreStr} | Status: ${e.statusName}`);
            
            if (e.name.includes("Gimn") || e.name.toLowerCase().includes("midland")) {
                 console.log("   📍 [TARGET] Este es el partido en cuestión.");
            }
        });
    } else {
        console.log("❌ No events found in 574 for that date.");
    }
};

run();
