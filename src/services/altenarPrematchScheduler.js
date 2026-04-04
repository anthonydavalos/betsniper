import altenarClient from '../config/axiosClient.js';
import { getAltenarPublicRequestConfig, maybeAutoRenewWidgetToken } from '../config/altenarPublicConfig.js';
import db, { initDB, writeDBWithRetry } from '../db/database.js';
import { ingestAltenarPrematch } from '../../scripts/ingest-altenar.js';

const toPositiveInt = (value, fallback, min = 1) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.floor(parsed);
    if (!Number.isFinite(rounded) || rounded < min) return fallback;
    return rounded;
};

const toBoolean = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
};

const DISCOVERY_BASE_MS = 12 * 60 * 1000;
const DISCOVERY_JITTER_MS = 3 * 60 * 1000;
const LOOP_TICK_MS = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_LOOP_TICK_MS, 20000, 3000);
const MAX_CONCURRENCY_BASE = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_MAX_CONCURRENCY, 3, 1);
const MAX_EVENTS_PER_TICK_BASE = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_MAX_EVENTS_PER_TICK, 6, 1);
const BURST_ENABLED = toBoolean(process.env.ALTENAR_PREMATCH_SCHEDULER_BURST_ENABLED, true);
const MAX_CONCURRENCY_BURST = Math.max(
    MAX_CONCURRENCY_BASE,
    toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_BURST_MAX_CONCURRENCY, 6, 1)
);
const MAX_EVENTS_PER_TICK_BURST = Math.max(
    MAX_EVENTS_PER_TICK_BASE,
    toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_BURST_MAX_EVENTS_PER_TICK, 14, 1)
);
const BURST_WINDOW_MINUTES = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_BURST_WINDOW_MINUTES, 120, 10);
const BURST_STALE_THRESHOLD_MS = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_BURST_STALE_THRESHOLD_MS, 6 * 60 * 1000, 60000);
const BURST_MIN_LINKED_STALE = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_BURST_MIN_LINKED_STALE, 8, 1);
const CAPACITY_LOG_INTERVAL_MS = toPositiveInt(process.env.ALTENAR_PREMATCH_SCHEDULER_CAPACITY_LOG_INTERVAL_MS, 60000, 5000);
const DETAIL_CANDIDATE_PAST_GRACE_MS = 10 * 60 * 1000;
const DETAIL_CANDIDATE_FUTURE_WINDOW_MS = 12 * 60 * 60 * 1000;

let schedulerStarted = false;
let schedulerTimer = null;
let isDetailRefreshRunning = false;
let isDiscoveryRunning = false;
let nextDiscoveryAt = 0;
let lastCapacityLogAt = 0;

const eventState = new Map();

const nowMs = () => Date.now();

const resolveSchedulerCapacity = ({ altenarEvents = [], linkedSet = new Set() } = {}) => {
    const current = nowMs();
    const burstWindowEnd = current + (BURST_WINDOW_MINUTES * 60 * 1000);

    let linkedNearWindow = 0;
    let linkedNearWindowStale = 0;

    for (const event of altenarEvents) {
        const id = String(event?.id || '').trim();
        if (!id || !linkedSet.has(id)) continue;

        const startTs = new Date(event?.startDate || 0).getTime();
        if (!Number.isFinite(startTs)) continue;
        if (startTs < (current - DETAIL_CANDIDATE_PAST_GRACE_MS) || startTs > burstWindowEnd) continue;

        linkedNearWindow += 1;
        const updatedTs = new Date(event?.lastUpdated || 0).getTime();
        const isStale = !Number.isFinite(updatedTs) || (current - updatedTs) > BURST_STALE_THRESHOLD_MS;
        if (isStale) linkedNearWindowStale += 1;
    }

    const shouldBurst = BURST_ENABLED && linkedNearWindowStale >= BURST_MIN_LINKED_STALE;

    return {
        shouldBurst,
        maxConcurrency: shouldBurst ? MAX_CONCURRENCY_BURST : MAX_CONCURRENCY_BASE,
        maxEventsPerTick: shouldBurst ? MAX_EVENTS_PER_TICK_BURST : MAX_EVENTS_PER_TICK_BASE,
        metrics: {
            linkedNearWindow,
            linkedNearWindowStale,
            burstWindowMinutes: BURST_WINDOW_MINUTES,
            staleThresholdMs: BURST_STALE_THRESHOLD_MS,
            staleMinLinkedEvents: BURST_MIN_LINKED_STALE
        }
    };
};

