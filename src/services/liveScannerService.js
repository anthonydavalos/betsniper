import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { findMatch, diagnoseNoMatch } from '../utils/teamMatcher.js'; // [NEW] Import Matcher
import { getAllPinnacleLiveOdds } from './pinnacleService.js'; // [NEW] Static import for matcher fallback
import { getKellyBankrollBase } from './bookyAccountService.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Ajustamos path para que apunte a data/ en la RAIZ (../data desde src/services está mal, necesitamos ../../data)
const STALE_TRIGGER_FILE = path.join(__dirname, '../../data/pinnacle_stale.trigger');
const STALE_TRIGGER_MIN_INTERVAL_MS = Math.max(30000, Number(process.env.PINNACLE_STALE_TRIGGER_MIN_INTERVAL_MS || 180000));
let lastStaleTriggerAt = 0;

const parseThresholdFromEnv = (rawValue, fallback, envName, sourceTag) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return fallback;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
        console.warn(`⚠️ [${sourceTag}] ${envName}="${rawValue}" no es numérico. Usando default ${fallback}.`);
        return fallback;
    }
    if (parsed < 0) {
        console.warn(`⚠️ [${sourceTag}] ${envName}=${parsed} fuera de rango [0,1]. Se ajusta a 0.`);
        return 0;
    }
    if (parsed > 1) {
        console.warn(`⚠️ [${sourceTag}] ${envName}=${parsed} fuera de rango [0,1]. Se ajusta a 1.`);
        return 1;
    }
    return parsed;
};

const parseBooleanFromEnv = (rawValue, fallback = false, envName = 'ENV_FLAG', sourceTag = 'Config') => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return fallback;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    const truthy = new Set(['1', 'true', 'yes', 'on']);
    const falsy = new Set(['0', 'false', 'no', 'off']);

    if (truthy.has(normalized)) return true;
    if (falsy.has(normalized)) return false;

    console.warn(`⚠️ [${sourceTag}] ${envName}="${rawValue}" no es booleano válido. Usando default ${fallback}.`);
    return fallback;
};

const ENABLE_MATCH_DIAGNOSTICS = parseBooleanFromEnv(
    process.env.MATCH_DIAGNOSTIC_LOG,
    false,
    'MATCH_DIAGNOSTIC_LOG',
    'LiveScanner'
);
const MATCHER_FUZZY_THRESHOLD = parseThresholdFromEnv(
    process.env.MATCH_FUZZY_THRESHOLD,
    0.77,
    'MATCH_FUZZY_THRESHOLD',
    'LiveScanner'
);
const MATCH_MIN_ACCEPT_SCORE = parseThresholdFromEnv(
    process.env.MATCH_MIN_ACCEPT_SCORE,
    0.6,
    'MATCH_MIN_ACCEPT_SCORE',
    'LiveScanner'
);

console.log(
    `🔧 [MatcherConfig] diag=${ENABLE_MATCH_DIAGNOSTICS ? 1 : 0} ` +
    `fuzzy=${MATCHER_FUZZY_THRESHOLD} minAccept=${MATCH_MIN_ACCEPT_SCORE}`
);

const normalizeMarketText = (value = '') => String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokenizeMarketText = (value = '') => normalizeMarketText(value).split(/\s+/).filter(Boolean);

const extractLineFromText = (value = '') => {
    const text = normalizeMarketText(value);
    const match = text.match(/(\d+(?:\.\d+)?)/);
    if (!match) return NaN;
    const line = parseFloat(match[1]);
    return Number.isFinite(line) ? line : NaN;
};

const flattenMarketOddIds = (market = {}) => {
    if (Array.isArray(market.desktopOddIds)) return market.desktopOddIds.flat().filter(Boolean);
    if (Array.isArray(market.oddIds)) return market.oddIds.filter(Boolean);
    return [];
};

const isMatchTotalMarket = (market, eventName, oddsMap) => {
    const n = normalizeMarketText(market?.name || '');
    if (!n) return false;

    const whitelist = ['total', 'over under', 'linea de gol', 'goals', 'goles'];
    if (!whitelist.some(v => n.includes(v))) return false;

    const forbidden = [
        'corner', 'esquina', 'card', 'tarjeta', 'amarilla', 'roja', 'booking',
        'half', 'mitad', 'tiempo', '1st', '2nd', '1er', '2do', 'primer', 'segundo',
        'team', 'equipo', 'player', 'jugador', 'goleador', 'scorer',
        'doble', 'chance', 'btts', 'both', 'ambos', 'marca',
        'result', 'resultado', 'handicap', 'asian', 'asiatico', 'exact', 'range', 'rango',
        'rest', 'odd even', 'par impar', 'winning', 'margin', 'margen',
        '1x2', 'multi', 'escala', 'team total', 'total del equipo', 'total de equipo',
        'goles del equipo', 'equipo total', 'equipo 1', 'equipo 2', 'home total', 'away total',
        'local', 'visitante', 'home', 'away', 'casa', 'fuera', 'anota', 'score', 'porteria', 'arco'
    ];
    if (forbidden.some(word => n.includes(word))) return false;

    const hasCompetitorBinding = Number.isFinite(Number(market?.competitorId)) ||
        (Array.isArray(market?.competitorIds) && market.competitorIds.length > 0);
    if (hasCompetitorBinding) return false;

    const eventParts = String(eventName || '').split(/\s+vs\.?\s+/i);
    const homeParts = tokenizeMarketText(eventParts[0] || '').filter(w => w.length >= 3);
    const awayParts = tokenizeMarketText(eventParts[1] || '').filter(w => w.length >= 3);
    const stopWords = new Set([
        'fc', 'sc', 'cd', 'ca', 'club', 'de', 'la', 'el', 'los', 'al',
        'united', 'city', 'real', 'sport', 'res', 'u21', 'u20', 'u19', 'women', 'femenino', 'b'
    ]);
    const teamTokens = [...new Set([...homeParts, ...awayParts].filter(t => !stopWords.has(t)))];

    if (teamTokens.some(t => n.includes(t))) return false;

    const oddTexts = flattenMarketOddIds(market)
        .map(id => oddsMap.get(id))
        .filter(Boolean)
        .map(o => normalizeMarketText(o.name || ''));

    if (oddTexts.some(txt => teamTokens.some(t => txt.includes(t)))) return false;

    return true;
};

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER"
// Estrategia: "La Volteada" (Favorito perdiendo por 1 gol)
// =====================================================================

