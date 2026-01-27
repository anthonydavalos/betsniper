import { scanPrematchOpportunities } from '../src/services/prematchScannerService.js';
import db, { initDB } from '../src/db/database.js';

const run = async () => {
    await initDB();
    const opportunities = await scanPrematchOpportunities();
    
    if (opportunities.length > 0) {
        console.log(`\n📢 DETECTADAS: ${opportunities.length} OPORTUNIDADES (PRE-MATCH) - Escaneo Completo`);
        console.table(opportunities.map(op => ({
            Match: op.match,
            Market: op.market,
            Odd: op.odd,
            RealProb: op.realProb.toFixed(1) + '%',
            EV: op.ev.toFixed(1) + '%',
            Bankroll: '$' + op.kellyStake.toFixed(2)
        })));
    } else {
        console.log("\n⚠️ No se encontraron oportunidades nuevas en este escaneo.");
    }

    // Mostrar estado actual de la DB
    await db.read();
    const active = db.data.portfolio.activeBets || [];
    const balance = db.data.portfolio.balance;

    console.log(`\n💰 ESTADO ACTUAL DE LA BASE DE DATOS (db.json):`);
    console.log(`   - Balance: $${balance.toFixed(2)}`);
    console.log(`   - Apuestas Activas: ${active.length}`);
    
    if (active.length > 0) {
        console.table(active.map(b => ({
            ID: b.id.substring(0,8) + '...',
            Match: b.match,
            Pick: b.selection,
            Stake: '$' + b.stake,
            Status: b.status
        })));
    } else {
        console.log("   (No hay apuestas colocadas aun. Ejecuta 'npm start' para activar el Auto-Bet)");
    }
};

run();