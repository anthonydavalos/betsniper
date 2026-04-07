import altenarClient from '../config/axiosClient.js';
import { getEventDetails } from './liveValueScanner.js';
import { calculateKellyStake } from '../utils/mathUtils.js';
import { getKellyBankrollBase } from './bookyAccountService.js';
import { getAllPinnaclePrematchOdds } from './pinnacleService.js';

const PREMATCH_REFRESH_RECALCULATE_PINNACLE = String(process.env.PREMATCH_REFRESH_RECALCULATE_PINNACLE || 'true').toLowerCase() !== 'false';
const PREMATCH_PINNACLE_CACHE_TTL_MS = Math.max(3000, Number(process.env.PREMATCH_PINNACLE_CACHE_TTL_MS || 15000));

let prematchPinnacleCache = {
    atMs: 0,
    oddsMap: null
};

const normalizeMarketText = (value = '') => String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[º°]/g, 'o')
    .replace(/ª/g, 'a')
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

const isDoubleChanceMarketName = (value = '') => {
    const normalized = normalizeMarketText(value);
    return normalized.includes('double chance') || normalized.includes('doble oportunidad');
};

const isHalfTimeMarketName = (value = '') => {
    const normalized = normalizeMarketText(value);

    const isHalfByNumericPattern = (
        (/\b1\b[^a-z0-9]{0,3}(half|mitad|tiempo)\b/.test(normalized)) ||
        (/\b2\b[^a-z0-9]{0,3}(half|mitad|tiempo)\b/.test(normalized)) ||
        (/(half|mitad|tiempo)\b[^a-z0-9]{0,3}\b1\b/.test(normalized)) ||
        (/(half|mitad|tiempo)\b[^a-z0-9]{0,3}\b2\b/.test(normalized))
    );

    if (isHalfByNumericPattern) return true;

    return (
        normalized.includes('1st half') ||
        normalized.includes('first half') ||
        normalized.includes('2nd half') ||
        normalized.includes('second half') ||
        normalized.includes('1er tiempo') ||
        normalized.includes('2do tiempo') ||
        normalized.includes('primer tiempo') ||
        normalized.includes('segundo tiempo') ||
        normalized.includes('1ra mitad') ||
        normalized.includes('2da mitad') ||
        normalized.includes('primera mitad') ||
        normalized.includes('segunda mitad') ||
        normalized.includes('1a mitad') ||
        normalized.includes('2a mitad') ||
        normalized.includes('half time') ||
        normalized.includes('halftime')
    );
};

