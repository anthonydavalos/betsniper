import db, { initDB } from '../src/db/database.js';

const migrateBankroll = async () => {
    console.log("💰 Iniciando migración de Bankroll a 10,000...");
    await initDB();

    const portfolio = db.data.portfolio;
    const oldCapital = portfolio.initialCapital || 1000;
    const newCapital = 10000;
    
    // Si ya es 10000, quizás quiera resetear o arreglar, pero asumiremos factor x10 si era 1000
    // Si era diferente, calculamos factor.
    let factor = 1;
    if (oldCapital !== newCapital) {
        factor = newCapital / oldCapital;
        console.log(`   Factor de multiplicación detectado: x${factor} (De ${oldCapital} a ${newCapital})`);
    } else {
        console.log("   El capital ya es 10,000. Solo recalculando balance por seguridad.");
    }

    // 1. Actualizar Historia
    portfolio.history.forEach(bet => {
        // Solo multiplicamos si no parece que ya fue migrada (check sanity)
        // Pero asumimos confianza en el factor.
        bet.stake = bet.stake * factor;
        bet.profit = bet.profit * factor;
        if (bet.return) bet.return = bet.return * factor;
    });
    console.log(`   Historial actualizado (${portfolio.history.length} bets).`);

    // 2. Actualizar Activas
    portfolio.activeBets.forEach(bet => {
        bet.stake = bet.stake * factor;
    });
    console.log(`   Apuestas Activas actualizadas (${portfolio.activeBets.length} bets).`);

    // 3. Actualizar Capital Inicial
    portfolio.initialCapital = newCapital;
    
    // 4. Recalcular Balance
    // Formula: Balance = Inicial + Sum(History Profits) - Sum(Active Stakes)
    const totalHistoryProfit = portfolio.history.reduce((sum, b) => sum + (b.profit || 0), 0);
    const totalActiveStakes = portfolio.activeBets.reduce((sum, b) => sum + (b.stake || 0), 0);
    
    const recalculatedBalance = newCapital + totalHistoryProfit - totalActiveStakes;
    
    console.log(`   --------------------------------`);
    console.log(`   Capital Inicial:      ${newCapital.toFixed(2)}`);
    console.log(`   PnL Histórico:        ${totalHistoryProfit >= 0 ? '+' : ''}${totalHistoryProfit.toFixed(2)}`);
    console.log(`   Stakes en Juego:     -${totalActiveStakes.toFixed(2)}`);
    console.log(`   --------------------------------`);
    console.log(`   Nuevo Balance:        ${recalculatedBalance.toFixed(2)}`);

    portfolio.balance = recalculatedBalance;

    // Actualizar config global si existe
    if (!db.data.config) db.data.config = {};
    db.data.config.bankroll = calculatedBalance(portfolio.balance); // Update config bankroll to match real balance? 
    // Usually config.bankroll is the "starting" or "reference" for some calcs if not using portfolio.balance.
    // Let's set it to current balance.
    db.data.config.bankroll = recalculatedBalance;

    await db.write();
    console.log("✅ Migración Completada Exitosamente.");
};

// Helper simple para evitar NaN en config
const calculatedBalance = (val) => isNaN(val) ? 10000 : val;

migrateBankroll();
