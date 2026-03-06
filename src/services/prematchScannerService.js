import db from '../db/database.js';
import { findMatch, isTimeMatch, normalizeName, getSimilarity, getTokenSimilarity, TEAM_ALIASES } from '../utils/teamMatcher.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { getAllPinnaclePrematchOdds } from './pinnacleService.js';
import { getKellyBankrollBase } from './bookyAccountService.js';

const NIGHT_MODE_START_HOUR_PE = 18;
const NEXT_DAY_CUTOFF_HOUR_PE = 6;
const PAIR_FALLBACK_TIME_WINDOW_MINUTES = Number.isFinite(Number(process.env.MATCH_TIME_EXTENDED_TOLERANCE_MINUTES))
    ? Number(process.env.MATCH_TIME_EXTENDED_TOLERANCE_MINUTES)
    : 30;
const EXCLUDED_MATCH_TERMS = [
    'corners',
    'corner',
    'bookings',
    'booking',
    'cards',
    'card',
    'tarjetas',
    '8 games',
    '8 game'
];

const normalizeMarketText = (value = '') => String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const isExcludedMarketVariant = ({ home = '', away = '', league = '' } = {}) => {
    const blob = normalizeMarketText(`${home} ${away} ${league}`);
    return EXCLUDED_MATCH_TERMS.some(term => blob.includes(term));
};

const getPrematchWindowUtc = () => {
    const nowUtcMs = Date.now();
    const peruOffsetMs = -5 * 60 * 60 * 1000;
    const nowPeru = new Date(nowUtcMs + peruOffsetMs);
    const hourPeru = nowPeru.getUTCHours();

    let endPeruMs;
    if (hourPeru >= NIGHT_MODE_START_HOUR_PE) {
        endPeruMs = Date.UTC(
            nowPeru.getUTCFullYear(),
            nowPeru.getUTCMonth(),
            nowPeru.getUTCDate() + 1,
            NEXT_DAY_CUTOFF_HOUR_PE,
            0,
            0,
            0
        );
    } else {
        endPeruMs = Date.UTC(
            nowPeru.getUTCFullYear(),
            nowPeru.getUTCMonth(),
            nowPeru.getUTCDate(),
            23,
            59,
            59,
            999
        );
    }

    const endUtcMs = endPeruMs - peruOffsetMs;
    return { nowUtcMs, endUtcMs, hourPeru };
};

const writeDbWithRetry = async (maxRetries = 12, waitMs = 300) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await db.write();
            return true;
        } catch (error) {
            const isLockErr = error?.code === 'EPERM' || error?.code === 'EBUSY';
            if (!isLockErr || attempt === maxRetries) throw error;
            await new Promise(r => setTimeout(r, waitMs * attempt));
        }
    }
    return false;
};

const splitEventSides = (value = '') => {
    const parts = String(value || '').split(/\s+vs\.?\s+/i);
    return {
        home: String(parts[0] || '').trim(),
        away: String(parts[1] || '').trim()
    };
};

const sideSimilarity = (a = '', b = '') => {
    const naBase = normalizeName(a);
    const nbBase = normalizeName(b);
    const na = TEAM_ALIASES[naBase] || naBase;
    const nb = TEAM_ALIASES[nbBase] || nbBase;
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const token = getTokenSimilarity(na, nb);
    const fuzzy = getSimilarity(na, nb);
    return Math.max(token, fuzzy);
};

const analyzePairMatch = (pinMatch = {}, altenarEvent = {}) => {
    const pinHome = pinMatch?.home || splitEventSides(pinMatch?.match || '').home;
    const pinAway = pinMatch?.away || splitEventSides(pinMatch?.match || '').away;
    const altSides = splitEventSides(altenarEvent?.name || '');

    if (!pinHome || !pinAway || !altSides.home || !altSides.away) {
        return {
            valid: true,
            orientation: 'unknown',
            directScore: 0,
            swappedScore: 0,
            bestScore: 0
        };
    }

    const directHome = sideSimilarity(pinHome, altSides.home);
    const directAway = sideSimilarity(pinAway, altSides.away);
    const swappedHome = sideSimilarity(pinHome, altSides.away);
    const swappedAway = sideSimilarity(pinAway, altSides.home);

    const directScore = Math.min(directHome, directAway);
    const swappedScore = Math.min(swappedHome, swappedAway);
    const bestPairScore = Math.max(directScore, swappedScore);

    let orientation = 'none';
    if (bestPairScore >= 0.72) {
        orientation = swappedScore > directScore ? 'swapped' : 'direct';
    }

    return {
        valid: bestPairScore >= 0.72,
        orientation,
        directScore,
        swappedScore,
        bestScore: bestPairScore
    };
};

