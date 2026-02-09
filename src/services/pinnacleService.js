// src/services/pinnacleService.js

import { pinnacleClient } from '../config/pinnacleClient.js';
// Removed: axios, HEADERS, API_KEY (Managed by pinnacleClient)

// Conversor de American Odds a Decimal (Pinnacle usa American)
const americanToDecimal = (american) => {
    if (!american) return 0;
    if (american > 0) {
        return (american / 100) + 1;
    } else {
        return (100 / Math.abs(american)) + 1;
    }
};

// HELPER: Calcular Double Chance desde 1x2 (para no depender de la API)
const calculateDCFromMoneyline = (homeStr, drawStr, awayStr) => {
    // Input puede ser string o number
    const h = Number(homeStr);
    const d = Number(drawStr);
    const a = Number(awayStr);
    if (!h || !d || !a) return null;

    // Inversas (Probabilidad Implícita Bruta)
    const probH = 1/h;
    const probD = 1/d;
    const probA = 1/a;
    
    // Sumas para DC
    const dc1X = 1 / (probH + probD);
    const dc12 = 1 / (probH + probA);
    const dcX2 = 1 / (probD + probA);

    return {
        homeDraw: Number(dc1X.toFixed(3)),
        homeAway: Number(dc12.toFixed(3)),
        drawAway: Number(dcX2.toFixed(3))
    };
};

/**
 * STRATEGY: HYBRID FETCHING
 * 1. Global: fetches ALL live markets (20MB+ JSON usually, but filtered by Sport 29 maybe smaller).
 *    Faster for obtaining 1x2 and Totals for MANY matches.
 * 2. Surgical: fetches specific match details (BTTS, Props) using `related` endpoint.
 */