/**
 * Obtiene un resumen ligero de TODOS los partidos en vivo de fútbol.
 * Actualizado a /GetLivenow para soporte de tiempo extra y más mercados.
 */
export const getLiveOverview = async () => {
    try {
        // sportId=66 (Fútbol), categoryId=0 (Mundo)
        // Usamos GetLivenow en lugar de GetLiveOverview
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { 
                sportId: 66, 
                categoryId: 0,
                _: Date.now() // Cache buster
            } // Eliminado limit eventCount para ver todo
        });

        // [NEW] Mapas de búsqueda rápida para Ligas y Países (Relational Data)
        const champsMap = new Map();
        if (Array.isArray(data.champs)) {
            data.champs.forEach(c => champsMap.set(c.id, c.name));
        }

        const catsMap = new Map();
        if (Array.isArray(data.categories)) {
            data.categories.forEach(c => catsMap.set(c.id, c.name));
        }
        
        // Normalización de Tiempos (Fix Visual 103' -> 90'+ y estado)
        // Usamos la propiedad 'ls' (Live Status) para detectar tiempos extra
        return (data.events || []).map(ev => {
             // [NEW] Enriquecer con nombres reales
             const leagueName = champsMap.get(ev.champId) || "";
             const countryName = catsMap.get(ev.catId) || "";

             const status = ev.ls || ""; 
             let cleanTime = ev.liveTime;
             
             // [FALLBACK IMPROVED] Si tiempo es inválido o 0, calculamos desde startDate
             const isInvalidTime = !cleanTime || cleanTime === "0'" || cleanTime === "" || cleanTime === 0 || cleanTime === "0";
             
             if (isInvalidTime && ev.startDate) {
                 const startedAt = new Date(ev.startDate).getTime();
                 const now = Date.now();
                 let diffMins = Math.floor((now - startedAt) / 60000);
                 
                 if (diffMins < 0) diffMins = 0; // Evitar negativos
                 
                 // Solo aplicamos corrección si hace sentido (entre 0 y 130 mins)
                 if (diffMins >= 0 && diffMins < 130) {
                     if (status.toLowerCase().includes('2nd') || status.toLowerCase().includes('2t')) {
                         cleanTime = `${Math.max(46, diffMins)}'`; // Force 46+ if 2nd half
                     } else if (diffMins === 0) { // Si es 0 pero está activo
                         cleanTime = "1'"; 
                     } else {
                         cleanTime = `${diffMins}'`;
                     }
                 }
             }

             const minutes = parseInt((cleanTime || "0").replace("'", "")) || 0;
             const statusLower = (status || "").toLowerCase();

             // [FIX] Mostrar "HT" claramente en el frontend
             if (statusLower.includes('half') || statusLower.includes('descanso') || statusLower.includes('ht') || statusLower.includes('intermedio')) {
                 cleanTime = "HT";
             }

             // Detectar Extra Time / Prórrogas (>90 min)
             // El usuario prefiere marcar como "Finalizado" (Settled) si entramos a tiempos extra.
             // Updated: >= 90 para capturar también el "90'+" y forzar cierre visual.
             const isExtraTime = minutes >= 90 || 
                               status.toLowerCase().includes('adicional') || 
                               status.toLowerCase().includes('prórroga') ||
                               status.toLowerCase().includes('penal');

             if (isExtraTime) {
                 cleanTime = "Final"; // "Final" triggerea settlement inmediato en paperTradingService y se muestra limpio en UI.
             }
             
             return {
                 ...ev,
                 league: leagueName,   // [NEW]
                 country: countryName, // [NEW]
                 liveTime: cleanTime,
                 rawStatus: status
             };
        });
    } catch (error) {
        console.error('❌ Error en GetLivenow:', error.message);
        return [];
    }
};

/**
 * Obtiene detalles profundos de un partido específico (Stats, Tarjetas).
 */