const flattenOddIds = (market) => {
    if (!market) return [];
    if (Array.isArray(market.desktopOddIds)) return market.desktopOddIds.flat().filter(Boolean);
    if (Array.isArray(market.oddIds)) return market.oddIds.filter(Boolean);
    return [];
};

const extractLineFromText = (value = '') => {
    const normalized = String(value).toLowerCase().replace(',', '.');
    const match = normalized.match(/(\d+(?:\.\d+)?)/);
    if (!match) return NaN;
    const line = parseFloat(match[1]);
    return Number.isFinite(line) ? line : NaN;
};

const normalizeText = (value = '') => String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const tokenize = (value = '') => normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const extractEventSides = (eventName = '') => {
    const parts = String(eventName).split(/\s+vs\.?\s+/i);
    const homeName = parts[0] || '';
    const awayName = parts[1] || '';
    return { homeName, awayName };
};

const getDetailIntervalMs = (minutesToStart) => {
    if (minutesToStart <= 30) return 30 * 1000;
    if (minutesToStart <= 120) return 90 * 1000;
    if (minutesToStart <= 360) return 5 * 60 * 1000;
    return 10 * 60 * 1000;
};

const getPriorityScore = (event, linkedSet) => {
    const startTs = new Date(event.startDate).getTime();
    const minutesToStart = Math.max(0, (startTs - nowMs()) / 60000);
    let score = 0;

    if (linkedSet.has(String(event.id))) score += 5;
    if (minutesToStart <= 30) score += 4;
    else if (minutesToStart <= 120) score += 2;
    else if (minutesToStart <= 360) score += 1;

    return score;
};

