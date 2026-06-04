import db, { initDB, writeDBWithRetry } from '../db/database.js';
import { getAllPinnacleLiveOdds, getPinnacleLiveOdds } from './pinnacleService.js';
import { getLiveOverview, getEventDetails } from './liveValueScanner.js';
import { findMatch } from '../utils/teamMatcher.js';

const DEFAULT_PREVIEW_LIMIT = 40;
const MAX_PREVIEW_LIMIT = 200;
const DEFAULT_MAX_EVENTS = Math.max(10, Math.floor(Number(process.env.LIVE_ARBITRAGE_MAX_EVENTS || 80)));
const DETAILS_CONCURRENCY = Math.max(1, Math.floor(Number(process.env.LIVE_ARBITRAGE_DETAILS_CONCURRENCY || 6)));
const DIAG_MAX_HISTORY = Math.max(200, Math.floor(Number(process.env.LIVE_ARBITRAGE_DIAG_MAX_HISTORY || 1200)));
const DIAG_DEFAULT_LIMIT = 200;
const DIAG_DEFAULT_WINDOW_MINUTES = Math.max(10, Math.floor(Number(process.env.LIVE_ARBITRAGE_DIAG_WINDOW_MINUTES || 180)));
const DIAG_TOP_OPS = Math.max(1, Math.min(10, Math.floor(Number(process.env.LIVE_ARBITRAGE_DIAG_TOP_OPS || 5))));
const DB_READ_RETRY_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.LIVE_ARBITRAGE_DB_READ_RETRY_ATTEMPTS || 4)));
const DB_READ_RETRY_DELAY_MS = Math.max(20, Math.floor(Number(process.env.LIVE_ARBITRAGE_DB_READ_RETRY_DELAY_MS || 90)));
const REQUIRE_CROSS_PROVIDER = !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_REQUIRE_CROSS_PROVIDER || 'true').trim().toLowerCase());
const ROLLOUT_TOTALS_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_TOTALS_ENABLED || 'false').trim().toLowerCase());
const ROLLOUT_BTTS_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_BTTS_ENABLED || 'false').trim().toLowerCase());
const BTTS_RELATED_FALLBACK_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_BTTS_RELATED_FALLBACK_ENABLED || 'true').trim().toLowerCase());
const TOTALS_MAX_LINE_DELTA = Math.max(0, Number(process.env.LIVE_ARBITRAGE_TOTALS_MAX_LINE_DELTA || 0.01));
const TOTALS_MIN_PINNACLE_MAX_RISK = Math.max(0, Number(process.env.LIVE_ARBITRAGE_TOTALS_MIN_PINNACLE_MAX_RISK || 120));
const BTTS_MIN_PINNACLE_MAX_RISK = Math.max(0, Number(process.env.LIVE_ARBITRAGE_BTTS_MIN_PINNACLE_MAX_RISK || 120));
const MARKET_MIN_ODD = Math.max(1.01, Number(process.env.LIVE_ARBITRAGE_MARKET_MIN_ODD || 1.01));
const MARKET_MAX_ODD = Math.max(MARKET_MIN_ODD, Number(process.env.LIVE_ARBITRAGE_MARKET_MAX_ODD || 25));
const RISK_MIN_ROI_PERCENT_DEFAULT = Math.max(0, Number(process.env.LIVE_ARBITRAGE_MIN_ROI_PERCENT || 0));
const RISK_MIN_PROFIT_ABS_DEFAULT = Math.max(0, Number(process.env.LIVE_ARBITRAGE_MIN_PROFIT_ABS || 0));
const LINK_FALLBACK_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_LINK_FALLBACK_ENABLED || 'true').trim().toLowerCase());
const LINK_FALLBACK_MIN_HOME_SCORE = Math.max(0, Math.min(1, Number(process.env.LIVE_ARBITRAGE_LINK_FALLBACK_MIN_HOME_SCORE || 0.8)));
const LINK_FALLBACK_MIN_SIDE_SCORE = Math.max(0, Math.min(1, Number(process.env.LIVE_ARBITRAGE_LINK_FALLBACK_MIN_SIDE_SCORE || 0.6)));
const LINK_FALLBACK_MIN_PAIR_SCORE = Math.max(0, Math.min(2, Number(process.env.LIVE_ARBITRAGE_LINK_FALLBACK_MIN_PAIR_SCORE || 1.45)));
const LINK_FALLBACK_SAMPLE_LIMIT = Math.max(1, Math.min(20, Math.floor(Number(process.env.LIVE_ARBITRAGE_LINK_FALLBACK_SAMPLE_LIMIT || 6))));
const PIN_LIVE_FALLBACK_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.LIVE_ARBITRAGE_PIN_LIVE_FALLBACK_ENABLED || 'true').trim().toLowerCase());
const PIN_LIVE_FALLBACK_MIN_HOME_SCORE = Math.max(0, Math.min(1, Number(process.env.LIVE_ARBITRAGE_PIN_LIVE_FALLBACK_MIN_HOME_SCORE || 0.8)));
const PIN_LIVE_FALLBACK_MIN_SIDE_SCORE = Math.max(0, Math.min(1, Number(process.env.LIVE_ARBITRAGE_PIN_LIVE_FALLBACK_MIN_SIDE_SCORE || 0.6)));
const PIN_LIVE_FALLBACK_MIN_PAIR_SCORE = Math.max(0, Math.min(2, Number(process.env.LIVE_ARBITRAGE_PIN_LIVE_FALLBACK_MIN_PAIR_SCORE || 1.45)));
const PIN_LIVE_FALLBACK_SAMPLE_LIMIT = Math.max(1, Math.min(20, Math.floor(Number(process.env.LIVE_ARBITRAGE_PIN_LIVE_FALLBACK_SAMPLE_LIMIT || 6))));

const SENSITIVE_MARKERS = [
  'women',
  'femen',
  'u21',
  'u20',
  'u19',
  'reserve',
  'res',
  ' ii ',
  ' iii '
];

const DC_OPPOSITE_COMBOS = [
  {
    code: '1X_PLUS_AWAY',
    label: '1X + Away',
    dcKey: 'homeDraw',
    dcSelection: '1X',
    oppositeKey: 'away',
    oppositeSelection: 'Away'
  },
  {
    code: 'X2_PLUS_HOME',
    label: 'X2 + Home',
    dcKey: 'drawAway',
    dcSelection: 'X2',
    oppositeKey: 'home',
    oppositeSelection: 'Home'
  },
  {
    code: '12_PLUS_DRAW',
    label: '12 + Draw',
    dcKey: 'homeAway',
    dcSelection: '12',
    oppositeKey: 'draw',
    oppositeSelection: 'Draw'
  }
];

const toNumber = (value, fallback = NaN) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableDbReadError = (error) => {
  const code = String(error?.code || '').toUpperCase();
  const msg = String(error?.message || '').toLowerCase();

  if (['EBUSY', 'EPERM', 'EACCES'].includes(code)) return true;
  if (msg.includes('unexpected end of json input')) return true;
  if (msg.includes('unterminated string')) return true;
  return false;
};

const ensureDbReadyWithRetry = async () => {
  let lastError = null;

  for (let attempt = 1; attempt <= DB_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await initDB();
      await db.read();
      return;
    } catch (error) {
      lastError = error;
      const canRetry = isRetryableDbReadError(error) && attempt < DB_READ_RETRY_ATTEMPTS;
      if (!canRetry) break;
      await wait(DB_READ_RETRY_DELAY_MS * attempt);
    }
  }

  if (lastError) throw lastError;
};

const toNonNegative = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const safePositiveOdd = (value) => {
  const n = toNumber(value, NaN);
  if (!Number.isFinite(n) || n <= 1) return null;
  return n;
};

const safeMarketOdd = (value) => {
  const odd = safePositiveOdd(value);
  if (!odd) return null;
  if (odd < MARKET_MIN_ODD || odd > MARKET_MAX_ODD) return null;
  return odd;
};

const clampPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const normalizeText = (value = '') => String(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeTeam = (value = '') => normalizeText(value)
  .replace(/\b(fc|cf|sc|ac|cd|club|futbol|football|deportivo)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const splitVsName = (name = '') => {
  const raw = String(name || '');
  const parts = raw.split(/\s+vs\.?\s+/i);
  return {
    home: String(parts[0] || '').trim(),
    away: String(parts[1] || '').trim()
  };
};

const teamSimilarity = (a = '', b = '') => {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const token of ta) {
    if (tb.has(token)) common += 1;
  }
  return common / Math.max(ta.size, tb.size);
};

const resolveOrientation = ({ pinHome = '', pinAway = '', altName = '' } = {}) => {
  const sides = splitVsName(altName);
  if (!sides.home || !sides.away) return { orientation: 'unknown', confidence: 0 };

  const normalScore = teamSimilarity(pinHome, sides.home) + teamSimilarity(pinAway, sides.away);
  const swappedScore = teamSimilarity(pinHome, sides.away) + teamSimilarity(pinAway, sides.home);

  if (normalScore < 0.8 && swappedScore < 0.8) {
    return {
      orientation: 'unknown',
      confidence: Number(Math.max(normalScore, swappedScore).toFixed(3))
    };
  }

  if (swappedScore > normalScore + 0.15) {
    return {
      orientation: 'swapped',
      confidence: Number(swappedScore.toFixed(3))
    };
  }

  return {
    orientation: 'normal',
    confidence: Number(normalScore.toFixed(3))
  };
};

const toLeagueName = (league) => {
  if (!league) return '';
  if (typeof league === 'string') return league;
  return String(league?.name || league?.league || '').trim();
};

const toCountryName = (row = {}) => String(
  row?.country
    || row?.catName
    || row?.league?.country
    || row?.league?.countryName
    || ''
).trim();

const buildFallbackCandidates = (upcomingRows = []) => {
  if (!Array.isArray(upcomingRows) || upcomingRows.length === 0) return [];

  return upcomingRows
    .filter((row) => row && row?.id && row?.home && row?.away && row?.date)
    .map((row) => ({
      id: String(row.id),
      home: String(row.home || '').trim(),
      away: String(row.away || '').trim(),
      date: row.date,
      startDate: row.date,
      league: toLeagueName(row?.league),
      country: toCountryName(row),
      __row: row
    }));
};

const resolveFallbackLink = ({ event, fallbackCandidates = [] } = {}) => {
  try {
    const altName = String(event?.name || '').trim();
    const sides = splitVsName(altName);
    const altHome = String(sides?.home || '').trim();
    const altAway = String(sides?.away || '').trim();
    const targetDate = event?.startDate || event?.date || null;
    const targetLeague = String(event?.league || '').trim();

    if (!altHome || !targetDate || fallbackCandidates.length === 0) {
      return { link: null, reason: 'fallback_input_missing', meta: null };
    }

    const homeMatch = findMatch(altHome, targetDate, fallbackCandidates, null, targetLeague);
    if (!homeMatch?.match) {
      return { link: null, reason: 'fallback_no_home_match', meta: null };
    }

    if (Number(homeMatch?.score || 0) < LINK_FALLBACK_MIN_HOME_SCORE) {
      return {
        link: null,
        reason: 'fallback_home_score_low',
        meta: {
          homeScore: Number(homeMatch?.score || 0)
        }
      };
    }

    const row = homeMatch?.match?.__row || null;
    if (!row) {
      return { link: null, reason: 'fallback_missing_row_ref', meta: null };
    }

    if (!altAway) {
      return {
        link: row,
        reason: null,
        meta: {
          method: 'fallback_home_only',
          homeScore: Number(homeMatch?.score || 0)
        }
      };
    }

    const directHome = teamSimilarity(altHome, row?.home || '');
    const directAway = teamSimilarity(altAway, row?.away || '');
    const swappedHome = teamSimilarity(altHome, row?.away || '');
    const swappedAway = teamSimilarity(altAway, row?.home || '');

    const directPair = directHome + directAway;
    const swappedPair = swappedHome + swappedAway;

    const useDirect = directPair >= swappedPair;
    const pairScore = useDirect ? directPair : swappedPair;
    const homeScore = useDirect ? directHome : swappedHome;
    const awayScore = useDirect ? directAway : swappedAway;

    if (pairScore < LINK_FALLBACK_MIN_PAIR_SCORE || homeScore < LINK_FALLBACK_MIN_SIDE_SCORE || awayScore < LINK_FALLBACK_MIN_SIDE_SCORE) {
      return {
        link: null,
        reason: 'fallback_pair_score_low',
        meta: {
          pairScore: Number(pairScore.toFixed(3)),
          homeScore: Number(homeScore.toFixed(3)),
          awayScore: Number(awayScore.toFixed(3)),
          directPair: Number(directPair.toFixed(3)),
          swappedPair: Number(swappedPair.toFixed(3))
        }
      };
    }

    return {
      link: row,
      reason: null,
      meta: {
        method: 'fallback_name_time_context',
        matchMethod: homeMatch?.method || null,
        baseScore: Number(homeMatch?.score || 0),
        pairScore: Number(pairScore.toFixed(3)),
        orientationHint: useDirect ? 'normal' : 'swapped'
      }
    };
  } catch (error) {
    return {
      link: null,
      reason: 'fallback_error',
      meta: {
        message: error?.message || String(error)
      }
    };
  }
};

const buildPinnacleLiveCandidates = (pinLiveMap) => {
  if (!(pinLiveMap instanceof Map) || pinLiveMap.size === 0) return [];

  const out = [];
  for (const [id, row] of pinLiveMap.entries()) {
    const home = String(row?.home || '').trim();
    const away = String(row?.away || '').trim();
    const date = row?.date || null;
    if (!home || !away || !date) continue;

    out.push({
      id: String(id),
      home,
      away,
      date,
      startDate: date,
      league: toLeagueName(row?.league),
      country: toCountryName(row),
      __pinId: Number(id),
      __pinLive: row
    });
  }

  return out;
};

const resolvePinnacleLiveFallback = ({ event, link, pinLiveCandidates = [] } = {}) => {
  try {
    const linkHome = String(link?.home || '').trim();
    const linkAway = String(link?.away || '').trim();
    const eventSides = splitVsName(event?.name || '');
    const targetHome = linkHome || String(eventSides?.home || '').trim();
    const targetAway = linkAway || String(eventSides?.away || '').trim();
    const targetDate = link?.date || event?.startDate || event?.date || null;
    const targetLeague = toLeagueName(link?.league) || String(event?.league || '').trim();

    if (!targetHome || !targetDate || pinLiveCandidates.length === 0) {
      return { pinLive: null, reason: 'pinlive_fallback_input_missing', meta: null };
    }

    const homeMatch = findMatch(targetHome, targetDate, pinLiveCandidates, null, targetLeague);
    if (!homeMatch?.match) {
      return { pinLive: null, reason: 'pinlive_fallback_no_home_match', meta: null };
    }

    if (Number(homeMatch?.score || 0) < PIN_LIVE_FALLBACK_MIN_HOME_SCORE) {
      return {
        pinLive: null,
        reason: 'pinlive_fallback_home_score_low',
        meta: {
          homeScore: Number(homeMatch?.score || 0)
        }
      };
    }

    const candidate = homeMatch?.match || null;
    const pinLive = candidate?.__pinLive || null;
    if (!candidate || !pinLive) {
      return { pinLive: null, reason: 'pinlive_fallback_missing_candidate', meta: null };
    }

    if (!pinLive?.moneyline) {
      return {
        pinLive: null,
        reason: 'pinlive_fallback_candidate_no_moneyline',
        meta: {
          candidateId: candidate?.__pinId || null
        }
      };
    }

    if (!targetAway) {
      return {
        pinLive,
        reason: null,
        meta: {
          method: 'pinlive_fallback_home_only',
          candidateId: candidate?.__pinId || null,
          homeScore: Number(homeMatch?.score || 0)
        }
      };
    }

    const directHome = teamSimilarity(targetHome, candidate?.home || '');
    const directAway = teamSimilarity(targetAway, candidate?.away || '');
    const swappedHome = teamSimilarity(targetHome, candidate?.away || '');
    const swappedAway = teamSimilarity(targetAway, candidate?.home || '');

    const directPair = directHome + directAway;
    const swappedPair = swappedHome + swappedAway;

    const useDirect = directPair >= swappedPair;
    const pairScore = useDirect ? directPair : swappedPair;
    const homeScore = useDirect ? directHome : swappedHome;
    const awayScore = useDirect ? directAway : swappedAway;

    if (pairScore < PIN_LIVE_FALLBACK_MIN_PAIR_SCORE || homeScore < PIN_LIVE_FALLBACK_MIN_SIDE_SCORE || awayScore < PIN_LIVE_FALLBACK_MIN_SIDE_SCORE) {
      return {
        pinLive: null,
        reason: 'pinlive_fallback_pair_score_low',
        meta: {
          candidateId: candidate?.__pinId || null,
          pairScore: Number(pairScore.toFixed(3)),
          homeScore: Number(homeScore.toFixed(3)),
          awayScore: Number(awayScore.toFixed(3)),
          directPair: Number(directPair.toFixed(3)),
          swappedPair: Number(swappedPair.toFixed(3))
        }
      };
    }

    return {
      pinLive,
      reason: null,
      meta: {
        method: 'pinlive_fallback_name_time_context',
        candidateId: candidate?.__pinId || null,
        matchMethod: homeMatch?.method || null,
        baseScore: Number(homeMatch?.score || 0),
        pairScore: Number(pairScore.toFixed(3)),
        orientationHint: useDirect ? 'normal' : 'swapped'
      }
    };
  } catch (error) {
    return {
      pinLive: null,
      reason: 'pinlive_fallback_error',
      meta: {
        message: error?.message || String(error)
      }
    };
  }
};

const chooseBestOdd = ({ pinnacleOdd, altenarOdd } = {}) => {
  const pin = safePositiveOdd(pinnacleOdd);
  const alt = safePositiveOdd(altenarOdd);

  if (!pin && !alt) return null;
  if (!pin) return { provider: 'altenar', odd: alt };
  if (!alt) return { provider: 'pinnacle', odd: pin };

  if (alt > pin) return { provider: 'altenar', odd: alt };
  return { provider: 'pinnacle', odd: pin };
};

const buildThreeLegStakePlan = ({ bankroll, bestOdds } = {}) => {
  const base = toNumber(bankroll, NaN);
  if (!Number.isFinite(base) || base <= 0) return null;

  const oHome = safePositiveOdd(bestOdds?.home?.odd);
  const oDraw = safePositiveOdd(bestOdds?.draw?.odd);
  const oAway = safePositiveOdd(bestOdds?.away?.odd);
  if (!oHome || !oDraw || !oAway) return null;

  const impliedSum = (1 / oHome) + (1 / oDraw) + (1 / oAway);
  if (!(impliedSum < 1)) return null;

  const rawStakes = {
    home: base * ((1 / oHome) / impliedSum),
    draw: base * ((1 / oDraw) / impliedSum),
    away: base * ((1 / oAway) / impliedSum)
  };

  const rounded = {
    home: Number(rawStakes.home.toFixed(2)),
    draw: Number(rawStakes.draw.toFixed(2)),
    away: Number(rawStakes.away.toFixed(2))
  };

  const sumRounded = rounded.home + rounded.draw + rounded.away;
  const diff = Number((base - sumRounded).toFixed(2));
  if (Math.abs(diff) > 0) {
    const targetLeg = Object.entries(bestOdds)
      .map(([key, val]) => ({ key, odd: safePositiveOdd(val?.odd) || 0 }))
      .sort((a, b) => b.odd - a.odd)[0]?.key || 'home';
    rounded[targetLeg] = Number((rounded[targetLeg] + diff).toFixed(2));
  }

  const payoutHome = Number((rounded.home * oHome).toFixed(2));
  const payoutDraw = Number((rounded.draw * oDraw).toFixed(2));
  const payoutAway = Number((rounded.away * oAway).toFixed(2));
  const guaranteedPayout = Number(Math.min(payoutHome, payoutDraw, payoutAway).toFixed(2));
  const expectedProfit = Number((guaranteedPayout - base).toFixed(2));
  const roiPercent = Number(((expectedProfit / base) * 100).toFixed(3));
  const edgePercent = Number(((1 - impliedSum) * 100).toFixed(3));

  return {
    impliedSum: Number(impliedSum.toFixed(6)),
    edgePercent,
    stakes: rounded,
    payouts: {
      home: payoutHome,
      draw: payoutDraw,
      away: payoutAway
    },
    guaranteedPayout,
    expectedProfit,
    roiPercent
  };
};

const buildTwoLegStakePlan = ({ bankroll, bestOdds } = {}) => {
  const base = toNumber(bankroll, NaN);
  if (!Number.isFinite(base) || base <= 0) return null;

  const oCover = safePositiveOdd(bestOdds?.cover?.odd);
  const oOpposite = safePositiveOdd(bestOdds?.opposite?.odd);
  if (!oCover || !oOpposite) return null;

  const impliedSum = (1 / oCover) + (1 / oOpposite);
  if (!(impliedSum < 1)) return null;

  const rawStakes = {
    cover: base * ((1 / oCover) / impliedSum),
    opposite: base * ((1 / oOpposite) / impliedSum)
  };

  const rounded = {
    cover: Number(rawStakes.cover.toFixed(2)),
    opposite: Number(rawStakes.opposite.toFixed(2))
  };

  const sumRounded = rounded.cover + rounded.opposite;
  const diff = Number((base - sumRounded).toFixed(2));
  if (Math.abs(diff) > 0) {
    const targetLeg = oOpposite >= oCover ? 'opposite' : 'cover';
    rounded[targetLeg] = Number((rounded[targetLeg] + diff).toFixed(2));
  }

  const payoutCover = Number((rounded.cover * oCover).toFixed(2));
  const payoutOpposite = Number((rounded.opposite * oOpposite).toFixed(2));
  const guaranteedPayout = Number(Math.min(payoutCover, payoutOpposite).toFixed(2));
  const expectedProfit = Number((guaranteedPayout - base).toFixed(2));
  const roiPercent = Number(((expectedProfit / base) * 100).toFixed(3));
  const edgePercent = Number(((1 - impliedSum) * 100).toFixed(3));

  return {
    impliedSum: Number(impliedSum.toFixed(6)),
    edgePercent,
    stakes: rounded,
    payouts: {
      cover: payoutCover,
      opposite: payoutOpposite
    },
    guaranteedPayout,
    expectedProfit,
    roiPercent
  };
};

const flattenMarketOddIds = (market = {}) => {
  if (Array.isArray(market.desktopOddIds)) return market.desktopOddIds.flat().filter(Boolean);
  if (Array.isArray(market.oddIds)) return market.oddIds.filter(Boolean);
  return [];
};

const resolveDoubleChanceSide = (odd = {}) => {
  const normalized = normalizeText(odd?.name || '');
  const compact = normalized.replace(/\s+/g, '');

  if (compact.includes('1x')) return '1X';
  if (compact.includes('x2')) return 'X2';
  if (compact.includes('12')) return '12';

  if (normalized.includes('home draw') || normalized.includes('local empate')) return '1X';
  if (normalized.includes('draw away') || normalized.includes('empate visita')) return 'X2';
  if (normalized.includes('home away') || normalized.includes('local visita')) return '12';

  if (Number(odd?.typeId) === 9) return '1X';
  if (Number(odd?.typeId) === 10) return '12';
  if (Number(odd?.typeId) === 11) return 'X2';

  return null;
};

const parseLineValue = (raw = null) => {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(',', '.');
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
};

const resolveTotalsSide = (odd = {}) => {
  const typeId = Number(odd?.typeId);
  if (typeId === 12) return 'over';
  if (typeId === 13) return 'under';

  const normalized = normalizeText(odd?.name || '');
  if (normalized.startsWith('mas de') || normalized.startsWith('over')) return 'over';
  if (normalized.startsWith('menos de') || normalized.startsWith('under')) return 'under';
  return null;
};

const resolveBttsSide = (odd = {}) => {
  const typeId = Number(odd?.typeId);
  if (typeId === 74) return 'yes';
  if (typeId === 76) return 'no';

  const normalized = normalizeText(odd?.name || '');
  if (normalized === 'si' || normalized === 'yes') return 'yes';
  if (normalized === 'no') return 'no';
  return null;
};

const hasEnoughPinnacleLiquidity = (maxRiskStake, minRequired = 0) => {
  if (minRequired <= 0) return true;
  const liquidity = Number(maxRiskStake);
  if (!Number.isFinite(liquidity) || liquidity <= 0) return false;
  return liquidity >= minRequired;
};

const findBestMatchingTotalLine = ({ pinTotals = [], targetLine, maxDelta = 0.01 } = {}) => {
  if (!Array.isArray(pinTotals) || pinTotals.length === 0 || !Number.isFinite(Number(targetLine))) return null;

  const safeDelta = Math.max(0, Number(maxDelta) || 0);
  let best = null;

  for (const row of pinTotals) {
    const line = Number(row?.line);
    if (!Number.isFinite(line)) continue;

    const delta = Math.abs(line - Number(targetLine));
    if (delta > safeDelta) continue;

    if (!best || delta < best.delta) {
      best = {
        row,
        delta
      };
    }
  }

  return best?.row || null;
};

const mapLiveAltenarOdds = ({ details, orientation }) => {
  const markets = Array.isArray(details?.markets) ? details.markets : [];
  const odds = Array.isArray(details?.odds) ? details.odds : [];
  const oddsMap = new Map(odds.map((row) => [row?.id, row]));

  const market1x2 = markets.find((m) => Number(m?.typeId) === 1);
  const marketDc = markets.find((m) => Number(m?.typeId) === 10);

  const oneXTwo = {
    home: null,
    draw: null,
    away: null
  };

  if (market1x2) {
    const rows = flattenMarketOddIds(market1x2)
      .map((id) => oddsMap.get(id))
      .filter(Boolean);

    const home = rows.find((o) => Number(o?.typeId) === 1);
    const draw = rows.find((o) => Number(o?.typeId) === 2);
    const away = rows.find((o) => Number(o?.typeId) === 3);

    oneXTwo.home = safePositiveOdd(home?.price);
    oneXTwo.draw = safePositiveOdd(draw?.price);
    oneXTwo.away = safePositiveOdd(away?.price);
  }

  const dcRaw = {
    homeDraw: null,
    homeAway: null,
    drawAway: null
  };
  const totalsByLine = new Map();
  let btts = null;

  if (marketDc) {
    const rows = flattenMarketOddIds(marketDc)
      .map((id) => oddsMap.get(id))
      .filter(Boolean);

    for (const odd of rows) {
      const side = resolveDoubleChanceSide(odd);
      const price = safePositiveOdd(odd?.price);
      if (!side || !price) continue;
      if (side === '1X') dcRaw.homeDraw = price;
      if (side === '12') dcRaw.homeAway = price;
      if (side === 'X2') dcRaw.drawAway = price;
    }
  }

  const totalMarkets = markets.filter((m) => Number(m?.typeId) === 18);
  for (const market of totalMarkets) {
    const rows = flattenMarketOddIds(market)
      .map((id) => oddsMap.get(id))
      .filter((odd) => odd && Number(odd?.oddStatus || 0) === 0);

    const overOdd = rows.find((odd) => resolveTotalsSide(odd) === 'over');
    const underOdd = rows.find((odd) => resolveTotalsSide(odd) === 'under');
    const over = safeMarketOdd(overOdd?.price);
    const under = safeMarketOdd(underOdd?.price);
    const line = parseLineValue(market?.sv ?? market?.sn);

    if (!Number.isFinite(line) || !over || !under) continue;

    const lineKey = Number(line).toFixed(2);
    const prev = totalsByLine.get(lineKey);
    if (!prev) {
      totalsByLine.set(lineKey, {
        line: Number(line),
        over,
        under,
        marketId: market?.id || null
      });
      continue;
    }

    totalsByLine.set(lineKey, {
      line: Number(line),
      over: Math.max(prev.over, over),
      under: Math.max(prev.under, under),
      marketId: prev.marketId || market?.id || null
    });
  }

  const bttsMarket = markets.find((m) => Number(m?.typeId) === 29);
  if (bttsMarket) {
    const rows = flattenMarketOddIds(bttsMarket)
      .map((id) => oddsMap.get(id))
      .filter((odd) => odd && Number(odd?.oddStatus || 0) === 0);

    const yesOdd = rows.find((odd) => resolveBttsSide(odd) === 'yes');
    const noOdd = rows.find((odd) => resolveBttsSide(odd) === 'no');
    const yes = safeMarketOdd(yesOdd?.price);
    const no = safeMarketOdd(noOdd?.price);

    if (yes && no) {
      btts = {
        yes,
        no,
        marketId: bttsMarket?.id || null
      };
    }
  }

  const totals = Array.from(totalsByLine.values()).sort((a, b) => Number(a?.line || 0) - Number(b?.line || 0));

  if (orientation === 'swapped') {
    return {
      oneXTwo: {
        home: oneXTwo.away,
        draw: oneXTwo.draw,
        away: oneXTwo.home
      },
      doubleChance: {
        homeDraw: dcRaw.drawAway,
        homeAway: dcRaw.homeAway,
        drawAway: dcRaw.homeDraw
      },
      totals,
      btts
    };
  }

  return {
    oneXTwo,
    doubleChance: dcRaw,
    totals,
    btts
  };
};

const hasSensitiveCategory = (event = {}, pin = {}) => {
  const blob = normalizeText([
    event?.name,
    event?.league,
    event?.country,
    event?.rawStatus,
    pin?.league?.name,
    pin?.league
  ].filter(Boolean).join(' '));

  return SENSITIVE_MARKERS.some((term) => {
    if (term === ' ii ' || term === ' iii ') {
      return blob.includes(term.trim());
    }
    return blob.includes(term);
  });
};

const isLiveEventFinishedOrUncertain = (event = {}) => {
  const liveTime = String(event?.liveTime || '').trim().toLowerCase();
  const status = String(event?.rawStatus || event?.ls || event?.status || '').trim().toLowerCase();

  if (liveTime === 'final' || liveTime === 'ft' || liveTime === 'ended') return true;

  const blockedTokens = [
    'suspend',
    'cancel',
    'postpon',
    'abandon',
    'interrump',
    'delayed'
  ];

  return blockedTokens.some((token) => status.includes(token));
};

const ensureLiveArbitrageDiagnosticsStore = () => {
  if (!db.data.liveArbitrageDiagnostics || typeof db.data.liveArbitrageDiagnostics !== 'object') {
    db.data.liveArbitrageDiagnostics = {
      history: [],
      lastInventoryAt: null,
      lastSummary: null
    };
  }

  if (!Array.isArray(db.data.liveArbitrageDiagnostics.history)) {
    db.data.liveArbitrageDiagnostics.history = [];
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.liveArbitrageDiagnostics, 'lastInventoryAt')) {
    db.data.liveArbitrageDiagnostics.lastInventoryAt = null;
  }

  if (!Object.prototype.hasOwnProperty.call(db.data.liveArbitrageDiagnostics, 'lastSummary')) {
    db.data.liveArbitrageDiagnostics.lastSummary = null;
  }

  return db.data.liveArbitrageDiagnostics;
};

