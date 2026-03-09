import { americanToDecimal } from '../src/utils/oddsConverter.js';
import db, { initDB, writeDBWithRetry } from '../src/db/database.js';
import { fileURLToPath } from 'url';
import { pinnacleClient } from '../src/config/pinnacleClient.js';

// --- CONFIGURATION ---
// Headers y API Key manejados por pinnacleClient

// --- HELPERS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseEnvBoolean(value, defaultValue = false) {
    if (value == null) return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return defaultValue;
}

function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPrematchHybridWindow() {
    const now = new Date();
    const primaryHours = parsePositiveNumber(process.env.PREMATCH_WINDOW_PRIMARY_HOURS, 6);
    const prefetchHours = parsePositiveNumber(process.env.PREMATCH_WINDOW_PREFETCH_HOURS, 6);
    const overlapMinutes = parsePositiveNumber(process.env.PREMATCH_WINDOW_OVERLAP_MINUTES, 30);
    const totalHours = primaryHours + prefetchHours;

    const startDate = new Date(now.getTime() - (overlapMinutes * 60 * 1000));
    const primaryEndDate = new Date(now.getTime() + (primaryHours * 60 * 60 * 1000));
    const endDate = new Date(now.getTime() + (totalHours * 60 * 60 * 1000));

    return {
        now,
        startDate,
        primaryEndDate,
        endDate,
        overlapMinutes,
        primaryHours,
        prefetchHours,
        totalHours
    };
}

async function fetchMarketsForMatch(matchId) {
    try {
        return await pinnacleClient.get(`/matchups/${matchId}/markets/related/straight`);
    } catch (e) {
        console.error(`❌ Error fetching markets for ${matchId}: ${e.message}`);
        return [];
    }
}

async function fetchRelated(matchId) {
    try {
        return await pinnacleClient.get(`/matchups/${matchId}/related`);
    } catch (e) {
        return [];
    }
}

function processMoneyline(markets) {
    const mlMarket = markets.find(m => m.key === 's;0;m' && m.status === 'open');
    if (!mlMarket || !mlMarket.prices) return null;

    const prices = {};
    mlMarket.prices.forEach(p => {
        const decimal = americanToDecimal(p.price);
        if (decimal) prices[p.designation] = Number(decimal.toFixed(3));
    });

    return {
        home: prices.home || null,
        away: prices.away || null,
        draw: prices.draw || null
    };
}

function processTotals(markets) {
    // Buscar mercados de tipo 'total' para el periodo 0 (partido completo)
    // El endpoint /straight puede devolver múltiples líneas (incluyendo alternativos)
    const totalMarkets = markets.filter(m => m.type === 'total' && m.period === 0 && m.status === 'open');
    if (totalMarkets.length === 0) return [];

    const lines = [];
    totalMarkets.forEach(m => {
        const overPrice = m.prices.find(p => p.designation === 'over');
        const underPrice = m.prices.find(p => p.designation === 'under');
        
        // Usar puntos del precio o del mercado si existe
        const points = overPrice?.points || m.points; 

        if (points && overPrice && underPrice) {
            lines.push({
                line: points,
                over: Number(americanToDecimal(overPrice.price).toFixed(3)),
                under: Number(americanToDecimal(underPrice.price).toFixed(3))
            });
        }
    });

    // Ordenar por línea para facilitar lectura (ej. 1.5, 2.5, 3.5)
    return lines.sort((a, b) => a.line - b.line);
}

