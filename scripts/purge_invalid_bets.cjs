const fs = require('fs');
const path = require('path');

// RUTAS
const DB_PATH = path.join(__dirname, '../db.json');

// IDs ESPECÍFICOS A PURGAR (Añadir aquí si hay más conocidos)
const TARGET_IDS = [
    14120615, 15198387, 14838462, 14012464, 15226567, 
    15196454, 14012539, 14012517, 15237679, 15062219, 
    13365602, 14738969, 13834070, 15209079, 15004479, 
    13835233, 15004478, 13821409, 15027883, 15274141, 
    14012564, 14839292
];

function purgeInvalidBets() {
    console.log("🧹 Iniciando purga de apuestas inválidas...");

    if (!fs.existsSync(DB_PATH)) {
        console.error("❌ No se encontró db.json");
        process.exit(1);
    }

    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    
    // Validar estructura básica
    if (!db.portfolio) {
        console.error("❌ Estructura de portfolio no encontrada.");
        process.exit(1);
    }

    // Asegurar arrays
    const activeBets = db.portfolio.activeBets || [];
    const history = db.portfolio.history || [];
    // Algunos sistemas usan closedBets, revisar por si acaso
    const closedBets = db.portfolio.closedBets || []; // Si existe, la trataremos

    const upcomingMatches = db.upcomingMatches || [];
    
    // Crear mapa de eventos Linked IDs para verificación rápida
    // (Solo útil para activeBets, ya que los pasados no estarán aquí)
    const validLinkedIds = new Set(upcomingMatches.map(m => m.id)); // ID de Pinnacle o Altenar?
    // upcomingMatches usualmente tiene 'id' como AltenarID si es el primario, o 'altenarId'.
    // Verificaremos ambos.
    upcomingMatches.forEach(m => {
        if(m.id) validLinkedIds.add(m.id);
        if(m.altenarId) validLinkedIds.add(m.altenarId);
    });

    console.log(`📊 Estado Actual:`);
    console.log(`   - Active Bets: ${activeBets.length}`);
    console.log(`   - History Bets: ${history.length}`);
    console.log(`   - Linked matches: ${upcomingMatches.length}`);
    console.log(`   - Balance: ${db.portfolio.balance.toFixed(2)}`);

    let betsDeleted = 0;
    let moneyRefunded = 0; // Impacto en el balance

    // 1. LIMPIEZA DE ACTIVE BETS
    // Criterio: ID en TARGET_IDS O ID no presente en linked matches (Orphan)
    const newActiveBets = [];
    activeBets.forEach(bet => {
        const isTargeted = TARGET_IDS.includes(bet.eventId);
        // Si es orphan: es decir, el evento ya no está en la lista de macheos activos.
        // Cuidado: Podría ser un evento recién terminado que aún no se liquida.
        // Pero el usuario pidió borrar "huerfanas" de malas vinculaciones.
        // Asumiremos que si no está linkeado, y está activo, es sospechoso.
        // PERO para seguridad máxima, por ahora solo borraremos los TARGET_IDS y los Orphan MUY obvios si el filtro orphan se activa.
        
        // El usuario pidió "borrar apuestas asociadas a malas vinculaciones" y "huerfanas".
        // Si el linker rompió el enlace, el evento sale de upcomingMatches.
        // Así que orphan check es valido para activeBets.
        
        const isOrphan = !validLinkedIds.has(bet.eventId);

        if (isTargeted || isOrphan) {
            console.log(`🗑️ Eliminando Active Bet ID: ${bet.id} | EventID: ${bet.eventId} | Match: ${bet.match} | Razón: ${isTargeted ? 'Target List' : 'Orphan'}`);
            moneyRefunded += parseFloat(bet.stake);
            betsDeleted++;
        } else {
            newActiveBets.push(bet);
        }
    });

    // 2. LIMPIEZA DE HISTORY (Solo Target IDs)
    // No podemos usar Orphan check porque los eventos viejos legítimos tampoco están en upcomingMatches.
    const newHistory = [];
    history.forEach(bet => {
        if (TARGET_IDS.includes(bet.eventId)) {
            console.log(`🗑️ Eliminando History Bet ID: ${bet.id} | EventID: ${bet.eventId} | Match: ${bet.match} | Status: ${bet.status} | Profit: ${bet.profit}`);
            // Para revertir historia: Restamos el profit.
            // Si profit fue -10, balance = balance - (-10) = balance + 10.
            // Si profit fue +10, balance = balance - 10.
            moneyRefunded -= parseFloat(bet.profit || 0);
            betsDeleted++;
        } else {
            newHistory.push(bet);
        }
    });

    // 3. LIMPIEZA DE CLOSED BETS (Si existe)
    let newClosedBets = closedBets;
    if (closedBets.length > 0) {
        newClosedBets = [];
        closedBets.forEach(bet => {
             if (TARGET_IDS.includes(bet.eventId)) {
                console.log(`🗑️ Eliminando Closed Bet ID: ${bet.id} | EventID: ${bet.eventId}`);
                moneyRefunded -= parseFloat(bet.profit || 0);
                betsDeleted++;
            } else {
                newClosedBets.push(bet);
            }
        });
        db.portfolio.closedBets = newClosedBets;
    }

    // APLICAR CAMBIOS
    db.portfolio.activeBets = newActiveBets;
    db.portfolio.history = newHistory;
    
    const oldBalance = db.portfolio.balance;
    const newBalance = oldBalance + moneyRefunded;
    db.portfolio.balance = parseFloat(newBalance.toFixed(2));

    console.log(`\n✅ Resumen de Operación:`);
    console.log(`   - Apuestas eliminadas: ${betsDeleted}`);
    console.log(`   - Ajuste de Balance: ${moneyRefunded >= 0 ? '+' : ''}${moneyRefunded.toFixed(2)} (${oldBalance.toFixed(2)} -> ${newBalance.toFixed(2)})`);

    if (betsDeleted > 0) {
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        console.log("💾 Cambios guardados en db.json");
    } else {
        console.log("👍 No se encontraron apuestas para eliminar.");
    }
}

purgeInvalidBets();
