import db, { initDB } from '../src/db/database.js';
import { scanPrematchOpportunities } from '../src/services/prematchScannerService.js';

// Nombre del equipo que vimos en Altenar
const TEST_TEAM = 'Huesca'; 

const runIntegrationTest = async () => {
  console.log('🧪 INICIANDO TEST DE INTEGRACIÓN: Value Bet Detection');
  
  // 1. Inicializar y Limpiar DB Mock
  await initDB();
  
  console.log(`📝 Inyectando partido MOCK en DB para equipo: ${TEST_TEAM}...`);
  
  // Guardamos un backup por si acaso (en memoria)
  const backupMatches = [...(db.data.upcomingMatches || [])];

  // Inyectamos un partido "trampa" donde Huesca es el super favorito según Pinnacle
  db.data.upcomingMatches = [{
    id: 999999,
    date: new Date().toISOString(),
    league: { name: 'Liga Smartbank MOCK', country: 'Spain' },
    home: TEST_TEAM, // Debe coincidir con Altenar "Huesca"
    away: 'Córdoba',
    pinnacleOdds: { home: 1.2, draw: 5.0, away: 10.0 }, // Pinnacle paga poco porque es muy favorito
    realProbabilities: {
      home: 85.0, // 85% Probabilidad Real de ganar (Super Value si Dorado paga > 1.2)
      draw: 10.0,
      away: 5.0
    },
    isAnalyzed: true
  }];
  
  await db.write();

  try {
    // 2. Ejecutar el Escáner Real
    console.log('🕵️ Ejecutando scanPrematchOpportunities()...');
    const opportunities = await scanPrematchOpportunities();

    // 3. Resultados
    console.log('\n📊 RESULTADOS DEL TEST:');
    if (opportunities.length > 0) {
      console.log(`✅ ¡ÉXITO! Se detectaron ${opportunities.length} Value Bets.`);
      opportunities.forEach((op, index) => {
        console.log(`   [${index+1}] ${op.match}`);
        console.log(`       Mercado: ${op.market}`);
        console.log(`       Cuota Altenar: ${op.odd}`);
        console.log(`       Prob. Real: ${op.realProb}%`);
        console.log(`       EV: ${op.ev.toFixed(2)}%`);
        console.log(`       Stake Kelly: $${op.stake.amount} (${op.stake.percentage.toFixed(2)}%)`);
      });
    } else {
      console.log('❌ FALLO: El escáner no detectó la oportunidad creada artificialmente.');
      console.log('Posibles causas: Nombre de equipo no coincide, cuota de Altenar muy baja, o lógica de EV.');
    }

  } catch (err) {
    console.error('❌ Error fatal en el test:', err);
  } finally {
    // 4. Restaurar DB (Opcional, pero buena práctica)
    // db.data.upcomingMatches = backupMatches;
    // await db.write();
    // console.log('\n🧹 DB Restaurada.');
  }
};

runIntegrationTest();