// --------------------------------------------------------------------------------------
// 1. GLOBAL FETCH (THE FIREHOSE) - Usar por defecto en el loop
// --------------------------------------------------------------------------------------
export const getAllPinnacleLiveOdds = async () => {
    try {
        console.log("   🌐 [Pinnacle] Descargando Snapshot Global (Camaleón API)...");
        const t0 = Date.now();
        
        // Ejecutar Requests en Paralelo
        // Usamos nuestro cliente inteligente que ya devuelve response.data
        const [marketData, matchupData] = await Promise.all([
            // 1. Odds (Global)
            pinnacleClient.get('/sports/29/markets/live/straight', { primaryOnly: false, withSpecials: false }),
            // 2. Metadata (Nombres, Score, Tiempo)
            pinnacleClient.get('/sports/29/matchups/live', { brandId: 0 })
        ]);

        const marketsSafe = marketData || [];
        const matchupsSafe = matchupData || [];

        console.log(`   ✅ Snapshot recibido en ${Date.now() - t0}ms. Procesando ${marketsSafe.length} mercados y ${matchupsSafe.length} partidos...`);
        
        // PASO A: Indexar Metadata (Filtrando solo Units="Regular")
        const metaMap = new Map();
        matchupsSafe.forEach(m => {
            // Solo nos interesan partidos de fútbol regulares (no corners/cards)
            // Si units no existe, asumimos que es regular. Si dice 'Corners' o 'Yellow Cards', lo ignoramos OR lo usamos solo para referenciar parent.
            if (m.units && m.units !== 'Regular') return;

            // Extraer Score Correcto
            const home = m.participants.find(p => p.alignment === 'home');
            const away = m.participants.find(p => p.alignment === 'away');
            const homeScore = home?.state?.score || 0;
            const awayScore = away?.state?.score || 0;
            
            // Extraer Tiempo
            const stateMap = { 1: '1T', 2: 'HT', 3: '2T' };
            const phase = stateMap[m.state?.state] || (m.liveMode === 'danger_zone' ? 'Live' : '');
            const minutes = m.state?.minutes || 0;


            metaMap.set(m.id, {
                match: `${home?.name} vs ${away?.name}`,
                score: `${homeScore}-${awayScore}`,
                time: `${phase} ${minutes}'`,
                league: m.league?.name,
                isLive: true
            });
        });

        // PASO B: Indexar Cuotas
        const oddsMap = new Map();

        // Procesar array masivo de mercados
        for (const market of marketData) {
            // Ignorar si el matchupId no es de un partido Regular (no está en metaMap)
            // Esto filtra automáticamente cuotas de Corners/Cards que tendrían IDs diferentes
            if (!metaMap.has(market.matchupId)) continue; 

            if (!oddsMap.has(market.matchupId)) {
                oddsMap.set(market.matchupId, {
                    ...metaMap.get(market.matchupId), // Inyectar metadata
                    moneyline: null,
                    doubleChance: null, 
                    totals: []
                });
            }

            const parsed = oddsMap.get(market.matchupId);

            // A) MONEYLINE (1x2)
            if (market.period === 0 && (market.type === 'moneyline' || market.key === 's;0;m')) {
                // [Security Fix] Check if we already have a Moneyline and compare cutoffAt
                // We want the OLDEST cutoffAt (True Match Winner), not "Rest of Match"
                const currentCutoff = market.cutoffAt || '9999';
                const existingCutoff = parsed._mlCutoff || '9999';

                // Si ya existe uno y el nuevo es "mas futuro" (mayor cutoff), lo ignoramos (es Rest of Match)
                if (parsed.moneyline && currentCutoff >= existingCutoff) {
                    continue;
                }

                const p = {};
                market.prices.forEach(priceObj => {
                    const dec = americanToDecimal(priceObj.price);
                    if(priceObj.designation) p[priceObj.designation.toLowerCase()] = Number(dec.toFixed(3));
                });
                
                if (p.home && p.away && p.draw) {
                    parsed.moneyline = {
                        home: p.home,
                        away: p.away,
                        draw: p.draw,
                        isLive: true 
                    };
                    parsed._mlCutoff = currentCutoff; // Save for comparison
                    // Auto-Calcular DC
                    parsed.doubleChance = calculateDCFromMoneyline(p.home, p.draw, p.away);
                }
            }

            // B) TOTALS
            if (market.period === 0 && (market.type === 'total' || market.key === 's;0;t')) {
                // Find Over/Under
                const overObj = market.prices.find(x => x.designation === 'over' || x.designation === 'Over');
                const underObj = market.prices.find(x => x.designation === 'under' || x.designation === 'Under');
                
                if (overObj && underObj) {
                     const line = market.points; 
                     parsed.totals.push({
                         line: Number(line),
                         over: Number(americanToDecimal(overObj.price).toFixed(3)),
                         under: Number(americanToDecimal(underObj.price).toFixed(3))
                     });
                }
            }
        }

        return oddsMap;

    } catch (e) {
        console.error("❌ Error en getAllPinnacleLiveOdds (Global):", e.message);
        return new Map();
    }
};

/**
 * Obtiene las cuotas en vivo de un partido específico desde Pinnacle Arcadia.
 * @param {string|number} pinnacleMatchId - ID del partido en Pinnacle.
 * @returns {Object|null} Objeto con propiedad { home, draw, away, timestamp } o null.
 */
