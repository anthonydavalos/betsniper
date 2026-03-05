import altenarClient from '../config/axiosClient.js';
import { getEventDetails } from './liveValueScanner.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { getKellyBankrollBase } from './bookyAccountService.js';

const normalizeMarketText = (value = '') => String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const is1x2MarketName = (value = '') => {
    const normalized = normalizeMarketText(value);
    return (
        normalized === '1x2' ||
        normalized === '1 x 2' ||
        normalized === 'match winner' ||
        normalized === 'match result' ||
        normalized === 'moneyline'
    );
};

const extractFirstNumber = (value = '') => {
    const normalized = normalizeMarketText(String(value).replace(',', '.'));
    const match = normalized.match(/(\d+(?:\.\d+)?)/);
    if (!match) return NaN;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : NaN;
};

const parseTotalsHint = (marketName = '', selectionName = '') => {
    const m = normalizeMarketText(marketName);
    const s = normalizeMarketText(selectionName);
    const combined = `${m} ${s}`;

    const side = combined.includes('under') || combined.includes('menos')
        ? 'under'
        : (combined.includes('over') || combined.includes('mas') || combined.includes('más') ? 'over' : null);

    const rawSelection = String(selectionName || '').trim();
    const rawMarket = String(marketName || '').trim();
    const hasAmbiguousSelectionLine = /\b\d+\.$/.test(rawSelection);

    const lineFromSelection = hasAmbiguousSelectionLine ? NaN : extractFirstNumber(selectionName);
    const lineFromMarket = extractFirstNumber(marketName);
    const line = Number.isFinite(lineFromMarket)
        ? lineFromMarket
        : (Number.isFinite(lineFromSelection)
        ? lineFromSelection
        : NaN);

    const lineFrom = Number.isFinite(lineFromMarket)
        ? 'market'
        : (Number.isFinite(lineFromSelection) ? 'selection' : (hasAmbiguousSelectionLine ? 'ambiguous' : 'none'));

    return { side, line, lineFrom, rawSelection, rawMarket };
};

/**
 * Refresca la cuota de una oportunidad Live utilizando la API de Altenar en tiempo real.
 * @param {Object} opportunity - Objeto oportunidad original
 * @returns {Promise<Object>} - Oportunidad actualizada o null si falló/cambió drásticamente
 */
