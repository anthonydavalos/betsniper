import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER"
// Estrategia: "La Volteada" (Favorito perdiendo por 1 gol)
// =====================================================================

/**
 * Obtiene un resumen ligero de TODOS los partidos en vivo de fútbol.
 */
export const getLiveOverview = async () => {
    try {
        // sportId=66 (Fútbol), categoryId=0 (Mundo)
        const { data } = await altenarClient.get('/GetLiveOverview', {
            params: { sportId: 66, categoryId: 0 }
        });
        return data.events || [];
    } catch (error) {
        console.error('❌ Error en GetLiveOverview:', error.message);
        return [];
    }
};

/**
 * Obtiene detalles profundos de un partido específico (Stats, Tarjetas).
 */
export const getEventDetails = async (eventId) => {
    try {
        const { data } = await altenarClient.get('/GetEventDetails', {
            params: { eventId }
        });
        return data; // Retorna objeto completo con markets, odds, etc.
    } catch (error) {
        console.error(`❌ Error en GetEventDetails (${eventId}):`, error.message);
        return null;
    }
};

/**
 * Obtiene el resultado final de un evento desde el API de Resultados.
 * Útil para partidos que ya no están en el feed en vivo (Zombie Matches).
 */
export const getEventResult = async (sportId, catId, dateISO) => {
    try {
         // Endpoint: https://sb2ris-altenar2.biahosted.com/api/WidgetResults/GetEventResults
         const resultsBaseURL = 'https://sb2ris-altenar2.biahosted.com/api/WidgetResults';
         
         // Asegurar que la fecha esté en formato correcto (start of day often works best for filtering)
         // El usuario usó: date=2026-01-15T00:00:00.000Z
         // Si dateISO viene con hora, quizás cortarlo al día.
         const dateParam = dateISO ? new Date(dateISO).toISOString().split('T')[0] + 'T00:00:00.000Z' : new Date().toISOString().split('T')[0] + 'T00:00:00.000Z';

         const { data } = await altenarClient.get('/GetEventResults', {
            baseURL: resultsBaseURL, 
            params: {
                sportId: sportId || 66,
                categoryId: catId,
                date: dateParam
            }
         });
         return data;
    } catch (error) {
        console.error(`❌ Error en GetEventResult (Cat: ${catId}):`, error.message);
        return null;
    }
};

/**
 * Analiza el marcador para ver si cumple la condición de "Favorito Perdiendo".
 * @param {Object} liveEvent - Evento de Altenar
 * @param {Object} pinnacleMatch - Datos guardados de Pinnacle (Source of Truth)
 */
const checkTurnaroundCondition = (liveEvent, pinnacleMatch) => {
    // 1. Validar Tiempo de Juego (15' a 70')
    const timeStr = liveEvent.liveTime || "";
    const cleanTime = parseInt(timeStr.replace("'", "")) || 0;
    
    // Si no hay tiempo numérico o está fuera de rango
    if (cleanTime < 15 || cleanTime > 75) return null;

    // 2. Validar Marcador (Diferencia de 1 gol)
    const [scoreHome, scoreAway] = liveEvent.score || [0, 0];
    const diff = scoreHome - scoreAway;

    if (Math.abs(diff) !== 1) return null; 

    // 3. Identificar Favorito según Pinnacle
    // Antes > 0.60 (Cuota < 1.67). Ajustamos a > 0.55 (Cuota < 1.81) para ser más permisivos.
    if (!pinnacleMatch || !pinnacleMatch.odds) return null;

    const pHome = 1 / pinnacleMatch.odds.home;
    const pAway = 1 / pinnacleMatch.odds.away;

    const MIN_PROB_FAVORITE = 0.55;

    // CASO A: Favorito Local va perdiendo (Score: 0-1, 1-2...) => diff negativo
    if (diff === -1 && pHome > MIN_PROB_FAVORITE) { 
        return { 
            side: 'home', 
            favorite: pinnacleMatch.home, 
            currentScore: `${scoreHome}-${scoreAway}`,
            prematchProb: pHome * 100 // %
        };
    }

    // CASO B: Favorito Visita va perdiendo (Score: 1-0, 2-1...) => diff positivo
    if (diff === 1 && pAway > MIN_PROB_FAVORITE) {
        return { 
            side: 'away', 
            favorite: pinnacleMatch.away, 
            currentScore: `${scoreHome}-${scoreAway}`,
            prematchProb: pAway * 100 // %
        };
    }

    return null;
};

/**
 * Función Principal del Sniper
 */
export const scanLiveOpportunities = async () => {
    await initDB(); 
    const pinnacleDb = db.data.upcomingMatches || [];
    
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(m.altenarId, m);
    });

    console.log(`📡 Escaneando en vivo... (DB tiene ${linkedMatches.size} partidos enlazados)`);

    const liveEvents = await getLiveOverview();
    const opportunities = [];

    for (const event of liveEvents) {
        const pinMatch = linkedMatches.get(event.id);

        if (pinMatch) {
            const condition = checkTurnaroundCondition(event, pinMatch);
            
            if (condition) {
                console.log(`   🧐 Candidato detectado: ${event.name} (${condition.currentScore})`);
                
                try {
                    const details = await getEventDetails(event.id);
                    
                    // Nota: Eliminamos el filtro estricto de !details.rc para mostrar info de tarjetas
                    if (details) { 
                        
                        // NOTA: Para Live Sniper "La Volteada", estimamos la probabilidad
                        // de remontada. En modelo simple, usamos una fracción de la prob original 
                        // o un valor fijo conservador para el cálculo Kelly.
                        // Para V1, asumimos que la cuota actual en vivo paga MUCHO más que la pre-match.
                        // Usaremos la prob original como "target confidence".
                        
                        // Simulamos encontrar la cuota en vivo (en producción es compleja de parsear)
                        // Asumiremos cuota 2.50+ si va perdiendo
                        const estimatedLiveOdd = 3.00; 

                        opportunities.push({
                            type: 'LIVE_SNIPE',
                            eventId: event.id, // ID Vital para tracking
                            match: event.name,
                            league: pinMatch.league.name,
                            sportId: event.sportId || 66,
                            catId: event.catId || event.categoryId,
                            champId: event.champId || event.championshipId,
                            time: event.liveTime,
                            score: condition.currentScore,
                            favorite: condition.favorite,
                            reason: `Favorito pre-match perdiendo por 1 gol.`,
                            action: `Apostar a ${condition.side === 'home' ? 'LOCAL' : 'VISITA'}`,
                            redCards: details.rc || 0, // Info de tarjetas
                            
                            // Datos financieros para Kelly Strategy
                            realProb: condition.prematchProb * 0.7, // Ajuste conservador por ir perdiendo
                            odd: estimatedLiveOdd,
                            ev: 10, // Placeholder EV
                            kellyStake: calculateKellyStake(
                                (condition.prematchProb * 0.7) * 100, 
                                estimatedLiveOdd, 
                                db.data.portfolio.balance || 1000
                            ).amount
                        });
                    }
                } catch(error) {
                    console.error(`Error details ${event.id}`, error);
                }
            }
        }
    }

    // [ELIMINADO] Bloque de Simulación TEST (Real Madrid vs Barcelona)
    
    return opportunities;
};