const findDirectPairFallback = (pinMatch = {}, altenarEvents = []) => {
    if (!pinMatch?.home || !pinMatch?.away || !Array.isArray(altenarEvents) || altenarEvents.length === 0) {
        return null;
    }

    let best = null;
    let bestScore = 0;

    for (const candidate of altenarEvents) {
        if (!candidate) continue;
        const candidateDate = candidate.startDate || candidate.date;
        if (!isTimeMatch(pinMatch.date, candidateDate, PAIR_FALLBACK_TIME_WINDOW_MINUTES)) continue;

        const pairCheck = analyzePairMatch(pinMatch, candidate);
        if (!pairCheck.valid || pairCheck.orientation !== 'direct') continue;

        if (pairCheck.bestScore > bestScore) {
            bestScore = pairCheck.bestScore;
            best = candidate;
        }
    }

    return best;
};

const buildCanonicalMatchKey = (home = '', away = '', date = '') => {
    const nh = normalizeName(home);
    const na = normalizeName(away);
    const ts = new Date(date).getTime();
    if (!nh || !na || !Number.isFinite(ts)) return null;
    return `${nh}__${na}__${ts}`;
};

const applyLinkToDbMirror = (pinMatch = {}, altenarMatch = {}) => {
    const rows = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
    if (!rows.length) return false;

    const pinId = String(pinMatch?.id || '');
    const targetKey = buildCanonicalMatchKey(pinMatch?.home, pinMatch?.away, pinMatch?.date);

    let updated = false;
    for (const row of rows) {
        if (!row) continue;
        const rowId = String(row?.id || '');
        const rowKey = buildCanonicalMatchKey(row?.home, row?.away, row?.date);
        const sameId = pinId && rowId && pinId === rowId;
        const sameTuple = targetKey && rowKey && targetKey === rowKey;

        if (sameId || sameTuple) {
            row.altenarId = altenarMatch?.id ?? null;
            row.altenarName = altenarMatch?.name || null;
            updated = true;
        }
    }

    return updated;
};

// =====================================================================
// SERVICE: PRE-MATCH VALUE SCANNER & LINKER
// =====================================================================

