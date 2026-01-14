import altenarClient from '../config/axiosClient.js';
import db from '../db/database.js';
import { findMatch } from '../utils/teamMatcher.js';
import { calculateEV, calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: LIVE SCANNER (LA VOLTEADA & PRE-MATCH VALUE)
// =====================================================================

/**
 * 1. Obtiene TODOS los partidos en vivo de Altenar.
 * 2. Cruza con la base de datos local (API-Sports) para encontrar valor.
 * 3. Aplica filtros de estrategia "La Volteada".
 */
// MEMORY CACHE: Aquí guardamos la última foto del scanner para no saturar la API
let cachedOpportunities = [];
let lastScanTime = null;
let isScanning = false;

/**
 * INICIAR LOOP DE FONDO (BACKGROUND WORKER)
 * Se asegura de que solo haya 1 petición a Altenar cada X segundos,
 * sin importar cuántos clientes (pestañas) consulten el backend.
 */
export const startBackgroundScanner = () => {
    if (isScanning) return; // Ya está corriendo
    isScanning = true;
    
    const loop = async () => {
        try {
            // Escanear y actualizar caché
            const ops = await scanLiveOpportunities();
            cachedOpportunities = ops;
            lastScanTime = new Date();
        } catch (e) {
            console.error('⚠️ Background Scan Error:', e.message);
        } finally {
            // PLANIFICAR SIGUIENTE ESCANEO (JITTER)
            // Aleatorio entre 30s y 50s para evitar patrones robóticos
            const delay = Math.floor(Math.random() * (20000)) + 30000; 
            // console.log(`   ⏳ Próximo escaneo en ${(delay/1000).toFixed(1)}s`);
            setTimeout(loop, delay);
        }
    };

    // Arrancar primer ciclo inmediatamente
    loop();
    console.log('🔄 Background Scanner Iniciado (Modo Seguro Anti-Ban)');
};

/**
 * Obtener datos desde la Caché (Instantáneo, seguro para el Frontend)
 */
export const getCachedLiveOpportunities = () => {
    return {
        timestamp: lastScanTime,
        data: cachedOpportunities
    };
};

/**
 * LÓGICA CORE (PÚBLICA PARA SCRIPTS): Realiza la petición real a Altenar
 */
export const scanLiveOpportunities = async () => {
  try {
    console.log(`\n📡 [Live Scanner] Buscando oportunidades en vivo (${new Date().toLocaleTimeString()})...`);
    
    // 1. Obtener Live Data (Sin eventCount explicito para evitar bloqueos)
    const response = await altenarClient.get('/GetLivenow', {
      params: { sportId: 66 }
    });

    const liveEvents = response.data.events || [];
    
    // Preparar Maps Relacionales
    const marketsMap = new Map((response.data.markets || []).map(m => [m.id, m]));
    const oddsMap = new Map((response.data.odds || []).map(o => [o.id, o]));

    // Leer DB Local
    await db.read();
    const upcomingDbMatches = db.data.upcomingMatches || []; 
    
    const opportunities = [];

    // =========================================================
    // 🚨 MODO REAL: SIN DATOS FALSOS
    // =========================================================
    // opportunities.push(...); // Demo removido

    if (liveEvents.length === 0) {
      console.log('   💤 No hay partidos reales en vivo.');
      // No retornamos inmediatamente
    }

    // 2. Iterar sobre la base de datos de Pinnacle
    for (const dbMatch of upcomingDbMatches) {
        
        let event = null;

        // A) INTENTO DE MATCH RÁPIDO (O(1)) POR ID GUARDADO DÍA PREVIO
        if (dbMatch.altenarId) {
            // Buscamos si ese ID está en la lista de Live actual
            const cachedLiveEvent = liveEvents.find(e => e.id === dbMatch.altenarId);
            if (cachedLiveEvent) {
                event = cachedLiveEvent;
                // console.log(`   ⚡ Fast Match: ${dbMatch.home}`); // Debug
            }
        }

        // B) FALLBACK: MATCH LENTO (FUZZY) SI NO HAY ID O CAMBIÓ
        if (!event) {
            // Usar el TeamMatcher avanzado (Fuzzy + Time)
            const matchResult = findMatch(dbMatch.home, dbMatch.date, liveEvents);
            if (matchResult) {
                event = matchResult.match;
                
                // Auto-healing (Opcional): Si encontramos match live, podríamos guardar el ID
                // pero db.write en un loop live es peligroso. Mejor dejarlo al pre-match scanner.
            }
        }

        if (!event) continue; // Este partido no está en vivo o Altenar no lo tiene

        // 3. Extracción de Datos en Vivo
        
        // 3. Extracción de Datos en Vivo
        const currentOdds = extract1x2Odds(event, marketsMap, oddsMap);
        if (!currentOdds) continue;

        // Scores
        const score = event.score || [0, 0];
        const [homeScore, awayScore] = score;
        const timeStr = event.liveTime ? event.liveTime.replace("'", "") : "0";
        const time = parseInt(timeStr, 10) || 0;

        // Extraer Tarjetas Rojas (Intento Heurístico)
        // Estructura común Altenar: event.rc (Red Cards) o dentro de stats
        let redCards = { home: 0, away: 0 };
        if (event.rc) {
             // A veces viene como "1-0" string o como objeto
             if (typeof event.rc === 'string' && event.rc.includes('-')) {
                 const parts = event.rc.split('-');
                 redCards = { home: parseInt(parts[0]) || 0, away: parseInt(parts[1]) || 0 };
             } else if (typeof event.rc === 'object') {
                 redCards = event.rc;
             }
        } else if (event.redCards) {
            redCards = event.redCards;
        }

        // =========================================================
        // ESTRATEGIA A: LIVE VALUE (Arbitraje Puro en Vivo)
        // =========================================================
        evaluateLiveValue(opportunities, dbMatch, event, 'Home', currentOdds.home, dbMatch.realProbabilities.home, redCards);
        evaluateLiveValue(opportunities, dbMatch, event, 'Away', currentOdds.away, dbMatch.realProbabilities.away, redCards);

        // =========================================================
        // ESTRATEGIA B: "LA VOLTEADA" (The Comeback)
        // =========================================================
        // Condiciones:
        // 1. Minuto 15 - 75
        // 2. El favorito PRE-PARTIDO (Cuota real < 1.60 => Prob > 62%) va perdiendo por 1 gol.
        
        if (time >= 15 && time <= 75) {
            const isHomeFavorite = dbMatch.realProbabilities.home > 60; // 60% chance de ganar inicial
            const isAwayFavorite = dbMatch.realProbabilities.away > 60; 

            // CASO 1: Favorito Local va Perdiendo 0-1
            if (isHomeFavorite && homeScore === 0 && awayScore === 1) {
                // Si la cuota ha subido lo suficiente (ahora pagan más porque va perdiendo)
                // y creemos que aún puede remontar...
                const liveProb = calculateVirtualLiveProb(dbMatch.realProbabilities.home, time, -1);
                
                // Si EV con la nueva cuota es positivo
                const ev = calculateEV(liveProb, currentOdds.home);
                if (ev > 5.0) {
                     addOpportunity(opportunities, 'LA_VOLTEADA', event, dbMatch, 'Home Remontada', currentOdds.home, liveProb, ev, '🔥 Favorito perdiendo', redCards);
                }
            }

            // CASO 2: Favorito Visita va Perdiendo 1-0
            if (isAwayFavorite && homeScore === 1 && awayScore === 0) {
                const liveProb = calculateVirtualLiveProb(dbMatch.realProbabilities.away, time, -1);
                const ev = calculateEV(liveProb, currentOdds.away);
                 if (ev > 5.0) {
                     addOpportunity(opportunities, 'LA_VOLTEADA', event, dbMatch, 'Away Remontada', currentOdds.away, liveProb, ev, '🔥 Favorito perdiendo', redCards);
                }
            }
        }
    }

    if (opportunities.length > 0) {
      console.log(`🔥 ${opportunities.length} OPORTUNIDADES EN VIVO DETECTADAS`);
    } else {
      console.log('   ✅ Escaneo Live completado. Sin oportunidades claras.');
    }

    return opportunities;

  } catch (error) {
    console.error('❌ Error en Live Scanner:', error.message);
    return [];
  }
};

// =========================================================
// HELPERS
// =========================================================

// Estimar degradación de probabilidad según tiempo y marcador (Heurística simple)
// En producción esto requiere un modelo de Poisson.
const calculateVirtualLiveProb = (prematchProb, minute, goalDiff) => {
    let decayFactor = 1.0;
    
    // Si va perdiendo, la prob baja drásticamente con el tiempo
    if (goalDiff < 0) {
        // Minuto 15: 85% de la prob original
        // Minuto 70: 30% de la prob original
        decayFactor = 1 - (minute / 100); 
    }
    
    // Nunca bajar de 0
    return Math.max(prematchProb * decayFactor, 10);
};

const addOpportunity = (list, type, event, dbMatch, marketName, odd, realProb, ev, tag, redCards = {home:0, away:0}) => {
    const kelly = calculateKellyStake(realProb, odd, db.data.config.bankroll);
    list.push({
        type: type,
        match: event.name,
        league: dbMatch.league.name,
        time: event.liveTime,
        score: event.score ? event.score.join('-') : '0-0',
        market: marketName,
        odd: odd,
        realProb: realProb,
        ev: ev,
        kellyStake: kelly.amount,
        kellyPct: kelly.percentage,
        tag: tag,
        redCards: redCards,
        timestamp: Date.now()
    });
};

const evaluateLiveValue = (list, dbMatch, event, side, currentOdd, prematchProb, redCards) => {
    if (!currentOdd) return;
    
    const ev = calculateEV(prematchProb, currentOdd);
    if (ev > 8.0) { 
        addOpportunity(list, 'LIVE_VALUE', event, dbMatch, `1x2 ${side}`, currentOdd, prematchProb, ev, '⚡ Live Value', redCards);
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
