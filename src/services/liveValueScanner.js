import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { calculateKellyStake } from '../utils/mathUtils.js';

// =====================================================================
// SERVICE: LIVE VALUE SCANNER v2
// Estrategia: Value Investing Live (Pinnacle como Source of Truth)
// Soporta: Match Result (1x2), Double Chance, Totals (Over/Under)
// =====================================================================

/**
 * Obtiene un resumen ligero de TODOS los partidos en vivo de fútbol.
 */
export const getLiveOverview = async () => {
    try {
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { sportId: 66, categoryId: 0 }
        });
        
        return (data.events || []).map(ev => {
             const status = ev.ls || ""; 
             let cleanTime = ev.liveTime;
             const minutes = parseInt((ev.liveTime || "0").replace("'", "")) || 0;

             // Detectar Extra Time / Prórrogas / Penales
             const isExtraTime = minutes >= 90 || 
                               status.toLowerCase().includes('adicional') || 
                               status.toLowerCase().includes('prórroga') ||
                               status.toLowerCase().includes('penal');

             if (isExtraTime) {
                 cleanTime = "Final"; 
             }
             
             return {
                 ...ev,
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
            params: { eventId }
        });
        return data; 
    } catch (error) {
        return null; 
    }
};

/**
 * ESCÁNER DE OPORTUNIDADES LIVE
 * @param {Array} preFetchedEvents - (Opcional) Eventos raw ya obtenidos para ahorrar calls.
 */
export const scanLiveOpportunities = async (preFetchedEvents = null) => {
    await initDB(); 
    const pinnacleDb = db.data.upcomingMatches || [];
    
    // Mapa: AltenarID -> PinnacleMatchData
    const linkedMatches = new Map();
    pinnacleDb.forEach(m => {
        if (m.altenarId) linkedMatches.set(m.altenarId, m);
    });

    // Obtener vista general (Usar pre-fetched o llamar API)
    const liveEvents = preFetchedEvents || await getLiveOverview();
    const opportunities = [];

    console.log(`📡 Escaneando en vivo (V2 Value)... (${liveEvents.length} eventos, ${linkedMatches.size} links)`);

    // Import dinámico de servicios Pinnacle
    const { getAllPinnacleLiveOdds } = await import('./pinnacleService.js');

    // Filtramos links y evitamos partidos finalizados/prórroga
    const activeLinkedEvents = liveEvents.filter(e => linkedMatches.has(e.id) && e.liveTime !== 'Final');

    if (activeLinkedEvents.length === 0) return [];

    // --- NUEVO: OBTENER SNAPSHOT MASIVO (Estrategia "The Firehose") ---
    // En lugar de 1 call por partido, hacemos 1 call gigante
    const globalPinnacleOdds = await getAllPinnacleLiveOdds();
    
    // console.log(`   ℹ️ Analizando ${activeLinkedEvents.length} partidos vinculados...`);

    for (const event of activeLinkedEvents) {
        const pinMatch = linkedMatches.get(event.id);
        
        // --- PASO 1: PINNACLE LIVE ODDS (FROM MEMORY) ---
        // Buscamos en el Mapa Global descargado
        const pinLiveOdds = globalPinnacleOdds.get(Number(pinMatch.id));
        
        if (!pinLiveOdds) {
             // Si no está en el mapa global, quizás cerró apuestas. Skip.
             continue; 
        } 

        // --- PASO 2: ALTENAR DETAILS (BOOKMAKER) ---
        let details;
        try {
            details = await getEventDetails(event.id);
        } catch (e) { continue; }

        if (!details || !details.markets) continue;

        const altenarOddsMap = new Map();
        if (details.odds && Array.isArray(details.odds)) {
            details.odds.forEach(o => altenarOddsMap.set(o.id, o));
        }

        // --- PASO 3: ANÁLISIS POR ESTRATEGIA ---

        // >>> ESTRATEGIA A: 1X2 (MATCH RESULT) <<<
        const market1x2 = details.markets.find(m => m.typeId === 1); 
        if (market1x2 && pinLiveOdds.moneyline) {
            const oddIds = (market1x2.desktopOddIds || []).flat(); 
            const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);
            
            const altHome = oddsObjs.find(o => o.typeId === 1);
            const altDraw = oddsObjs.find(o => o.typeId === 2);
            const altAway = oddsObjs.find(o => o.typeId === 3);

            if (altHome && pinLiveOdds.moneyline.home) checkAndAddOpp(opportunities, event, pinMatch, 'Match Winner', 'Home', altHome.price, pinLiveOdds.moneyline.home, pinLiveOdds.moneyline);
            if (altAway && pinLiveOdds.moneyline.away) checkAndAddOpp(opportunities, event, pinMatch, 'Match Winner', 'Away', altAway.price, pinLiveOdds.moneyline.away, pinLiveOdds.moneyline);
            if (altDraw && pinLiveOdds.moneyline.draw) checkAndAddOpp(opportunities, event, pinMatch, 'Match Winner', 'Draw', altDraw.price, pinLiveOdds.moneyline.draw, pinLiveOdds.moneyline);
        }

        // >>> ESTRATEGIA B: DOUBLE CHANCE (DOBLE OPORTUNIDAD) <<<
        const marketDC = details.markets.find(m => m.typeId === 10);
        if (marketDC && pinLiveOdds.doubleChance) {
            const oddIds = (marketDC.desktopOddIds || []).flat();
            const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);

            const cand1X = oddsObjs.find(o => o.name.includes(event.name.split(' vs ')[0]) || o.name.includes('1X')); 
            const candX2 = oddsObjs.find(o => (event.name.split(' vs ')[1] && o.name.includes(event.name.split(' vs ')[1])) || o.name.includes('X2'));

            if (cand1X && pinLiveOdds.doubleChance.homeDraw) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', '1X', cand1X.price, pinLiveOdds.doubleChance.homeDraw, pinLiveOdds.doubleChance);
            if (candX2 && pinLiveOdds.doubleChance.drawAway) checkAndAddOpp(opportunities, event, pinMatch, 'Double Chance', 'X2', candX2.price, pinLiveOdds.doubleChance.drawAway, pinLiveOdds.doubleChance);
        }

        // >>> ESTRATEGIA C: OVER/UNDER (TOTAL GOALS) <<<
        const totalMarkets = details.markets.filter(m => m.typeId === 18 || m.name.includes('Total') || m.name.includes('Goles'));
        if (totalMarkets.length > 0 && pinLiveOdds.totals && pinLiveOdds.totals.length > 0) {
            
            for (const mTotal of totalMarkets) {
                let line = mTotal.activeLine || mTotal.specialOddValue; 
                if (!line) {
                    const matchIdx = mTotal.name.match(/(\d+\.?\d*)/);
                    if (matchIdx) line = parseFloat(matchIdx[0]);
                }

                if (!line) continue;

                // Buscar linea equivalente en Pinnacle
                const pinLineObj = pinLiveOdds.totals.find(t => Math.abs(t.line - line) < 0.1);
                
                if (pinLineObj) {
                    const oddIds = (mTotal.desktopOddIds || []).flat();
                    const oddsObjs = oddIds.map(id => altenarOddsMap.get(id)).filter(Boolean);

                    const altOver = oddsObjs.find(o => o.name.toLowerCase().includes('más') || o.name.toLowerCase().includes('over'));
                    const altUnder = oddsObjs.find(o => o.name.toLowerCase().includes('menos') || o.name.toLowerCase().includes('under'));

                    if (altOver && pinLineObj.over) checkAndAddOpp(opportunities, event, pinMatch, `Total Goals ${line}`, 'Over', altOver.price, pinLineObj.over, pinLineObj);
                    if (altUnder && pinLineObj.under) checkAndAddOpp(opportunities, event, pinMatch, `Total Goals ${line}`, 'Under', altUnder.price, pinLineObj.under, pinLineObj);
                }
            }
        }
    } 

    if (opportunities.length > 0) {
        console.log(`✅ ${opportunities.length} OPORTUNIDADES ENCONTRADAS.`);
    }

    return opportunities;
};