const extractOddsFromDetails = (details, eventName = '') => {
    const safeOdds = { home: 0, draw: 0, away: 0, doubleChance: {}, totals: [], btts: {} };
    if (!details || !Array.isArray(details.markets) || !Array.isArray(details.odds)) return safeOdds;

    const oddsMap = new Map(details.odds.map(o => [o.id, o]));

    const market1x2 = details.markets.find(m => m.typeId === 1 || normalizeText(m.name).includes('1x2'));
    if (market1x2) {
        const odds = flattenOddIds(market1x2).map(id => oddsMap.get(id)).filter(Boolean);
        const home = odds.find(o => o.typeId === 1);
        const draw = odds.find(o => o.typeId === 2);
        const away = odds.find(o => o.typeId === 3);
        safeOdds.home = home?.price || 0;
        safeOdds.draw = draw?.price || 0;
        safeOdds.away = away?.price || 0;
    }

    const eventTokens = tokenize(eventName);
    const { homeName, awayName } = extractEventSides(eventName);
    const homeTokens = tokenize(homeName).filter(t => t.length >= 3);
    const awayTokens = tokenize(awayName).filter(t => t.length >= 3);
    const teamTokens = [...new Set([...homeTokens, ...awayTokens])];

    const stopWords = new Set([
        'fc', 'sc', 'cd', 'ca', 'cf', 'club', 'de', 'la', 'el', 'los', 'las', 'al',
        'real', 'city', 'united', 'sporting', 'athletic', 'atletico', 'b', 'res', 'u21', 'women'
    ]);

    const canonicalTeamTokens = teamTokens.filter(t => !stopWords.has(t));

    const totalsBlacklist = [
        'corner', 'esquina', 'card', 'tarjeta', 'half', 'mitad', 'tiempo',
        'team', 'equipo', 'player', 'handicap', 'asian', 'btts',
        'local', 'visitante', 'home', 'away', 'score', 'anota',
        'team total', 'total del equipo', 'total de equipo', 'goles del equipo', 'equipo total',
        'equipo 1', 'equipo 2', 'home total', 'away total'
    ];

    const totalsMarkets = details.markets.filter(m => {
        const name = normalizeText(m.name);
        const isTotal = m.typeId === 18;
        if (!isTotal) return false;
        if (totalsBlacklist.some(word => name.includes(word))) return false;

        const hasCompetitorBinding = Number.isFinite(Number(m.competitorId)) ||
            (Array.isArray(m.competitorIds) && m.competitorIds.length > 0);
        if (hasCompetitorBinding) return false;

        if (canonicalTeamTokens.some(t => name.includes(t))) return false;
        if (eventTokens.some(t => t.length >= 5 && name.includes(t))) return false;

        const oddTexts = flattenOddIds(m)
            .map(id => oddsMap.get(id))
            .filter(Boolean)
            .map(o => normalizeText(o.name));

        const oddMentionsTeam = oddTexts.some(txt => canonicalTeamTokens.some(t => txt.includes(t)));
        if (oddMentionsTeam) return false;

        return true;
    });

    const totalsBuffer = new Map();

    const upsertTotal = (line, side, price) => {
        if (!Number.isFinite(line) || !Number.isFinite(price) || price <= 1) return;
        const key = Number(line.toFixed(2));
        if (!totalsBuffer.has(key)) totalsBuffer.set(key, { line: key, over: 0, under: 0 });
        const entry = totalsBuffer.get(key);
        if (side === 'over' && (!entry.over || entry.over <= 0)) entry.over = price;
        if (side === 'under' && (!entry.under || entry.under <= 0)) entry.under = price;
    };

    for (const market of totalsMarkets) {
        const odds = flattenOddIds(market).map(id => oddsMap.get(id)).filter(Boolean);

        const marketLine = parseFloat(market.sv ?? market.sn ?? market.activeLine ?? market.specialOddValue);

        for (const odd of odds) {
            const oddName = normalizeText(odd.name || '');
            const lineFromOdd = extractLineFromText(oddName);
            const line = Number.isFinite(lineFromOdd) ? lineFromOdd : (Number.isFinite(marketLine) ? marketLine : NaN);
            if (!Number.isFinite(line)) continue;

            if (odd.typeId === 12 || oddName.includes('over') || oddName.includes('mas')) {
                upsertTotal(line, 'over', odd.price);
            }
            if (odd.typeId === 13 || oddName.includes('under') || oddName.includes('menos')) {
                upsertTotal(line, 'under', odd.price);
            }
        }
    }

    safeOdds.totals = Array.from(totalsBuffer.values())
        .filter(t => t.over > 0 && t.under > 0)
        .sort((a, b) => a.line - b.line);

    const bttsMarket = details.markets.find(m => m.typeId === 29 || normalizeText(m.name).includes('ambos'));
    if (bttsMarket) {
        const odds = flattenOddIds(bttsMarket).map(id => oddsMap.get(id)).filter(Boolean);
        const yes = odds.find(o => o.typeId === 74 || normalizeText(o.name).includes('si') || normalizeText(o.name).includes('yes'));
        const no = odds.find(o => o.typeId === 76 || normalizeText(o.name).includes('no'));
        if (yes?.price) safeOdds.btts.yes = yes.price;
        if (no?.price) safeOdds.btts.no = no.price;
    }

    const dcMarket = details.markets.find(m => m.typeId === 10 || normalizeText(m.name).includes('double chance') || normalizeText(m.name).includes('doble oportunidad'));
    if (dcMarket) {
        const odds = flattenOddIds(dcMarket).map(id => oddsMap.get(id)).filter(Boolean);
        for (const odd of odds) {
            if (Number(odd?.typeId) === 9 && odd?.price > 1) {
                safeOdds.doubleChance.homeDraw = odd.price;
                continue;
            }
            if (Number(odd?.typeId) === 10 && odd?.price > 1) {
                safeOdds.doubleChance.homeAway = odd.price;
                continue;
            }
            if (Number(odd?.typeId) === 11 && odd?.price > 1) {
                safeOdds.doubleChance.drawAway = odd.price;
                continue;
            }

            const name = normalizeText(odd.name || '').replace(/\s+/g, '');
            if (name.includes('1x') && odd?.price > 1) safeOdds.doubleChance.homeDraw = odd.price;
            if (name.includes('12') && odd?.price > 1) safeOdds.doubleChance.homeAway = odd.price;
            if (name.includes('x2') && odd?.price > 1) safeOdds.doubleChance.drawAway = odd.price;
        }
    }

    return safeOdds;
};