export const scanPrematchOpportunities = async () => {
    try {
        console.log(`\n📡 [Pre-Match Scanner] Buscando Value Bets y Enlazando IDs...`);

        // 1. Leer DB (Ahora poblada por ingesta Pinnacle y Altenar)
        await db.read();
        
        let dbPinnacleMatches = db.data.upcomingMatches || [];
        const dbPinnacleMatchesSnapshot = Array.isArray(dbPinnacleMatches)
            ? [...dbPinnacleMatches]
            : [];
        const altenarCachedEvents = db.data.altenarUpcoming || [];
        let dbWasUpdatedFromCache = false;

        // [NEW] Cache-First para Pinnacle Pre-Match
        // 1) Intentar usar canal separado (pinnacle_prematch.json)
        // 2) Fallback a snapshot legacy en DB cuando falte data
        let pinnacleMatches = dbPinnacleMatches;
        try {
            const prematchMap = await getAllPinnaclePrematchOdds();
            if (prematchMap && prematchMap.size > 0) {
                const { nowUtcMs, endUtcMs } = getPrematchWindowUtc();
                const inWindow = (dateVal) => {
                    if (!dateVal) return false;
                    const ts = new Date(dateVal).getTime();
                    if (!Number.isFinite(ts)) return false;
                    return ts >= nowUtcMs - 10 * 60 * 1000 && ts <= endUtcMs;
                };

                const dbById = new Map(dbPinnacleMatches.map(m => [String(m.id), m]));
                const cacheDriven = [];
                const cacheIds = new Set();

                prematchMap.forEach((p) => {
                    const candidateDate = p.date || dbById.get(String(p.id))?.date;
                    if (!inWindow(candidateDate)) return;

                    const id = String(p.id);
                    cacheIds.add(id);

                    const dbMatch = dbById.get(id);
                    const safeHome = p.home || dbMatch?.home || (p.match || '').split(' vs ')[0] || 'Home';
                    const safeAway = p.away || dbMatch?.away || (p.match || '').split(' vs ')[1] || 'Away';

                    cacheDriven.push({
                        id,
                        home: safeHome,
                        away: safeAway,
                        date: p.date || dbMatch?.date,
                        league: dbMatch?.league || { name: p.league || 'Unknown League' },
                        bookmaker: 'Pinnacle',
                        odds: {
                            home: p.moneyline?.home || dbMatch?.odds?.home || 0,
                            draw: p.moneyline?.draw || dbMatch?.odds?.draw || 0,
                            away: p.moneyline?.away || dbMatch?.odds?.away || 0,
                            totals: (p.totals && p.totals.length > 0) ? p.totals : (dbMatch?.odds?.totals || []),
                            btts: dbMatch?.odds?.btts || null
                        },
                        altenarId: dbMatch?.altenarId || null,
                        altenarName: dbMatch?.altenarName || null,
                        source: 'prematch-cache'
                    });
                });

                const fallbackLegacy = dbPinnacleMatches.filter(m => {
                    if (cacheIds.has(String(m.id))) return false;
                    if (!inWindow(m.date)) return false;
                    return !isExcludedMarketVariant({ home: m.home, away: m.away, league: m.league?.name });
                });
                pinnacleMatches = [...cacheDriven, ...fallbackLegacy];

                console.log(`   🧠 Pinnacle Source: PREMATCH CACHE (${cacheDriven.length}) + Fallback DB (${fallbackLegacy.length}).`);

                // [NEW] Persistencia Automática a DB desde canal prematch (cache-first)
                // Mantiene upcomingMatches fresco sin depender de scripts legacy.
                const byId = new Map(dbPinnacleMatches.map((m, idx) => [String(m.id), { idx, val: m }]));
                const merged = [...dbPinnacleMatches];
                let changedCount = 0;

                for (const pm of cacheDriven) {
                    const id = String(pm.id);
                    const found = byId.get(id);

                    const existing = found?.val || {};
                    const nextObj = {
                        ...existing,
                        id: pm.id,
                        home: pm.home,
                        away: pm.away,
                        date: pm.date || existing.date,
                        league: pm.league || existing.league,
                        bookmaker: 'Pinnacle',
                        odds: pm.odds,
                        // Preservar enlaces existentes y metadatos útiles
                        altenarId: existing.altenarId || pm.altenarId || null,
                        altenarName: existing.altenarName || pm.altenarName || null,
                        lastUpdated: new Date().toISOString()
                    };

                    if (!found) {
                        merged.push(nextObj);
                        changedCount++;
                        continue;
                    }

                    const changed =
                        existing.home !== nextObj.home ||
                        existing.away !== nextObj.away ||
                        existing.date !== nextObj.date ||
                        JSON.stringify(existing.odds || {}) !== JSON.stringify(nextObj.odds || {}) ||
                        JSON.stringify(existing.league || {}) !== JSON.stringify(nextObj.league || {});

                    if (changed) {
                        merged[found.idx] = nextObj;
                        changedCount++;
                    }
                }

                const pruned = merged.filter(m => {
                    // Conservar SIEMPRE registros con link manual, aunque salgan de la ventana temporal.
                    // Esto evita que un reinicio o scan posterior borre el altenarId asignado manualmente.
                    if (m.altenarId != null) return true;
                    if (!inWindow(m.date)) return false;
                    return !isExcludedMarketVariant({ home: m.home, away: m.away, league: m.league?.name });
                });
                if (changedCount > 0 || pruned.length !== dbPinnacleMatches.length) {
                    // Re-leer altenarIds frescos para evitar race condition:
                    // si el usuario linkeó manualmente entre nuestro db.read() inicial
                    // y este punto, el snapshot que usamos para construir pruned
                    // tiene altenarId=null. Recuperamos los links reales antes de escribir.
                    await db.read();
                    const freshAltenarMap = new Map(
                        (db.data.upcomingMatches || [])
                            .filter(m => m.altenarId != null)
                            .map(m => [String(m.id), { altenarId: m.altenarId, altenarName: m.altenarName }])
                    );
                    for (const m of pruned) {
                        const fresh = freshAltenarMap.get(String(m.id));
                        if (fresh?.altenarId != null && m.altenarId == null) {
                            m.altenarId = fresh.altenarId;
                            m.altenarName = fresh.altenarName;
                        }
                    }
                    db.data.upcomingMatches = pruned;
                    dbPinnacleMatches = pruned;
                    dbWasUpdatedFromCache = true;
                    console.log(`   💾 Cache Prematch -> DB: ${changedCount} upserts en upcomingMatches.`);
                }
            } else {
                console.log('   ℹ️ Pinnacle Source: fallback DB (cache prematch vacío).');
            }
        } catch (cacheError) {
            console.warn(`   ⚠️ Cache prematch no disponible. Usando DB legacy. (${cacheError.message})`);
            pinnacleMatches = dbPinnacleMatches;
        }

        if (pinnacleMatches.length === 0 || altenarCachedEvents.length === 0) {
            console.log('   ⚠️ Faltan datos en DB. Ejecuta los scripts de ingesta (node scripts/ingest-pinnacle.js y node scripts/ingest-altenar.js).');
            return [];
        }

        const valueBets = [];
        let totalMatchesFound = 0;
        let newLinksCreated = 0; // Contador de nuevos enlaces
        let expiredCount = 0;

        // Limpieza de partidos pasados (Started)
        const now = new Date();
        const validPinnacleMatches = pinnacleMatches.filter(m => {
            const matchDate = new Date(m.date);
            // Permitimos un margen de 5 min después del inicio por si hay delay en "En Vivo"
            // Pero idealmente, si ya empezó, es Live.
            const isFuture = matchDate > new Date(now.getTime() - 5 * 60000); 
            if (!isFuture) expiredCount++;
            return isFuture;
        });

        if (expiredCount > 0) {
            // Actualizar DB para remover expirados si se desea
            // Por ahora solo filtramos en memoria para no borrar data histórica útil para debug
             console.log(`   🧹 Filtrando ${expiredCount} partidos que ya comenzaron o terminaron para el análisis de valor.`);
        }

        // --- FASE 1: LINKING GLOBAL (Linkear TODO, incluso pasados) ---
        // Esto asegura que reportes y futuros análisis tengan la data cruzada.
        const matchesForLinking = Array.from(
            new Map(
                [...dbPinnacleMatchesSnapshot, ...pinnacleMatches]
                    .filter(Boolean)
                    .map(m => [String(m.id), m])
            ).values()
        );

        for (const pinMatch of matchesForLinking) {
             let altenarEvent = null;
                             const dbMirror = (db.data.upcomingMatches || []).find(m => String(m.id) === String(pinMatch.id));
               const manualSticky = String(pinMatch?.linkSource || dbMirror?.linkSource || '').toLowerCase() === 'manual';

             // RE-VALIDACIÓN ESTRICTA DE LINKS EXISTENTES 
             // (Crucial si cambiamos tolerancias de tiempo)
             if (pinMatch.altenarId) {
                altenarEvent = altenarCachedEvents.find(e => e.id === pinMatch.altenarId);
                
                if (altenarEvent) {
                          const pairCheck = analyzePairMatch(pinMatch, altenarEvent);
                          if (!manualSticky && (!pairCheck.valid || pairCheck.orientation === 'swapped')) {
                                 if (pairCheck.orientation === 'swapped') {
                                     console.log(`   ⚠️ ENLACE OMITIDO (SWAPPED): ${pinMatch.home} vs ${pinMatch.away} <-> ${altenarEvent.name}`);
                                 }
                                 pinMatch.altenarId = null;
                                 pinMatch.altenarName = null;
                                 if (dbMirror) {
                                     dbMirror.altenarId = null;
                                     dbMirror.altenarName = null;
                                 }
                                 altenarEvent = null;
                          }

                          if (altenarEvent) {
                    // Si el evento existe, validamos que siga cumpliendo la tolerancia de tiempo actual (5 min)
                    // Si ya no cumple (ej. es un falso positivo de 6 horas), ROMPEMOS el enlace.
                    if (!manualSticky && !isTimeMatch(pinMatch.date, altenarEvent.startDate || altenarEvent.date)) {
                         console.log(`   ✂️ ROMPIENDO ENLACE INVÁLIDO (Tiempo): ${pinMatch.home} vs ${altenarEvent.name || altenarEvent.home}`);
                         pinMatch.altenarId = null;
                         pinMatch.altenarName = null;
                         pinMatch.linkSource = null;
                        if (dbMirror) {
                           dbMirror.altenarId = null;
                           dbMirror.altenarName = null;
                           dbMirror.linkSource = null;
                        }
                         altenarEvent = null;
                    }
                          }
                } else {
                    // [FIX] Enlace huérfano: el evento Altenar ya no está en cache actual.
                    // Rompemos el link para evitar ghost prematch y permitir relink limpio.
                    if (!manualSticky) {
                        pinMatch.altenarId = null;
                        pinMatch.altenarName = null;
                        pinMatch.linkSource = null;
                        if (dbMirror) {
                            dbMirror.altenarId = null;
                            dbMirror.altenarName = null;
                            dbMirror.linkSource = null;
                        }
                    }
                }
             }

             if (!pinMatch.altenarId) {
                // Solo intentamos linkear si NO tienen ID.
                const leagueName = pinMatch.league ? pinMatch.league.name : '';
                let matchResult = findMatch(pinMatch.home, pinMatch.date, altenarCachedEvents, pinMatch.homeId, leagueName);

                // Fallback: matching por par home/away + tiempo para casos donde
                // el home string llega ruidoso y findMatch(home) no alcanza score.
                if (!matchResult) {
                    const pairFallback = findDirectPairFallback(pinMatch, altenarCachedEvents);
                    if (pairFallback) {
                        matchResult = { match: pairFallback, score: 0.9, method: 'pair_fallback' };
                    }
                }

                if (matchResult) {
                    const pairCheck = analyzePairMatch(pinMatch, matchResult.match);
                    if (pairCheck.valid && pairCheck.orientation === 'direct') {
                        pinMatch.altenarId = matchResult.match.id;  
                        pinMatch.altenarName = matchResult.match.name; 
                        pinMatch.linkSource = 'auto';
                        if (dbMirror) {
                            dbMirror.altenarId = matchResult.match.id;
                            dbMirror.altenarName = matchResult.match.name;
                            dbMirror.linkSource = 'auto';
                        }
                        applyLinkToDbMirror(pinMatch, matchResult.match);
                        newLinksCreated++;
                        console.log(`   🔗 NUEVO ENLACE: ${pinMatch.home} (Pin) <--> ${matchResult.match.name} (Alt)`);
                    } else if (pairCheck.valid && pairCheck.orientation === 'swapped') {
                        console.log(`   ⚠️ NO LINK AUTO (SWAPPED): ${pinMatch.home} vs ${pinMatch.away} <-> ${matchResult.match.name}`);
                    }
                }
             }
        }

        const totalLinked = (db.data.upcomingMatches || []).filter(m => m.altenarId).length;
        console.log(`   📊 Estado del Linker: ${totalLinked} total enlazados (${newLinksCreated} nuevos en esta pasada).`);

        // Helper para calcular Probabilidad Real (Sin Vig) - 3 WAY (1x2)
        const getFairProbabilities = (odds) => {
            if (!odds || !odds.home || !odds.draw || !odds.away) return null;
            const impliedHome = 1 / odds.home;
            const impliedDraw = 1 / odds.draw;
            const impliedAway = 1 / odds.away;
            const sum = impliedHome + impliedDraw + impliedAway;
            
            return {
                home: impliedHome / sum,
                draw: impliedDraw / sum,
                away: impliedAway / sum
            };
        };

        // Helper para calcular Probabilidad Real - 2 WAY (Over/Under, BTTS, Handicap)
        const getFair2Way = (o1, o2) => {
            if (!o1 || !o2) return null;
            const i1 = 1 / o1;
            const i2 = 1 / o2;
            const sum = i1 + i2;
            return { p1: i1 / sum, p2: i2 / sum };
        };

        const bankrollBase = await getKellyBankrollBase();
        const currentBankroll = bankrollBase.amount;

        // 2. Iterar sobre Pinnacle (SOLO VÁLIDOS FUTUROS)
        for (const pinMatch of validPinnacleMatches) {
            
            let altenarEvent = null;

            // ESTRATEGIA HÍBRIDA: ID CACHEADO vs BUSQUEDA FUZZY
            if (pinMatch.altenarId) {
                altenarEvent = altenarCachedEvents.find(e => e.id === pinMatch.altenarId);
            }
            // NOTA: Ya linkeamos arriba en Fase 1. Si no tiene link, es que falló findMatch globalmente.

            if (altenarEvent) {
                totalMatchesFound++;
                
                // ... Analysis Logic ...
                const altenarOdds = altenarEvent.odds;

                // A) Analizar Oportunidades 1x2
                // ==========================================
                const realProbs1x2 = getFairProbabilities(pinMatch.odds);
                if (realProbs1x2 && altenarOdds) {
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Home', altenarOdds.home, realProbs1x2.home, currentBankroll, '1x2');
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Draw', altenarOdds.draw, realProbs1x2.draw, currentBankroll, '1x2');
                     evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'Away', altenarOdds.away, realProbs1x2.away, currentBankroll, '1x2');
                }

                // A.1) Analizar Double Chance
                // ==========================================
                if (pinMatch.odds?.doubleChance && altenarOdds?.doubleChance) {
                    const dcPin = pinMatch.odds.doubleChance;
                    const dcAlt = altenarOdds.doubleChance;

                    if (dcAlt.homeDraw && dcPin.homeDraw) {
                        const realProb = 1 / dcPin.homeDraw;
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, '1X', dcAlt.homeDraw, realProb, currentBankroll, 'Double Chance');
                    }
                    if (dcAlt.homeAway && dcPin.homeAway) {
                        const realProb = 1 / dcPin.homeAway;
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, '12', dcAlt.homeAway, realProb, currentBankroll, 'Double Chance');
                    }
                    if (dcAlt.drawAway && dcPin.drawAway) {
                        const realProb = 1 / dcPin.drawAway;
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'X2', dcAlt.drawAway, realProb, currentBankroll, 'Double Chance');
                    }
                }

                // B) Analizar Totals (Over/Under)
                // ==========================================
                if (pinMatch.odds.totals && Array.isArray(pinMatch.odds.totals) && 
                    altenarOdds.totals && Array.isArray(altenarOdds.totals)) {
                        
                    for (const pinTotal of pinMatch.odds.totals) {
                        // Buscamos la misma linea en Altenar (margen error 0.1 para floats 2.5 vs 2.50)
                        const altTotal = altenarOdds.totals.find(t => Math.abs(t.line - pinTotal.line) < 0.1);
                        
                        if (altTotal) {
                            const realProbsTotal = getFair2Way(pinTotal.over, pinTotal.under);
                            if (realProbsTotal) {

                                // Over (p1)
                                evaluateOpportunity(valueBets, pinMatch, altenarEvent, `Over ${pinTotal.line}`, altTotal.over, realProbsTotal.p1, currentBankroll, 'Total');
                                // Under (p2)
                                evaluateOpportunity(valueBets, pinMatch, altenarEvent, `Under ${pinTotal.line}`, altTotal.under, realProbsTotal.p2, currentBankroll, 'Total');
                            }
                        }
                    }
                }

                // C) Analizar BTTS (Ambos Marcan)
                // ==========================================
                // Verificamos que existan ambos mercados en ambas casas
                if (pinMatch.odds.btts && pinMatch.odds.btts.yes && 
                    altenarOdds.btts && altenarOdds.btts.yes) {
                    
                    const realProbsBTTS = getFair2Way(pinMatch.odds.btts.yes, pinMatch.odds.btts.no);
                    
                    if (realProbsBTTS) {
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'BTTS Yes', altenarOdds.btts.yes, realProbsBTTS.p1, currentBankroll, 'BTTS');
                        evaluateOpportunity(valueBets, pinMatch, altenarEvent, 'BTTS No', altenarOdds.btts.no, realProbsBTTS.p2, currentBankroll, 'BTTS');
                    }
                }
            }
        }

        // 3. PERSISTIR CAMBIOS (links + cache prematch)
        if (newLinksCreated > 0 || dbWasUpdatedFromCache) {
            // Snapshot de trabajo (con cambios de este ciclo) antes de re-leer disco.
            const workingRows = JSON.parse(JSON.stringify(Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : []));

            // Protección anti-race: si un enlace manual ocurrió mientras este ciclo corría,
            // re-leemos la DB en disco y preservamos esos links manuales antes de escribir.
            await db.read();
            const freshRows = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
            const freshManualById = new Map(
                freshRows
                    .filter(row => row?.altenarId != null && String(row?.linkSource || '').toLowerCase() === 'manual')
                    .map(row => [String(row.id), row])
            );

            for (const row of workingRows) {
                const freshManual = freshManualById.get(String(row?.id));
                if (!freshManual) continue;
                row.altenarId = freshManual.altenarId;
                row.altenarName = freshManual.altenarName;
                row.linkSource = 'manual';
                row.linkUpdatedAt = freshManual.linkUpdatedAt || row.linkUpdatedAt || new Date().toISOString();
            }

            db.data.upcomingMatches = workingRows;

            await writeDbWithRetry();
            if (newLinksCreated > 0) {
                console.log(`   🔗 ${newLinksCreated} nuevos enlaces Pinnacle-Altenar guardados en DB.`);
            }
        }

        // ORDENAMIENTO CRÍTICO: Partidos más cercanos primero
        // Esto responde a la necesidad de ver "lo más reciente/próximo" arriba en la UI.
        valueBets.sort((a, b) => new Date(a.date) - new Date(b.date));

        console.log(`\n📊 ESTADÍSTICAS PRE-MATCH:`);
        console.log(`   - Partidos Pinnacle (DB):   ${pinnacleMatches.length}`);
        console.log(`   - Filtrados (Ya iniciaron): ${expiredCount}`);
        console.log(`   - Enlazados con Altenar:    ${totalLinked}`);

        if (valueBets.length > 0) {
            console.log(`💎 ${valueBets.length} VALUE BETS DETECTADAS`);
        } else {
            console.log('   ✅ Escaneo completado. Sin value bets por ahora.');
        }

        return valueBets;

    } catch (error) {
        console.error('❌ Error en Pre-Match Scanner:', error.message);
        return [];
    }
};

