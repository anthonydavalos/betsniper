import axios from 'axios';
import { randomUUID } from 'crypto';
import { americanToDecimal } from '../src/utils/oddsConverter.js';
import db, { initDB } from '../src/db/database.js';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const API_KEY = 'PINNACLE_API_KEY_PLACEHOLDER';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'host': 'guest.api.arcadia.pinnacle.com',
    'X-API-Key': API_KEY,
};

// --- HELPERS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchMarketsForMatch(matchId) {
    const DEVICE_UUID = randomUUID(); // Use fresh UUID
    try {
        const { data } = await axios.get(`https://guest.api.arcadia.pinnacle.com/0.1/matchups/${matchId}/markets/related/straight`, { 
            headers: { ...HEADERS, 'X-Device-UUID': DEVICE_UUID } 
        });
        return data;
    } catch (e) {
        return [];
    }
}

async function fetchRelated(matchId) {
    const DEVICE_UUID = randomUUID();
    try {
        const { data } = await axios.get(`https://guest.api.arcadia.pinnacle.com/0.1/matchups/${matchId}/related`, { 
            headers: { ...HEADERS, 'X-Device-UUID': DEVICE_UUID } 
        });
        return data;
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

    const partYes = participants.find(p => p.name === 'Yes');
    const partNo = participants.find(p => p.name === 'No');

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

async function run() {
    console.log("🚀 INICIANDO INGESTA PINNACLE (Reemplazo API-Sports)...");
    await initDB();

    const DEVICE_UUID = randomUUID();
    
    // 1. Fetch Active Leagues
    let leagues = [];
    try {
        console.log("📡 Obteniendo ligas activas...");
        const sportsRes = await axios.get(`https://guest.api.arcadia.pinnacle.com/0.1/sports/29/leagues?hasMatchups=true`, { 
            headers: { ...HEADERS, 'X-Device-UUID': DEVICE_UUID } 
        });
        leagues = sportsRes.data.filter(l => l.matchupCount > 0);
    } catch (e) {
        console.error("❌ Error obteniendo ligas:", e.message);
        return;
    }

    // 2. Define Date Range (Next 48 Hours)
    const now = new Date();
    const futureLimit = new Date();
    futureLimit.setDate(now.getDate() + 2); 

    let refinedMatches = [];
    let processedLeagues = 0;
    
    leagues.sort((a, b) => b.matchupCount - a.matchupCount);
    const MAX_LEAGUES_TO_CHECK = 100;

    for (const league of leagues) {
        if (processedLeagues >= MAX_LEAGUES_TO_CHECK) break;

        try {
            const matchesUrl = `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${league.id}/matchups`;
            const { data: matches } = await axios.get(matchesUrl, { 
                headers: { ...HEADERS, 'X-Device-UUID': randomUUID() } 
            });
            
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
                            r.special.description.includes('Both Teams To Score')
                        );

                        if (bttsSpec) {
                            await sleep(50); // Extra sleep for 2nd call
                            const bttsMarkets = await fetchMarketsForMatch(bttsSpec.id);
                            oddsBTTS = processBTTS(bttsMarkets, bttsSpec.participants);
                        }
                    } catch (err) {
                        // Silent fail for optional markets
                    }

                    if (oddsML && oddsML.home && oddsML.away) {
                        refinedMatches.push({
                            id: match.id.toString(),
                            home: match.participants.find(p => p.alignment === 'home')?.name, 
                            away: match.participants.find(p => p.alignment === 'away')?.name, 
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

    console.log(`💾 Guardando ${refinedMatches.length} partidos de Pinnacle en DB...`);
    
    // Save to DB replacing the old collection
    db.data.upcomingMatches = refinedMatches; 
    db.data.lastUpdate = new Date().toISOString();
    await db.write();
    
    console.log("✅ INGESTA PINNACLE COMPLETADA.");
}

run();
