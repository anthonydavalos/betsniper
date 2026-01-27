
import db from '../src/db/database.js';
import { getPinnacleLiveOdds } from '../src/services/pinnacleService.js';

const run = async () => {
    await db.read();
    
    // Buscar en todos los posibles lugares
    const allMatches = [
        ...(db.data.upcomingMatches || []),
        ...(db.data.liveMatches || [])
    ];

    const matchName = "Persis Solo";
    const match = allMatches.find(m => 
        (m.home && m.home.includes(matchName)) || 
        (m.away && m.away.includes(matchName)) ||
        (m.participants && m.participants.some(p => p.name.includes(matchName)))
    );

    if (!match) {
        console.log(`❌ No se encontró el partido '${matchName}' en la base de datos local (db.json).`);
        console.log("Probando búsqueda flexible...");
        // Intentar buscar en db.data directamente si structure difiere
        return;
    }

    console.log(`✅ Partido encontrado localmente: ${match.home} vs ${match.away} (ID: ${match.id})`);
    console.log(`   Fecha: ${match.date}, Liga: ${match.league?.name}`);

    console.log("\n📡 Consultando API Pinnacle en Vivo...");
    
    try {
        const odds = await getPinnacleLiveOdds(match.id);
        
        if (odds) {
            console.log("✅ Respuesta de Pinnacle recibida:");
            console.log(JSON.stringify(odds, null, 2));
        } else {
            console.log("⚠️ Pinnacle no retornó cuotas (null). El mercado podría estar cerrado o bloqueado.");
        }
    } catch (e) {
        console.error("❌ Error consultando Pinnacle:", e.message);
    }
};

run();
