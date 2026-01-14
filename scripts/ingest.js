import db, { initDB } from '../src/db/database.js';
import apiSportsHelper from '../src/services/apiSportsService.js';
import { calculateFairProbabilities } from '../src/utils/mathUtils.js';

// Helper para delay
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fecha helper (YYYY-MM-DD)
const getDateString = (daysOffset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().split('T')[0];
};

const ingestData = async () => {
  console.log('🚀 INICIANDO PROCESO DE INGESTA (API-SPORTS)...');
  await initDB();

  // 1. Verificar Cuota
  const status = await apiSportsHelper.getQuotaStatus();
  
  let requestBalance = 90; // Valor seguro por defecto
  // Actualizar saldo real si tenemos info
  if (status && status.response && status.response.requests) {
      requestBalance = status.response.requests.limit_day - status.response.requests.current;
      console.log(`💰 Saldo API disponible: ~${requestBalance} llamadas.`);
  }

  // 2. Definir fechas (Hoy y Mañana)
  const dates = [getDateString(0), getDateString(1)];
  const allEnrichedMatches = [];

  for (const date of dates) {
    if (requestBalance < 3) {
        console.warn('⛔ Saldo API crítico. Deteniendo procesamiento de fechas.');
        break;
    }

    console.log(`\n📅 Procesando fecha: ${date}`);
    
    // 2.1 Obtener Fixtures (Partidos)
    const fixtures = await apiSportsHelper.getFixturesByDate(date);
    requestBalance--; 
    console.log(`   ✅ Fixtures encontrados: ${fixtures.length}`);

    if (fixtures.length === 0) continue;

    // 2.2 ESTRATEGIA GLOBAL (FREE PLAN): Pedir Odds Globales (Limitado a 3 páginas)
    // apiSportsHelper manejará la paginación y parará suavemente en la página 3.
    const oddsData = await apiSportsHelper.getPinnacleOddsByDate(date);
    console.log(`   ✅ Odds (Pinnacle) encontrados: ${oddsData.length} bloques`);

    /*
    // ESTRATEGIA OPTIMIZADA (FREE PLAN): Odds POR LIGA + THROTTLING - DESACTIVADA
    // Razón: El plan gratuito bloquea el acceso a "current season" cuando se pide por liga específica.
    
    // Agrupar IDs de Ligas, contar partidos y capturar SEASON
    const leaguesInfo = new Map();
    // ... codigo removido para limpieza ...
    */

    console.log(`   ✅ Odds (Pinnacle) recolectados: ${oddsData.length} bloques totales.`);

    // 2.3 Cruzar Data (Fixture + Odds)
    console.log('   🔄 Cruzando datos y calculando Fair Odds...');
    
    // Crear mapa de odds para acceso rápido O(1)
    const oddsMap = new Map();
    oddsData.forEach(item => {
      // API Sports devuelve: { fixture: { id: ... }, bookmakers: [...] }
      // Filtramos pinnacle (ya debería venir filtrado por endpoint, pero validamos)
      const pinnacle = item.bookmakers.find(b => b.id === 4); // 4 = Pinnacle
      if (pinnacle && pinnacle.bets) {
        // Buscamos apuesta "Match Winner" (id: 1)
        const matchWinnerBet = pinnacle.bets.find(bet => bet.id === 1);
        if (matchWinnerBet) {
          oddsMap.set(item.fixture.id, matchWinnerBet.values);
        }
      }
    });

    // Procesar cada fixture
    fixtures.forEach(item => {
      const fixtureId = item.fixture.id;
      const rawOdds = oddsMap.get(fixtureId);

      // Solo nos sirven partidos que tengan cuota en Pinnacle
      if (rawOdds) {
        // Formatear Odds { "1": 1.5, "X": 3.0, "2": 5.0 }
        // API Sports Values: [ { value: "Home", odd: 1.5 }, { value: "Draw", odd: 3.0 }, { value: "Away", odd: 5.0 } ]
        
        const homeObj = rawOdds.find(o => o.value === 'Home');
        const drawObj = rawOdds.find(o => o.value === 'Draw');
        const awayObj = rawOdds.find(o => o.value === 'Away');

        if (homeObj && drawObj && awayObj) {
          const pinnacleOdds = {
            home: parseFloat(homeObj.odd),
            draw: parseFloat(drawObj.odd),
            away: parseFloat(awayObj.odd)
          };

          // MATEMÁTICA PURA: Calcular Probabilidad Real (Fair Odds)
          const realProbabilities = calculateFairProbabilities(pinnacleOdds);

          // Construir objeto optimizado para DB
          allEnrichedMatches.push({
            id: fixtureId, // ID único de API-Sports
            date: item.fixture.date,
            timestamp: item.fixture.timestamp,
            league: {
              id: item.league.id,
              name: item.league.name,
              country: item.league.country
            },
            home: item.teams.home.name,
            away: item.teams.away.name,
            pinnacleOdds: pinnacleOdds,
            realProbabilities: realProbabilities, // { home: 45.5, draw: 25.0, away: 29.5 }
            isAnalyzed: true,
            lastUpdated: new Date().toISOString()
          });
        }
      }
    });
  }

  // 3. Guardar en Base de Datos
  console.log(`\n💾 Guardando ${allEnrichedMatches.length} partidos analizados en DB...`);
  
  // Reemplazamos la lista de upcomingMatches (o podríamos hacer upsert/merge)
  // Estrategia simple: Reemplazo fresco para evitar partidos viejos.
  db.data.upcomingMatches = allEnrichedMatches;
  db.data.lastIngestionV3 = new Date().toISOString();
  await db.write();

  console.log('✅ PROCESO DE INGESTA FINALIZADO CON ÉXITO.');
};

ingestData();
