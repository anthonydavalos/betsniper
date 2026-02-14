
import altenarClient from '../src/config/axiosClient.js';
import fs from 'fs';

// Aumentar timeout para debug
altenarClient.defaults.timeout = 30000;

async function run() {
    console.log("🔍 Iniciando Escaneo de RAW Data Altenar...");
    try {
        console.log("📡 Solicitando GetLivenow...");
        const response = await altenarClient.get('/GetLivenow', {
            params: { 
                sportId: 66, 
                categoryId: 0,
                culture: "es-ES", // Probar cultura explicita
                _: Date.now()
            }
        });

        const events = response.data.events || [];
        console.log(`✅ Recibidos ${events.length} eventos.`);

        if (events.length === 0) {
            console.log("⚠️ Array de eventos vacío.");
            return;
        }

        // Dump de los primeros 5 eventos para inspeccion
        const dump = events.slice(0, 10).map(e => ({
            id: e.id,
            name: e.name || `${e.homeTeam?.name} vs ${e.awayTeam?.name}`,
            liveTime: e.liveTime,
            clock: e.clock,
            startDate: e.startDate,
            status: e.status || e.ls
        }));

        console.log("🔎 Muestra de datos (RAW):");
        console.log(JSON.stringify(dump, null, 2));

        // Guardar en archivo para analisis profundo
        fs.writeFileSync('debug_output_full.json', JSON.stringify(events, null, 2));
        console.log("💾 Dump completo guardado en debug_output_full.json");

    } catch (error) {
        console.error("❌ Error FATAL:", error.message);
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", error.response.data);
        }
    }
}

run();
