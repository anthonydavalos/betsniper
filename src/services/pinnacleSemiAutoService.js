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
  if (!db.data.pinnacle) db.data.pinnacle = { pendingTickets: [], history: [] };
  if (!Array.isArray(db.data.pinnacle.pendingTickets)) db.data.pinnacle.pendingTickets = [];
  if (!Array.isArray(db.data.pinnacle.history)) db.data.pinnacle.history = [];
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

const buildQuoteRequestPayload = (opportunity = {}) => {
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

  if (Number.isFinite(Number(preview.referencePriceAmerican))) {
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
  const quoteRes = await arcadiaRequest('POST', '/bets/straight/quote', { data: quotePayload });
  const payload = buildRealPlacementPayloadFromQuote({ quoteResponse: quoteRes.data, opportunity: ticket.opportunity });

  return {
    endpoint: '/bets/straight',
    quoteEndpoint: '/bets/straight/quote',
    quotePayload,
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

  const mirroredBet = await placeAutoBet(ticket.opportunity);
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

  let mirroredBet = await placeAutoBet(ticket.opportunity);
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
