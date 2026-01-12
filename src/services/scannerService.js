import altenarClient from '../config/axiosClient.js';
import db from '../db/database.js';
import { isSameTeam } from '../utils/teamNormalizer.js';
import { calculateEV, calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: LIVE SCANNER (LA VOLTEADA & PRE-MATCH VALUE)
// =====================================================================

/**
 * 1. Obtiene TODOS los partidos en vivo de Altenar.
 * 2. Cruza con la base de datos local (API-Sports) para encontrar valor.
 * 3. Aplica filtros de estrategia "La Volteada".
 */
export const scanLiveOpportunities = async () => {
  try {
    console.log(`\n📡 [Scanner] Escaneando oportunidades en vivo (${new Date().toLocaleTimeString()})...`);
    
    // A. Llamada Ligera a Altenar (GetLivenow)
    const response = await altenarClient.get('/GetLivenow', {
      params: { eventCount: 100, sportId: 66 } // Traemos un bloque grande
    });

    const liveEvents = response.data.events || [];
    if (liveEvents.length === 0) {
      console.log('   💤 No hay partidos en vivo.');
      return [];
    }

    // Preparar Maps para acceso rápido a Relational Data
    const marketsMap = new Map((response.data.markets || []).map(m => [m.id, m]));
    const oddsMap = new Map((response.data.odds || []).map(o => [o.id, o]));

    // Leer DB Local (Source of Truth)
    await db.read();
    const upcomingDbMatches = db.data.upcomingMatches || [];
    
    const opportunities = [];

    // B. Iterar sobre eventos en vivo
    for (const event of liveEvents) {
      // Filtros básicos de estrategia "La Volteada"
      // 1. Tiempo de juego: 15' - 80' (aprox)
      const timeStr = event.liveTime ? event.liveTime.replace("'", "") : "0";
      const time = parseInt(timeStr, 10);
      
      // Si no hay tiempo o es muy temprano/tarde, podemos ignorar (o ajustar estrategia)
      // if (isNaN(time) || time < 10 || time > 80) continue; 

      // Buscar si tenemos este partido analizado en DB
      // Cruzamos por nombre del Local
      const altenarHomeId = event.competitorIds ? event.competitorIds[0] : null;
      // Altenar no manda el nombre en el evento a veces, sino en competitors array.
      // Pero GetLivenow sí manda 'name': "Team A vs Team B"
      
      const [homeNameRaw] = event.name.split(' vs ');
      if (!homeNameRaw) continue;

      const matchedDbMatch = upcomingDbMatches.find(dbMatch => 
        isSameTeam(homeNameRaw, dbMatch.home)
      );

      if (matchedDbMatch) {
        // ¡TENEMOS MATCH! Conocemos la probabilidad real pre-partido.
        
        // C. Extraer cuota actual en vivo (Mercado 1x2) - Buscamos Valor
        const currentOdds = extract1x2Odds(event, marketsMap, oddsMap);
        
        if (currentOdds) {
          // Analizar Home (Local)
          const homeEV = calculateEV(matchedDbMatch.realProbabilities.home, currentOdds.home);
          if (homeEV > 2.0) { // Filtro EV > 2%
            const kelly = calculateKellyStake(matchedDbMatch.realProbabilities.home, currentOdds.home, db.data.config.bankroll);
            
            opportunities.push({
              type: 'LIVE_VALUE',
              match: event.name,
              league: matchedDbMatch.league.name, // Data enriquecida de DB
              time: event.liveTime,
              score: event.score ? event.score.join('-') : '0-0',
              market: 'Home Win',
              odd: currentOdds.home,
              realProb: matchedDbMatch.realProbabilities.home,
              ev: homeEV,
              stake: kelly,
              timestamp: Date.now()
            });
          }

          // Analizar Away (Visita)
          const awayEV = calculateEV(matchedDbMatch.realProbabilities.away, currentOdds.away);
          if (awayEV > 2.0) {
             const kelly = calculateKellyStake(matchedDbMatch.realProbabilities.away, currentOdds.away, db.data.config.bankroll);
             opportunities.push({
              type: 'LIVE_VALUE',
              match: event.name,
              league: matchedDbMatch.league.name,
              time: event.liveTime,
              score: event.score ? event.score.join('-') : '0-0',
              market: 'Away Win',
              odd: currentOdds.away,
              realProb: matchedDbMatch.realProbabilities.away,
              ev: awayEV,
              stake: kelly,
              timestamp: Date.now()
            });
          }
        }
      } else {
        // Loguear para mejorar el diccionario de nombres
        // console.log(`   🔸 No match en DB: ${homeNameRaw}`);
      }
    }

    if (opportunities.length > 0) {
      console.log(`🔥 ${opportunities.length} OPORTUNIDADES DETECTADAS`);
    } else {
      console.log('   ✅ Escaneo completado. Sin oportunidades claras por ahora.');
    }

    return opportunities;

  } catch (error) {
    console.error('❌ Error en Scanner:', error.message);
    return [];
  }
};

// Helper: Extraer cuotas 1x2 de la estructura relacional loca de Altenar
const extract1x2Odds = (event, marketsMap, oddsMap) => {
  if (!event.marketIds) return null;

  let odds = { home: 0, draw: 0, away: 0 };
  let found = false;

  for (const marketId of event.marketIds) {
    const market = marketsMap.get(marketId);
    if (!market) continue;

    // Identificar mercado Ganador del Partido (1x2)
    // Altenar usa typeId: 1 o name: "1x2"
    if (market.typeId === 1 || market.name === '1x2') {
      for (const oddId of market.oddIds) {
        const odd = oddsMap.get(oddId);
        if (odd) {
          if (odd.typeId === 1) odds.home = odd.price;
          if (odd.typeId === 2) odds.draw = odd.price; // X
          if (odd.typeId === 3) odds.away = odd.price; // 2
        }
      }
      found = true;
      break; // Ya encontramos el mercado principal
    }
  }

  return found ? odds : null;
};
