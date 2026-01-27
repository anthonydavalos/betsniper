import altenarClient from '../src/config/axiosClient.js';

const debugLiveEvent = async () => {
    console.log("🔍 Buscando evento 'Boavista' o ID 14738504 en feed En Vivo...");
    
    try {
        // Usamos la misma llamada que en liveScannerService (sin limite, tras el fix)
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { sportId: 66, categoryId: 0 }
        });

        const events = data.events || [];
        console.log(`📡 Total Eventos en Vivo Recibidos: ${events.length}`);

        const targetId = 14738504;
        const targetName = "Boavista";

        const matchById = events.find(e => e.id === targetId);
        const matchByName = events.find(e => e.name.includes(targetName) || e.homeTeam?.name?.includes(targetName));

        if (matchById) {
            console.log("\n✅ ¡ENCONTRADO POR ID!");
            console.log(JSON.stringify(matchById, null, 2));
        } else {
            console.log("\n❌ NO encontrado por ID exacto.");
        }

        if (matchByName && matchByName.id !== targetId) {
            console.log("\n⚠️ ¡ENCONTRADO POR NOMBRE (ID DIFERENTE)!");
            console.log(JSON.stringify(matchByName, null, 2));
        }

    } catch (error) {
        console.error("Error fetching live data:", error.message);
    }
};

debugLiveEvent();