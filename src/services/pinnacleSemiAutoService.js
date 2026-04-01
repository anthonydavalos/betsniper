import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import db, { initDB, writeDBWithRetry } from '../db/database.js';
import { placeAutoBet } from './paperTradingService.js';

const ARCADIA_BASE_URL = 'https://api.arcadia.pinnacle.com/0.1';
const PINNACLE_TOKEN_FILE = path.resolve('data', 'pinnacle_token.json');
const PINNACLE_CAPTURE_LATEST = path.resolve('data', 'pinnacle', 'capture-placement.latest.json');
const PINNACLE_REMOTE_HISTORY_TTL_MS = 45 * 1000;
const PINNACLE_REMOTE_TRANSACTIONS_TTL_MS = 45 * 1000;
const PINNACLE_REMOTE_HISTORY_DEFAULT_DAYS = Number(process.env.PINNACLE_HISTORY_DEFAULT_DAYS || 120);
const PINNACLE_REMOTE_HISTORY_DEFAULT_STATUS = String(process.env.PINNACLE_HISTORY_DEFAULT_STATUS || 'settled').trim().toLowerCase();
const PINNACLE_PNL_WINDOW_DAYS = Number(process.env.PINNACLE_PNL_WINDOW_DAYS || 365);
const PINNACLE_PNL_BASE_CAPITAL_FALLBACK = Number(process.env.PINNACLE_PNL_BASE_CAPITAL);
const PINNACLE_BET_STATUS_ALLOWED = new Set(['all', 'unsettled', 'settled']);

const nowIso = () => new Date().toISOString();

const safeNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const createPinnacleError = (message, extras = {}) => {
  const err = new Error(message);
  if (extras.code) err.code = extras.code;
  if (extras.statusCode) err.statusCode = extras.statusCode;
  if (extras.diagnostic) err.diagnostic = extras.diagnostic;
  return err;
};

const parsePositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const parsePinnacleHistoryStatus = (value = '', fallback = 'settled') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (PINNACLE_BET_STATUS_ALLOWED.has(normalized)) return normalized;
  return PINNACLE_BET_STATUS_ALLOWED.has(String(fallback || '').trim().toLowerCase())
    ? String(fallback || '').trim().toLowerCase()
    : 'settled';
};

const withPinnacleMirrorMetadata = (opportunity = {}) => ({
  ...(opportunity || {}),
  provider: 'pinnacle',
  placementProvider: 'pinnacle',
  integration: 'pinnacle'
});

const reconcileMirroredBetWithRequested = ({ mirroredBet, requestedPayload, providerBody } = {}) => {
  if (!mirroredBet?.id) return mirroredBet;

  const requestedStakeRaw = Number(requestedPayload?.stake);
  const requestedStake = Number.isFinite(requestedStakeRaw) && requestedStakeRaw > 0
    ? Number(requestedStakeRaw)
    : null;

  const requestedOddRaw = Number(requestedPayload?.selections?.[0]?.price);
  const requestedOdd = Number.isFinite(requestedOddRaw) && requestedOddRaw > 1
    ? Number(requestedOddRaw)
    : null;

  const providerRequestId = providerBody?.requestId || requestedPayload?.requestId || null;
  const providerStatus = String(providerBody?.status || '').toUpperCase() || null;

  const applyPatch = (bet = {}) => {
    const patched = {
      ...bet,
      odd: requestedOdd || bet.odd,
      price: requestedOdd || bet.price,
      stake: requestedStake || bet.stake,
      kellyStake: requestedStake || bet.kellyStake || bet.stake,
      providerRequestId,
      providerStatus,
      provider: 'pinnacle',
      placementProvider: 'pinnacle',
      integration: 'pinnacle',
      providerRequestedStake: requestedStake || bet.providerRequestedStake || null,
      providerRequestedOdd: requestedOdd || bet.providerRequestedOdd || null,
      providerAcceptedAt: nowIso()
    };

    if (Number.isFinite(Number(patched.stake)) && Number.isFinite(Number(patched.odd))) {
      patched.potentialReturn = Number((Number(patched.stake) * Number(patched.odd)).toFixed(2));
    }

    return patched;
  };

  const activeBets = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : [];
  const activeIdx = activeBets.findIndex((b) => String(b.id) === String(mirroredBet.id));
  if (activeIdx >= 0) {
    const current = activeBets[activeIdx];
    const oldStake = Number(current?.stake);
    const patched = applyPatch(current);

    if (requestedStake && Number.isFinite(oldStake)) {
      const delta = Number((oldStake - requestedStake).toFixed(2));
      if (Math.abs(delta) > 0) {
        const currentBalance = Number(db.data?.portfolio?.balance || 0);
        db.data.portfolio.balance = Number((currentBalance + delta).toFixed(2));
      }
    }

    db.data.portfolio.activeBets[activeIdx] = patched;
    return patched;
  }

  const historyBets = Array.isArray(db.data?.portfolio?.history) ? db.data.portfolio.history : [];
  const historyIdx = historyBets.findIndex((b) => String(b.id) === String(mirroredBet.id));
  if (historyIdx >= 0) {
    const patched = applyPatch(historyBets[historyIdx]);
    db.data.portfolio.history[historyIdx] = patched;
    return patched;
  }

  return applyPatch(mirroredBet);
};

const ensurePinnacleStore = () => {
  if (!db.data.pinnacle) db.data.pinnacle = { pendingTickets: [], history: [], remoteHistory: null };
  if (!Array.isArray(db.data.pinnacle.pendingTickets)) db.data.pinnacle.pendingTickets = [];
  if (!Array.isArray(db.data.pinnacle.history)) db.data.pinnacle.history = [];
  if (!db.data.pinnacle.remoteHistory || typeof db.data.pinnacle.remoteHistory !== 'object') {
    db.data.pinnacle.remoteHistory = {
      items: [],
      fetchedAt: null,
      source: 'cache-empty',
      params: null
    };
  }
  if (!Array.isArray(db.data.pinnacle.remoteHistory.items)) db.data.pinnacle.remoteHistory.items = [];

  if (!db.data.pinnacle.remoteTransactions || typeof db.data.pinnacle.remoteTransactions !== 'object') {
    db.data.pinnacle.remoteTransactions = {
      items: [],
      fetchedAt: null,
      source: 'cache-empty',
      windowDays: null,
      summary: null
    };
  }
  if (!Array.isArray(db.data.pinnacle.remoteTransactions.items)) db.data.pinnacle.remoteTransactions.items = [];
};

const cloneForStorage = (value) => JSON.parse(JSON.stringify(value || null));

const readJsonIfExists = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const redactHeaders = (headers = {}) => {
  const out = { ...(headers || {}) };
  const secretKeys = new Set(['x-session', 'cookie', 'authorization', 'x-auth-token', 'set-cookie']);
  for (const key of Object.keys(out)) {
    if (secretKeys.has(String(key).toLowerCase())) {
      out[key] = '[REDACTED]';
    }
  }
  return out;
};

const getPinnacleAuthHeaders = () => {
  const tokenData = readJsonIfExists(PINNACLE_TOKEN_FILE);
  const headers = tokenData?.headers || {};
  if (!headers || Object.keys(headers).length === 0) {
    throw createPinnacleError(
      'No hay credenciales de Pinnacle en data/pinnacle_token.json. Ejecuta pinnacle gateway antes del placement.',
      { code: 'PINNACLE_TOKEN_MISSING', statusCode: 428 }
    );
  }

  const hasSession = Boolean(headers['X-Session'] || headers['x-session']);
  if (!hasSession) {
    throw createPinnacleError(
      'Credenciales de Pinnacle incompletas: falta X-Session.',
      { code: 'PINNACLE_SESSION_MISSING', statusCode: 428 }
    );
  }

  return headers;
};