export const getEventDetails = async (eventId) => {
    try {
        const { data } = await altenarClient.get('/GetEventDetails', {
            params: {
                eventId,
                _: Date.now()
            }
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

         console.log(`[DEBUG] Calling GetEventResults: Sport=${sportId}, Cat=${catId}, Date=${dateParam}`);
         
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
    const timeStr = (liveEvent.liveTime || "").toLowerCase();
    
    // 1. Validar Tiempo de Juego (15' a 70')
    let cleanTime = parseInt(timeStr.replace("'", "")) || 0;
    
    // [FIX] Tratar "Descanso" (HT) como minuto 45 para no perder oportunidades de medio tiempo
    if (timeStr.includes("descanso") || timeStr.includes("half") || timeStr.includes("so") || timeStr.includes("ht")) {
        cleanTime = 45;
    }
    
    // Si no hay tiempo numérico o está fuera de rango
    // Extendemos rango hasta 80 para los "Late Snipes"
    if (cleanTime < 15 || cleanTime > 80) return null;

    // 2. Validar Marcador (Diferencia de 1 gol)
    // Altenar score comes as array [home, away]
    const [scoreHome, scoreAway] = liveEvent.score || [0, 0];
    const diff = scoreHome - scoreAway;

    if (Math.abs(diff) !== 1) return null; 

    // 3. ESTRATEGIA "UN CEREBRO": 
    // Ya no exigimos que sea el súper favorito pre-match (>55%).
    // Cualquier equipo perdiendo por 1 gol es candidato SI las cuotas en vivo tienen valor (EV+).
    // La filtración real ocurre después con calculateKellyStake.

    if (!pinnacleMatch || !pinnacleMatch.odds) return null;

    const pHome = 1 / pinnacleMatch.odds.home;
    const pAway = 1 / pinnacleMatch.odds.away;

    // CASO A: Local va perdiendo (Buscamos remontada local)
    if (diff === -1) { 
        // console.log(`       ✅ Match Candidate: ${liveEvent.name} (Home losing)`);
        return { 
            side: 'home', 
            favorite: pinnacleMatch.home, // Reference name only
            currentScore: `${scoreHome}-${scoreAway}`,
            prematchProb: pHome * 100 // % (Reference only)
        };
    }

    // CASO B: Visita va perdiendo (Buscamos remontada visita)
    if (diff === 1) {
        // console.log(`       ✅ Match Candidate: ${liveEvent.name} (Away losing)`);
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
export const scanLiveOpportunities = async (preFetchedEvents = null, options = { dryRun: false }) => {
    await initDB(); 
    const bankrollBase = await getKellyBankrollBase();
    const liveBankroll = bankrollBase.amount;
    const pinnacleDb = db.data.upcomingMatches || [];
    
    // ... (dryRun flag disponible para future usage si decidimos mover la lógica de apuesta aquí dentro) ...
    
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(m.altenarId, m);
    });

    // Usar eventos inyectados si existen, si no, buscar frescos
    const liveEvents = preFetchedEvents || await getLiveOverview();
    const opportunities = [];
    const diagSummary = {
        unmatched: 0,
        awayFallbackMatches: 0,
        reasons: new Map(),
        bestScores: [],
        nearThreshold: 0,
        categoryMismatch: 0,
        timeWindow5: 0,
        strictAliasFlow: 0
    };

    // [NEW] Cargar Pinnacle Live para Fallback (Matcher en caliente)
    let pinnacleLiveFeed = [];
    try {
        const pinMap = await getAllPinnacleLiveOdds();
        if (pinMap) pinnacleLiveFeed = Array.from(pinMap.values());
    } catch(e) { /* ignore */ }

    // [DEBUG LOG]
    console.log(`📡 Recibidos ${liveEvents.length} eventos live. (PinLive: ${pinnacleLiveFeed.length} cands)`);
    // liveEvents.forEach(e => console.log(`   - ${e.name} (ID: ${e.id}) [Linked? ${linkedMatches.has(e.id)}]`));

    for (const event of liveEvents) {
        let pinMatch = linkedMatches.get(event.id);

        // [FALLBACK] Intentar Match Dinámico si no hay link previo
        if (!pinMatch && pinnacleLiveFeed.length > 0) {
            const parts = (event.name || "").split(/ vs\.? /i);
            const homeName = (parts[0] || '').trim();
            const awayName = (parts[1] || '').trim();
            
            if (homeName) {
                // Usamos startDate del evento Altenar. Si es null, usamos ahora.
                const targetDate = event.startDate || new Date().toISOString(); 
                
                // Buscamos coincidencia en el feed en vivo de Pinnacle
                let matchResult = findMatch(homeName, targetDate, pinnacleLiveFeed, null, event.league);
                let matchedWithAwayFallback = false;

                // Fallback inverso: si por home falla, intentamos con away.
                if ((!matchResult || matchResult.score < MATCH_MIN_ACCEPT_SCORE) && awayName) {
                    const reverseResult = findMatch(awayName, targetDate, pinnacleLiveFeed, null, event.league);
                    if (reverseResult && reverseResult.score >= MATCH_MIN_ACCEPT_SCORE) {
                        matchResult = reverseResult;
                        matchedWithAwayFallback = true;
                    }
                }

                if (matchResult && matchResult.score >= MATCH_MIN_ACCEPT_SCORE) { // Umbral razonable
                    const m = matchResult.match;
                    
                    if (m && m.match) {
                        
                        // [FIX] Recuperación Inversa: Intentar buscar en DB (Prematch) usando el ID Dinámico
                        const dbMatch = pinnacleDb.find(pm => String(pm.id) === String(m.id));
                        
                        if (dbMatch) {
                            pinMatch = dbMatch;
                            // console.log(`   🔗 RE-LINKED LIVE->PRE: ${pinMatch.home} vs ${pinMatch.away}`);
                        } else {
                            // Construimos un objeto pinMatch temporal "Duck Typed"
                            pinMatch = {
                                id: m.id,
                                home: m.match.split(' vs ')[0] || m.match,
                                away: m.match.split(' vs ')[1] || "Away",
                                league: m.league || { name: "Unknown League" }, // [FIX] Proporcionar objeto league por defecto
                                odds: m.moneyline // Pasamos las cuotas LIVE como "base" si no hay prematch
                            };
                        }
                        // console.log(`   🔗 LIVE MATCHED: ${event.name} -> ${pinMatch.home} vs ${pinMatch.away}`);
                    }
                }

                if (pinMatch && matchedWithAwayFallback) {
                    diagSummary.awayFallbackMatches++;
                }

                if (!pinMatch && ENABLE_MATCH_DIAGNOSTICS) {
                    const homeDiag = diagnoseNoMatch(homeName, targetDate, pinnacleLiveFeed, event.league);
                    const awayDiag = awayName
                        ? diagnoseNoMatch(awayName, targetDate, pinnacleLiveFeed, event.league)
                        : null;

                    const bestDiag = awayDiag && (awayDiag.bestScore || 0) > (homeDiag.bestScore || 0)
                        ? awayDiag
                        : homeDiag;

                    diagSummary.unmatched++;
                    diagSummary.reasons.set(
                        bestDiag.probableReason,
                        (diagSummary.reasons.get(bestDiag.probableReason) || 0) + 1
                    );
                    if (typeof bestDiag.bestScore === 'number') {
                        diagSummary.bestScores.push(bestDiag.bestScore);
                        if (bestDiag.bestScore >= 0.70 && bestDiag.bestScore < MATCHER_FUZZY_THRESHOLD) {
                            diagSummary.nearThreshold++;
                        }
                    }
                    if (bestDiag.probableReason === 'category_mismatch') diagSummary.categoryMismatch++;
                    if (String(bestDiag.probableReason || '').startsWith('time_window_')) diagSummary.timeWindow5++;
                    if (bestDiag.probableReason === 'score_threshold_or_flow') diagSummary.strictAliasFlow++;

                    console.log(
                        `🧪 [MATCH_DIAG] ALT#${event.id} "${event.name}" -> reason=${bestDiag.probableReason} ` +
                        `| in5=${bestDiag.inWindow5}/${bestDiag.totalCandidates} ` +
                        `| catMismatch=${bestDiag.categoryMismatches5} ` +
                        `| bestScore=${bestDiag.bestScore ?? 'n/a'} ` +
                        `| bestCand="${bestDiag.bestCandidate?.name || 'n/a'}"`
                    );
                }
            }
        }

        if (pinMatch) {
            // [NEW] STALE DATA DETECTION (FROZEN SOCKET)
            // Si hay match pero la diferencia de minutos es > 2 mins, es probable que 
            // el socket de Pinnacle esté congelado. Reiniciamos el scraper.
            if (pinMatch.time && event.liveTime) {
                const pinMins = parseInt(pinMatch.time.replace("'", "")) || 0;
                // Altenar usa "HT" o "45'" para descansos, normalizar
                let altMins = parseInt(event.liveTime.replace("'", "")) || 0;
                
                // Ignorar discrepancias en el entretiempo (HT) o al inicio del 2T
                const isHalfTime = event.liveTime.includes('HT') || event.liveTime === "45'";
                
                if (!isHalfTime && Math.abs(pinMins - altMins) > 3) {
                    console.warn(`⚠️ STALE DATA DETECTED: ${event.name} (Pin: ${pinMatch.time} vs Alt: ${event.liveTime})`);
                    console.warn(`   ⌛ Difference > 3 min. Triggering Pinnacle Scraper Restart...`);
                    
                    try {
                        // Borramos el lockfile para forzar reinicio por el Scheduler
                        // OJO: liveScannerService no debe reiniciar procesos directamente, 
                        // pero puede borrar el flag de "actualizado" o el lockfile.
                        
                        // Opción mejor: Loggear un "Warning" visible que el MonitorDashboard pueda mostrar
                        // O si estamos en modo agresivo, eliminar el archivo 'pinnacle_live.json' para forzar refetch
                        
                        // [V3] Escribir el archivo TRIGGER para que el proceso PinnacleGateway se reinicie
                        const nowMs = Date.now();
                        const cooldownPassed = (nowMs - lastStaleTriggerAt) >= STALE_TRIGGER_MIN_INTERVAL_MS;

                        if (!cooldownPassed) {
                            console.warn(`⏱️ Trigger stale suprimido por cooldown (${Math.ceil((STALE_TRIGGER_MIN_INTERVAL_MS - (nowMs - lastStaleTriggerAt)) / 1000)}s restantes).`);
                        } else if (!fs.existsSync(STALE_TRIGGER_FILE)) {
                            // Escribir Timestamp como motivo
                            fs.writeFileSync(STALE_TRIGGER_FILE, new Date().toISOString());
                            lastStaleTriggerAt = nowMs;
                            console.warn("🔄 REINICIO FORZADO ENVIADO AL GATEWAY!");
                        }
                    } catch (err) {
                        console.error("Error triggering restart logic", err);
                    }
                }
            }

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
                        
                        // -----------------------------------------------------------
                        // 4. ESTRATEGIA PURA (ARCADIA LIVE TRUTH)
                        // -----------------------------------------------------------
                        
                        // [MEJORA: CORRECCIÓN DE TIEMPO Y SCORE DESDE PINNACLE SI EXISTE]
                        if (pinMatch && pinMatch.id && pinnacleLiveFeed.length > 0) {
                            // Buscar el objeto Pinnacle original en el feed en vivo
                            const realPinLive = pinnacleLiveFeed.find(p => String(p.id) === String(pinMatch.id));
                            if (realPinLive) {
                                // Inyectar datos de Tiempo/Score oficiales de Pinnacle
                                // Pinnacle Status: 1=Live 1H, 2=Live 2H.
                                // Period 0 = Match
                                // Period 1 = 1st Half
                                // Period 2 = 2nd Half
                                
                                // Score - Priorizar el más alto (por si uno está atrasado)
                                const pinH = realPinLive.score?.home || 0;
                                const pinA = realPinLive.score?.away || 0;
                                const altH = (event.score && event.score[0]) || 0;
                                const altA = (event.score && event.score[1]) || 0;
                                
                                if ((pinH + pinA) >= (altH + altA)) {
                                     condition.currentScore = `${pinH}-${pinA}`;
                                     if (details) details.score = [pinH, pinA];
                                } else {
                                     // Altenar is fresher
                                     condition.currentScore = `${altH}-${altA}`;
                                     // No tocamos condition.score (que viene de Pinnacle/Altenar mixed logic)
                                     // Pero aseguramos que el display use el más fresco.
                                }

                                // Time [FIX CRUCIAL] Priorizar reloj de Pinnacle SOLO SI es más reciente o Altenar falla
                                // Si Pinnacle está congelado (realPinLive.time viejo), no sobreescribir Altenar fresco.
                                // Solución: Comparar minutos si es posible.
                                
                                const pTimeStr = realPinLive.time || "";
                                const aTimeStr = event.liveTime || "";
                                const pMin = parseInt(pTimeStr.replace("'", "")) || 0;
                                const aMin = parseInt(aTimeStr.replace("'", "")) || 0;
                                
                                // Sobrescribir solo si Pinnacle Time es MAYOR (más avanzado) o Altenar es 0/inválido
                                if (pTimeStr.length > 2 && (pMin >= aMin || aMin === 0)) {
                                    event.liveTime = pTimeStr;
                                    pinMatch.time = pTimeStr; 
                                    pinMatch.score = condition.currentScore;
                                }

                                // [NEW] Inject Live Odds context safely (without overwriting pre-match)
                                if (realPinLive.moneyline) {
                                    // Ensure clean object structure
                                    pinMatch.liveOdds = { 
                                        home: realPinLive.moneyline.home,
                                        away: realPinLive.moneyline.away,
                                        draw: realPinLive.moneyline.draw
                                    };
                                }
                                if (realPinLive.totals) {
                                     // Ensure we don't wipe liveOdds if we just set moneyline
                                     if (!pinMatch.liveOdds) pinMatch.liveOdds = {};
                                     pinMatch.liveOdds.totals = realPinLive.totals;
                                }
                            }
                        }

                        // NOTA: Si llegamos aquí es porque GetEventDetails funcionó. 
                        // Usamos sus datos para refinar el tiempo si era 0 O si Altenar es más fresco que Pinnacle.
                        // [MOD] Prioridad absoluta al reloj más avanzado entre (Pinnacle Stored, Detail Clock, Event Clock)
                        // Asegurar tipos numéricos para comparación
                        const pStoredMin = pinMatch.time ? (parseInt(String(pinMatch.time).replace(/[^0-9]/g, "")) || 0) : 0;
                        const dClockMin = (details.clock && details.clock.matchTime) ? (parseInt(String(details.clock.matchTime).replace(/[^0-9]/g, "")) || 0) : 0;
                        const eLiveMin = (event.liveTime && event.liveTime !== "0'") ? (parseInt(String(event.liveTime).replace(/[^0-9]/g, "")) || 0) : 0;

                        // Si el detalle trae un tiempo MAYOR al que pusimos de Pinnacle (o igual), úsalo.
                        // Y si Pinnacle está "atrasado" (pStoredMin < eLiveMin), volver a Altenar.
                        if (dClockMin >= pStoredMin && dClockMin > 0) {
                            event.liveTime = details.clock.matchTime + "'";
                            // [FIX] Update pinMatch too so UI shows fresh time
                            if (pinMatch) pinMatch.time = event.liveTime;
                        } else if (pStoredMin < eLiveMin && eLiveMin > 0) {
                             // Si Pinnacle time (archivo) es MENOR que Altenar Time, ignorar Pinnacle
                             // Esto arregla el caso donde el archivo Pinnacle está viejo/stale.
                             
                             // [FIX] Force update stored Pin Time with fresher Altenar time for UI consistency
                             if (pinMatch) pinMatch.time = event.liveTime;
                        } else if (dClockMin > 0 && pStoredMin === 0) {
                             event.liveTime = details.clock.matchTime + "'";
                             if (pinMatch) pinMatch.time = event.liveTime;
                        }

                        // Update condition score too from Detail if fresher
                        if (details.score && details.score.length === 2) {
                            // Comparar score actual vs score de details
                            const [dsH, dsA] = details.score;
                            // Ensure condition.currentScore is valid string
                            const parts = (condition.currentScore || "0-0").split('-');
                            const csH = parseInt(parts[0]) || 0;
                            const csA = parseInt(parts[1]) || 0;
                            
                            if ((dsH + dsA) > (csH + csA)) {
                                condition.currentScore = `${dsH}-${dsA}`;
                            }
                        }

                        // A) Obtener Cuota Altenar (Value) - FIXED RELATIONAL MAPPING
                        let altenarOdd = 0;
                        const targetSide = condition.side; // 'home' or 'away'
                        
                        // Map de Odds para búsqueda rápida
                        const oddsMap = new Map();
                        if (details.odds && Array.isArray(details.odds)) {
                            details.odds.forEach(o => oddsMap.set(o.id, o));
                        }

                        if (details.markets && details.markets.length > 0) {
                            const market1x2 = details.markets.find(m => m.typeId === 1 || m.name === '1x2' || m.name === 'Match Result');
                            
                            if (market1x2) { 
                                const targetOddId = targetSide === 'home' ? 1 : 3; 
                                
                                // Buscar IDs en desktopOddIds (Array de Arrays)
                                const marketOddIds = (market1x2.desktopOddIds || []).flat(); 
                                
                                // Buscar el odd que coincida con el typeId y esté en este mercado
                                const oddObj = marketOddIds.map(id => oddsMap.get(id)).find(o => o && o.typeId === targetOddId);
                                
                                if (oddObj) {
                                    altenarOdd = oddObj.price;
                                    console.log(`       ✅ Cuota Encontrada: ${altenarOdd} (Side: ${targetSide})`);
                                } else {
                                    console.log(`       ⚠️ Cuota NO encontrada para ${targetSide} en mercado 1x2`);
                                }
                            } else {
                                console.log("       ⚠️ Mercado 1x2 NO encontrado en detalles.");
                            }
                        }

                        // B) Obtener Probabilidad Real (Pinnacle Arcadia Live)
                        let realProb = 0;
                        let isLivePinnacle = false;
                        let pinLiveOdds = null;

                        // Import dinámico para evitar ciclos si fuera necesario, o directo arriba
                        const { getPinnacleLiveOdds, calculateNoVigProb } = await import('./pinnacleService.js');
                        
                        if (pinMatch.id) {
                            const pinData = await getPinnacleLiveOdds(pinMatch.id);
                            pinLiveOdds = pinData ? pinData.moneyline : null;

                            if (pinLiveOdds) {
                                // Calcular Total Implied Prob (Suma de inversas)
                                const invHome = 1 / pinLiveOdds.home;
                                const invAway = 1 / pinLiveOdds.away;
                                const invDraw = pinLiveOdds.draw > 1 ? (1 / pinLiveOdds.draw) : 0; // Draw puede no existir o ser bajo
                                const totalImplied = invHome + invAway + invDraw;
                                
                                // Seleccionar cuota objetivo
                                const targetPinOdd = targetSide === 'home' ? pinLiveOdds.home : pinLiveOdds.away;
                                
                                // Calcular Prob Real sin Vig
                                realProb = calculateNoVigProb(targetPinOdd, totalImplied);
                                isLivePinnacle = true;
                                console.log(`   🎯 Pinnacle Live Found: Home=${pinLiveOdds.home}, Away=${pinLiveOdds.away} -> RealProb(${targetSide})=${realProb.toFixed(1)}%`);
                            }
                        }

                        // FALLBACK: Si Pinnacle no da live odds, usar lógica antigua de decaimiento sobre prematch
                        if (!isLivePinnacle) {
                            // Aplicar penalización por tiempo transcurrido si no tenemos dato real
                            const minute = parseInt((event.liveTime||"0").replace("'", ""));
                            const timeDecayFactor = Math.max(0.3, 1 - (minute / 120)); // Reduce prob conforme avanza tiempo
                            realProb = condition.prematchProb * timeDecayFactor;
                        }

                        // Regla estricta: LIVE_SNIPE requiere cuota live real de Pinnacle.
                        // Evita colocar apuestas con EV estimado pero sin referencia PIN usable en UI/registro.
                        if (!isLivePinnacle) {
                            console.log(`   ⚠️ Skip LIVE_SNIPE sin cuota Pinnacle Live: ${event.name} (${condition.side})`);
                            continue;
                        }

                        // C) Validar EV+ y Kelly
                        // Si no hay cuota Altenar, no podemos apostar
                        if (altenarOdd <= 1) {
                            // console.log("   ❌ Altenar Odd no disponible o bloqueada.");
                            continue; 
                        }

                        // Cálculo Kelly (ESTRATEGIA: LIVE_SNIPE - Alto Riesgo)
                        // Enviamos 'LIVE_SNIPE' para usar el perfil más conservador (1/10).
                        const kellyResult = calculateKellyStake(
                            realProb, 
                            altenarOdd, 
                            liveBankroll || 100,
                            'LIVE_SNIPE'
                        );
                        
                        // Solo push si hay valor positivo y min 1 Sol
                        if (kellyResult.amount >= 1) {
                             opportunities.push({
                                type: 'LIVE_SNIPE',
                                eventId: event.id,
                                pinnacleId: pinMatch.id, // ID de Arcadia/Pinnacle para referencia
                                match: event.name,
                                league: pinMatch.league?.name || "Live League", // [FIX] Safe access
                                sportId: event.sportId || 66,
                                catId: event.catId || event.categoryId,
                                champId: event.champId || event.championshipId,
                                time: pinMatch.time || event.liveTime, // [FIX] Prioritize Pin Time
                                score: condition.currentScore,
                                date: event.startDate, // Fecha de inicio real para la DB
                                market: '1x2', // Normalizado para consistencia de payload/API
                                favorite: condition.favorite,
                                selection: condition.side === 'home' ? 'Home' : 'Away',
                                
                                reason: isLivePinnacle 
                                    ? `EV+ Real detectado (Pin Live: ${(100/realProb).toFixed(2)})` 
                                    : `Favorito perdiendo (Prob Est: ${realProb.toFixed(1)}%)`,
                                    
                                action: `Apostar a ${condition.side === 'home' ? 'LOCAL' : 'VISITA'}`,
                                redCards: details.rc || 0,
                                
                                realProb: realProb, 
                                odd: altenarOdd,
                                ev: (((realProb)/100 * altenarOdd) - 1) * 100,
                                kellyStake: kellyResult.amount,

                                // [FIXED] Add missing pinnaclePrice for UI (Prevent "PIN OFF")
                                // Priority: 1. Fresh Fetch (pinLiveOdds), 2. Global Feed (pinMatch.liveOdds), 3. Null
                                pinnaclePrice: (isLivePinnacle 
                                    ? (condition.side === 'home' ? pinLiveOdds?.home : pinLiveOdds?.away) 
                                    : (pinMatch.liveOdds ? (condition.side === 'home' ? pinMatch.liveOdds.home : pinMatch.liveOdds.away) : null)),
                                
                                // [NEW] Enhanced Pinnacle Info for Frontend
                                pinnacleInfo: {
                                    id: pinMatch.id,
                                    time: pinMatch.time || event.liveTime,
                                    score: condition.currentScore,
                                    // [NEW] Add Prematch Odds Context for UI
                                    prematchPrice: condition.side === 'home' ? pinMatch.odds?.home : pinMatch.odds?.away,
                                    // [NEW] Full Context for Badges
                                    prematchContext: {
                                        home: pinMatch.odds?.home,
                                        draw: pinMatch.odds?.draw,
                                        away: pinMatch.odds?.away,
                                        over25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.over,
                                        under25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.under,
                                    }
                                }
                            });
                        }
                    }
                } catch(error) {
                    console.error(`Error details ${event.id}`, error);
                }
            }

            // --- NUEVA ESTRATEGIA: NEXT GOAL VALUE (TOTALS) ---
            const goalValue = checkGoalPressure(event, pinMatch);
            if (goalValue) {
                try {
                    console.log(`   ⚽ Posible Gol Próximo: ${event.name} (Buscando Over ${goalValue.line})...`);
                    
                    // fetch details si no existían
                    const details = await getEventDetails(event.id);
                    let realOdd = 0;

                    if (details && details.markets) {
                        // Map de Odds para búsqueda
                        const oddsMap = new Map();
                        if (details.odds && Array.isArray(details.odds)) {
                            details.odds.forEach(o => oddsMap.set(o.id, o));
                        }

                        // Buscar mercado de Totales (Over/Under)
                        // [FIX] Filtrado Estricto para evitar Team Totals y Otros Props
                        const totalMarket = details.markets.find(m => isMatchTotalMarket(m, event.name, oddsMap));

                        if (totalMarket) { // && totalMarket.odds REMOVED
                            // Relational Logic
                            const marketOddIds = (totalMarket.desktopOddIds || []).flat();

                            // Filtrar por linea
                            // Muchos mercados están agrupados. Buscamos el odd que tenga line == goalValue.line
                            // Y que sea Over (Name match or typeId 12 approx)
                            const overOdd = marketOddIds
                                .map(id => oddsMap.get(id))
                                .filter(Boolean)
                                .find(o => {
                                    const oddName = normalizeMarketText(o.name || '');
                                    const oddLine = Number.isFinite(Number(o.line))
                                        ? Number(o.line)
                                        : extractLineFromText(o.name || '');

                                    if (!Number.isFinite(oddLine)) return false;

                                    const isOverOdd = oddName.includes('over') || oddName.includes('mas');
                                    return isOverOdd && Math.abs(oddLine - goalValue.line) < 0.1;
                                });

                            if (overOdd) {
                                realOdd = overOdd.price;
                            }
                        }
                    }

                    if (realOdd > 1.2) { // Filtro minimo de cuota
                        const estimatedProb = 55; // Mantenemos prob fija por ahora (TODO: Calcular real based on Live Vig)
                        
                        // [FIX] Usar NAV (Net Asset Value) en lugar de Balance simple para evitar sub-inversión
                        const currentNAV = liveBankroll || ((db.data.portfolio.balance || 0) + (db.data.portfolio.activeBets || []).reduce((acc, b) => acc + (b.stake || 0), 0));
                        
                        // [FIX] Pasar estrategia explícita 'LIVE_SNIPE' para usar el Risk Profile correcto (0.10)
                        const kRes = calculateKellyStake(
                            estimatedProb, 
                            realOdd, 
                            currentNAV, 
                            'LIVE_SNIPE' 
                        );
                        
                        // No aplicar fracción manual extra. El Risk Profile ya lo incluye.
                        const kStake = kRes.amount; 

                        if (kStake >= 1) {
                            opportunities.push({
                                type: 'LIVE_VALUE', // Etiqueta para el frontend
                                strategy: 'LIVE_SNIPE', // Etiqueta para el motor de riesgo
                                eventId: event.id,
                                pinnacleId: pinMatch.id, // ID de Arcadia/Pinnacle para referencia
                                match: event.name,
                                league: pinMatch.league?.name || "Live League",
                                sportId: event.sportId || 66,
                                catId: event.catId || event.categoryId,
                                champId: event.champId || event.championshipId,
                                time: event.liveTime,
                                score: goalValue.currentScore,
                                date: event.startDate, // Fecha de inicio real para la DB
                                market: 'Total',
                                selection: `Apostar MÁS DE ${goalValue.line} GOLES`, // Action name for uniqueness
                                pick: `over_${goalValue.line}`,
                                reason: goalValue.reason,
                                action: `Apostar MÁS DE ${goalValue.line} GOLES`,
                                
                                realProb: estimatedProb,
                                odd: realOdd, // Cuota real obtenida
                                ev: ((estimatedProb/100 * realOdd) - 1) * 100,
                                kellyStake: kStake,
                                
                                // [FIXED] Add missing pinnaclePrice for UI (Next Goal Strategy)
                                // Use LIVE totals if available, otherwise Pre-Match totals
                                pinnaclePrice: (pinMatch?.liveOdds?.totals || pinMatch?.odds?.totals || []).find(t => Math.abs(t.line - goalValue.line) < 0.1)?.over,

                                pinnacleInfo: {
                                    id: pinMatch?.id,
                                    time: pinMatch?.time || event.liveTime,
                                    score: goalValue.currentScore,
                                    // [NEW] Add Prematch Odds Context for Totals
                                    prematchPrice: (pinMatch?.odds?.totals || []).find(t => Math.abs(t.line - goalValue.line) < 0.1)?.over,
                                    // [NEW] Full Context for Badges
                                    prematchContext: {
                                        home: pinMatch.odds?.home,
                                        draw: pinMatch.odds?.draw,
                                        away: pinMatch.odds?.away,
                                        over25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.over,
                                        under25: (pinMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.under,
                                    }
                                }
                            });
                        }
                    } else {
                        // console.log(`   ❌ Cuota para Over ${goalValue.line} no encontrada o muy baja.`);
                    }

                } catch (e) {
                    console.error("Error fetching details for Goal Value", e);
                }
            }
        }
    }

    if (ENABLE_MATCH_DIAGNOSTICS && diagSummary.unmatched > 0) {
        const scores = [...diagSummary.bestScores].sort((a, b) => a - b);
        const getPercentile = (arr, p) => {
            if (!arr.length) return null;
            const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * arr.length)));
            return Number(arr[idx].toFixed(3));
        };

        const topReasons = [...diagSummary.reasons.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([reason, count]) => ({ reason, count }));

        const nearThresholdRate = diagSummary.unmatched > 0
            ? diagSummary.nearThreshold / diagSummary.unmatched
            : 0;
        const categoryMismatchRate = diagSummary.unmatched > 0
            ? diagSummary.categoryMismatch / diagSummary.unmatched
            : 0;

        let recommendedFuzzyThreshold = MATCHER_FUZZY_THRESHOLD;
        let recommendationReason = 'keep_current';

        if (nearThresholdRate >= 0.45 && categoryMismatchRate < 0.40) {
            recommendedFuzzyThreshold = 0.74;
            recommendationReason = 'many_near_threshold_candidates';
        } else if (nearThresholdRate >= 0.25 && categoryMismatchRate < 0.50) {
            recommendedFuzzyThreshold = 0.75;
            recommendationReason = 'moderate_near_threshold_candidates';
        } else if (categoryMismatchRate >= 0.50) {
            recommendationReason = 'category_mismatch_dominant';
        }

        console.log(`🧪 [MATCH_DIAG_SUMMARY] unmatched=${diagSummary.unmatched} | awayFallbackMatches=${diagSummary.awayFallbackMatches}`);
        console.log(`🧪 [MATCH_DIAG_SUMMARY] topReasons=${JSON.stringify(topReasons)}`);
        console.log(
            `🧪 [MATCH_DIAG_SUMMARY] scoreStats=` +
            JSON.stringify({
                count: scores.length,
                p50: getPercentile(scores, 50),
                p75: getPercentile(scores, 75),
                p90: getPercentile(scores, 90),
                nearThresholdRate: Number((nearThresholdRate * 100).toFixed(1))
            })
        );
        console.log(
            `🧪 [MATCH_DIAG_RECOMMENDATION] fuzzyCurrent=${MATCHER_FUZZY_THRESHOLD} ` +
            `fuzzySuggested=${recommendedFuzzyThreshold} reason=${recommendationReason}`
        );
    }
    
    return opportunities;
};