function processBTTS(markets, participants) {
    // BTTS es un moneyline dentro del matchup especial
    // Usamos los IDs de participantes (Yes/No) obtenidos de la API 'related'
    const ml = markets.find(m => m.type === 'moneyline' && m.period === 0 && m.status === 'open');
    if (!ml || !ml.prices || !participants) return null;

    // Búsqueda insensible a mayúsculas
    const partYes = participants.find(p => p.name && p.name.toLowerCase() === 'yes');
    const partNo = participants.find(p => p.name && p.name.toLowerCase() === 'no');

    if (!partYes || !partNo) return null;

    let priceYes = null;
    let priceNo = null;

    ml.prices.forEach(p => {
        const decimal = americanToDecimal(p.price);
        if (decimal) {
             if (p.participantId === partYes.id) {
                 priceYes = Number(decimal.toFixed(3));
             } else if (p.participantId === partNo.id) {
                 priceNo = Number(decimal.toFixed(3));
             }
        }
    });

    if (priceYes && priceNo) {
        return { yes: priceYes, no: priceNo };
    }
    return null;
}

export const ingestPinnaclePrematch = async (force = false, options = {}) => {
    await initDB();
    await db.read();

    const incrementalFlushEnabledFromEnv = parseEnvBoolean(
        process.env.PINNACLE_INGEST_INCREMENTAL_FLUSH_ENABLED,
        true
    );
    const incrementalFlushEnabled =
        typeof options.incrementalFlushEnabled === 'boolean'
            ? options.incrementalFlushEnabled
            : incrementalFlushEnabledFromEnv;
    const incrementalFlushEveryLeaguesRaw = Number.parseInt(
        process.env.PINNACLE_INGEST_INCREMENTAL_FLUSH_EVERY_LEAGUES || '8',
        10
    );
    const incrementalFlushEveryLeagues = Number.isFinite(incrementalFlushEveryLeaguesRaw) && incrementalFlushEveryLeaguesRaw > 0
        ? incrementalFlushEveryLeaguesRaw
        : 8;

    if (!incrementalFlushEnabled) {
        console.log('🧱 Flush incremental desactivado (PINNACLE_INGEST_INCREMENTAL_FLUSH_ENABLED=false).');
    }

    const existingMatches = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
    const existingById = new Map(existingMatches.map(m => [String(m.id), m]));

    // --- SMART SKIP LOGIC ---
    if (!force && db.data.pinnacleLastUpdate) {
        const lastRun = new Date(db.data.pinnacleLastUpdate).getTime();
        const nowMs = Date.now();
        const diffMins = (nowMs - lastRun) / 60000;
        
        if (diffMins < 100) { // 100 Minutos (1h 40m) de protección
            console.log(`⏳ INGESTA PINNACLE OMITIDA: Datos frescos (${diffMins.toFixed(1)} mins)`);
            return;
        }
    }

    console.log("🚀 INICIANDO INGESTA PINNACLE (Camaleón Mode)...");

    // 1. Fetch Active Leagues
    let leagues = [];
    try {
        console.log("📡 Obteniendo ligas activas...");
        const data = await pinnacleClient.get('/sports/29/leagues', { hasMatchups: true });
        
        // Response is array directly
        leagues = data.filter(l => l.matchupCount > 0);

    } catch (e) {
        console.error("❌ Error obteniendo ligas:", e.message);
        return;
    }

    // 2. Define Date Range (ventana híbrida deslizante)
    const windowCfg = getPrematchHybridWindow();
    const now = windowCfg.now;
    const futureStart = windowCfg.startDate;
    const futureLimit = windowCfg.endDate;

    console.log(
        `🧭 Ventana híbrida Pinnacle: ${futureStart.toISOString()} -> ${futureLimit.toISOString()} ` +
        `(primaria +${windowCfg.primaryHours}h, precarga +${windowCfg.prefetchHours}h, overlap ${windowCfg.overlapMinutes}m).`
    );

    let refinedMatches = [];
    let processedLeagues = 0;
    
    leagues.sort((a, b) => b.matchupCount - a.matchupCount);
    const MAX_LEAGUES_TO_CHECK = 100;

    for (const league of leagues) {
        if (processedLeagues >= MAX_LEAGUES_TO_CHECK) break;

        try {
            const matchesResponse = await pinnacleClient.get(`/leagues/${league.id}/matchups`);
            // Pinnacle a veces devuelve un objeto { code: '...', leagues: [...] } o array directo? 
            // Ojo: En endpoints de matchups suele ser array directo o wrapper.
            
            // Normalizar si viene envuelto
            const matches = Array.isArray(matchesResponse) ? matchesResponse : (matchesResponse.matchups || []);
            
            const relevant = matches.filter(m => {
                if (!m.startTime) return false;
                const date = new Date(m.startTime);
                // Debug log for first few matches
                // if (Math.random() < 0.05) console.log(`Debug Match Date: ${date.toISOString()} vs Limit: ${futureLimit.toISOString()}`);
                return date >= futureStart && date <= futureLimit && m.type === 'matchup' && m.parentId === null; 
            });

            if (matches.length > 0 && relevant.length === 0) {
                 console.log(`⚠️ ${league.name}: ${matches.length} partidos encontrados, pero 0 en rango (Filtro: ${futureLimit.toISOString()})`);
            }

            if (relevant.length > 0) {
                console.log(`   Analizando ${league.name}: ${relevant.length} partidos.`);
                
                for (const match of relevant) {
                    await sleep(100); // Throttling
                    
                    // 1. Fetch Main Markets (Moneyline + Totals)
                    const markets = await fetchMarketsForMatch(match.id);
                    const oddsML = processMoneyline(markets);
                    const oddsTotals = processTotals(markets);
                    
                    // 2. Fetch Helper Markets (BTTS) via Related API
                    let oddsBTTS = null;
                    try {
                        const related = await fetchRelated(match.id);
                        const bttsSpec = related.find(r => 
                            r.special && 
                            r.special.description && 
                            r.special.description.toLowerCase().includes('both teams to score')
                        );

                        if (bttsSpec) {
                            await sleep(50); // Extra sleep for 2nd call
                            const bttsMarkets = await fetchMarketsForMatch(bttsSpec.id);
                            oddsBTTS = processBTTS(bttsMarkets, bttsSpec.participants);
                        }
                    } catch (err) {
                        // Silent fail for optional markets
                        // console.warn(`⚠️ Error BTTS para ${match.id}: ${err.message}`);
                    }

                    if (oddsML && oddsML.home && oddsML.away) {
                        const existing = existingById.get(String(match.id)) || {};
                        refinedMatches.push({
                            id: match.id.toString(),
                            home: match.participants.find(p => p.alignment === 'home')?.name, 
                            homeId: match.participants.find(p => p.alignment === 'home')?.id,
                            away: match.participants.find(p => p.alignment === 'away')?.name, 
                            awayId: match.participants.find(p => p.alignment === 'away')?.id,
                            date: match.startTime, 
                            league: { name: league.name },
                            bookmaker: "Pinnacle",
                            odds: {
                                ...oddsML,         // home, draw, away
                                totals: oddsTotals, // array of {line, over, under}
                                btts: oddsBTTS      // {yes, no} or null
                            },
                            // Preservar link metadata existente para no perder enlaces al reiniciar.
                            altenarId: existing.altenarId ?? null,
                            altenarName: existing.altenarName ?? null,
                            linkSource: existing.linkSource ?? null,
                            linkUpdatedAt: existing.linkUpdatedAt ?? null
                        });
                        console.log(`      ✅ Agregado: ${match.participants.find(p => p.alignment === 'home')?.name} vs ${match.participants.find(p => p.alignment === 'away')?.name}`);
                    } else {
                        console.log(`      ⚠️ Sin cuotas ML: ${match.id} (Markets: ${markets.length})`);
                    }
                }
            }
        } catch (e) {}
        processedLeagues++;
        
        // --- INCREMENTAL SAVE (Anti-Crash) ---
        // Reducimos frecuencia de flush para bajar colisiones de escritura con OneDrive.
        const shouldFlushIncremental =
            incrementalFlushEnabled &&
            processedLeagues % incrementalFlushEveryLeagues === 0;
        if (shouldFlushIncremental) {
            try {
                const existing = db.data.upcomingMatches || [];
                const preserveStartMs = futureStart.getTime() - (windowCfg.overlapMinutes * 60 * 1000);
                const preserveEndMs = futureLimit.getTime();

                const kept = existing.filter(old => {
                    const oldTs = new Date(old.date).getTime();
                    const replaced = refinedMatches.some(newM => newM.id === old.id);
                    const inWindow = Number.isFinite(oldTs) && oldTs >= preserveStartMs && oldTs <= preserveEndMs;
                    return inWindow && !replaced;
                });

                const merged = [...kept, ...refinedMatches].sort((a, b) => new Date(a.date) - new Date(b.date));
                db.data.upcomingMatches = merged;
                db.data.pinnacleLastUpdate = new Date().toISOString();
                await writeDBWithRetry({ maxAttempts: 12, baseDelayMs: 140 });
            } catch (saveErr) {
                console.error("   ❌ Error saving progress:", saveErr.message);
            }
        }
    }

    console.log(`💾 Fusionando versión final...`);

    // --- LÓGICA DE FUSIÓN (MERGE) ---
    // 1. Cargar partidos existentes
    const existingMatchesFinal = db.data.upcomingMatches || [];
    
    // 2. Definir ventana de preservación: horizonte híbrido activo
    const preserveStartMs = futureStart.getTime() - (windowCfg.overlapMinutes * 60 * 1000);
    const preserveEndMs = futureLimit.getTime();

    const keptMatches = existingMatchesFinal.filter(oldMatch => {
        const oldTs = new Date(oldMatch.date).getTime();
        const inWindow = Number.isFinite(oldTs) && oldTs >= preserveStartMs && oldTs <= preserveEndMs;
        
        // Criterio 2: Aún no ha sido reemplazado por la nueva descarga
        const isReplacedByNew = refinedMatches.some(newMatch => newMatch.id === oldMatch.id);
        
        return inWindow && !isReplacedByNew;
    });

    console.log(`   ♻️  Preservando ${keptMatches.length} partidos previos de ventana híbrida.`);
    console.log(`   🆕 Insertando/Actualizando ${refinedMatches.length} partidos frescos desde API.`);

    // Guard anti-vaciado: si Pinnacle no devolvió partidos frescos (p. ej. mantenimiento/rate-limit),
    // no pisamos la cache local con 0 y mantenemos los datos previos para que el matcher no quede ciego.
    if (refinedMatches.length === 0 && existingMatchesFinal.length > 0) {
        console.warn('⚠️ Ingesta Pinnacle sin partidos frescos. Se conserva upcomingMatches actual para evitar wipe por outage temporal.');
        db.data.lastUpdate = new Date().toISOString();
        await writeDBWithRetry({ maxAttempts: 8, baseDelayMs: 140 });
        return;
    }

    // 3. Fusionar Listas
    const finalMatchList = [...keptMatches, ...refinedMatches];
    
    // Ordenar cronológicamente
    finalMatchList.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Save to DB
    db.data.upcomingMatches = finalMatchList; 
    db.data.lastUpdate = new Date().toISOString(); // General
    db.data.pinnacleLastUpdate = new Date().toISOString(); // Específico
    await writeDBWithRetry({ maxAttempts: 16, baseDelayMs: 180 });
    
    console.log(`✅ INGESTA PINNACLE COMPLETADA. Total: ${finalMatchList.length} partidos en DB.`);
}

// Ejecución directa desde CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const force = process.argv.includes('--force');
    const noIncrementalFlush = process.argv.includes('--no-incremental-flush');
    ingestPinnaclePrematch(force, {
        incrementalFlushEnabled: noIncrementalFlush ? false : undefined
    })
        .then(() => {
            process.exit(0);
        })
        .catch((error) => {
            console.error(`❌ Ingesta Pinnacle falló: ${error?.message || error}`);
            process.exit(1);
        });
}