// Helper interno para evaluar y agregar oportunidad
const evaluateOpportunity = (resultsArray, dbMatch, event, listSide, offeredOdd, realProb, bankroll, marketName = '1x2') => {
    if (!offeredOdd || offeredOdd <= 1) return;

    // EV Formula: (ProbReal * CuotaOfrecida) - 1
    const evPercentage = (realProb * offeredOdd - 1) * 100;
    
    // Filtro de Valor (> 2% EV por defecto)
    if (evPercentage > 2.0) {
        // Calcular Stake Kelly
        // ESTRATEGIA: PREMATCH_VALUE (Perfil Bajo Riesgo, Alta Confianza)
        const kellyResult = calculateKellyStake(realProb * 100, offeredOdd, bankroll, 'PREMATCH_VALUE');
        
        // [FILTER] Min Stake 1.00 PEN (Evitar centavos)
        if (kellyResult.amount < 1) return;

        resultsArray.push({
            type: 'PREMATCH_VALUE',
            eventId: event.id, // ID Vital para tracking
            pinnacleId: dbMatch.id, // ID Pinnacle para referencia
            match: `${dbMatch.home} vs ${dbMatch.away}`,
            league: dbMatch.league?.name, // Nombre de liga formateado
            catId: event.catId, // Metadata para liquidación
            champId: event.champId,
            sportId: event.sportId || 66,
            date: dbMatch.date,
            market: marketName,
            selection: listSide,
            odd: offeredOdd,
            realProb: realProb * 100,
            ev: evPercentage,
            kellyStake: kellyResult.amount, // Extraer el monto ($) del objeto devuelto
            bookmaker: 'Altenar',
            snapshotTime: new Date().toISOString(),
            // [NEW] Pinnacle Context for UI
            pinnacleInfo: {
                prematchContext: {
                    home: dbMatch.odds?.home,
                    draw: dbMatch.odds?.draw,
                    away: dbMatch.odds?.away,
                    over25: (dbMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.over,
                    under25: (dbMatch.odds?.totals || []).find(t => Math.abs(t.line - 2.5) < 0.1)?.under,
                }
            }
        });
    }
};