/**
 * [NUEVO] Analiza si hay presión para un gol inminente (Especulativo basado en Pinnacle Pre-Match)
 * Un favorito claro + marcador bajo/empate + tiempo avanzando = Probabilidad de gol subiendo.
 */
const checkGoalPressure = (liveEvent, pinnacleMatch) => {
    
    // 1. Filtrar Tiempo: Partidos "maduros" donde el gol apremia (35'-45' o 65'-85')
    const timeStr = liveEvent.liveTime || "";
    const min = parseInt(timeStr.replace("'", "")) || 0;
    const isPressureTime = (min >= 35 && min <= 45) || (min >= 65 && min <= 85);
    
    if (!isPressureTime) return null;

    // 2. ¿Se espera gol? (Over 2.5 Pinnacle era bajo aka < 1.90?)
    // Si Pinnacle pre-match daba Over 2.5 < 1.80, es un partido de goles.
    let expectedGoalsHigh = false;
    if (pinnacleMatch.odds && pinnacleMatch.odds.totals) {
         // Buscar linea 2.5
         const line25 = pinnacleMatch.odds.totals.find(t => Math.abs(t.line - 2.5) < 0.1);
         if (line25) {
             // Convertir prob implicita
             const probOver = 1 / line25.over; 
             if (probOver > 0.55) expectedGoalsHigh = true; // > 55% de esperanza de over
         }
    }

    if (!expectedGoalsHigh) return null;

    // 3. Marcador Actual Bajo
    // Si se esperaban goles y vamos 0-0 o 1-0/0-1, hay presión.
    const [h, a] = liveEvent.score || [0, 0];
    const totalGoals = h + a;
    
    if (totalGoals > 2) return null; // Ya hubo fiesta, riesgo de que se cierren

    // 4. Determinar Línea a Atacar (Current Total + 0.5)
    // Altenar suele ofrecer Over X.5. Si van 1-0 (Total 1), buscamos Over 1.5.
    const targetLine = totalGoals + 0.5;

    return {
        line: targetLine,
        currentScore: `${h}-${a}`,
        reason: `Partido de alta expectativa de gol (Prematch) con marcador bajo en minuto ${min}'.`
    };
};
