import { scanLiveOpportunities } from '../src/services/liveScannerService.js';

const run = async () => {
    console.log("🟢 INICIANDO LIVE SNIPER (Intervalo: 60s)...");
    
    const loop = async () => {
        const opportunities = await scanLiveOpportunities();

        if (opportunities.length > 0) {
            console.log("\n🔥 OPORTUNIDADES EN VIVO DETECTADAS 🔥");
            console.table(opportunities);
            // Aquí iría la integración con notificaciones (Telegram/Frontend)
        } else {
            // console.log("   (Sin oportunidades por ahora...)");
        }
    };

    // Ejecutar inmediatamente y luego intervalar
    await loop();
    
    setInterval(async () => {
        await loop();
    }, 60000); // Cada 60 segundos
};

run();