const summarizeDiagnostics = (history = [], { windowMinutes = DIAG_DEFAULT_WINDOW_MINUTES } = {}) => {
  const windowSafe = clampPositiveInt(windowMinutes, DIAG_DEFAULT_WINDOW_MINUTES);
  const nowMs = Date.now();
  const windowStartMs = nowMs - (windowSafe * 60 * 1000);

  const inWindow = history.filter((row) => {
    const ts = new Date(row?.at || 0).getTime();
    return Number.isFinite(ts) && ts >= windowStartMs;
  });

  const reasonTotals = {};
  let withOps = 0;
  let zeroOps = 0;

  for (const row of inWindow) {
    const count = Number(row?.result?.count || 0);
    if (count > 0) withOps += 1;
    else zeroOps += 1;

    const reasons = row?.rejections || {};
    for (const [key, value] of Object.entries(reasons)) {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) continue;
      reasonTotals[key] = (reasonTotals[key] || 0) + n;
    }
  }

  return {
    windowMinutes: windowSafe,
    snapshotsInWindow: inWindow.length,
    withOpportunities: withOps,
    zeroOpportunities: zeroOps,
    rejectionReasonTotals: reasonTotals
  };
};

const normalizeOpportunityLegsForSnapshot = (opportunity = {}) => {
  if (Array.isArray(opportunity?.legs)) {
    return opportunity.legs.map((leg) => ({
      market: leg?.market || null,
      selection: leg?.selection || null,
      provider: leg?.provider || null,
      odd: Number(leg?.odd || 0) || null
    }));
  }

  const best = opportunity?.odds?.best || {};
  return [
    {
      market: '1x2',
      selection: 'Home',
      provider: best?.home?.provider || null,
      odd: Number(best?.home?.odd || 0) || null
    },
    {
      market: '1x2',
      selection: 'Draw',
      provider: best?.draw?.provider || null,
      odd: Number(best?.draw?.odd || 0) || null
    },
    {
      market: '1x2',
      selection: 'Away',
      provider: best?.away?.provider || null,
      odd: Number(best?.away?.odd || 0) || null
    }
  ];
};

