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

export const ingestPinnaclePrematch = async () => {
    console.log("🚀 INICIANDO INGESTA PINNACLE (Camaleón Mode)...");
    await initDB();

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

    // 2. Define Date Range (SOLO HOY para minimizar tráfico y riesgo)
    const now = new Date();
    const futureLimit = new Date();
    futureLimit.setHours(23, 59, 59, 999); // Final de hoy
    // futureLimit.setDate(now.getDate() + 2); // ANTES: 48 Horas
    
    console.log(`📅 Filtrando partidos desde AHORA hasta: ${futureLimit.toISOString()}`);

    let refinedMatches = [];
    let processedLeagues = 0;
    
    leagues.sort((a, b) => b.matchupCount - a.matchupCount);
    const MAX_LEAGUES_TO_CHECK = 100;

    for (const league of leagues) {
        if (processedLeagues >= MAX_LEAGUES_TO_CHECK) break;

        try {
            const matches = await pinnacleClient.get(`/leagues/${league.id}/matchups`);
            
            const relevant = matches.filter(m => {
                if (!m.startTime) return false;
                const date = new Date(m.startTime);
                return date >= now && date <= futureLimit && m.type === 'matchup' && m.parentId === null; 
            });

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
                            }
                        });
                    }
                }
            }
        } catch (e) {}
        processedLeagues++;
    }

    console.log(`💾 Fusionando partidos...`);

    // --- LÓGICA DE FUSIÓN (MERGE) PARA NO PERDER LIVE MATCHES ---
    // 1. Cargar partidos existentes
    const existingMatches = db.data.upcomingMatches || [];
    
    // 2. Definir ventana de preservación: TODO EL DÍA DE HOY
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const keptMatches = existingMatches.filter(oldMatch => {
        const oldDate = new Date(oldMatch.date);
        
        // Criterio: Es de HOY y no ha sido reemplazado por la nueva data
        const isToday = oldDate >= startOfToday && oldDate <= endOfToday;
        
        // Si el partido "nuevo" ya existe en lo que acabamos de descargar, NO lo guardamos del viejo
        // (Dejamos que la versión nueva, actualizada, tome el lugar)
        const isReplacedByNew = refinedMatches.some(newMatch => newMatch.id === oldMatch.id);
        
        return isToday && !isReplacedByNew;
    });

    console.log(`   ♻️  Preservando ${keptMatches.length} partidos previos de HOY (en curso/recientes).`);
    console.log(`   🆕 Insertando/Actualizando ${refinedMatches.length} partidos frescos desde API.`);

    // 3. Fusionar Listas
    const finalMatchList = [...keptMatches, ...refinedMatches];
    
    // Ordenar cronológicamente
    finalMatchList.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Save to DB
    db.data.upcomingMatches = finalMatchList; 
    db.data.lastUpdate = new Date().toISOString();
    await db.write();
    
    console.log(`✅ INGESTA PINNACLE COMPLETADA. Total: ${finalMatchList.length} partidos en DB.`);
}

// Ejecución directa desde CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    ingestPinnaclePrematch();
}
