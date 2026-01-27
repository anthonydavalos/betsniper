const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../db.json');
const reportPath = path.join(__dirname, '../reporte_completo_partidos.csv');

try {
    console.log("Leyendo base de datos...");
    const rawData = fs.readFileSync(dbPath, 'utf8');
    const db = JSON.parse(rawData);

    const upcomingMatches = db.upcomingMatches || [];
    const altenarMatches = db.altenarUpcoming || [];

    // Mapas para búsqueda rápida
    const altenarMap = new Map();
    altenarMatches.forEach(a => altenarMap.set(String(a.id), a));
    
    // Set para rastrear qué partidos de Altenar ya fueron enlazados
    const linkedAltenarIds = new Set();
    const linkedArcadiaIds = new Set();

    let csvContent = '\uFEFFArcadia ID;Arcadia Evento;Liga;Arcadia Home ID;Arcadia Away ID;Arcadia Fecha;Altenar ID;Altenar Evento;Altenar Home ID;Altenar Away ID;Altenar Fecha;Estado Enlace\n';

    // Función auxiliar para limpiar texto CSV
    const safe = (str) => String(str || "").replace(/;/g, ",").replace(/\n/g, " ").trim();
    
    // 1. Procesar partidos de Arcadia (Pinnacle)
    upcomingMatches.forEach(match => {
        // Datos Arcadia
        const arcId = match.id;
        const arcEvent = `${match.home} vs ${match.away}`;
        const arcLeague = match.league ? match.league.name : "N/A";
        
        // Estrategia de IDs: Buscar en top-level primero, luego en participants si existe
        let arcHomeId = match.homeId || "N/A";
        let arcAwayId = match.awayId || "N/A";
        
        if (arcHomeId === "N/A" && match.participants) {
            const homeP = match.participants.find(p => p.alignment === 'home');
            if (homeP) arcHomeId = homeP.id;
        }
        if (arcAwayId === "N/A" && match.participants) {
            const awayP = match.participants.find(p => p.alignment === 'away');
            if (awayP) arcAwayId = awayP.id;
        }

        const arcDate = match.starts || match.startDate || match.date || "N/A";

        // Datos Altenar
        let altId = "N/A";
        let altEvent = "N/A";
        let altHomeId = "N/A";
        let altAwayId = "N/A";
        let altDate = "N/A";
        let linkStatus = "Huérfano (Arcadia)";

        // Verificar enlace
        if (match.altenarId) {
            altId = match.altenarId; // ID guardado en DB
            linkedAltenarIds.add(String(altId));
            
            // Buscar datos frescos en feed Altenar
            const altMatch = altenarMap.get(String(match.altenarId));
            
            if (altMatch) {
                // Enlace confirmado con datos frescos
                linkStatus = "Enlazado";
                altEvent = altMatch.name || (altMatch.home ? `${altMatch.home} vs ${altMatch.away}` : "N/A");
                altDate = altMatch.startDate;
                if (altMatch.competitors && altMatch.competitors.length >= 2) {
                    altHomeId = altMatch.competitors[0];
                    altAwayId = altMatch.competitors[1];
                }
            } else {
                // Enlace existe en DB pero Altenar ha borrado el evento del feed inmediato
                linkStatus = "Enlazado (Altenar Cache)";
                if (match.altenarName) altEvent = match.altenarName; 
                else altEvent = "(Datos no disponibles)";
            }
        }

        csvContent += `${safe(arcId)};${safe(arcEvent)};${safe(arcLeague)};${safe(arcHomeId)};${safe(arcAwayId)};${safe(arcDate)};${safe(altId)};${safe(altEvent)};${safe(altHomeId)};${safe(altAwayId)};${safe(altDate)};${safe(linkStatus)}\n`;
    });

    // 2. Procesar partidos de Altenar que NO fueron enlazados (Huérfanos de Altenar)
    altenarMatches.forEach(altMatch => {
        if (!linkedAltenarIds.has(String(altMatch.id))) {
            // Datos Arcadia (Vacios)
            const arcId = "";
            const arcEvent = "";
            const arcLeague = "";
            const arcHomeId = "";
            const arcAwayId = "";
            const arcDate = "";

            // Datos Altenar
            const altId = altMatch.id;
            const altEvent = altMatch.name || (altMatch.home ? `${altMatch.home} vs ${altMatch.away}` : "N/A");
            const altDate = altMatch.startDate;
            
            let altHomeId = "N/A";
            let altAwayId = "N/A";
            if (altMatch.competitors && altMatch.competitors.length >= 2) {
                altHomeId = altMatch.competitors[0];
                altAwayId = altMatch.competitors[1];
            }

            const linkStatus = "Huérfano (Altenar)";

            csvContent += `${safe(arcId)};${safe(arcEvent)};${safe(arcLeague)};${safe(arcHomeId)};${safe(arcAwayId)};${safe(arcDate)};${safe(altId)};${safe(altEvent)};${safe(altHomeId)};${safe(altAwayId)};${safe(altDate)};${safe(linkStatus)}\n`;
        }
    });

    fs.writeFileSync(reportPath, csvContent);
    console.log(`Reporte completo generado en: ${reportPath}`);
    console.log(`Total Arcadia: ${upcomingMatches.length}`);
    console.log(`Total Altenar: ${altenarMatches.length}`);
    console.log(`Links encontrados: ${linkedAltenarIds.size}`);

} catch (error) {
    console.error("Error generando reporte:", error);
}