const buildTopOpportunitiesSnapshot = (rows = [], { top = DIAG_TOP_OPS } = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const safeTop = Math.max(1, Math.min(10, Math.floor(Number(top) || DIAG_TOP_OPS)));
  return rows.slice(0, safeTop).map((op, idx) => ({
    rank: idx + 1,
    type: op?.type || null,
    comboCode: op?.comboCode || null,
    comboLabel: op?.comboLabel || null,
    eventId: op?.eventId || null,
    pinnacleId: op?.pinnacleId || null,
    match: op?.match || null,
    league: op?.league || null,
    country: op?.country || null,
    liveTime: op?.liveTime || null,
    score: op?.score || null,
    plan: {
      roiPercent: Number(op?.plan?.roiPercent || 0),
      edgePercent: Number(op?.plan?.edgePercent || 0),
      expectedProfit: Number(op?.plan?.expectedProfit || 0),
      guaranteedPayout: Number(op?.plan?.guaranteedPayout || 0),
      impliedSum: Number(op?.plan?.impliedSum || 0)
    },
    legs: normalizeOpportunityLegsForSnapshot(op)
  }));
};

const buildRejectionBreakdown = (diagnostics = {}) => ({
  sameProvider: Number(diagnostics?.skippedSameProvider || 0),
  unlinked: Number(diagnostics?.skippedUnlinked || 0),
  staleAltenar: Number(diagnostics?.skippedStaleAltenar || 0),
  missingOdds: Number(diagnostics?.skippedMissingOdds || 0),
  noSurebetEdge: Number(diagnostics?.skippedNoSurebetEdge || 0),
  uncertainStatus: Number(diagnostics?.skippedUncertainStatus || 0),
  detailsErrors: Number(diagnostics?.skippedDetailsError || 0),
  sensitiveMismatch: Number(diagnostics?.skippedSensitiveMismatch || 0),
  totalsDisabled: Number(diagnostics?.skippedTotalsDisabled || 0),
  totalsMissingMarket: Number(diagnostics?.skippedTotalsMissingMarket || 0),
  totalsLineMismatch: Number(diagnostics?.skippedTotalsLineMismatch || 0),
  totalsLowLiquidity: Number(diagnostics?.skippedTotalsLowLiquidity || 0),
  totalsSameProvider: Number(diagnostics?.skippedTotalsSameProvider || 0),
  totalsNoSurebetEdge: Number(diagnostics?.skippedTotalsNoSurebetEdge || 0),
  bttsDisabled: Number(diagnostics?.skippedBttsDisabled || 0),
  bttsMissingMarket: Number(diagnostics?.skippedBttsMissingMarket || 0),
  bttsRelatedFallbackNoData: Number(diagnostics?.skippedBttsRelatedFallbackNoData || 0),
  bttsRelatedFallbackError: Number(diagnostics?.skippedBttsRelatedFallbackError || 0),
  bttsLowLiquidity: Number(diagnostics?.skippedBttsLowLiquidity || 0),
  bttsSameProvider: Number(diagnostics?.skippedBttsSameProvider || 0),
  bttsNoSurebetEdge: Number(diagnostics?.skippedBttsNoSurebetEdge || 0)
});

