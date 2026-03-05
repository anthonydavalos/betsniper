import { americanToDecimal } from '../src/utils/oddsConverter.js';
import db, { initDB } from '../src/db/database.js';
import { fileURLToPath } from 'url';
import { pinnacleClient } from '../src/config/pinnacleClient.js';

// --- CONFIGURATION ---
// Headers y API Key manejados por pinnacleClient

// --- HELPERS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

export const ingestPinnaclePrematch = async (force = false) => {
    await initDB();
    await db.read();

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

    // 2. Define Date Range (HORIZONTE DINÁMICO)
    // Estrategia:
    // - Mañana (< 12:00 PM Perú): Descargar solo hasta el final de HOY.
    // - Tarde   (>= 12:00 PM Perú): Descargar hasta el final de MAÑANA.
    const now = new Date();
    const peruTime = new Date().toLocaleString("en-US", { timeZone: "America/Lima" });
    const currentHourPeru = new Date(peruTime).getHours();
    
    // CAMBIO A 6 PM (18:00): Antes de eso, foco total en liquidar el día.
    const futureLimit = new Date();
    if (currentHourPeru >= 18) {
        // Noche: Extender hasta el final de MAÑANA (para preparar sesión de madrugada)
        futureLimit.setDate(futureLimit.getDate() + 1);
        console.log(`🕒 Modo Noche (${currentHourPeru}:00 PE): Extendiendo búsqueda hasta mañana.`);
    } else {
        // Día: Buscando solo partidos de hoy (sin ruido futuro)
        console.log(`🕒 Modo Operativo (${currentHourPeru}:00 PE): Buscando solo partidos de hoy.`);
    }
    futureLimit.setHours(23, 59, 59, 999);
    
    console.log(`📅 Filtrando partidos desde AHORA hasta: ${futureLimit.toISOString()}`);

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
                return date >= now && date <= futureLimit && m.type === 'matchup' && m.parentId === null; 
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
        try {
            const existing = db.data.upcomingMatches || [];
            const getPeruDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
            const todayStr = getPeruDate(new Date());
            
            // Recalculate Kept Matches based on current refinedMatches state
            // Note: This is slightly inefficient (O(N^2)) but safe for 100s of matches
            const kept = existing.filter(old => {
                const dStr = getPeruDate(old.date);
                const replaced = refinedMatches.some(newM => newM.id === old.id);
                return dStr === todayStr && !replaced;
            });
            
            const merged = [...kept, ...refinedMatches].sort((a, b) => new Date(a.date) - new Date(b.date));
            db.data.upcomingMatches = merged;
            db.data.pinnacleLastUpdate = new Date().toISOString();
            await db.write();
            // console.log(`   💾 Saved progress: ${merged.length} total matches.`);
        } catch (saveErr) {
            console.error("   ❌ Error saving progress:", saveErr.message);
        }
    }

    console.log(`💾 Fusionando versión final...`);

    // --- LÓGICA DE FUSIÓN (MERGE) ---
    // 1. Cargar partidos existentes
    const existingMatchesFinal = db.data.upcomingMatches || [];
    
    // 2. Definir ventana de preservación: DÍA CALENDARIO ACTUAL (PERÚ UTC-5)
    // Usamos 'en-CA' para obtener formato YYYY-MM-DD ajustado a la zona horaria
    const getPeruDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const todayStr = getPeruDate(new Date());

    const keptMatches = existingMatchesFinal.filter(oldMatch => {
        // Extraer fecha base (YYYY-MM-DD) del partido según Perú
        const matchDateStr = getPeruDate(oldMatch.date);
        
        // Criterio 1: Pertenece al día de HOY
        const belongsToToday = matchDateStr === todayStr;
        
        // Criterio 2: Aún no ha sido reemplazado por la nueva descarga
        const isReplacedByNew = refinedMatches.some(newMatch => newMatch.id === oldMatch.id);
        
        return belongsToToday && !isReplacedByNew;
    });

    console.log(`   ♻️  Preservando ${keptMatches.length} partidos previos de HOY (Perú).`);
    console.log(`   🆕 Insertando/Actualizando ${refinedMatches.length} partidos frescos desde API.`);

    // 3. Fusionar Listas
    const finalMatchList = [...keptMatches, ...refinedMatches];
    
    // Ordenar cronológicamente
    finalMatchList.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Save to DB
    db.data.upcomingMatches = finalMatchList; 
    db.data.lastUpdate = new Date().toISOString(); // General
    db.data.pinnacleLastUpdate = new Date().toISOString(); // Específico
    await db.write();
    
    console.log(`✅ INGESTA PINNACLE COMPLETADA. Total: ${finalMatchList.length} partidos en DB.`);
}

// Ejecución directa desde CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const force = process.argv.includes('--force');
    ingestPinnaclePrematch(force);
}