export const getPinnacleLiveOdds = async (pinnacleMatchId) => {
    if (!pinnacleMatchId) return null;
    
    try {
        // Usamos el endpoint que devuelve mercados "straight" (1x2, OU, HC)
        // Usamos pinnacleClient para manejo de identidad y anti-delay
        const data = await pinnacleClient.get(`/matchups/${pinnacleMatchId}/markets/related/straight`);

        // DEBUG: Imprimir raw data para debuggear live status
        // console.log("RAW PINNACLE DATA SAMPLE:", JSON.stringify(data.slice(0, 2), null, 2));


        // ----------------------------------------------------------------
        // 1. MONEYLINE (1x2) & DOUBLE CHANCE
        // ----------------------------------------------------------------
        // Buscamos periodo 0 (Match) o periodo 1/2 si es live (pero para "Full Match Match Winner" sigue siendo periodo 0)
        // [Security Fix] Filtramos múltiples mercados para evitar "Rest of Match"
        // El verdadero Match Winner es el que tiene el cutoffAt más antiguo (original).
        
        const allMoneylines = data.filter(m => (m.key === 's;0;m' || m.type === 'moneyline') && m.period === 0 && m.status === 'open');
        
        // Ordenar: Más antiguo primero
        allMoneylines.sort((a, b) => (a.cutoffAt || '9999').localeCompare(b.cutoffAt || '9999'));

        const mlMarket = allMoneylines[0];
        
        // DEBUG: Si hay duplicados, avisar
        if (allMoneylines.length > 1) {
             console.log(`🛡️  Filtered ${allMoneylines.length} ML markets. Selected Cutoff: ${mlMarket.cutoffAt}`);
        }
        
        // --- LIVE CHECK ---
        // Verificamos si hay mercados de periodo 1 o 2, lo cual confirma que es LIVE
        const isLiveConfirmed = data.some(m => m.period === 1 || m.period === 2);

        
        let moneyline = null;
        let doubleChance = null;

        if (mlMarket && mlMarket.prices) {
            const prices = {};
            mlMarket.prices.forEach(p => {
                const decimal = americanToDecimal(p.price);
                if (decimal && p.designation) prices[p.designation.toLowerCase()] = Number(decimal.toFixed(3));
            });

            if (prices.home && prices.away) {
                const draw = prices.draw || 0;
                moneyline = {
                    home: prices.home,
                    away: prices.away,
                    draw: draw,
                    isLive: isLiveConfirmed
                };

                // Calcular Double Chance Real (Fair Probabilities derived from ML)
                // Primero obtenemos probs sin vig del ML
                const invH = 1 / prices.home;
                const invA = 1 / prices.away;
                const invD = draw > 0 ? 1 / draw : 0;
                const totalInv = invH + invA + invD;

                const probH = invH / totalInv;
                const probA = invA / totalInv;
                const probD = invD / totalInv;

                // Probabilidades DC Sumadas
                const prob1X = probH + probD;
                const prob12 = probH + probA;
                const probX2 = probD + probA;

                // Cuotas Fair (Sin Vig) para DC
                doubleChance = {
                    homeDraw: Number((1 / prob1X).toFixed(3)),     // 1X
                    homeAway: Number((1 / prob12).toFixed(3)),     // 12
                    drawAway: Number((1 / probX2).toFixed(3))      // X2
                };
            }
        }

        // ----------------------------------------------------------------
        // 2. TOTALS (Over/Under)
        // ----------------------------------------------------------------
        // Buscamos todos los totales abiertos full match
        const totalMarkets = data.filter(m => m.type === 'total' && m.period === 0 && m.status === 'open');
        let totals = [];
        
        if (totalMarkets.length > 0) {
            totals = totalMarkets.map(m => {
                const overP = m.prices.find(p => p.designation === 'over');
                const underP = m.prices.find(p => p.designation === 'under');
                
                // Algunos formats usan m.points, otros lo tienen en price
                const line = m.points !== undefined ? m.points : (overP?.points);

                if (line !== undefined && overP && underP) {
                    return {
                        line: Number(line),
                        over: Number(americanToDecimal(overP.price).toFixed(3)),
                        under: Number(americanToDecimal(underP.price).toFixed(3))
                    };
                }
                return null;
            }).filter(Boolean);
            
            // Ordenar por diff absoluta con linea "estándar" 2.5 para priorizar
            // o simplemente devolver todos
            totals.sort((a,b) => a.line - b.line);
        }

        return {
            moneyline,
            doubleChance,
            totals,
            timestamp: Date.now()
        };

    } catch (error) {
        // Silenciar errores 404/403 para no ensuciar logs excesivamente
        // console.error(`❌ Error fetching Pinnacle Live Odds (${pinnacleMatchId}):`, error.message);
        return null;
    }
};

/**
 * Calcula la Probabilidad Implícita Real (Fair Chance) removiendo el Vig (Margen).
 * Usa método multiplicativo simple o Power method si se requiere más precisión.
 * @param {number} odd 
 * @param {number} totalImpliedProb - Suma de 1/odd de todas las opciones del mercado
 * @returns {number} Probabilidad en % (0-100)
 */
export const calculateNoVigProb = (odd, totalImpliedProb) => {
    if (!odd || odd <= 1) return 0;
    // Implied Prob raw
    const rawP = 1 / odd;
    // Fair Prob = Raw / Total (Normalización)
    const fairP = rawP / totalImpliedProb;
    return fairP * 100;
};