const persistDiagnosticSnapshot = async ({ payload, query, trigger = 'request', tag = null } = {}) => {
  if (!payload || !payload?.diagnostics) return;

  ensureLiveArbitrageDiagnosticsStore();
  const store = db.data.liveArbitrageDiagnostics;

  const row = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: payload.generatedAt || new Date().toISOString(),
    trigger: String(trigger || 'request').toLowerCase(),
    tag: tag ? String(tag) : null,
    query: {
      bankroll: Number(query?.bankroll || 0),
      limit: Number(query?.limit || 0),
      minRoiPercent: Number(query?.minRoiPercent || 0),
      minProfitAbs: Number(query?.minProfitAbs || 0)
    },
    result: {
      count: Number(payload?.count || 0),
      source: payload?.source || null,
      market: payload?.market || null
    },
    topOpportunities: buildTopOpportunitiesSnapshot(payload?.data || [], { top: DIAG_TOP_OPS }),
    diagnostics: payload.diagnostics,
    rejections: buildRejectionBreakdown(payload.diagnostics)
  };

  store.history.push(row);
  if (store.history.length > DIAG_MAX_HISTORY) {
    store.history.splice(0, store.history.length - DIAG_MAX_HISTORY);
  }

  if (row.trigger === 'scheduled') {
    store.lastInventoryAt = row.at;
  }

  store.lastSummary = summarizeDiagnostics(store.history, { windowMinutes: DIAG_DEFAULT_WINDOW_MINUTES });
  await writeDBWithRetry();
};