const arcadiaRequest = async (method, endpoint, { data, params } = {}) => {
  const authHeaders = getPinnacleAuthHeaders();
  const response = await axios({
    method,
    url: `${ARCADIA_BASE_URL}${endpoint}`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://www.pinnacle.com',
      Referer: 'https://www.pinnacle.com/',
      ...authHeaders
    },
    data,
    params,
    timeout: 15000,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  if (response.status >= 400) {
    throw createPinnacleError(
      `Arcadia ${endpoint} devolvio HTTP ${response.status}.`,
      {
        code: 'PINNACLE_API_HTTP_ERROR',
        statusCode: response.status,
        diagnostic: {
          endpoint,
          method,
          providerStatus: response.status,
          providerBody: response.data || null,
          requestedAt: nowIso()
        }
      }
    );
  }

  return {
    status: response.status,
    headers: response.headers || {},
    data: response.data
  };
};

const decimalToAmerican = (decimalOdd) => {
  const dec = safeNumber(decimalOdd, 0);
  if (!Number.isFinite(dec) || dec <= 1) return null;
  if (dec >= 2) return Math.round((dec - 1) * 100);
  return Math.round(-100 / (dec - 1));
};

const americanToDecimal = (americanOdd) => {
  const am = safeNumber(americanOdd, 0);
  if (!Number.isFinite(am) || am === 0) return null;
  if (am > 0) return Number(((am / 100) + 1).toFixed(3));
  return Number(((100 / Math.abs(am)) + 1).toFixed(3));
};

const normalizeText = (value = '') => String(value || '').trim().toLowerCase();

const inferMarketKeyFromOpportunity = (opportunity = {}) => {
  const market = normalizeText(opportunity.market || opportunity.marketName || '');
  if (market.includes('1x2') || market.includes('moneyline')) return 's;0;m';
  if (market.includes('total') || market.includes('over') || market.includes('under')) return 's;0;t';
  return 's;0;m';
};

const inferDesignationFromOpportunity = (opportunity = {}, fallbackMarketKey = 's;0;m') => {
  const selection = normalizeText(opportunity.selection || opportunity.action || '');

  if (selection.includes('away') || selection.includes('visita') || selection.includes('visitante')) return 'away';
  if (selection.includes('draw') || selection.includes('empate')) return 'draw';
  if (selection.includes('over') || selection.includes('mas') || selection.includes('mAs')) return 'over';
  if (selection.includes('under') || selection.includes('menos')) return 'under';

  if (fallbackMarketKey === 's;0;t') {
    return selection.includes('under') || selection.includes('menos') ? 'under' : 'over';
  }
  return 'home';
};

const normalizeDesignation = (value = '') => {
  const normalized = normalizeText(value);
  if (normalized === 'local') return 'home';
  if (normalized === 'visitante') return 'away';
  if (normalized === 'empate') return 'draw';
  return normalized;
};

const inferMarketTypeFromMarketKey = (marketKey = 's;0;m') => {
  const key = normalizeText(marketKey);
  if (key === 's;0;t') return 'total';
  return 'moneyline';
};

const isArcadiaMarketOpen = (market = {}) => {
  const status = normalizeText(market?.status || 'open');
  return !status || status === 'open';
};

const getArcadiaMarketPriceByDesignation = (market = {}, designation = '') => {
  const targetDesignation = normalizeDesignation(designation);
  if (!targetDesignation) return null;

  const prices = Array.isArray(market?.prices) ? market.prices : [];
  const priceRow = prices.find((row) => normalizeDesignation(row?.designation) === targetDesignation);
  const price = Number(priceRow?.price);
  return Number.isFinite(price) ? Number(price) : null;
};

const summarizeAvailableDesignations = (markets = []) => {
  const list = Array.isArray(markets) ? markets : [];
  const out = new Set();

  list.forEach((market) => {
    const prices = Array.isArray(market?.prices) ? market.prices : [];
    prices.forEach((priceRow) => {
      const designation = normalizeDesignation(priceRow?.designation);
      if (designation) out.add(designation);
    });
  });

  return Array.from(out);
};

const pickPreferredArcadiaMarket = (markets = [], targetMarketKey = 's;0;m') => {
  const list = Array.isArray(markets) ? markets : [];
  if (list.length === 0) return null;

  const targetKey = normalizeText(targetMarketKey);
  const sorted = list.slice().sort((a, b) => {
    const aExactKey = normalizeText(a?.key) === targetKey ? 0 : 1;
    const bExactKey = normalizeText(b?.key) === targetKey ? 0 : 1;
    if (aExactKey !== bExactKey) return aExactKey - bExactKey;

    const aOpen = isArcadiaMarketOpen(a) ? 0 : 1;
    const bOpen = isArcadiaMarketOpen(b) ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;

    const aPeriod = Number(a?.period) === 0 ? 0 : 1;
    const bPeriod = Number(b?.period) === 0 ? 0 : 1;
    if (aPeriod !== bPeriod) return aPeriod - bPeriod;

    const aCutoff = String(a?.cutoffAt || '9999-12-31T23:59:59Z');
    const bCutoff = String(b?.cutoffAt || '9999-12-31T23:59:59Z');
    return aCutoff.localeCompare(bCutoff);
  });

  return sorted[0] || null;
};

const resolveArcadiaQuoteSelectionFromRelatedMarkets = async (opportunity = {}, baseSelection = {}) => {
  const matchupId = getMatchupIdFromOpportunity(opportunity);
  if (!matchupId) {
    return {
      ok: false,
      reason: 'missing-matchup-id',
      availableDesignations: []
    };
  }

  const desiredMarketKey = normalizeText(baseSelection?.marketKey || inferMarketKeyFromOpportunity(opportunity));
  const desiredDesignation = normalizeDesignation(baseSelection?.designation || inferDesignationFromOpportunity(opportunity, desiredMarketKey));
  const desiredType = inferMarketTypeFromMarketKey(desiredMarketKey);

  const response = await arcadiaRequest('GET', `/matchups/${matchupId}/markets/related/straight`);
  const markets = Array.isArray(response?.data) ? response.data : [];
  const availableDesignations = summarizeAvailableDesignations(markets);

  const withDesignation = markets.filter((market) => {
    const price = getArcadiaMarketPriceByDesignation(market, desiredDesignation);
    return Number.isFinite(price);
  });

  const exactKey = withDesignation.filter((market) => normalizeText(market?.key) === desiredMarketKey);
  const byType = withDesignation.filter((market) => normalizeText(market?.type) === desiredType);

  const pool = exactKey.length > 0
    ? exactKey
    : (byType.length > 0 ? byType : withDesignation);

  const market = pickPreferredArcadiaMarket(pool, desiredMarketKey);
  if (!market) {
    return {
      ok: false,
      reason: 'selection-unavailable',
      desiredMarketKey,
      desiredDesignation,
      desiredType,
      availableDesignations,
      marketsCount: markets.length
    };
  }

  const refreshedPriceAmerican = getArcadiaMarketPriceByDesignation(market, desiredDesignation);
  if (!Number.isFinite(refreshedPriceAmerican)) {
    return {
      ok: false,
      reason: 'selection-price-missing',
      desiredMarketKey,
      desiredDesignation,
      desiredType,
      availableDesignations,
      marketsCount: markets.length
    };
  }

  return {
    ok: true,
    selection: {
      matchupId,
      marketKey: String(market?.key || desiredMarketKey || 's;0;m').trim().toLowerCase(),
      designation: desiredDesignation,
      price: Number(refreshedPriceAmerican)
    },
    diagnostic: {
      desiredMarketKey,
      desiredDesignation,
      desiredType,
      selectedMarketId: market?.id ?? null,
      selectedMarketKey: market?.key ?? null,
      selectedMarketType: market?.type ?? null,
      selectedMarketPeriod: market?.period ?? null,
      selectedMarketStatus: market?.status ?? null,
      selectedMarketCutoffAt: market?.cutoffAt ?? null,
      availableDesignations,
      marketsCount: markets.length
    }
  };
};

const isArcadiaInsufficientFundsError = (error = {}) => {
  const body = error?.diagnostic?.providerBody || {};
  const title = normalizeText(body?.title || '');
  const detail = normalizeText(body?.detail || '');
  return title.includes('insufficient_funds') || detail.includes('insufficient funds');
};

const getArcadiaBalanceAmountSafe = async () => {
  try {
    const response = await arcadiaRequest('GET', '/wallet/balance');
    const amount = Number(response?.data?.amount);
    return Number.isFinite(amount) ? Number(amount) : null;
  } catch {
    return null;
  }
};

const getMatchupIdFromOpportunity = (opportunity = {}) => {
  const id = Number(
    opportunity.pinnacleId
    || opportunity.pinnacleInfo?.id
    || opportunity.pinnacleMatchId
    || 0
  );
  return Number.isFinite(id) && id > 0 ? id : null;
};

const getStakeFromOpportunity = (opportunity = {}) => {
  const rawStake = safeNumber(opportunity.kellyStake ?? opportunity.stake, 0);
  const stake = rawStake > 0 ? rawStake : 1.05;
  return Number(Math.max(1.05, stake).toFixed(2));
};

const getReferenceDecimalPriceFromOpportunity = (opportunity = {}) => {
  const candidates = [
    opportunity.pinnaclePrice,
    opportunity.realPrice,
    opportunity.odd,
    opportunity.price
  ];

  for (const candidate of candidates) {
    const n = safeNumber(candidate, 0);
    if (Number.isFinite(n) && n > 1) return Number(n.toFixed(3));
  }

  return null;
};

const getTicketById = (ticketId) => {
  const idx = db.data.pinnacle.pendingTickets.findIndex((t) => String(t.id) === String(ticketId));
  if (idx < 0) {
    throw createPinnacleError('Ticket Pinnacle no encontrado.', { code: 'PINNACLE_TICKET_NOT_FOUND', statusCode: 404 });
  }
  return { idx, ticket: db.data.pinnacle.pendingTickets[idx] };
};

const buildTicketKey = (opportunity = {}) => {
  const matchupId = getMatchupIdFromOpportunity(opportunity) || 'na';
  const marketKey = inferMarketKeyFromOpportunity(opportunity);
  const designation = inferDesignationFromOpportunity(opportunity, marketKey);
  return `${matchupId}|${marketKey}|${designation}`;
};

const findPortfolioMirrorBet = ({ ticket, draft } = {}) => {
  const activeBets = Array.isArray(db.data?.portfolio?.activeBets) ? db.data.portfolio.activeBets : [];

  const selection = String(draft?.payload?.selections?.[0]?.designation || '').trim().toLowerCase();
  const expectedPick = selection || null;

  const candidateEventIds = new Set(
    [
      ticket?.opportunity?.eventId,
      ticket?.opportunity?.pinnacleId,
      draft?.payload?.selections?.[0]?.matchupId
    ]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );

  const isMatch = (bet = {}) => {
    const betEventId = String(bet?.eventId || '').trim();
    const betPinnacleId = String(bet?.pinnacleId || '').trim();
    const eventHit = candidateEventIds.has(betEventId) || candidateEventIds.has(betPinnacleId);
    if (!eventHit) return false;

    if (!expectedPick) return true;
    const betPick = String(bet?.pick || '').trim().toLowerCase();
    return betPick === expectedPick || betPick.startsWith(`${expectedPick}_`);
  };

  return activeBets.find(isMatch) || null;
};

const resolvePickFromDraft = (draft = {}) => {
  const designation = String(draft?.payload?.selections?.[0]?.designation || '').toLowerCase();
  if (designation === 'home' || designation === 'away' || designation === 'draw') return designation;
  if (designation === 'over' || designation === 'under') return designation;
  return 'unknown';
};

const createManualMirrorBetFromPlacement = ({ ticket, draft, providerBody } = {}) => {
  if (!db.data?.portfolio) return null;

  const requestedStake = Number(draft?.payload?.stake);
  const requestedOdd = Number(draft?.payload?.selections?.[0]?.price);
  if (!Number.isFinite(requestedStake) || requestedStake <= 0) return null;
  if (!Number.isFinite(requestedOdd) || requestedOdd <= 1) return null;

  const pick = resolvePickFromDraft(draft);
  const opportunity = ticket?.opportunity || {};

  const newBet = {
    id: Date.now().toString(),
    createdAt: nowIso(),
    matchDate: opportunity.date || null,
    eventId: opportunity.eventId || opportunity.pinnacleId || draft?.payload?.selections?.[0]?.matchupId || null,
    pinnacleId: opportunity.pinnacleId || draft?.payload?.selections?.[0]?.matchupId || null,
    pinnaclePrice: opportunity.pinnaclePrice || null,
    sportId: opportunity.sportId,
    catId: opportunity.catId,
    champId: opportunity.champId,
    match: opportunity.match || 'Pinnacle Real Placement',
    league: opportunity.league,
    market: opportunity.market || '1x2',
    type: opportunity.type || 'LIVE_VALUE',
    selection: opportunity.action || opportunity.selection || pick,
    pick,
    odd: requestedOdd,
    price: requestedOdd,
    realProb: Number.isFinite(Number(opportunity.realProb)) ? Number(opportunity.realProb) : 50,
    ev: Number.isFinite(Number(opportunity.ev)) ? Number(opportunity.ev) : null,
    stake: Number(requestedStake.toFixed(2)),
    kellyStake: Number(requestedStake.toFixed(2)),
    status: 'PENDING',
    provider: 'pinnacle',
    placementProvider: 'pinnacle',
    integration: 'pinnacle',
    initialScore: opportunity.score || '0-0',
    lastKnownScore: opportunity.score || '0-0',
    lastUpdate: nowIso(),
    pinnacleInfo: opportunity.pinnacleInfo,
    liveTime: opportunity.time || opportunity.liveTime,
    providerRequestId: providerBody?.requestId || draft?.payload?.requestId || null,
    providerStatus: String(providerBody?.status || '').toUpperCase() || null,
    providerRequestedStake: Number(requestedStake.toFixed(2)),
    providerRequestedOdd: requestedOdd,
    providerAcceptedAt: nowIso(),
    potentialReturn: Number((requestedStake * requestedOdd).toFixed(2))
  };

  const currentBalance = Number(db.data?.portfolio?.balance || 0);
  db.data.portfolio.balance = Number((currentBalance - requestedStake).toFixed(2));
  db.data.portfolio.activeBets.push(newBet);

  return newBet;
};

const buildDraftPreviewPayload = (opportunity = {}) => {
  const marketKey = inferMarketKeyFromOpportunity(opportunity);
  const designation = inferDesignationFromOpportunity(opportunity, marketKey);
  const matchupId = getMatchupIdFromOpportunity(opportunity);

  return {
    marketKey,
    designation,
    matchupId,
    stake: getStakeFromOpportunity(opportunity),
    referencePriceDecimal: getReferenceDecimalPriceFromOpportunity(opportunity),
    referencePriceAmerican: decimalToAmerican(getReferenceDecimalPriceFromOpportunity(opportunity))
  };
};

const buildQuoteRequestPayload = (opportunity = {}, { omitPrice = false, selectionOverride = null } = {}) => {
  const preview = buildDraftPreviewPayload(opportunity);

  if (!preview.matchupId) {
    throw createPinnacleError(
      'La oportunidad no tiene pinnacleId. No se puede cotizar en Arcadia.',
      { code: 'PINNACLE_MATCHUP_MISSING', statusCode: 400 }
    );
  }

  const selection = {
    matchupId: preview.matchupId,
    marketKey: preview.marketKey,
    designation: preview.designation
  };

  if (selectionOverride && typeof selectionOverride === 'object') {
    const overrideMatchupId = Number(selectionOverride?.matchupId);
    const overrideMarketKey = String(selectionOverride?.marketKey || '').trim().toLowerCase();
    const overrideDesignation = normalizeDesignation(selectionOverride?.designation || '');

    if (Number.isFinite(overrideMatchupId) && overrideMatchupId > 0) selection.matchupId = overrideMatchupId;
    if (overrideMarketKey) selection.marketKey = overrideMarketKey;
    if (overrideDesignation) selection.designation = overrideDesignation;
  }

  const overridePrice = Number(selectionOverride?.price);
  if (!omitPrice && Number.isFinite(overridePrice)) {
    selection.price = Number(overridePrice);
  } else if (!omitPrice && Number.isFinite(Number(preview.referencePriceAmerican))) {
    selection.price = Number(preview.referencePriceAmerican);
  }

  return {
    oddsFormat: 'american',
    selections: [selection]
  };
};

const buildRealPlacementPayloadFromQuote = ({ quoteResponse, opportunity }) => {
  const firstSelection = Array.isArray(quoteResponse?.selections) ? quoteResponse.selections[0] : null;
  if (!firstSelection) {
    throw createPinnacleError('Quote de Pinnacle sin selections[0].', {
      code: 'PINNACLE_QUOTE_INVALID',
      statusCode: 409,
      diagnostic: { quoteResponse: quoteResponse || null }
    });
  }

  const quotePriceAmerican = safeNumber(firstSelection.price, 0);
  const quotePriceDecimal = americanToDecimal(quotePriceAmerican);
  if (!quotePriceDecimal) {
    throw createPinnacleError('No se pudo convertir cuota quote a decimal.', {
      code: 'PINNACLE_QUOTE_PRICE_INVALID',
      statusCode: 409,
      diagnostic: { selection: firstSelection }
    });
  }

  return {
    oddsFormat: 'decimal',
    requestId: randomUUID(),
    acceptBetterPrices: true,
    class: 'Straight',
    selections: [{
      marketId: firstSelection.marketId,
      matchupId: firstSelection.matchupId,
      marketKey: firstSelection.marketKey,
      designation: firstSelection.designation,
      price: quotePriceDecimal
    }],
    stake: getStakeFromOpportunity(opportunity),
    originTag: 'sl:bsd',
    acceptBetterPrice: true
  };
};

const prepareRealPlacementDraftInternal = async (ticketId) => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  const { ticket } = getTicketById(ticketId);
  if (ticket.status !== 'DRAFT') {
    throw createPinnacleError(`Ticket en estado no valido: ${ticket.status}`, {
      code: 'PINNACLE_TICKET_INVALID_STATE',
      statusCode: 409
    });
  }

  const quotePayload = buildQuoteRequestPayload(ticket.opportunity);
  let quoteRes = null;
  let quotePayloadUsed = quotePayload;
  let quoteRetriedWithoutPrice = false;
  let quoteRetriedWithMarketRefresh = false;
  let quoteResolution = null;
  try {
    quoteRes = await arcadiaRequest('POST', '/bets/straight/quote', { data: quotePayload });
  } catch (error) {
    const status = Number(error?.statusCode || 0);
    const firstBody = error?.diagnostic?.providerBody || null;
    if (isArcadiaInsufficientFundsError(error)) {
      const requestedStake = getStakeFromOpportunity(ticket.opportunity);
      const availableBalance = await getArcadiaBalanceAmountSafe();
      throw createPinnacleError(
        'Arcadia reporta saldo insuficiente para cotizar/apostar este ticket.',
        {
          code: 'PINNACLE_INSUFFICIENT_BALANCE',
          statusCode: 409,
          diagnostic: {
            ticketId,
            requestedStake,
            availableBalance,
            quotePayload,
            firstError: error?.diagnostic || null,
            observedAt: nowIso()
          }
        }
      );
    }

    // Fallback robusto: refrescar marketKey/designation/price desde related/straight
    // y reintentar quote una sola vez con precio vigente.
    if (status === 400 || status === 410) {
      let refreshedSelection = null;
      try {
        refreshedSelection = await resolveArcadiaQuoteSelectionFromRelatedMarkets(
          ticket.opportunity,
          quotePayload?.selections?.[0] || {}
        );
      } catch (resolutionError) {
        refreshedSelection = {
          ok: false,
          reason: 'related-fetch-failed',
          error: {
            message: resolutionError?.message || 'No se pudo consultar related/straight.',
            code: resolutionError?.code || null,
            statusCode: Number(resolutionError?.statusCode || 0) || null,
            diagnostic: resolutionError?.diagnostic || null
          }
        };
      }

      if (!refreshedSelection?.ok) {
        if (refreshedSelection?.reason === 'selection-unavailable') {
          throw createPinnacleError(
            'Arcadia no tiene disponible la seleccion solicitada en mercados abiertos para este matchup.',
            {
              code: 'PINNACLE_SELECTION_UNAVAILABLE',
              statusCode: 409,
              diagnostic: {
                ticketId,
                providerStatus: status,
                quotePayload,
                firstError: error?.diagnostic || null,
                resolution: refreshedSelection,
                observedAt: nowIso()
              }
            }
          );
        }

        throw createPinnacleError(
          'Arcadia quote no pudo refrescarse desde related/straight. Refresca y reintenta.',
          {
            code: status === 410 ? 'PINNACLE_QUOTE_GONE' : 'PINNACLE_QUOTE_BAD_REQUEST',
            statusCode: 409,
            diagnostic: {
              ticketId,
              providerStatus: status,
              quotePayload,
              firstError: error?.diagnostic || null,
              resolution: refreshedSelection,
              observedAt: nowIso()
            }
          }
        );
      }

      const quotePayloadRefreshed = buildQuoteRequestPayload(ticket.opportunity, {
        selectionOverride: refreshedSelection.selection
      });
      quotePayloadUsed = quotePayloadRefreshed;
      quoteRetriedWithMarketRefresh = true;
      quoteResolution = refreshedSelection?.diagnostic || null;
      try {
        quoteRes = await arcadiaRequest('POST', '/bets/straight/quote', { data: quotePayloadRefreshed });
      } catch (retryError) {
        const retryStatus = Number(retryError?.statusCode || 0);
        const retryBody = retryError?.diagnostic?.providerBody || null;
        if (isArcadiaInsufficientFundsError(retryError)) {
          const requestedStake = getStakeFromOpportunity(ticket.opportunity);
          const availableBalance = await getArcadiaBalanceAmountSafe();
          throw createPinnacleError(
            'Arcadia reporta saldo insuficiente para cotizar/apostar este ticket.',
            {
              code: 'PINNACLE_INSUFFICIENT_BALANCE',
              statusCode: 409,
              diagnostic: {
                ticketId,
                requestedStake,
                availableBalance,
                quotePayload,
                quotePayloadRefreshed,
                firstError: error?.diagnostic || null,
                secondError: retryError?.diagnostic || null,
                resolution: quoteResolution,
                observedAt: nowIso()
              }
            }
          );
        }
        if (retryStatus === 410) {
          throw createPinnacleError(
            'Arcadia quote no disponible (HTTP 410): la seleccion/mercado ya no esta cotizable en este momento. Refresca y reintenta.',
            {
              code: 'PINNACLE_QUOTE_GONE',
              statusCode: 409,
              diagnostic: {
                ticketId,
                providerStatus: 410,
                retriedWithoutPrice: false,
                retriedWithMarketRefresh: true,
                quotePayload,
                quotePayloadRefreshed,
                firstError: error?.diagnostic || null,
                secondError: retryError?.diagnostic || null,
                resolution: quoteResolution,
                observedAt: nowIso()
              }
            }
          );
        }
        if (retryStatus === 400) {
          throw createPinnacleError(
            'Arcadia quote invalido (HTTP 400): request no aceptado para la seleccion actual. Refresca y reintenta.',
            {
              code: 'PINNACLE_QUOTE_BAD_REQUEST',
              statusCode: 409,
              diagnostic: {
                ticketId,
                providerStatus: 400,
                retriedWithoutPrice: false,
                retriedWithMarketRefresh: true,
                quotePayload,
                quotePayloadRefreshed,
                firstError: error?.diagnostic || null,
                secondError: retryError?.diagnostic || null,
                firstBody,
                secondBody: retryBody,
                resolution: quoteResolution,
                observedAt: nowIso()
              }
            }
          );
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }
  const payload = buildRealPlacementPayloadFromQuote({ quoteResponse: quoteRes.data, opportunity: ticket.opportunity });

  return {
    endpoint: '/bets/straight',
    quoteEndpoint: '/bets/straight/quote',
    quotePayload: quotePayloadUsed,
    quoteRetriedWithoutPrice,
    quoteRetriedWithMarketRefresh,
    quoteResolution,
    quoteResponse: quoteRes.data,
    payload,
    opportunity: ticket.opportunity,
    authHeadersPreview: redactHeaders(getPinnacleAuthHeaders())
  };
};

export const preparePinnacleSemiAutoTicket = async (opportunity) => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  if (!opportunity || typeof opportunity !== 'object') {
    throw createPinnacleError('Oportunidad invalida para preparar ticket Pinnacle.', {
      code: 'PINNACLE_OPPORTUNITY_INVALID',
      statusCode: 400
    });
  }

  const matchupId = getMatchupIdFromOpportunity(opportunity);
  if (!matchupId) {
    throw createPinnacleError('Falta pinnacleId en la oportunidad. No se puede preparar ticket.', {
      code: 'PINNACLE_MATCHUP_MISSING',
      statusCode: 400
    });
  }

  const ticketKey = buildTicketKey(opportunity);
  const expiresAt = new Date(Date.now() + 90 * 1000).toISOString();
  const existingIdx = db.data.pinnacle.pendingTickets.findIndex((t) => t.ticketKey === ticketKey && t.status === 'DRAFT');

  const nextTicket = {
    id: `pn_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    ticketKey,
    status: 'DRAFT',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt,
    opportunity: cloneForStorage(opportunity),
    payload: buildDraftPreviewPayload(opportunity)
  };

  if (existingIdx >= 0) {
    const old = db.data.pinnacle.pendingTickets[existingIdx];
    nextTicket.id = old.id;
    nextTicket.createdAt = old.createdAt;
    db.data.pinnacle.pendingTickets[existingIdx] = nextTicket;
  } else {
    db.data.pinnacle.pendingTickets.push(nextTicket);
  }

  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
  return nextTicket;
};

export const confirmPinnacleSemiAutoTicket = async (ticketId) => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  const { idx, ticket } = getTicketById(ticketId);
  if (ticket.status !== 'DRAFT') {
    throw createPinnacleError(`Ticket en estado no confirmable: ${ticket.status}`, {
      code: 'PINNACLE_TICKET_INVALID_STATE',
      statusCode: 409
    });
  }

  const now = Date.now();
  const exp = new Date(ticket.expiresAt).getTime();
  if (!Number.isFinite(exp) || now > exp) {
    ticket.status = 'EXPIRED';
    ticket.updatedAt = nowIso();
    db.data.pinnacle.history.push(ticket);
    db.data.pinnacle.pendingTickets.splice(idx, 1);
    await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
    throw createPinnacleError('Ticket expirado. Preparar nuevamente.', {
      code: 'PINNACLE_TICKET_EXPIRED',
      statusCode: 409
    });
  }

  const mirroredBet = await placeAutoBet(withPinnacleMirrorMetadata(ticket.opportunity));
  if (!mirroredBet) {
    throw createPinnacleError('No se pudo registrar apuesta simulada en portfolio.', {
      code: 'PINNACLE_SIM_MIRROR_FAILED',
      statusCode: 409
    });
  }

  ticket.status = 'CONFIRMED';
  ticket.updatedAt = nowIso();
  ticket.confirmedAt = nowIso();
  ticket.portfolioBetId = mirroredBet.id;

  db.data.pinnacle.history.push(ticket);
  db.data.pinnacle.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

  return { ticket, bet: mirroredBet };
};

export const cancelPinnacleSemiAutoTicket = async (ticketId) => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  const { idx, ticket } = getTicketById(ticketId);
  ticket.status = 'CANCELLED';
  ticket.updatedAt = nowIso();

  db.data.pinnacle.history.push(ticket);
  db.data.pinnacle.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });
  return ticket;
};

export const getPinnacleSemiAutoTickets = async () => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  return {
    pending: db.data.pinnacle.pendingTickets,
    history: db.data.pinnacle.history.slice(-100).reverse()
  };
};

const toFiniteOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseArcadiaDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const isExternalPinnacleCashflowTx = (tx = {}) => {
  const typeNorm = String(tx?.type || '').trim().toLowerCase();
  const descNorm = String(tx?.description || '').trim().toLowerCase();

  if (typeNorm === 'e') return true;
  if (descNorm.includes('customer deposit')) return true;
  if (descNorm.includes('customer withdrawal')) return true;
  if (descNorm.includes('deposit')) return true;
  if (descNorm.includes('withdraw')) return true;
  return false;
};

const normalizeArcadiaTransaction = (raw = {}) => {
  const amountRaw = Number(raw?.amount);
  const creditRaw = Number(raw?.creditAmount);
  const debitRaw = Number(raw?.debitAmount);
  const amount = Number.isFinite(amountRaw)
    ? amountRaw
    : (Number.isFinite(creditRaw) && Number.isFinite(debitRaw)
      ? Number((creditRaw - debitRaw).toFixed(2))
      : null);

  const normalized = {
    id: raw?.id ?? null,
    createdAt: parseArcadiaDateOrNull(raw?.createdAt),
    type: String(raw?.type || '').trim() || null,
    code: String(raw?.code || '').trim() || null,
    description: String(raw?.description || '').trim() || null,
    productName: String(raw?.productName || '').trim() || null,
    amount: Number.isFinite(Number(amount)) ? Number(amount) : null,
    creditAmount: Number.isFinite(creditRaw) ? Number(creditRaw) : null,
    debitAmount: Number.isFinite(debitRaw) ? Number(debitRaw) : null,
    balance: toFiniteOrNull(raw?.balance),
    raw
  };

  return {
    ...normalized,
    isExternalCashflow: isExternalPinnacleCashflowTx(normalized)
  };
};

const normalizeArcadiaTransactions = (payload = null) => {
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items)
      ? payload.items
      : (Array.isArray(payload?.data) ? payload.data : []));

  return rows
    .filter((row) => row && typeof row === 'object')
    .map(normalizeArcadiaTransaction)
    .sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime());
};

const summarizePinnacleTransactions = (rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  const externalRows = list.filter((row) => row?.isExternalCashflow === true && Number.isFinite(Number(row?.amount)));

  const externalCredits = Number(externalRows
    .filter((row) => Number(row.amount) > 0)
    .reduce((sum, row) => sum + Number(row.amount), 0)
    .toFixed(2));

  const externalDebits = Number(externalRows
    .filter((row) => Number(row.amount) < 0)
    .reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0)
    .toFixed(2));

  const externalNet = Number((externalCredits - externalDebits).toFixed(2));
  const baseCapitalFromEnv = Number.isFinite(PINNACLE_PNL_BASE_CAPITAL_FALLBACK)
    ? Number(PINNACLE_PNL_BASE_CAPITAL_FALLBACK.toFixed(2))
    : null;

  const hasExternalBase = externalRows.length > 0;
  const baseCapital = hasExternalBase ? externalNet : baseCapitalFromEnv;
  const baseCapitalSource = hasExternalBase
    ? 'arcadia-transactions-external'
    : (Number.isFinite(baseCapitalFromEnv) ? 'env-pinnacle-pnl-base-capital' : 'unavailable');

  return {
    rowsCount: list.length,
    externalRowsCount: externalRows.length,
    externalCredits,
    externalDebits,
    externalNet,
    baseCapital: Number.isFinite(Number(baseCapital)) ? Number(baseCapital) : null,
    baseCapitalSource,
    firstTxAt: list.length > 0 ? list[list.length - 1]?.createdAt || null : null,
    lastTxAt: list.length > 0 ? list[0]?.createdAt || null : null
  };
};

const fetchPinnacleTransactionsSummary = async ({ forceRefresh = false, days = PINNACLE_PNL_WINDOW_DAYS } = {}) => {
  const normalizedDays = parsePositiveInt(days, parsePositiveInt(PINNACLE_PNL_WINDOW_DAYS, 365));
  const cache = db.data?.pinnacle?.remoteTransactions || null;
  const cacheFresh = !forceRefresh
    && cache?.fetchedAt
    && Number.isFinite(new Date(cache.fetchedAt).getTime())
    && (Date.now() - new Date(cache.fetchedAt).getTime()) <= PINNACLE_REMOTE_TRANSACTIONS_TTL_MS
    && Number(cache?.windowDays) === Number(normalizedDays)
    && Array.isArray(cache?.items);

  if (cacheFresh) {
    return {
      source: 'cache',
      fetchedAt: cache.fetchedAt,
      windowDays: normalizedDays,
      items: cache.items,
      summary: cache.summary || summarizePinnacleTransactions(cache.items)
    };
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - (normalizedDays * 24 * 60 * 60 * 1000));
  const params = {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  };

  try {
    const response = await arcadiaRequest('GET', '/transactions', { params });
    const items = normalizeArcadiaTransactions(response?.data);
    const summary = summarizePinnacleTransactions(items);

    db.data.pinnacle.remoteTransactions = {
      items,
      fetchedAt: nowIso(),
      source: 'arcadia',
      windowDays: normalizedDays,
      summary,
      params
    };
    await db.write();

    return {
      source: 'arcadia',
      fetchedAt: db.data.pinnacle.remoteTransactions.fetchedAt,
      windowDays: normalizedDays,
      items,
      summary
    };
  } catch (error) {
    const fallbackItems = Array.isArray(cache?.items) ? cache.items : [];
    return {
      source: fallbackItems.length > 0 ? 'cache-fallback' : 'unavailable',
      fetchedAt: cache?.fetchedAt || null,
      windowDays: normalizedDays,
      items: fallbackItems,
      summary: cache?.summary || summarizePinnacleTransactions(fallbackItems),
      error: {
        message: error?.message || 'Error al obtener transacciones Pinnacle.',
        code: error?.code || null,
        statusCode: Number(error?.statusCode) || null,
        diagnostic: error?.diagnostic || null
      }
    };
  }
};

export const getPinnacleAccountBalance = async ({ forceRefreshTransactions = false } = {}) => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  const response = await arcadiaRequest('GET', '/wallet/balance');
  const raw = response?.data || {};

  const rawAmount = raw?.amount;
  const amount = (rawAmount === null || rawAmount === undefined || String(rawAmount).trim() === '')
    ? null
    : Number(rawAmount);
  const currency = String(raw?.currency || 'USD').toUpperCase();
  const txSummaryData = await fetchPinnacleTransactionsSummary({ forceRefresh: forceRefreshTransactions });
  const baseCapital = Number(txSummaryData?.summary?.baseCapital);
  const pnlByBalance = Number.isFinite(amount) && Number.isFinite(baseCapital)
    ? Number((amount - baseCapital).toFixed(2))
    : null;

  const pnlSource = Number.isFinite(pnlByBalance)
    ? 'balance-minus-external-cashflow'
    : 'unavailable';

  return {
    fetchedAt: nowIso(),
    endpoint: '/wallet/balance',
    source: 'arcadia',
    balance: {
      amount: Number.isFinite(amount) ? amount : null,
      currency
    },
    pnl: {
      total: Number.isFinite(pnlByBalance) ? pnlByBalance : null,
      netAfterOpenStake: Number.isFinite(pnlByBalance) ? pnlByBalance : null,
      byBalance: Number.isFinite(pnlByBalance) ? pnlByBalance : null,
      baseCapital: Number.isFinite(baseCapital) ? Number(baseCapital) : null,
      baseCapitalSource: txSummaryData?.summary?.baseCapitalSource || null,
      externalNet: Number(txSummaryData?.summary?.externalNet || 0),
      externalCredits: Number(txSummaryData?.summary?.externalCredits || 0),
      externalDebits: Number(txSummaryData?.summary?.externalDebits || 0),
      source: pnlSource,
      rowsCount: Number(txSummaryData?.summary?.rowsCount || 0)
    },
    transactions: {
      source: txSummaryData?.source || null,
      fetchedAt: txSummaryData?.fetchedAt || null,
      windowDays: Number(txSummaryData?.windowDays || 0),
      summary: txSummaryData?.summary || null,
      error: txSummaryData?.error || null
    },
    raw
  };
};

const formatArcadiaFinalScore = (items = []) => {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;

  const home = list.find((s) => String(s?.alignment || '').toLowerCase() === 'home');
  const away = list.find((s) => String(s?.alignment || '').toLowerCase() === 'away');
  const homeScore = Number(home?.score);
  const awayScore = Number(away?.score);

  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  return `${homeScore}-${awayScore}`;
};

const buildArcadiaMatchName = (matchup = {}) => {
  const participants = Array.isArray(matchup?.participants) ? matchup.participants : [];
  const home = participants.find((p) => String(p?.alignment || '').toLowerCase() === 'home') || participants[0] || null;
  const away = participants.find((p) => String(p?.alignment || '').toLowerCase() === 'away') || participants[1] || null;
  const homeName = String(home?.name || '').trim();
  const awayName = String(away?.name || '').trim();
  if (homeName && awayName) return `${homeName} vs ${awayName}`;
  return homeName || awayName || null;
};

const resolveArcadiaSelectionMeta = (selection = {}) => {
  const designation = String(selection?.designation || '').trim().toLowerCase();
  const marketType = String(selection?.market?.type || '').trim().toLowerCase();
  const marketKey = String(selection?.market?.key || '').trim().toLowerCase();
  const points = toFiniteOrNull(selection?.points);

  if (marketType === 'moneyline' || marketKey === 's;0;m') {
    if (designation === 'home') return { pick: 'home', selection: 'LOCAL', market: '1x2' };
    if (designation === 'away') return { pick: 'away', selection: 'VISITA', market: '1x2' };
    if (designation === 'draw') return { pick: 'draw', selection: 'EMPATE', market: '1x2' };
    return { pick: designation || 'unknown', selection: designation || 'SELECCION', market: '1x2' };
  }

  if (marketType === 'total' || marketKey === 's;0;t') {
    if (designation === 'over') {
      return {
        pick: Number.isFinite(points) ? `over_${points}` : 'over',
        selection: Number.isFinite(points) ? `OVER ${points}` : 'OVER',
        market: Number.isFinite(points) ? `Total ${points}` : 'Total'
      };
    }
    if (designation === 'under') {
      return {
        pick: Number.isFinite(points) ? `under_${points}` : 'under',
        selection: Number.isFinite(points) ? `UNDER ${points}` : 'UNDER',
        market: Number.isFinite(points) ? `Total ${points}` : 'Total'
      };
    }
  }

  return {
    pick: designation || 'unknown',
    selection: designation ? designation.toUpperCase() : 'SELECCION',
    market: marketType || marketKey || 'market'
  };
};

const resolveArcadiaLocalStatus = ({ status = '', outcome = '', stake = null } = {}) => {
  const statusNorm = String(status || '').trim().toLowerCase();
  const outcomeNorm = String(outcome || '').trim().toLowerCase();
  const stakeNum = toFiniteOrNull(stake);

  if (statusNorm !== 'settled') return { localStatus: 'PENDING', profit: 0 };

  if (['win', 'won'].includes(outcomeNorm)) return { localStatus: 'WON', profit: null };
  if (['loss', 'lose', 'lost'].includes(outcomeNorm)) {
    return { localStatus: 'LOST', profit: Number.isFinite(stakeNum) ? -Math.abs(stakeNum) : null };
  }
  if (['push', 'void', 'refund', 'cancelled', 'canceled'].includes(outcomeNorm)) return { localStatus: 'VOID', profit: 0 };

  return { localStatus: 'PENDING', profit: 0 };
};

const normalizeArcadiaRemoteBet = (raw = {}) => {
  const selection = Array.isArray(raw?.selections) ? (raw.selections[0] || null) : null;
  const matchup = selection?.matchup || null;
  const matchupId = Number(selection?.matchup?.id || selection?.matchupId || raw?.matchupId || 0);

  const stake = toFiniteOrNull(raw?.stake);
  const odd = toFiniteOrNull(raw?.price ?? selection?.price);
  const winLoss = toFiniteOrNull(raw?.winLoss);
  const payout = toFiniteOrNull(raw?.payout);
  const toWin = toFiniteOrNull(raw?.toWin);
  const placedAt = parseArcadiaDateOrNull(raw?.createdAt);
  const settledAt = parseArcadiaDateOrNull(raw?.settledAt);
  const status = String(raw?.status || '').trim().toLowerCase();
  const outcome = String(raw?.outcome || selection?.outcome || '').trim().toLowerCase();

  const selectionMeta = resolveArcadiaSelectionMeta(selection || {});
  const statusMeta = resolveArcadiaLocalStatus({ status, outcome, stake });

  let profit = Number.isFinite(winLoss)
    ? winLoss
    : (Number.isFinite(payout) ? payout : null);
  if (!Number.isFinite(profit)) {
    if (statusMeta.localStatus === 'WON' && Number.isFinite(toWin)) profit = toWin;
    else if (statusMeta.localStatus === 'LOST' && Number.isFinite(stake)) profit = -Math.abs(stake);
    else if (statusMeta.localStatus === 'VOID') profit = 0;
  }

  const potentialReturn = (() => {
    if (Number.isFinite(stake) && Number.isFinite(toWin)) return Number((stake + toWin).toFixed(2));
    if (Number.isFinite(stake) && Number.isFinite(odd) && odd > 1) return Number((stake * odd).toFixed(2));
    return null;
  })();

  return {
    providerBetId: raw?.id ?? null,
    providerRequestId: raw?.requestId || null,
    providerStatus: status || null,
    providerOutcome: outcome || null,
    placedAt,
    settledAt,
    statusNormalized: status || null,
    localStatus: statusMeta.localStatus,
    stake,
    odd,
    toWin,
    payout,
    winLoss,
    profit: Number.isFinite(profit) ? Number(profit) : null,
    potentialReturn,
    eventId: Number.isFinite(matchupId) && matchupId > 0 ? matchupId : null,
    pinnacleId: Number.isFinite(matchupId) && matchupId > 0 ? matchupId : null,
    matchDate: parseArcadiaDateOrNull(matchup?.startTime),
    match: buildArcadiaMatchName(matchup || {}),
    league: matchup?.league?.name || null,
    market: selectionMeta.market,
    selection: selectionMeta.selection,
    pick: selectionMeta.pick,
    finalScore: formatArcadiaFinalScore(selection?.finalScore),
    type: 'PINNACLE_REAL',
    strategy: 'PINNACLE_REAL',
    provider: 'pinnacle',
    placementProvider: 'pinnacle',
    integration: 'pinnacle',
    source: 'remote',
    raw
  };
};

const normalizeArcadiaRemoteBets = (payload = null) => {
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.bets)
      ? payload.bets
      : (Array.isArray(payload?.items)
        ? payload.items
        : (Array.isArray(payload?.data) ? payload.data : [])));

  return rows
    .filter((row) => row && typeof row === 'object')
    .map(normalizeArcadiaRemoteBet)
    .filter((row) => row?.providerBetId !== null && row?.providerBetId !== undefined && row?.providerBetId !== '');
};

const upsertPortfolioBetFromRemote = (existing = {}, remote = {}) => {
  const fallbackId = `pn_remote_${remote.providerBetId || remote.providerRequestId || Date.now()}_${Math.floor(Math.random() * 10000)}`;
  return {
    ...existing,
    id: existing?.id || fallbackId,
    createdAt: existing?.createdAt || remote.placedAt || nowIso(),
    confirmedAt: existing?.confirmedAt || remote.placedAt || null,
    closedAt: remote.settledAt || existing?.closedAt || null,
    lastUpdate: nowIso(),
    eventId: remote.eventId ?? existing?.eventId ?? null,
    pinnacleId: remote.pinnacleId ?? existing?.pinnacleId ?? remote.eventId ?? null,
    matchDate: remote.matchDate || existing?.matchDate || null,
    match: remote.match || existing?.match || 'Pinnacle Remote Bet',
    league: remote.league || existing?.league || null,
    market: remote.market || existing?.market || '1x2',
    selection: remote.selection || existing?.selection || null,
    pick: remote.pick || existing?.pick || 'unknown',
    type: existing?.type || remote.type || 'PINNACLE_REAL',
    strategy: existing?.strategy || remote.strategy || 'PINNACLE_REAL',
    odd: Number.isFinite(Number(remote.odd)) ? Number(remote.odd) : (existing?.odd ?? null),
    price: Number.isFinite(Number(remote.odd)) ? Number(remote.odd) : (existing?.price ?? null),
    stake: Number.isFinite(Number(remote.stake)) ? Number(remote.stake) : (existing?.stake ?? null),
    kellyStake: Number.isFinite(Number(remote.stake)) ? Number(remote.stake) : (existing?.kellyStake ?? existing?.stake ?? null),
    potentialReturn: Number.isFinite(Number(remote.potentialReturn))
      ? Number(remote.potentialReturn)
      : (existing?.potentialReturn ?? null),
    status: remote.localStatus || existing?.status || 'PENDING',
    profit: remote.localStatus === 'PENDING'
      ? (existing?.profit ?? 0)
      : (Number.isFinite(Number(remote.profit)) ? Number(remote.profit) : (existing?.profit ?? 0)),
    provider: 'pinnacle',
    placementProvider: 'pinnacle',
    integration: 'pinnacle',
    source: 'remote',
    providerBetId: remote.providerBetId ?? existing?.providerBetId ?? null,
    providerRequestId: remote.providerRequestId || existing?.providerRequestId || null,
    providerStatus: remote.providerStatus || existing?.providerStatus || null,
    providerOutcome: remote.providerOutcome || existing?.providerOutcome || null,
    providerAcceptedAt: remote.placedAt || existing?.providerAcceptedAt || null,
    providerSettledAt: remote.settledAt || existing?.providerSettledAt || null,
    providerToWin: Number.isFinite(Number(remote.toWin)) ? Number(remote.toWin) : (existing?.providerToWin ?? null),
    providerPayout: Number.isFinite(Number(remote.payout)) ? Number(remote.payout) : (existing?.providerPayout ?? null),
    providerWinLoss: Number.isFinite(Number(remote.winLoss)) ? Number(remote.winLoss) : (existing?.providerWinLoss ?? null),
    finalScore: remote.finalScore || existing?.finalScore || null,
    lastKnownScore: remote.finalScore || existing?.lastKnownScore || existing?.initialScore || '0-0',
    initialScore: existing?.initialScore || remote.finalScore || '0-0',
    realPlacement: {
      ...(existing?.realPlacement || {}),
      source: 'arcadia-remote-sync',
      endpoint: '/bets',
      requestId: remote.providerRequestId || existing?.realPlacement?.requestId || null,
      response: remote.raw || existing?.realPlacement?.response || null
    }
  };
};

const reconcilePortfolioFromPinnacleRemote = (remoteRows = [], { importUnsettled = false } = {}) => {
  if (!db.data?.portfolio) return { touchedCount: 0, insertedHistory: 0, insertedActive: 0, patched: 0, movedToHistory: 0 };
  if (!Array.isArray(db.data.portfolio.activeBets)) db.data.portfolio.activeBets = [];
  if (!Array.isArray(db.data.portfolio.history)) db.data.portfolio.history = [];

  const stats = {
    touchedCount: 0,
    insertedHistory: 0,
    insertedActive: 0,
    patched: 0,
    movedToHistory: 0
  };

  for (const remote of remoteRows) {
    const providerKey = String(remote?.providerBetId || '').trim();
    if (!providerKey) continue;

    const historyIdx = db.data.portfolio.history.findIndex((row) => String(row?.providerBetId || '').trim() === providerKey);
    const activeIdx = db.data.portfolio.activeBets.findIndex((row) => String(row?.providerBetId || '').trim() === providerKey);
    const isSettled = String(remote?.statusNormalized || '').toLowerCase() === 'settled';

    if (historyIdx >= 0) {
      db.data.portfolio.history[historyIdx] = upsertPortfolioBetFromRemote(db.data.portfolio.history[historyIdx], remote);
      stats.patched += 1;
      continue;
    }

    if (isSettled) {
      if (activeIdx >= 0) {
        const moved = upsertPortfolioBetFromRemote(db.data.portfolio.activeBets[activeIdx], remote);
        db.data.portfolio.activeBets.splice(activeIdx, 1);
        db.data.portfolio.history.unshift(moved);
        stats.movedToHistory += 1;
      } else {
        db.data.portfolio.history.unshift(upsertPortfolioBetFromRemote(null, remote));
        stats.insertedHistory += 1;
      }
      continue;
    }

    if (!importUnsettled) continue;

    if (activeIdx >= 0) {
      db.data.portfolio.activeBets[activeIdx] = upsertPortfolioBetFromRemote(db.data.portfolio.activeBets[activeIdx], remote);
      stats.patched += 1;
    } else {
      db.data.portfolio.activeBets.push(upsertPortfolioBetFromRemote(null, remote));
      stats.insertedActive += 1;
    }
  }

  stats.touchedCount = stats.insertedHistory + stats.insertedActive + stats.patched + stats.movedToHistory;
  return stats;
};

export const syncRemotePinnacleHistory = async ({
  forceRefresh = false,
  limit = 200,
  status = PINNACLE_REMOTE_HISTORY_DEFAULT_STATUS,
  days = PINNACLE_REMOTE_HISTORY_DEFAULT_DAYS
} = {}) => {
  await initDB();
  await db.read();
  ensurePinnacleStore();

  const normalizedStatus = parsePinnacleHistoryStatus(status, PINNACLE_REMOTE_HISTORY_DEFAULT_STATUS);
  const normalizedDays = parsePositiveInt(days, parsePositiveInt(PINNACLE_REMOTE_HISTORY_DEFAULT_DAYS, 120));
  const parsedLimit = Number(limit);
  const normalizedLimit = Number.isFinite(parsedLimit)
    ? (parsedLimit <= 0 ? null : Math.max(1, Math.min(5000, Math.floor(parsedLimit))))
    : 200;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - (normalizedDays * 24 * 60 * 60 * 1000));
  const params = {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    status: normalizedStatus
  };

  const cache = db.data.pinnacle.remoteHistory || null;
  const cacheFresh = !forceRefresh
    && cache?.fetchedAt
    && Number.isFinite(new Date(cache.fetchedAt).getTime())
    && (Date.now() - new Date(cache.fetchedAt).getTime()) <= PINNACLE_REMOTE_HISTORY_TTL_MS
    && cache?.params
    && cache.params.status === params.status
    && cache.params.startDate === params.startDate
    && cache.params.endDate === params.endDate;

  if (cacheFresh) {
    const items = Array.isArray(cache.items) ? cache.items : [];
    return {
      source: 'cache',
      fetchedAt: cache.fetchedAt,
      params,
      items: normalizedLimit === null ? items : items.slice(0, normalizedLimit),
      totalCount: items.length,
      summary: cache.summary || null,
      reconcileStats: { touchedCount: 0, insertedHistory: 0, insertedActive: 0, patched: 0, movedToHistory: 0 }
    };
  }

  try {
    const response = await arcadiaRequest('GET', '/bets', { params });
    const rows = normalizeArcadiaRemoteBets(response?.data)
      .sort((a, b) => new Date(b?.placedAt || 0).getTime() - new Date(a?.placedAt || 0).getTime());

    const reconcileStats = reconcilePortfolioFromPinnacleRemote(rows, {
      importUnsettled: normalizedStatus !== 'settled'
    });

    db.data.pinnacle.remoteHistory = {
      items: rows,
      fetchedAt: nowIso(),
      source: 'arcadia',
      params,
      summary: response?.data?.summary || null
    };

    await db.write();

    return {
      source: 'arcadia',
      fetchedAt: db.data.pinnacle.remoteHistory.fetchedAt,
      params,
      items: normalizedLimit === null ? rows : rows.slice(0, normalizedLimit),
      totalCount: rows.length,
      summary: response?.data?.summary || null,
      reconcileStats
    };
  } catch (error) {
    const fallbackItems = Array.isArray(cache?.items) ? cache.items : [];
    return {
      source: fallbackItems.length > 0 ? 'cache-fallback' : 'unavailable',
      fetchedAt: cache?.fetchedAt || null,
      params,
      items: normalizedLimit === null ? fallbackItems : fallbackItems.slice(0, normalizedLimit),
      totalCount: fallbackItems.length,
      summary: cache?.summary || null,
      error: {
        message: error?.message || 'Error al sincronizar historial Pinnacle.',
        code: error?.code || null,
        statusCode: Number(error?.statusCode) || null,
        diagnostic: error?.diagnostic || null
      },
      reconcileStats: { touchedCount: 0, insertedHistory: 0, insertedActive: 0, patched: 0, movedToHistory: 0 }
    };
  }
};

export const getPinnacleAccountSnapshot = async ({
  forceRefresh = false,
  historyLimit = 0,
  historyStatus = PINNACLE_REMOTE_HISTORY_DEFAULT_STATUS,
  historyDays = PINNACLE_REMOTE_HISTORY_DEFAULT_DAYS
} = {}) => {
  const balance = await getPinnacleAccountBalance({ forceRefreshTransactions: forceRefresh });

  const parsedLimit = Number(historyLimit);
  const shouldSyncHistory = Number.isFinite(parsedLimit) ? parsedLimit !== 0 : false;
  if (!shouldSyncHistory) {
    return {
      ...balance,
      history: [],
      historyCount: 0,
      historyTotalCount: 0,
      historyStatus: parsePinnacleHistoryStatus(historyStatus, PINNACLE_REMOTE_HISTORY_DEFAULT_STATUS),
      reconcile: { touchedCount: 0, insertedHistory: 0, insertedActive: 0, patched: 0, movedToHistory: 0 }
    };
  }

  const remote = await syncRemotePinnacleHistory({
    forceRefresh,
    limit: parsedLimit,
    status: historyStatus,
    days: historyDays
  });

  return {
    ...balance,
    history: Array.isArray(remote?.items) ? remote.items : [],
    historyCount: Array.isArray(remote?.items) ? remote.items.length : 0,
    historyTotalCount: Number(remote?.totalCount || 0),
    historyStatus: parsePinnacleHistoryStatus(historyStatus, PINNACLE_REMOTE_HISTORY_DEFAULT_STATUS),
    historySource: remote?.source || null,
    historyFetchedAt: remote?.fetchedAt || null,
    historySummary: remote?.summary || null,
    historyError: remote?.error || null,
    reconcile: remote?.reconcileStats || { touchedCount: 0, insertedHistory: 0, insertedActive: 0, patched: 0, movedToHistory: 0 }
  };
};

export const getLatestPinnacleCapture = async () => {
  const capture = readJsonIfExists(PINNACLE_CAPTURE_LATEST);
  if (!capture) {
    return {
      found: false,
      path: PINNACLE_CAPTURE_LATEST,
      message: 'No existe capture-placement.latest.json en data/pinnacle.'
    };
  }

  const captures = Array.isArray(capture.captures) ? capture.captures : [];
  return {
    found: true,
    path: PINNACLE_CAPTURE_LATEST,
    generatedAt: capture.generatedAt,
    totalCaptured: captures.length,
    sample: captures.slice(-5)
  };
};

export const getPinnacleRealPlacementDryRun = async (ticketId) => {
  const draft = await prepareRealPlacementDraftInternal(ticketId);

  return {
    ticketId,
    endpoint: draft.endpoint,
    quoteEndpoint: draft.quoteEndpoint,
    authHeadersPreview: draft.authHeadersPreview,
    quotePayload: draft.quotePayload,
    quotePreview: {
      marketId: draft.quoteResponse?.selections?.[0]?.marketId ?? null,
      matchupId: draft.quoteResponse?.selections?.[0]?.matchupId ?? null,
      marketKey: draft.quoteResponse?.selections?.[0]?.marketKey ?? null,
      designation: draft.quoteResponse?.selections?.[0]?.designation ?? null,
      priceAmerican: draft.quoteResponse?.selections?.[0]?.price ?? null,
      limits: draft.quoteResponse?.limits || []
    },
    payload: draft.payload,
    preview: {
      requestId: draft.payload?.requestId,
      matchupId: draft.payload?.selections?.[0]?.matchupId,
      marketId: draft.payload?.selections?.[0]?.marketId,
      marketKey: draft.payload?.selections?.[0]?.marketKey,
      designation: draft.payload?.selections?.[0]?.designation,
      price: draft.payload?.selections?.[0]?.price,
      stake: draft.payload?.stake
    }
  };
};

const resolveRealPlacementEnabled = () => String(process.env.PINNACLE_REAL_PLACEMENT_ENABLED || '').trim().toLowerCase() === 'true';

export const confirmPinnacleRealPlacement = async (ticketId) => {
  if (!resolveRealPlacementEnabled()) {
    throw createPinnacleError(
      'PINNACLE_REAL_PLACEMENT_ENABLED=false. Activalo en .env para envio real.',
      { code: 'PINNACLE_REAL_DISABLED', statusCode: 400 }
    );
  }

  await initDB();
  await db.read();
  ensurePinnacleStore();

  const { idx, ticket } = getTicketById(ticketId);
  if (ticket.status !== 'DRAFT') {
    throw createPinnacleError(`Ticket en estado no valido: ${ticket.status}`, {
      code: 'PINNACLE_TICKET_INVALID_STATE',
      statusCode: 409
    });
  }

  const draft = await prepareRealPlacementDraftInternal(ticketId);
  const response = await arcadiaRequest('POST', draft.endpoint, { data: draft.payload });
  const providerBody = response.data || {};
  const providerStatus = String(providerBody?.status || '').toUpperCase();

  if (providerStatus.includes('REJECT')) {
    ticket.status = 'REAL_REJECTED';
    ticket.updatedAt = nowIso();
    ticket.realPlacement = {
      placedAt: nowIso(),
      endpoint: draft.endpoint,
      requestId: draft.payload?.requestId || null,
      requested: draft.payload,
      response: providerBody
    };
    db.data.pinnacle.history.push(ticket);
    db.data.pinnacle.pendingTickets.splice(idx, 1);
    await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

    throw createPinnacleError('Apuesta real Pinnacle rechazada por provider.', {
      code: 'PINNACLE_REAL_REJECTED',
      statusCode: 409,
      diagnostic: {
        ticketId,
        providerStatus,
        providerBody
      }
    });
  }

  let mirroredBet = await placeAutoBet(withPinnacleMirrorMetadata(ticket.opportunity));
  if (!mirroredBet) {
    mirroredBet = findPortfolioMirrorBet({ ticket, draft });
  }
  if (!mirroredBet) {
    mirroredBet = createManualMirrorBetFromPlacement({ ticket, draft, providerBody });
  }
  mirroredBet = reconcileMirroredBetWithRequested({
    mirroredBet,
    requestedPayload: draft.payload,
    providerBody
  });

  ticket.status = providerStatus === 'PENDING_ACCEPTANCE' ? 'REAL_PENDING_ACCEPTANCE' : 'REAL_SUBMITTED';
  ticket.updatedAt = nowIso();
  ticket.confirmedAt = nowIso();
  ticket.realPlacement = {
    placedAt: nowIso(),
    endpoint: draft.endpoint,
    requestId: draft.payload?.requestId || null,
    requested: draft.payload,
    response: providerBody
  };
  if (mirroredBet?.id) ticket.portfolioBetId = mirroredBet.id;

  db.data.pinnacle.history.push(ticket);
  db.data.pinnacle.pendingTickets.splice(idx, 1);
  await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 120 });

  return {
    ticket,
    mirroredBet,
    providerResponse: providerBody
  };
};

export const confirmPinnacleRealPlacementFast = async (ticketId) => {
  return confirmPinnacleRealPlacement(ticketId);
};
