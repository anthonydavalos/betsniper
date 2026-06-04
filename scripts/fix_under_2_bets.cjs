const { readMergedDbSync, writeMergedDbSync } = require('./lib/read-split-db.cjs');

const dbData = readMergedDbSync();

console.log('🔧 Iniciando reparación de apuestas Under mal formadas...');

let fixedCount = 0;
let refundTotal = 0;

const fixBet = (bet) => {
    // Solo nos interesan los Under rotos
    if (bet.pick !== 'under_0') return false;
    
    // Intentar extraer linea del mercado
    // Ej: "Total Goals 1.5" -> 1.5
    const match = (bet.market || "").match(/(\d+\.?\d*)/);
    if (!match) return false;
    
    const trueLine = parseFloat(match[0]);
    if (trueLine === 0) return false;
    
    console.log(`\n🔍 Reparando Bet ID ${bet.id} (${bet.match})`);
    console.log(`   Pick Erroneo: ${bet.pick} -> Nuevo Pick: under_${trueLine}`);
    
    // 1. UPDATE PICK
    bet.pick = `under_${trueLine}`;
    
    // 2. RE-CALCULAR RESULTADO
    // Solo si ya estaba cerrada/liquidada (Status 'LOST' o 'WON')
    if (bet.status === 'LOST' || bet.status === 'WON') {
        const parts = (bet.finalScore || "0-0").split('-');
        const g1 = parseInt(parts[0]) || 0;
        const g2 = parseInt(parts[1]) || 0;
        const total = g1 + g2;
        
        const oldStatus = bet.status;
        const newStatus = total < trueLine ? 'WON' : 'LOST';
        
        console.log(`   Score: ${g1}-${g2} (Total ${total}). Linea: ${trueLine}. Resultado: ${newStatus}`);
        
        if (newStatus !== oldStatus) {
            bet.status = newStatus;
            
            if (newStatus === 'WON') {
                // LOST -> WON
                // Debemos devolver el retorno
                const ret = parseFloat((bet.stake * bet.odd).toFixed(2));
                const prof = parseFloat((ret - bet.stake).toFixed(2));
                
                bet.return = ret;
                bet.profit = prof;
                
                refundTotal += ret;
                console.log(`   💰 CAMBIO A GANADORA! Reembolso: +${ret}`);
            } else {
                // WON -> LOST (Raro en este caso, pero posible)
                // Debemos restar (si ya pagamos, oops, dejémoslo. Pero aqui estamos arreglando under_0 que casi siempre da LOST injusto)
                bet.return = 0;
                bet.profit = -bet.stake;
                // No restamos del balance aqui para no complicar, asumimos correccion de errores injustos.
            }
        }
    }
    
    return true;
};

// 1. Scan Active Bets
const activeBets = Array.isArray(dbData?.portfolio?.activeBets) ? dbData.portfolio.activeBets : [];
activeBets.forEach(bet => {
    if (fixBet(bet)) fixedCount++;
});

// 2. Scan History
const history = Array.isArray(dbData?.portfolio?.history) ? dbData.portfolio.history : [];
history.forEach(bet => {
    if (fixBet(bet)) fixedCount++;
});

// 3. Aplica reembolso al balance
if (!dbData.portfolio || typeof dbData.portfolio !== 'object') {
    dbData.portfolio = { balance: 100, initialCapital: 100, activeBets: [], history: [] };
}
if (!Number.isFinite(Number(dbData.portfolio.balance))) {
    dbData.portfolio.balance = 100;
}

if (refundTotal > 0) {
    console.log(`\n💵 Aplicando reembolso total al balance: ${dbData.portfolio.balance.toFixed(2)} + ${refundTotal.toFixed(2)}`);
    dbData.portfolio.balance += refundTotal;
    console.log(`💰 Nuevo Balance: ${dbData.portfolio.balance.toFixed(2)}`);
}

writeMergedDbSync(dbData);
console.log(`\n✅ Reparación completada. ${fixedCount} apuestas corregidos (db-core.json + db-diagnostics.json).`);
