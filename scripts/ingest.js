import db, { initDB } from '../src/db/database.js';
import apiSportsHelper from '../src/services/apiSportsService.js';
import { calculateFairProbabilities } from '../src/utils/mathUtils.js';

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
  if (status) {
    const { current, limit } = status.response.requests;
    console.log(`📊 Estado de Cuota API: ${current}/${limit} llamadas usadas hoy.`);
    if (current >= limit) {
      console.error('⛔ Límite de API alcanzado. Abortando ingesta.');
      return;
    }
  }

  // 2. Definir fechas (Hoy y Mañana)
  const dates = [getDateString(0), getDateString(1)];
  const allEnrichedMatches = [];

  for (const date of dates) {
    console.log(`\n📅 Procesando fecha: ${date}`);
    
    // 2.1 Obtener Fixtures (Partidos)
    // Esto trae toda la metadata: Nombres de equipos, liga, hora exacta.
    const fixtures = await apiSportsHelper.getFixturesByDate(date);
    console.log(`   ✅ Fixtures encontrados: ${fixtures.length}`);

    if (fixtures.length === 0) continue;

    // 2.2 Obtener Pinnacle Odds
    // Esto trae las cuotas de valor.
    const oddsData = await apiSportsHelper.getPinnacleOddsByDate(date);
    console.log(`   ✅ Odds (Pinnacle) encontrados: ${oddsData.length} bloques`);

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