export const refreshAltenarEventDetailsNow = async ({ eventId } = {}) => {
    const normalizedId = String(eventId || '').trim();
    if (!normalizedId) {
        return {
            success: false,
            code: 'MISSING_EVENT_ID',
            message: 'eventId es obligatorio para refrescar Altenar.'
        };
    }

    await initDB();
    await db.read();

    const rows = Array.isArray(db.data?.altenarUpcoming) ? db.data.altenarUpcoming : [];
    const idx = rows.findIndex((row) => String(row?.id || '').trim() === normalizedId);
    if (idx < 0) {
        return {
            success: false,
            code: 'EVENT_NOT_FOUND',
            message: `No existe evento Altenar ${normalizedId} en cache local.`
        };
    }

    const target = rows[idx];

    try {
        const { data } = await altenarClient.get(
            '/GetEventDetails',
            getAltenarPublicRequestConfig({ eventId: target.id, _: Date.now() })
        );

        const extracted = extractOddsFromDetails(data, target.name);
        const previousHash = JSON.stringify(target?.odds || {});
        const nextHash = JSON.stringify(extracted || {});
        const changed = previousHash !== nextHash;
        const updatedAt = new Date().toISOString();

        target.odds = extracted;
        target.lastUpdated = updatedAt;
        rows[idx] = target;
        db.data.altenarUpcoming = rows;
        db.data.altenarLastUpdate = updatedAt;
        await writeDBWithRetry();

        const startTs = new Date(target?.startDate || 0).getTime();
        const minutesToStart = Number.isFinite(startTs)
            ? Math.max(0, (startTs - nowMs()) / 60000)
            : 360;
        eventState.set(normalizedId, {
            failCount: 0,
            lastHash: nextHash,
            nextDueAt: nowMs() + getDetailIntervalMs(minutesToStart)
        });

        return {
            success: true,
            code: 'REFRESH_OK',
            eventId: normalizedId,
            changed,
            updatedAt
        };
    } catch (error) {
        maybeAutoRenewWidgetToken(error, `altenarPrematchScheduler.onDemand:${normalizedId}`);
        return {
            success: false,
            code: 'GET_EVENT_DETAILS_FAILED',
            eventId: normalizedId,
            message: error?.message || 'Fallo refrescando GetEventDetails en Altenar.'
        };
    }
};

const buildCandidates = (altenarEvents, linkedSet, maxEventsPerTick = MAX_EVENTS_PER_TICK_BASE) => {
    const current = nowMs();

    return altenarEvents
        .filter(ev => {
            if (!ev?.id || !ev?.startDate) return false;
            const ts = new Date(ev.startDate).getTime();
            if (!Number.isFinite(ts)) return false;
            if (ts < current - DETAIL_CANDIDATE_PAST_GRACE_MS) return false;
            if (ts > current + DETAIL_CANDIDATE_FUTURE_WINDOW_MS) return false;
            return true;
        })
        .map(ev => {
            const ts = new Date(ev.startDate).getTime();
            const minutesToStart = Math.max(0, (ts - current) / 60000);
            const intervalMs = getDetailIntervalMs(minutesToStart);
            const state = eventState.get(String(ev.id)) || {};
            const dueAt = state.nextDueAt || 0;
            return {
                event: ev,
                intervalMs,
                minutesToStart,
                priority: getPriorityScore(ev, linkedSet),
                due: dueAt <= current,
                dueAt
            };
        })
        .filter(item => item.due)
        .sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            if (a.minutesToStart !== b.minutesToStart) return a.minutesToStart - b.minutesToStart;
            return a.dueAt - b.dueAt;
        })
        .slice(0, Math.max(1, Number(maxEventsPerTick || MAX_EVENTS_PER_TICK_BASE)));
};

const runWithConcurrency = async (items, worker, concurrency = 4) => {
    const results = [];
    let cursor = 0;

    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const idx = cursor;
            cursor += 1;
            results[idx] = await worker(items[idx]);
        }
    });

    await Promise.all(runners);
    return results;
};

const scheduleNextDiscovery = () => {
    const jitter = Math.floor((Math.random() * 2 - 1) * DISCOVERY_JITTER_MS);
    nextDiscoveryAt = nowMs() + DISCOVERY_BASE_MS + jitter;
};

const runDiscoveryIfDue = async () => {
    if (isDiscoveryRunning) return;
    if (nowMs() < nextDiscoveryAt) return;

    isDiscoveryRunning = true;
    try {
        console.log('🔄 [Altenar Scheduler] Discovery prematch (GetUpcoming) iniciando...');
        await ingestAltenarPrematch(true);
        console.log('✅ [Altenar Scheduler] Discovery prematch completado.');
    } catch (error) {
        console.error(`❌ [Altenar Scheduler] Discovery error: ${error.message}`);
    } finally {
        scheduleNextDiscovery();
        isDiscoveryRunning = false;
    }
};