/**
 * HELPER: Evaluar EV y Kelly
 */
const checkAndAddOpp = (opsArray, event, pinMatch, marketName, selection, altOdd, pinOdd, contextGroup) => {
    // 1. Validar Cuotas
    if (altOdd < 1.05 || altOdd > 100) return;
    if (!pinOdd || pinOdd <= 1) return;

    // 2. Calcular Probabilidad Real (Fair)
    let totalImplied = 0;
    
    if (contextGroup.home !== undefined && contextGroup.away !== undefined) {
        totalImplied = (1/contextGroup.home) + (1/contextGroup.away) + (1/(contextGroup.draw || 999));
    } else if (contextGroup.homeDraw !== undefined) {
        totalImplied = (1/contextGroup.homeDraw) + (1/contextGroup.homeAway) + (1/contextGroup.drawAway);
    } else if (contextGroup.over !== undefined) {
        totalImplied = (1/contextGroup.over) + (1/contextGroup.under);
    }
    
    if (totalImplied === 0) totalImplied = 1.05;

    const rawProb = 1 / pinOdd;
    const fairProb = rawProb / totalImplied; 
    const fairPrice = 1 / fairProb;

    // 3. EV y Kelly
    const ev = (fairProb * altOdd) - 1;
    const kellyRes = calculateKellyStake(fairProb * 100, altOdd, db.data.portfolio.balance || 1000); 

    if (ev > 0.02 && kellyRes.amount > 0) {
        const safeStake = marketName.includes('Winner') ? kellyRes.amount : kellyRes.amount * 0.5;

        // console.log(`   🔥 VALOR DETECTADO: ${event.name} | ${marketName} ${selection} | Alt: ${altOdd} vs Real: ${fairPrice.toFixed(2)} | EV: ${(ev*100).toFixed(1)}%`);
        
        opsArray.push({
            type: 'LIVE_VALUE',
            eventId: event.id,
            pinnacleId: pinMatch.id,
            match: event.name,
            league: pinMatch.league.name,
            market: marketName,
            selection: selection,
            price: altOdd,
            realPrice: Number(fairPrice.toFixed(2)),
            
            ev: Number((ev * 100).toFixed(2)),
            kellyStake: Number(safeStake.toFixed(2)),
            
            // CRITICAL FIX: Pass realProb (as Percentage) to paperTradingService
            realProb: Number((fairProb * 100).toFixed(2)), 

            time: event.liveTime,
            score: (event.score || []).join("-"),
            foundAt: new Date().toISOString(),
            action: `BET ${selection} @ ${altOdd}`
        });
    }
};
