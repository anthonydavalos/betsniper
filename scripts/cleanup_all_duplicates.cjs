const fs = require('fs');

const DB_PATH = './db.json';

try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(data);

    // Función para generar clave única
    const getUniqueKey = (bet) => {
        const idPart = bet.eventId || bet.match;
        const selPart = bet.selection || bet.pick;
        const typePart = bet.type; 
        return `${idPart}|${selPart}|${typePart}`;
    };

    // 1. Recopilar claves del Historial para limpiar Activas Zombis
    const historyKeys = new Set();
    db.portfolio.history.forEach(h => historyKeys.add(getUniqueKey(h)));

    // 2. Limpiar Activas
    // A) Eliminar si ya está en historial (Bug de rebuy)
    const initialActiveCount = db.portfolio.activeBets.length;
    let newActiveBets = db.portfolio.activeBets.filter(bet => {
        const key = getUniqueKey(bet);
        return !historyKeys.has(key);
    });
    
    // B) Eliminar duplicados internos en Activas
    const activeSeen = new Set();
    newActiveBets = newActiveBets.filter(bet => {
        const key = getUniqueKey(bet);
        if (activeSeen.has(key)) return false;
        activeSeen.add(key);
        return true;
    });

    const finalActiveCount = newActiveBets.length;
    db.portfolio.activeBets = newActiveBets;

    // 3. Limpiar Historial (Dedup interno)
    const historySeen = new Set();
    const initialHistoryCount = db.portfolio.history.length;
    const newHistory = [];
    
    // Mantenemos solo la primera ocurrencia (presumiblemente la original)
    for (const bet of db.portfolio.history) {
        const key = getUniqueKey(bet);
        if (!historySeen.has(key)) {
            historySeen.add(key);
            newHistory.push(bet);
        }
    }
    
    db.portfolio.history = newHistory;
    const finalHistoryCount = newHistory.length;

    // 4. Recalcular Balance (Safety Check)
    // El balance estaba inflado por ganancias duplicadas. Lo reseteamos matemáticamente.
    let newBalance = db.portfolio.initialCapital || 1000;
    
    // Sumar PnL del historial limpio
    newHistory.forEach(h => {
        newBalance += (h.profit || 0);
    });
    
    // Restar Stakes de apuestas activas limpias (el dinero está "en la mesa")
    // OJO: En mi lógica de paperTrading, al crear la apuesta se resta balance.
    // Así que activeBets tienen balance -= stake. History ya tiene el resultado.
    // Debemos restar los stakes de las activas actuales al balance base+profits?
    // No, espera.
    // Balance = Capital Inicial + Suma(Profits Historial) - Suma(Stakes Activos)
    // Si profit es ganancia neta.
    // Si pierdo 10, profit es -10.
    // Si gano 10 (con stake 10 @ 2.0), profit es +10.
    
    // Correcto.
    newActiveBets.forEach(a => {
        newBalance -= (a.stake || 0);
    });

    console.log(`💰 Balance recalibrado: ${db.portfolio.balance.toFixed(2)} -> ${newBalance.toFixed(2)}`);
    db.portfolio.balance = newBalance;

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

    console.log(`🧹 REPORTE DE LIMPIEZA:`);
    console.log(`- Activas eliminadas (Duplicadas/Ya en Historial): ${initialActiveCount - finalActiveCount}`);
    console.log(`- Históricas eliminadas (Duplicadas): ${initialHistoryCount - finalHistoryCount}`);

} catch (e) {
    console.error("Error cleaning DB:", e);
}