export const refreshOpportunity = async (opportunity) => {
    try {
        if (!opportunity || !opportunity.eventId) throw new Error("ID de evento inválido");

        // 1. Fetch Fresh Details from Altenar
        const details = await getEventDetails(opportunity.eventId);
        if (!details || !details.markets) throw new Error("Evento no disponible o finalizado");

        // 2. Find the relevant market and selection
        // Necesitamos inferir el Market ID y Selection ID basado en el string "market" y "selection" de la op
        // Porque la op original no guardó los IDs explícitos (error de diseño previo, lo corregimos aquí con heurística)
        
        let targetOdd = null;
        let marketName = opportunity.market || '1x2'; // Default consistente con payload API
        let selectionName = opportunity.selection;
        const totalsHint = parseTotalsHint(marketName, selectionName);
        const isTotalsCandidate = normalizeMarketText(marketName).includes('total') ||
            totalsHint.side === 'over' ||
            totalsHint.side === 'under';

        for (const market of details.markets) {
            // Mapeo básico de nombres de mercado
            let isTargetMarket = false;
            // [FIX] Soporte canonical + legacy para 1x2
            if (is1x2MarketName(marketName) && (market.typeId === 1 || market.name === 'Match Result' || market.name === '1x2')) isTargetMarket = true;
            else if (marketName === 'Double Chance' && market.typeId === 10) isTargetMarket = true;
                else if (isTotalsCandidate && (market.typeId === 18 || normalizeMarketText(market.name).includes('total'))) {
                      // En Altenar un mismo market typeId=18 puede contener múltiples líneas
                      // (ej. 1.5, 2.5, 3.5) dentro de desktopOddIds. La línea se decide por odd, no por market.
                      isTargetMarket = true;
            }

            if (isTargetMarket) {
                const oddIds = (Array.isArray(market.desktopOddIds) ? market.desktopOddIds.flat() : market.oddIds || []);
                const oddsObjs = (details.odds || []).filter(o => oddIds.includes(o.id));
                
                // Buscar la selección correcta
                // A) Por tipo standard (1x2)
                if (is1x2MarketName(marketName)) {
                    if (selectionName === 'Home' && oddsObjs.some(o => o.typeId === 1)) targetOdd = oddsObjs.find(o => o.typeId === 1);
                    else if (selectionName === 'Draw' && oddsObjs.some(o => o.typeId === 2)) targetOdd = oddsObjs.find(o => o.typeId === 2);
                    else if (selectionName === 'Away' && oddsObjs.some(o => o.typeId === 3)) targetOdd = oddsObjs.find(o => o.typeId === 3);
                    // Fallback para '1', 'X', '2' si selectionName varía
                    else if (selectionName === '1' && oddsObjs.some(o => o.typeId === 1)) targetOdd = oddsObjs.find(o => o.typeId === 1);
                    else if (selectionName === 'X' && oddsObjs.some(o => o.typeId === 2)) targetOdd = oddsObjs.find(o => o.typeId === 2);
                    else if (selectionName === '2' && oddsObjs.some(o => o.typeId === 3)) targetOdd = oddsObjs.find(o => o.typeId === 3);
                } 
                // B) Por nombre (Double Chance / Totals)
                else {
                    // Match fuzzy por nombre
                    if (selectionName === 'Home' || selectionName === '1') selectionName = details.competitors?.find(c => c.isHome)?.name || "Home";
                    if (selectionName === 'Away' || selectionName === '2') selectionName = details.competitors?.find(c => !c.isHome)?.name || "Away";

                    const selectionLower = selectionName.toLowerCase();
                    
                    targetOdd = oddsObjs.find(o => {
                        const oName = (o.name || "").toLowerCase();
                        if (isTotalsCandidate) {
                            const oddLine = Number.isFinite(Number(o.line)) ? Number(o.line) : extractFirstNumber(o.name || '');
                            const strictLine = totalsHint.lineFrom === 'market';
                            const lineMatches = !strictLine || !Number.isFinite(totalsHint.line) || !Number.isFinite(oddLine)
                                ? true
                                : Math.abs(oddLine - totalsHint.line) < 0.11;

                            if (!lineMatches) return false;

                            if (totalsHint.side === 'over') {
                                return Number(o.typeId) === 12 || oName.includes('over') || oName.includes('más') || oName.includes('mas');
                            }
                            if (totalsHint.side === 'under') {
                                return Number(o.typeId) === 13 || oName.includes('under') || oName.includes('menos');
                            }
                        }
                        if (marketName === 'Double Chance') {
                            if (selectionName === '1X' && (oName.includes('1x') || oName.includes(details.name.split(' vs ')[0]))) return true;
                            if (selectionName === 'X2' && (oName.includes('x2') || oName.includes(details.name.split(' vs ')[1]))) return true;
                        }
                        return false;
                    });
                }
            }
            if (targetOdd) break;
        }

        if (!targetOdd) {
            throw new Error(`Cuota no encontrada para ${marketName} - ${selectionName}`);
        }

        // 3. Update Opportunity
        // Recalcular EV y Kelly con la nueva cuota
        const oldPrice = opportunity.price;
        const newPrice = targetOdd.price;
        
        // Asumimos que la Real Prob (Fair Price) se mantiene constante en el micro-segundo
        // (Sería ideal refrescar Pinnacle también, pero es mucho overhead. Confiamos en que la cuota de valor de Altenar es la variable rápida)
        const fairProb = opportunity.realProb ? (opportunity.realProb / 100) : (1 / (opportunity.realPrice || opportunity.pinnaclePrice));
        
        const newEV = (fairProb * newPrice) - 1;
        
        // Pass the strategy from original opportunity to scaling logic
        const strategy = opportunity.strategy || opportunity.type || 'LIVE_SNIPE';
        const bankrollBase = await getKellyBankrollBase();
        const bankroll = Number(bankrollBase?.amount);
        const kellyRes = calculateKellyStake(
            fairProb * 100,
            newPrice,
            Number.isFinite(bankroll) && bankroll > 0 ? bankroll : 100,
            strategy
        );
        
        // El ajuste por MarketName (Winner vs. Totals) ahora podría estar implícito 
        // en el STAKE DINAMICO, pero mantenemos esta capa extra si se desea.
        // Por consistencia con mathUtils, usamos kellyRes.amount directamente.
        const safeStake = kellyRes.amount;

        // Clone and Update
        const updatedOp = { ...opportunity };
        if (is1x2MarketName(marketName)) {
            updatedOp.market = '1x2';
        }
        updatedOp.price = newPrice;
        updatedOp.ev = Number((newEV * 100).toFixed(2));
        updatedOp.kellyStake = Number(safeStake.toFixed(2));
        updatedOp.kellyBankrollSource = bankrollBase?.source || null;
        updatedOp.lastUpdate = new Date().toISOString();

        console.log(`✅ Refresh Odds [${opportunity.match}]: ${oldPrice} -> ${newPrice} | Stake: ${updatedOp.kellyStake}`);
        
        return updatedOp;

    } catch (error) {
        console.error(`❌ Error refreshing odds for ${opportunity?.match}: ${error.message}`);
        // Si falla el refresh, devolvemos la op original PERO marcada como riesgosa o fallida?
        // Mejor lanzar error para abortar la apuesta si el usuario quería "Real Time"
        throw error;
    }
};