const runWithConcurrency = async (items, limit, worker) => {
  const out = [];
  let idx = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }).map(async () => {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      out[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return out;
};

const getDefaultBankroll = () => {
  const configBankroll = toNumber(db.data?.config?.bankroll, NaN);
  if (Number.isFinite(configBankroll) && configBankroll > 0) return Number(configBankroll);
  return 100;
};

export const getLiveArbitragePreview = async ({
  bankroll = null,
  limit = DEFAULT_PREVIEW_LIMIT,
  minRoiPercent = null,
  minProfitAbs = null
} = {}, {
  persistDiagnostics = true,
  trigger = 'request',
  tag = null
} = {}) => {
  await ensureDbReadyWithRetry();

  const maxItems = (() => {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PREVIEW_LIMIT;
    return Math.min(MAX_PREVIEW_LIMIT, Math.floor(parsed));
  })();

  const stakeBankroll = (() => {
    const parsed = Number(bankroll);
    if (!Number.isFinite(parsed) || parsed <= 0) return getDefaultBankroll();
    return Number(parsed);
  })();

  const riskThresholds = {
    minRoiPercent: toNonNegative(minRoiPercent, RISK_MIN_ROI_PERCENT_DEFAULT),
    minProfitAbs: toNonNegative(minProfitAbs, RISK_MIN_PROFIT_ABS_DEFAULT)
  };

  const liveEvents = await getLiveOverview();
  const activeEvents = (Array.isArray(liveEvents) ? liveEvents : []).filter((event) => !isLiveEventFinishedOrUncertain(event));
  const pinLiveMap = await getAllPinnacleLiveOdds();

  const upcomingRows = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
  const linkedByAltenarId = new Map();
  for (const row of upcomingRows) {
    const altId = String(row?.altenarId || '').trim();
    if (!altId) continue;
    linkedByAltenarId.set(altId, row);
  }
  const fallbackCandidates = LINK_FALLBACK_ENABLED ? buildFallbackCandidates(upcomingRows) : [];
  const pinLiveCandidates = PIN_LIVE_FALLBACK_ENABLED ? buildPinnacleLiveCandidates(pinLiveMap) : [];

  let skippedUncertainStatus = Math.max(0, (Array.isArray(liveEvents) ? liveEvents.length : 0) - activeEvents.length);
  let skippedUnlinked = 0;
  let skippedMissingPinnacleLive = 0;
  let skippedFallbackNoMatch = 0;
  let skippedFallbackLowConfidence = 0;
  let skippedFallbackError = 0;
  let linkedViaFallback = 0;
  let mappedViaPinLiveFallback = 0;
  let skippedPinLiveFallbackNoMatch = 0;
  let skippedPinLiveFallbackLowConfidence = 0;
  let skippedPinLiveFallbackError = 0;
  let skippedDetailsError = 0;
  let skippedSensitiveMismatch = 0;
  let skippedMissingOdds = 0;
  let skippedSameProvider = 0;
  let skippedNoSurebetEdge = 0;
  let skippedStaleAltenar = 0;
  let skippedTotalsDisabled = 0;
  let skippedTotalsMissingMarket = 0;
  let skippedTotalsLineMismatch = 0;
  let skippedTotalsLowLiquidity = 0;
  let skippedTotalsSameProvider = 0;
  let skippedTotalsNoSurebetEdge = 0;
  let skippedBttsDisabled = 0;
  let skippedBttsMissingMarket = 0;
  let skippedBttsRelatedFallbackNoData = 0;
  let skippedBttsRelatedFallbackError = 0;
  let skippedBttsLowLiquidity = 0;
  let skippedBttsSameProvider = 0;
  let skippedBttsNoSurebetEdge = 0;
  let mappedBttsViaRelatedFallback = 0;
  let generated1x2 = 0;
  let generatedDcOpposite = 0;
  let generatedTotals = 0;
  let generatedBtts = 0;
  const fallbackSamples = [];
  const pinLiveFallbackSamples = [];

  const linkedCandidates = [];
  for (const event of activeEvents) {
    const altenarId = String(event?.id || '').trim();
    let link = linkedByAltenarId.get(altenarId);
    let linkMeta = null;

    if (!link && LINK_FALLBACK_ENABLED) {
      const fallback = resolveFallbackLink({
        event,
        fallbackCandidates
      });

      if (fallback?.link) {
        link = fallback.link;
        linkMeta = fallback.meta || { method: 'fallback_unknown' };
        linkedViaFallback += 1;
      } else {
        const reason = String(fallback?.reason || 'fallback_unknown');
        if (reason === 'fallback_no_home_match' || reason === 'fallback_input_missing' || reason === 'fallback_missing_row_ref') {
          skippedFallbackNoMatch += 1;
        } else if (reason === 'fallback_home_score_low' || reason === 'fallback_pair_score_low') {
          skippedFallbackLowConfidence += 1;
        } else if (reason === 'fallback_error') {
          skippedFallbackError += 1;
        } else {
          skippedFallbackNoMatch += 1;
        }

        if (fallbackSamples.length < LINK_FALLBACK_SAMPLE_LIMIT) {
          fallbackSamples.push({
            altenarId: altenarId || null,
            event: event?.name || null,
            reason,
            meta: fallback?.meta || null
          });
        }
      }
    }

    if (!link) {
      skippedUnlinked += 1;
      continue;
    }

    let pinLive = pinLiveMap?.get(Number(link?.id));
    let pinLiveMeta = null;

    if ((!pinLive || !pinLive?.moneyline) && PIN_LIVE_FALLBACK_ENABLED) {
      const pinFallback = resolvePinnacleLiveFallback({
        event,
        link,
        pinLiveCandidates
      });

      if (pinFallback?.pinLive) {
        pinLive = pinFallback.pinLive;
        pinLiveMeta = pinFallback.meta || { method: 'pinlive_fallback_unknown' };
        mappedViaPinLiveFallback += 1;
      } else {
        const reason = String(pinFallback?.reason || 'pinlive_fallback_unknown');
        if (reason === 'pinlive_fallback_no_home_match' || reason === 'pinlive_fallback_input_missing' || reason === 'pinlive_fallback_missing_candidate' || reason === 'pinlive_fallback_candidate_no_moneyline') {
          skippedPinLiveFallbackNoMatch += 1;
        } else if (reason === 'pinlive_fallback_home_score_low' || reason === 'pinlive_fallback_pair_score_low') {
          skippedPinLiveFallbackLowConfidence += 1;
        } else if (reason === 'pinlive_fallback_error') {
          skippedPinLiveFallbackError += 1;
        } else {
          skippedPinLiveFallbackNoMatch += 1;
        }

        if (pinLiveFallbackSamples.length < PIN_LIVE_FALLBACK_SAMPLE_LIMIT) {
          pinLiveFallbackSamples.push({
            altenarId: altenarId || null,
            event: event?.name || null,
            pinnacleIdExpected: link?.id || null,
            reason,
            meta: pinFallback?.meta || null
          });
        }
      }
    }

    if (!pinLive || !pinLive?.moneyline) {
      skippedMissingPinnacleLive += 1;
      continue;
    }

    linkedCandidates.push({ event, link, pinLive, linkMeta, pinLiveMeta });
  }

  const limitedCandidates = linkedCandidates.slice(0, Math.max(1, DEFAULT_MAX_EVENTS));

  const detailRows = await runWithConcurrency(limitedCandidates, DETAILS_CONCURRENCY, async (candidate) => {
    try {
      const details = await getEventDetails(candidate?.event?.id);
      return { ...candidate, details, detailsError: null };
    } catch (error) {
      return { ...candidate, details: null, detailsError: error };
    }
  });

  const opportunities = [];

  for (const row of detailRows) {
    const event = row?.event || {};
    const link = row?.link || {};
    const pinLive = row?.pinLive || {};
    const details = row?.details || null;

    if (!details || !Array.isArray(details?.markets) || !Array.isArray(details?.odds)) {
      skippedDetailsError += 1;
      continue;
    }

    const altLastUpdateMs = new Date(details?.lst || details?.updatedAt || 0).getTime();
    if (Number.isFinite(altLastUpdateMs)) {
      const ageMs = Date.now() - altLastUpdateMs;
      if (ageMs > 5 * 60 * 1000) {
        skippedStaleAltenar += 1;
        continue;
      }
    }

    const orientation = resolveOrientation({
      pinHome: link?.home,
      pinAway: link?.away,
      altName: event?.name
    });

    const sensitive = hasSensitiveCategory(event, link);
    if (orientation.orientation === 'unknown') {
      skippedSensitiveMismatch += 1;
      continue;
    }

    if (sensitive && orientation.confidence < 1.7) {
      skippedSensitiveMismatch += 1;
      continue;
    }

    const altMapped = mapLiveAltenarOdds({
      details,
      orientation: orientation.orientation
    });

    const pinOneXTwo = {
      home: safePositiveOdd(pinLive?.moneyline?.home),
      draw: safePositiveOdd(pinLive?.moneyline?.draw),
      away: safePositiveOdd(pinLive?.moneyline?.away)
    };

    const pinDoubleChance = {
      homeDraw: safePositiveOdd(pinLive?.doubleChance?.homeDraw),
      homeAway: safePositiveOdd(pinLive?.doubleChance?.homeAway),
      drawAway: safePositiveOdd(pinLive?.doubleChance?.drawAway)
    };
    const pinTotals = Array.isArray(pinLive?.totals)
      ? pinLive.totals
        .map((row) => ({
          line: Number(row?.line),
          over: safeMarketOdd(row?.over),
          under: safeMarketOdd(row?.under),
          maxRiskStake: Number(row?.maxRiskStake)
        }))
        .filter((row) => Number.isFinite(row?.line) && row?.over && row?.under)
      : [];

    let pinBtts = {
      yes: safeMarketOdd(pinLive?.btts?.yes),
      no: safeMarketOdd(pinLive?.btts?.no),
      maxRiskStake: Number(pinLive?.btts?.maxRiskStake)
    };

    if ((!pinBtts?.yes || !pinBtts?.no) && ROLLOUT_BTTS_ENABLED && BTTS_RELATED_FALLBACK_ENABLED && link?.id) {
      try {
        const pinRelated = await getPinnacleLiveOdds(link.id);
        const relatedYes = safeMarketOdd(pinRelated?.btts?.yes);
        const relatedNo = safeMarketOdd(pinRelated?.btts?.no);
        if (relatedYes && relatedNo) {
          pinBtts = {
            yes: relatedYes,
            no: relatedNo,
            maxRiskStake: Number(pinRelated?.btts?.maxRiskStake)
          };
          mappedBttsViaRelatedFallback += 1;
        } else {
          skippedBttsRelatedFallbackNoData += 1;
        }
      } catch (error) {
        skippedBttsRelatedFallbackError += 1;
      }
    }

    let generatedAnyForEvent = false;

    const bestOdds1x2 = {
      home: chooseBestOdd({ pinnacleOdd: pinOneXTwo.home, altenarOdd: altMapped?.oneXTwo?.home }),
      draw: chooseBestOdd({ pinnacleOdd: pinOneXTwo.draw, altenarOdd: altMapped?.oneXTwo?.draw }),
      away: chooseBestOdd({ pinnacleOdd: pinOneXTwo.away, altenarOdd: altMapped?.oneXTwo?.away })
    };

    if (!bestOdds1x2.home || !bestOdds1x2.draw || !bestOdds1x2.away) {
      skippedMissingOdds += 1;
    } else {
      const providerSet = new Set([
        bestOdds1x2.home?.provider,
        bestOdds1x2.draw?.provider,
        bestOdds1x2.away?.provider
      ].filter(Boolean));

      if (REQUIRE_CROSS_PROVIDER && providerSet.size < 2) {
        skippedSameProvider += 1;
      } else {
        const plan = buildThreeLegStakePlan({ bankroll: stakeBankroll, bestOdds: bestOdds1x2 });
        if (plan) {
          opportunities.push({
            type: 'SUREBET_1X2_LIVE',
            market: '1x2',
            eventId: event?.id || null,
            pinnacleId: link?.id || null,
            altenarId: link?.altenarId || event?.id || null,
            match: event?.name || `${link?.home || ''} vs ${link?.away || ''}`.trim(),
            league: event?.league || link?.league?.name || null,
            country: event?.country || null,
            liveTime: event?.liveTime || null,
            score: Array.isArray(event?.score) ? `${event.score[0] || 0}-${event.score[1] || 0}` : null,
            orientation,
            odds: {
              pinnacle: pinOneXTwo,
              altenar: {
                home: safePositiveOdd(altMapped?.oneXTwo?.home),
                draw: safePositiveOdd(altMapped?.oneXTwo?.draw),
                away: safePositiveOdd(altMapped?.oneXTwo?.away)
              },
              best: bestOdds1x2
            },
            edgePercent: plan.edgePercent,
            roiPercent: plan.roiPercent,
            expectedProfit: plan.expectedProfit,
            guaranteedPayout: plan.guaranteedPayout,
            plan,
            stakePlan: plan
          });
          generated1x2 += 1;
          generatedAnyForEvent = true;
        }
      }
    }

    for (const combo of DC_OPPOSITE_COMBOS) {
      const dcBest = chooseBestOdd({
        pinnacleOdd: pinDoubleChance[combo.dcKey],
        altenarOdd: altMapped?.doubleChance?.[combo.dcKey]
      });

      const oppositeBest = chooseBestOdd({
        pinnacleOdd: pinOneXTwo[combo.oppositeKey],
        altenarOdd: altMapped?.oneXTwo?.[combo.oppositeKey]
      });

      if (!dcBest || !oppositeBest) {
        skippedMissingOdds += 1;
        continue;
      }

      if (REQUIRE_CROSS_PROVIDER && dcBest.provider === oppositeBest.provider) {
        skippedSameProvider += 1;
        continue;
      }

      const plan = buildTwoLegStakePlan({
        bankroll: stakeBankroll,
        bestOdds: {
          cover: dcBest,
          opposite: oppositeBest
        }
      });

      if (!plan) {
        skippedNoSurebetEdge += 1;
        continue;
      }

      opportunities.push({
        type: 'SUREBET_DC_OPPOSITE_LIVE',
        market: 'double_chance+opposite_1x2',
        comboCode: combo.code,
        comboLabel: combo.label,
        eventId: event?.id || null,
        pinnacleId: link?.id || null,
        altenarId: link?.altenarId || event?.id || null,
        match: event?.name || `${link?.home || ''} vs ${link?.away || ''}`.trim(),
        league: event?.league || link?.league?.name || null,
        country: event?.country || null,
        liveTime: event?.liveTime || null,
        score: Array.isArray(event?.score) ? `${event.score[0] || 0}-${event.score[1] || 0}` : null,
        orientation,
        legs: [
          {
            market: 'Double Chance',
            selection: combo.dcSelection,
            provider: dcBest.provider,
            odd: dcBest.odd
          },
          {
            market: '1x2',
            selection: combo.oppositeSelection,
            provider: oppositeBest.provider,
            odd: oppositeBest.odd
          }
        ],
        odds: {
          pinnacle: {
            doubleChance: pinDoubleChance[combo.dcKey],
            opposite: pinOneXTwo[combo.oppositeKey]
          },
          altenar: {
            doubleChance: altMapped?.doubleChance?.[combo.dcKey] || null,
            opposite: altMapped?.oneXTwo?.[combo.oppositeKey] || null
          },
          best: {
            doubleChance: dcBest,
            opposite: oppositeBest
          }
        },
        edgePercent: plan.edgePercent,
        roiPercent: plan.roiPercent,
        expectedProfit: plan.expectedProfit,
        guaranteedPayout: plan.guaranteedPayout,
        plan: {
          ...plan,
          labels: {
            cover: combo.dcSelection,
            opposite: combo.oppositeSelection
          }
        },
        stakePlan: {
          ...plan,
          labels: {
            cover: combo.dcSelection,
            opposite: combo.oppositeSelection
          }
        }
      });

      generatedDcOpposite += 1;
      generatedAnyForEvent = true;
    }

    if (!ROLLOUT_TOTALS_ENABLED) {
      skippedTotalsDisabled += 1;
    } else {
      const altTotals = Array.isArray(altMapped?.totals)
        ? altMapped.totals
          .map((row) => ({
            line: Number(row?.line),
            over: safeMarketOdd(row?.over),
            under: safeMarketOdd(row?.under)
          }))
          .filter((row) => Number.isFinite(row?.line) && row?.over && row?.under)
        : [];

      if (altTotals.length === 0 || pinTotals.length === 0) {
        skippedTotalsMissingMarket += 1;
      } else {
        for (const altTotal of altTotals) {
          const pinTotal = findBestMatchingTotalLine({
            pinTotals,
            targetLine: altTotal.line,
            maxDelta: TOTALS_MAX_LINE_DELTA
          });

          if (!pinTotal) {
            skippedTotalsLineMismatch += 1;
            continue;
          }

          const overBest = chooseBestOdd({
            pinnacleOdd: pinTotal.over,
            altenarOdd: altTotal.over
          });
          const underBest = chooseBestOdd({
            pinnacleOdd: pinTotal.under,
            altenarOdd: altTotal.under
          });

          if (!overBest || !underBest) {
            skippedTotalsMissingMarket += 1;
            continue;
          }

          const pinnacleUsed = overBest.provider === 'pinnacle' || underBest.provider === 'pinnacle';
          if (pinnacleUsed && !hasEnoughPinnacleLiquidity(pinTotal.maxRiskStake, TOTALS_MIN_PINNACLE_MAX_RISK)) {
            skippedTotalsLowLiquidity += 1;
            continue;
          }

          if (REQUIRE_CROSS_PROVIDER && overBest.provider === underBest.provider) {
            skippedTotalsSameProvider += 1;
            continue;
          }

          const plan = buildTwoLegStakePlan({
            bankroll: stakeBankroll,
            bestOdds: {
              cover: overBest,
              opposite: underBest
            }
          });

          if (!plan) {
            skippedTotalsNoSurebetEdge += 1;
            continue;
          }

          opportunities.push({
            type: 'SUREBET_TOTALS_LIVE',
            market: 'totals_over_under',
            line: Number(altTotal.line),
            eventId: event?.id || null,
            pinnacleId: link?.id || null,
            altenarId: link?.altenarId || event?.id || null,
            match: event?.name || `${link?.home || ''} vs ${link?.away || ''}`.trim(),
            league: event?.league || link?.league?.name || null,
            country: event?.country || null,
            liveTime: event?.liveTime || null,
            score: Array.isArray(event?.score) ? `${event.score[0] || 0}-${event.score[1] || 0}` : null,
            orientation,
            legs: [
              {
                market: `Total ${Number(altTotal.line).toFixed(2)}`,
                selection: 'Over',
                provider: overBest.provider,
                odd: overBest.odd
              },
              {
                market: `Total ${Number(altTotal.line).toFixed(2)}`,
                selection: 'Under',
                provider: underBest.provider,
                odd: underBest.odd
              }
            ],
            odds: {
              pinnacle: {
                line: Number(pinTotal.line),
                over: pinTotal.over,
                under: pinTotal.under,
                maxRiskStake: Number(pinTotal?.maxRiskStake) || null
              },
              altenar: {
                line: Number(altTotal.line),
                over: altTotal.over,
                under: altTotal.under
              },
              best: {
                over: overBest,
                under: underBest
              }
            },
            edgePercent: plan.edgePercent,
            roiPercent: plan.roiPercent,
            expectedProfit: plan.expectedProfit,
            guaranteedPayout: plan.guaranteedPayout,
            plan: {
              ...plan,
              labels: {
                cover: 'Over',
                opposite: 'Under'
              }
            },
            stakePlan: {
              ...plan,
              labels: {
                cover: 'Over',
                opposite: 'Under'
              }
            }
          });

          generatedTotals += 1;
          generatedAnyForEvent = true;
        }
      }
    }

    if (!ROLLOUT_BTTS_ENABLED) {
      skippedBttsDisabled += 1;
    } else {
      const altBtts = {
        yes: safeMarketOdd(altMapped?.btts?.yes),
        no: safeMarketOdd(altMapped?.btts?.no)
      };

      if (!pinBtts?.yes || !pinBtts?.no || !altBtts.yes || !altBtts.no) {
        skippedBttsMissingMarket += 1;
      } else {
        const yesBest = chooseBestOdd({
          pinnacleOdd: pinBtts.yes,
          altenarOdd: altBtts.yes
        });
        const noBest = chooseBestOdd({
          pinnacleOdd: pinBtts.no,
          altenarOdd: altBtts.no
        });

        if (!yesBest || !noBest) {
          skippedBttsMissingMarket += 1;
        } else {
          const pinnacleUsed = yesBest.provider === 'pinnacle' || noBest.provider === 'pinnacle';
          if (pinnacleUsed && !hasEnoughPinnacleLiquidity(pinBtts.maxRiskStake, BTTS_MIN_PINNACLE_MAX_RISK)) {
            skippedBttsLowLiquidity += 1;
          } else if (REQUIRE_CROSS_PROVIDER && yesBest.provider === noBest.provider) {
            skippedBttsSameProvider += 1;
          } else {
            const plan = buildTwoLegStakePlan({
              bankroll: stakeBankroll,
              bestOdds: {
                cover: yesBest,
                opposite: noBest
              }
            });

            if (!plan) {
              skippedBttsNoSurebetEdge += 1;
            } else {
              opportunities.push({
                type: 'SUREBET_BTTS_LIVE',
                market: 'btts_yes_no',
                eventId: event?.id || null,
                pinnacleId: link?.id || null,
                altenarId: link?.altenarId || event?.id || null,
                match: event?.name || `${link?.home || ''} vs ${link?.away || ''}`.trim(),
                league: event?.league || link?.league?.name || null,
                country: event?.country || null,
                liveTime: event?.liveTime || null,
                score: Array.isArray(event?.score) ? `${event.score[0] || 0}-${event.score[1] || 0}` : null,
                orientation,
                legs: [
                  {
                    market: 'BTTS',
                    selection: 'Yes',
                    provider: yesBest.provider,
                    odd: yesBest.odd
                  },
                  {
                    market: 'BTTS',
                    selection: 'No',
                    provider: noBest.provider,
                    odd: noBest.odd
                  }
                ],
                odds: {
                  pinnacle: {
                    yes: pinBtts.yes,
                    no: pinBtts.no,
                    maxRiskStake: Number(pinBtts?.maxRiskStake) || null
                  },
                  altenar: {
                    yes: altBtts.yes,
                    no: altBtts.no
                  },
                  best: {
                    yes: yesBest,
                    no: noBest
                  }
                },
                edgePercent: plan.edgePercent,
                roiPercent: plan.roiPercent,
                expectedProfit: plan.expectedProfit,
                guaranteedPayout: plan.guaranteedPayout,
                plan: {
                  ...plan,
                  labels: {
                    cover: 'Yes',
                    opposite: 'No'
                  }
                },
                stakePlan: {
                  ...plan,
                  labels: {
                    cover: 'Yes',
                    opposite: 'No'
                  }
                }
              });

              generatedBtts += 1;
              generatedAnyForEvent = true;
            }
          }
        }
      }
    }

    if (!generatedAnyForEvent) {
      skippedNoSurebetEdge += 1;
    }
  }

  const riskFiltered = opportunities.filter((op) => {
    const roi = Number(op?.plan?.roiPercent || 0);
    const profit = Number(op?.plan?.expectedProfit || 0);
    if (roi < riskThresholds.minRoiPercent) return false;
    if (profit < riskThresholds.minProfitAbs) return false;
    return true;
  });

  const filteredByRisk = opportunities.length - riskFiltered.length;

  const ordered = riskFiltered
    .sort((a, b) => Number(b?.plan?.edgePercent || 0) - Number(a?.plan?.edgePercent || 0))
    .slice(0, maxItems);

  const outputMarkets = ['1x2', 'double_chance+opposite_1x2'];
  if (ROLLOUT_TOTALS_ENABLED) outputMarkets.push('totals_over_under');
  if (ROLLOUT_BTTS_ENABLED) outputMarkets.push('btts_yes_no');

  const payload = {
    success: true,
    mode: 'preview-only',
    market: 'live-mixed',
    markets: outputMarkets,
    source: 'live-overview+pinnacle-live',
    generatedAt: new Date().toISOString(),
    bankroll: stakeBankroll,
    risk: {
      ...riskThresholds,
      stakeBankroll
    },
    count: ordered.length,
    data: ordered,
    diagnostics: {
      scannedLiveEvents: Array.isArray(liveEvents) ? liveEvents.length : 0,
      activeEvents: activeEvents.length,
      linkedCandidates: linkedCandidates.length,
      evaluatedEvents: detailRows.length,
      generatedByType: {
        surebet1x2Live: generated1x2,
        surebetDcOppositeLive: generatedDcOpposite,
        surebetTotalsLive: generatedTotals,
        surebetBttsLive: generatedBtts
      },
      skippedUncertainStatus,
      skippedUnlinked,
      skippedMissingPinnacleLive,
      linkedViaFallback,
      skippedFallbackNoMatch,
      skippedFallbackLowConfidence,
      skippedFallbackError,
      linkFallbackEnabled: LINK_FALLBACK_ENABLED,
      linkFallbackHomeScoreMin: LINK_FALLBACK_MIN_HOME_SCORE,
      linkFallbackSideScoreMin: LINK_FALLBACK_MIN_SIDE_SCORE,
      linkFallbackPairScoreMin: LINK_FALLBACK_MIN_PAIR_SCORE,
      linkFallbackSamples: fallbackSamples,
      pinLiveFallbackEnabled: PIN_LIVE_FALLBACK_ENABLED,
      mappedViaPinLiveFallback,
      skippedPinLiveFallbackNoMatch,
      skippedPinLiveFallbackLowConfidence,
      skippedPinLiveFallbackError,
      pinLiveFallbackHomeScoreMin: PIN_LIVE_FALLBACK_MIN_HOME_SCORE,
      pinLiveFallbackSideScoreMin: PIN_LIVE_FALLBACK_MIN_SIDE_SCORE,
      pinLiveFallbackPairScoreMin: PIN_LIVE_FALLBACK_MIN_PAIR_SCORE,
      pinLiveFallbackSamples,
      skippedDetailsError,
      skippedSensitiveMismatch,
      skippedStaleAltenar,
      skippedSameProvider,
      skippedMissingOdds,
      skippedNoSurebetEdge,
      totalsRolloutEnabled: ROLLOUT_TOTALS_ENABLED,
      bttsRolloutEnabled: ROLLOUT_BTTS_ENABLED,
      skippedTotalsDisabled,
      skippedTotalsMissingMarket,
      skippedTotalsLineMismatch,
      skippedTotalsLowLiquidity,
      skippedTotalsSameProvider,
      skippedTotalsNoSurebetEdge,
      totalsMaxLineDelta: TOTALS_MAX_LINE_DELTA,
      totalsMinPinnacleMaxRisk: TOTALS_MIN_PINNACLE_MAX_RISK,
      skippedBttsDisabled,
      skippedBttsMissingMarket,
      skippedBttsRelatedFallbackNoData,
      skippedBttsRelatedFallbackError,
      mappedBttsViaRelatedFallback,
      bttsRelatedFallbackEnabled: BTTS_RELATED_FALLBACK_ENABLED,
      skippedBttsLowLiquidity,
      skippedBttsSameProvider,
      skippedBttsNoSurebetEdge,
      bttsMinPinnacleMaxRisk: BTTS_MIN_PINNACLE_MAX_RISK,
      marketOddBounds: {
        min: MARKET_MIN_ODD,
        max: MARKET_MAX_ODD
      },
      filteredByRisk,
      riskThresholds,
      requireCrossProvider: REQUIRE_CROSS_PROVIDER,
      maxEvents: DEFAULT_MAX_EVENTS,
      detailsConcurrency: DETAILS_CONCURRENCY
    }
  };

  if (persistDiagnostics) {
    try {
      await persistDiagnosticSnapshot({
        payload,
        query: {
          bankroll: stakeBankroll,
          limit: maxItems,
          minRoiPercent: riskThresholds.minRoiPercent,
          minProfitAbs: riskThresholds.minProfitAbs
        },
        trigger,
        tag
      });
    } catch (error) {
      console.warn(`⚠️ No se pudo persistir diagnostico de arbitraje live: ${error?.message || error}`);
    }
  }

  return payload;
};

export const getLiveArbitrageDiagnosticsReport = async ({
  limit = DIAG_DEFAULT_LIMIT,
  trigger = 'all',
  windowMinutes = DIAG_DEFAULT_WINDOW_MINUTES
} = {}) => {
  await ensureDbReadyWithRetry();

  const store = ensureLiveArbitrageDiagnosticsStore();
  const safeLimit = Math.min(5000, clampPositiveInt(limit, DIAG_DEFAULT_LIMIT));
  const triggerKey = String(trigger || 'all').trim().toLowerCase();

  const filtered = triggerKey === 'all'
    ? store.history
    : store.history.filter((row) => String(row?.trigger || '').toLowerCase() === triggerKey);

  const recent = filtered.slice(-safeLimit);
  const summary = summarizeDiagnostics(filtered, { windowMinutes });

  return {
    generatedAt: new Date().toISOString(),
    trigger: triggerKey,
    storedSnapshots: store.history.length,
    filteredSnapshots: filtered.length,
    returnedSnapshots: recent.length,
    lastInventoryAt: store.lastInventoryAt || null,
    summary,
    recent
  };
};

export const runLiveArbitrageDiagnosticsInventory = async ({
  bankroll = null,
  limit = DEFAULT_PREVIEW_LIMIT,
  minRoiPercent = null,
  minProfitAbs = null,
  tag = 'scheduler'
} = {}) => {
  const payload = await getLiveArbitragePreview(
    {
      bankroll,
      limit,
      minRoiPercent,
      minProfitAbs
    },
    {
      persistDiagnostics: true,
      trigger: 'scheduled',
      tag
    }
  );

  return {
    ok: true,
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    count: Number(payload?.count || 0),
    diagnostics: payload?.diagnostics || null
  };
};