const refreshDueEventDetails = async () => {
    if (isDetailRefreshRunning) return;
    isDetailRefreshRunning = true;

    try {
        await initDB();
        await db.read();

        const altenarEvents = db.data.altenarUpcoming || [];
        const linkedSet = new Set(
            (db.data.upcomingMatches || [])
                .filter(m => m?.altenarId)
                .map(m => String(m.altenarId))
        );

        const capacity = resolveSchedulerCapacity({ altenarEvents, linkedSet });

        const mustLogCapacity = capacity.shouldBurst || (nowMs() - lastCapacityLogAt) >= CAPACITY_LOG_INTERVAL_MS;
        if (mustLogCapacity) {
            const mode = capacity.shouldBurst ? 'BURST' : 'BASE';
            console.log(
                `🧠 [Altenar Scheduler] Capacity=${mode} | conc=${capacity.maxConcurrency} | batch=${capacity.maxEventsPerTick} | ` +
                `linked<=${capacity.metrics.burstWindowMinutes}m: ${capacity.metrics.linkedNearWindow} | stale: ${capacity.metrics.linkedNearWindowStale}`
            );
            lastCapacityLogAt = nowMs();
        }

        const candidates = buildCandidates(altenarEvents, linkedSet, capacity.maxEventsPerTick);
        if (candidates.length === 0) return;

        const byId = new Map(altenarEvents.map(ev => [String(ev.id), ev]));
        let changedCount = 0;
        let requestCount = 0;

        const updates = await runWithConcurrency(candidates, async ({ event, intervalMs }) => {
            const id = String(event.id);
            const state = eventState.get(id) || { failCount: 0, lastHash: '' };

            try {
                requestCount += 1;
                const { data } = await altenarClient.get(
                    '/GetEventDetails',
                    getAltenarPublicRequestConfig({ eventId: event.id, _: Date.now() })
                );

                const extracted = extractOddsFromDetails(data, event.name);
                const hash = JSON.stringify(extracted);
                const changed = hash !== state.lastHash;

                const backoffFactor = state.failCount > 0 ? Math.min(4, 1 + state.failCount) : 1;
                eventState.set(id, {
                    failCount: 0,
                    lastHash: hash,
                    nextDueAt: nowMs() + intervalMs * backoffFactor
                });

                if (!changed) return null;

                return {
                    id,
                    odds: extracted,
                    lastUpdated: new Date().toISOString()
                };
            } catch (error) {
                maybeAutoRenewWidgetToken(error, `altenarPrematchScheduler.GetEventDetails:${event.id}`);
                const failCount = (state.failCount || 0) + 1;
                const backoffMs = Math.min(15 * 60 * 1000, intervalMs * Math.pow(2, failCount));
                eventState.set(id, {
                    failCount,
                    lastHash: state.lastHash || '',
                    nextDueAt: nowMs() + backoffMs
                });
                return null;
            }
        }, capacity.maxConcurrency);

        for (const update of updates) {
            if (!update) continue;
            const target = byId.get(update.id);
            if (!target) continue;
            target.odds = update.odds;
            target.lastUpdated = update.lastUpdated;
            changedCount += 1;
        }

        if (changedCount > 0) {
            db.data.altenarUpcoming = Array.from(byId.values()).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
            db.data.altenarLastUpdate = new Date().toISOString();
            await writeDBWithRetry();
        }

        if (requestCount > 0) {
            console.log(
                `📈 [Altenar Scheduler] Details refreshed: ${requestCount} req, ${changedCount} cambios ` +
                `(conc=${capacity.maxConcurrency}, batch=${capacity.maxEventsPerTick}, burst=${capacity.shouldBurst ? 'on' : 'off'}).`
            );
        }
    } catch (error) {
        console.error(`❌ [Altenar Scheduler] Detail refresh error: ${error.message}`);
    } finally {
        isDetailRefreshRunning = false;
    }
};

const schedulerLoop = async () => {
    if (!schedulerStarted) return;

    await runDiscoveryIfDue();
    await refreshDueEventDetails();

    schedulerTimer = setTimeout(schedulerLoop, LOOP_TICK_MS);
};

export const startAltenarPrematchAdaptiveScheduler = () => {
    if (schedulerStarted) return;

    schedulerStarted = true;
    scheduleNextDiscovery();
    nextDiscoveryAt = 0;

    console.log('🧠 Altenar Prematch Scheduler Adaptativo iniciado (cola + prioridad temporal).');
    console.log(
        `⚙️ [Altenar Scheduler] Config | tick=${LOOP_TICK_MS}ms | base(conc=${MAX_CONCURRENCY_BASE},batch=${MAX_EVENTS_PER_TICK_BASE}) ` +
        `| burst=${BURST_ENABLED ? 'on' : 'off'}(conc=${MAX_CONCURRENCY_BURST},batch=${MAX_EVENTS_PER_TICK_BURST})`
    );
    schedulerLoop();
};

export const stopAltenarPrematchAdaptiveScheduler = () => {
    schedulerStarted = false;
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
    }
};
