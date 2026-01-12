import altenarClient from '../config/axiosClient.js';
import db from '../db/database.js';
import { isSameTeam } from '../utils/teamNormalizer.js';
import { calculateEV, calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: PRE-MATCH VALUE SCANNER
// =====================================================================

/**
 * Escanea los próximos partidos en Altenar (GetUpcoming) y los cruza
 * con nuestras Probabilidades Reales (Pinnacle) almacenadas en DB.
 */
export const scanPrematchOpportunities = async () => {
    try {
        console.log(`\n📡 [Pre-Match Scanner] Buscando Value Bets en futuros eventos...`);

        // 1. Obtener Próximos Partidos de Altenar
        // Pedimos un bloque grande para maximizar coincidencias
        const response = await altenarClient.get('/GetUpcoming', {
            params: { eventCount: 100, sportId: 66 } 
        });

        const upcomingEvents = response.data.events || [];
        if (upcomingEvents.length === 0) {
            console.log('   💤 No se recibieron eventos futuros de Altenar.');
            return [];
        }

        // Preparar Maps para acceso rápido
        const marketsMap = new Map((response.data.markets || []).map(m => [m.id, m]));
        const oddsMap = new Map((response.data.odds || []).map(o => [o.id, o]));

        // 2. Leer DB con la "Verdad" (Pinnacle Data)
        await db.read();
        const pinnacleMatches = db.data.upcomingMatches || [];
        
        const valueBets = [];

        // 3. Iterar y Cruzar
        for (const event of upcomingEvents) {
            // Extraer nombre local para el cruce
            // En GetUpcoming, el nombre suele venir "Team A vs Team B"
            const [homeNameRaw] = event.name.split(' vs ');
            if (!homeNameRaw) continue;

            // Buscar coincidencia en nuestra DB
            const matchInDb = pinnacleMatches.find(dbMatch => 
                isSameTeam(homeNameRaw, dbMatch.home)
            );

            if (matchInDb) {
                // Extraer cuotas 1x2 de Altenar
                const altenarOdds = extract1x2Odds(event, marketsMap, oddsMap);
                
                if (altenarOdds) {
                    // C. Analizar HOME (Local)
                    evaluateOpportunity(valueBets, matchInDb, event, 'Home', altenarOdds.home, matchInDb.realProbabilities.home, db.data.config.bankroll);
                    
                    // D. Analizar DRAW (Empate)
                    evaluateOpportunity(valueBets, matchInDb, event, 'Draw', altenarOdds.draw, matchInDb.realProbabilities.draw, db.data.config.bankroll);

                    // E. Analizar AWAY (Visita)
                    evaluateOpportunity(valueBets, matchInDb, event, 'Away', altenarOdds.away, matchInDb.realProbabilities.away, db.data.config.bankroll);
                }
            }
        }

        if (valueBets.length > 0) {
            console.log(`💎 ${valueBets.length} VALUE BETS PRE-MATCH DETECTADAS`);
        } else {
            console.log('   ✅ Escaneo Pre-Match completado. Sin Value Bets claras.');
        }

        return valueBets;

    } catch (error) {
        console.error('❌ Error en Pre-Match Scanner:', error.message);
        return [];
    }
};

// Helper interno para evaluar y agregar oportunidad
const evaluateOpportunity = (resultsArray, dbMatch, event, listSide, offeredOdd, realProb, bankroll) => {
    if (!offeredOdd || offeredOdd <= 1) return;

    const ev = calculateEV(realProb, offeredOdd);
    
    // Filtro de Valor (Configurable, por defecto > 2% EV)
    if (ev > 2.0) {
        const kelly = calculateKellyStake(realProb, offeredOdd, bankroll);
        
        resultsArray.push({
            type: 'PREMATCH_VALUE',
            match: event.name,
            league: dbMatch.league.name,
            date: event.startDate,
            market: `1x2 - ${listSide}`,
            odd: offeredOdd,
            realProb: realProb,
            ev: ev,
            stake: kelly,
            timestamp: Date.now()
        });
    }
};

// Reutilizamos la lógica de extracción de Odds (Podríamos moverla a utils si crece mucho)
const extract1x2Odds = (event, marketsMap, oddsMap) => {
  if (!event.marketIds) return null;

  let odds = { home: 0, draw: 0, away: 0 };
  let found = false;

  for (const marketId of event.marketIds) {
    const market = marketsMap.get(marketId);
    if (!market) continue;

    if (market.typeId === 1 || market.name === '1x2') {
      for (const oddId of market.oddIds) {
        const odd = oddsMap.get(oddId);
        if (odd) {
          if (odd.typeId === 1) odds.home = odd.price;
          if (odd.typeId === 2) odds.draw = odd.price; 
          if (odd.typeId === 3) odds.away = odd.price; 
        }
      }
      found = true;
      break; 
    }
  }
  return found ? odds : null;
};