const isFullTimeMarket = (market = {}) => {
    if (!market || typeof market !== 'object') return false;

    const periodRaw = market.period ?? market.periodId ?? market.periodNumber ?? market.p;
    const periodNum = Number(periodRaw);
    if (periodRaw !== undefined && periodRaw !== null && String(periodRaw).trim() !== '' && Number.isFinite(periodNum)) {
        if (periodNum !== 0) return false;
    }

    if (isHalfTimeMarketName(market.name || '')) return false;
    return true;
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

const normalizeTeamText = (value = '') => String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const splitMatchSides = (value = '') => {
    const parts = String(value || '').split(/\s+vs\.?\s+/i);
    return {
        home: String(parts[0] || '').trim(),
        away: String(parts[1] || '').trim()
    };
};

const isPrematchOpportunity = (opportunity = {}) => {
    const type = String(opportunity.type || opportunity.strategy || '').toUpperCase();
    if (type.includes('PREMATCH')) return true;
    const timeValue = String(opportunity.time || opportunity.liveTime || '').toUpperCase();
    return !timeValue || timeValue === 'PRE' || timeValue.includes('PREMATCH');
};

const getSelectionToken = (selection = '') => normalizeMarketText(selection).replace(/\s+/g, '');

const getCachedPinnaclePrematchMap = async () => {
    const now = Date.now();
    if (prematchPinnacleCache.oddsMap && (now - prematchPinnacleCache.atMs) <= PREMATCH_PINNACLE_CACHE_TTL_MS) {
        return prematchPinnacleCache.oddsMap;
    }

    const oddsMap = await getAllPinnaclePrematchOdds();
    prematchPinnacleCache = {
        atMs: now,
        oddsMap: oddsMap instanceof Map ? oddsMap : null
    };
    return prematchPinnacleCache.oddsMap;
};

const findPinnaclePrematchEntry = async (opportunity = {}) => {
    const map = await getCachedPinnaclePrematchMap();
    if (!map || map.size === 0) return null;

    const pinId = opportunity.pinnacleId ?? opportunity.pinnacleInfo?.id;
    if (pinId !== undefined && pinId !== null && String(pinId).trim() !== '') {
        const byRaw = map.get(pinId);
        const byNum = map.get(Number(pinId));
        const byStr = map.get(String(pinId));
        const direct = byRaw || byNum || byStr;
        if (direct) return direct;
    }

    const { home, away } = splitMatchSides(opportunity.match || '');
    const nHome = normalizeTeamText(home);
    const nAway = normalizeTeamText(away);
    if (!nHome || !nAway) return null;

    for (const item of map.values()) {
        const candHome = normalizeTeamText(item?.home || '');
        const candAway = normalizeTeamText(item?.away || '');
        if (candHome === nHome && candAway === nAway) {
            return item;
        }
    }

    return null;
};

const normalizeFairFromOdds = (targetOdd, allOdds = []) => {
    const validOdds = allOdds.map(Number).filter(v => Number.isFinite(v) && v > 1);
    const target = Number(targetOdd);
    if (!Number.isFinite(target) || target <= 1 || validOdds.length === 0) return null;

    const totalImplied = validOdds.reduce((acc, odd) => acc + (1 / odd), 0);
    if (!Number.isFinite(totalImplied) || totalImplied <= 0) return null;

    const fairProb = (1 / target) / totalImplied;
    if (!Number.isFinite(fairProb) || fairProb <= 0 || fairProb >= 1) return null;

    return fairProb;
};

const resolvePrematchFairProbFromPinnacle = (opportunity = {}, pinEntry = null, marketName = '', selectionName = '', totalsHint = null) => {
    if (!pinEntry) return null;

    const marketNorm = normalizeMarketText(marketName || opportunity.market || '');
    const selectionToken = getSelectionToken(selectionName || opportunity.selection || '');

    // 1x2
    if (is1x2MarketName(marketName || opportunity.market || '')) {
        const ml = pinEntry.moneyline || {};
        const home = Number(ml.home);
        const draw = Number(ml.draw);
        const away = Number(ml.away);

        let targetOdd = null;
        if (selectionToken === 'home' || selectionToken === '1' || selectionToken.includes('local')) targetOdd = home;
        else if (selectionToken === 'draw' || selectionToken === 'x' || selectionToken.includes('empate')) targetOdd = draw;
        else if (selectionToken === 'away' || selectionToken === '2' || selectionToken.includes('visita')) targetOdd = away;

        const fairProb = normalizeFairFromOdds(targetOdd, [home, draw, away]);
        if (!fairProb) return null;

        return { fairProb, pinnaclePrice: targetOdd, source: 'pinnacle-prematch-1x2' };
    }

    // Double Chance
    if (marketNorm.includes('double chance') || marketNorm.includes('doble')) {
        const dc = pinEntry.doubleChance || {};
        const p1x = Number(dc.homeDraw);
        const p12 = Number(dc.homeAway);
        const px2 = Number(dc.drawAway);

        let targetOdd = null;
        if (selectionToken === '1x') targetOdd = p1x;
        else if (selectionToken === '12') targetOdd = p12;
        else if (selectionToken === 'x2') targetOdd = px2;

        const fairProb = normalizeFairFromOdds(targetOdd, [p1x, p12, px2]);
        if (!fairProb) return null;

        return { fairProb, pinnaclePrice: targetOdd, source: 'pinnacle-prematch-dc' };
    }

    // Totales
    if (marketNorm.includes('total')) {
        const totals = Array.isArray(pinEntry.totals) ? pinEntry.totals : [];
        const side = totalsHint?.side || null;
        const targetLine = Number.isFinite(Number(totalsHint?.line)) ? Number(totalsHint.line) : NaN;
        if (!side || totals.length === 0) return null;

        const lineObj = totals.find(t => {
            if (!Number.isFinite(targetLine)) return true;
            return Math.abs(Number(t.line) - targetLine) < 0.11;
        });

        if (!lineObj) return null;
        const over = Number(lineObj.over);
        const under = Number(lineObj.under);
        const targetOdd = side === 'over' ? over : under;
        const fairProb = normalizeFairFromOdds(targetOdd, [over, under]);
        if (!fairProb) return null;

        return { fairProb, pinnaclePrice: targetOdd, source: 'pinnacle-prematch-total' };
    }

    // BTTS (si existe en contexto)
    if (marketNorm.includes('btts') || marketNorm.includes('ambos')) {
        const btts = pinEntry.btts || opportunity?.pinnacleInfo?.prematchContext?.btts || null;
        if (!btts) return null;
        const yes = Number(btts.yes);
        const no = Number(btts.no);

        let targetOdd = null;
        if (selectionToken.includes('yes') || selectionToken.includes('si') || selectionToken.includes('sí')) targetOdd = yes;
        else if (selectionToken.includes('no')) targetOdd = no;

        const fairProb = normalizeFairFromOdds(targetOdd, [yes, no]);
        if (!fairProb) return null;

        return { fairProb, pinnaclePrice: targetOdd, source: 'pinnacle-prematch-btts' };
    }

    return null;
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
            else if (isDoubleChanceMarketName(marketName) && market.typeId === 10 && isFullTimeMarket(market)) isTargetMarket = true;
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
                            // Si tenemos linea valida (venga de market o selection), debe matchear.
                            // Solo relajamos cuando NO hay linea confiable para evitar tomar otra linea por error.
                            const mustMatchLine = Number.isFinite(totalsHint.line);
                            const lineMatches = mustMatchLine
                                ? (Number.isFinite(oddLine) && Math.abs(oddLine - totalsHint.line) < 0.11)
                                : true;

                            if (!lineMatches) return false;

                            if (totalsHint.side === 'over') {
                                return Number(o.typeId) === 12 || oName.includes('over') || oName.includes('más') || oName.includes('mas');
                            }
                            if (totalsHint.side === 'under') {
                                return Number(o.typeId) === 13 || oName.includes('under') || oName.includes('menos');
                            }
                        }
                        if (isDoubleChanceMarketName(marketName)) {
                            const selectionToken = String(selectionName || '').trim().toUpperCase();

                            // Mapeo principal por typeId del proveedor: 9=1X, 10=12, 11=X2.
                            if (selectionToken === '1X' && Number(o.typeId) === 9) return true;
                            if (selectionToken === '12' && Number(o.typeId) === 10) return true;
                            if (selectionToken === 'X2' && Number(o.typeId) === 11) return true;

                            // Fallback por nombre (cuando typeId no llega estable).
                            if (selectionToken === '1X' && (oName.includes('1x') || oName.includes('home draw') || oName.includes('local empate'))) return true;
                            if (selectionToken === '12' && (oName.includes('12') || oName.includes('home away') || oName.includes('local visitante'))) return true;
                            if (selectionToken === 'X2' && (oName.includes('x2') || oName.includes('draw away') || oName.includes('empate visitante'))) return true;
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
        
        // Recalcular fairProb en caliente para prematch consultando Pinnacle antes de confirmar.
        // Si falla el refresh de Pinnacle, fallback a probabilidad previa de la oportunidad.
        let fairProb = opportunity.realProb ? (opportunity.realProb / 100) : (1 / (opportunity.realPrice || opportunity.pinnaclePrice));
        let fairProbSource = 'opportunity-snapshot';
        let refreshedPinnaclePrice = null;

        if (PREMATCH_REFRESH_RECALCULATE_PINNACLE && isPrematchOpportunity(opportunity)) {
            try {
                const pinEntry = await findPinnaclePrematchEntry(opportunity);
                const resolved = resolvePrematchFairProbFromPinnacle(opportunity, pinEntry, marketName, selectionName, totalsHint);
                if (resolved?.fairProb && Number.isFinite(resolved.fairProb)) {
                    fairProb = resolved.fairProb;
                    fairProbSource = resolved.source || 'pinnacle-prematch-refresh';
                    refreshedPinnaclePrice = Number.isFinite(Number(resolved.pinnaclePrice)) ? Number(resolved.pinnaclePrice) : null;
                }
            } catch (pinErr) {
                console.warn(`⚠️ Pinnacle prematch refresh falló (${opportunity?.match}): ${pinErr.message}`);
            }
        }

        if (!Number.isFinite(fairProb) || fairProb <= 0 || fairProb >= 1) {
            throw new Error('No se pudo calcular probabilidad real válida para refresh.');
        }
        
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
        updatedOp.realProb = Number((fairProb * 100).toFixed(4));
        updatedOp.realPrice = Number((1 / fairProb).toFixed(4));
        updatedOp.fairProbSource = fairProbSource;
        updatedOp.pinnaclePrice = refreshedPinnaclePrice || updatedOp.pinnaclePrice || null;
        updatedOp.pinnacleRefreshedAt = fairProbSource.startsWith('pinnacle-') ? new Date().toISOString() : (updatedOp.pinnacleRefreshedAt || null);
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