import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { getLiveOddsComparison } from '../services/liveValueScanner.js';

const router = express.Router();

const parsePositiveIntOr = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
};

const parseBooleanFromEnv = (value, fallback = true) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
};

const MONITOR_CACHE_TTL_MS = parsePositiveIntOr(process.env.MONITOR_CACHE_TTL_MS, 12000);
const MONITOR_STALE_MAX_MS = Math.max(
    MONITOR_CACHE_TTL_MS,
    parsePositiveIntOr(process.env.MONITOR_STALE_MAX_MS, 180000)
);
const MONITOR_COMPUTE_TIMEOUT_MS = parsePositiveIntOr(process.env.MONITOR_COMPUTE_TIMEOUT_MS, 12000);
const MONITOR_REFRESH_MIN_INTERVAL_MS = parsePositiveIntOr(process.env.MONITOR_REFRESH_MIN_INTERVAL_MS, 1500);
const MONITOR_PERSIST_LAST_SAMPLE = parseBooleanFromEnv(process.env.MONITOR_PERSIST_LAST_SAMPLE, true);
const MONITOR_LAST_SAMPLE_PATH = process.env.MONITOR_LAST_SAMPLE_PATH
    ? path.resolve(process.cwd(), process.env.MONITOR_LAST_SAMPLE_PATH)
    : path.resolve(process.cwd(), 'data', 'monitor_live_odds.latest.json');

let monitorRefreshInFlight = null;
let monitorPersistLoadDone = false;
const monitorCache = {
    data: [],
    updatedAtMs: 0,
    lastDurationMs: null,
    lastError: null,
    lastRefreshStartedAtMs: 0,
    lastRefreshCompletedAtMs: 0
};

const hasMonitorCache = () => Array.isArray(monitorCache.data) && monitorCache.updatedAtMs > 0;

const sanitizeMonitorRows = (rows) => (Array.isArray(rows) ? rows : []);

const loadPersistedMonitorSampleIfNeeded = async () => {
    if (monitorPersistLoadDone) return;
    monitorPersistLoadDone = true;

    if (!MONITOR_PERSIST_LAST_SAMPLE) return;

    try {
        const raw = await fs.readFile(MONITOR_LAST_SAMPLE_PATH, 'utf8');
        const payload = JSON.parse(raw);
        const rows = sanitizeMonitorRows(payload?.data);
        if (rows.length === 0) return;

        const persistedUpdatedAtMs = Number(payload?.updatedAtMs || 0);
        monitorCache.data = rows;
        monitorCache.updatedAtMs = Number.isFinite(persistedUpdatedAtMs) && persistedUpdatedAtMs > 0
            ? persistedUpdatedAtMs
            : Date.now();
        monitorCache.lastDurationMs = Number(payload?.lastDurationMs || 0) || null;
        monitorCache.lastError = null;
    } catch (_) {
        // Sin snapshot persistido previo: seguimos con flujo normal de warming.
    }
};

const persistMonitorSample = async () => {
    if (!MONITOR_PERSIST_LAST_SAMPLE) return;

    try {
        const rows = sanitizeMonitorRows(monitorCache.data);
        const payload = {
            savedAt: new Date().toISOString(),
            updatedAtMs: Number(monitorCache.updatedAtMs || Date.now()),
            lastDurationMs: Number(monitorCache.lastDurationMs || 0),
            data: rows
        };
        await fs.mkdir(path.dirname(MONITOR_LAST_SAMPLE_PATH), { recursive: true });
        await fs.writeFile(MONITOR_LAST_SAMPLE_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (_) {
        // Persistencia best-effort: no bloquear endpoint por fallo de IO.
    }
};

const getMonitorCacheAgeMs = () => {
    if (!hasMonitorCache()) return null;
    return Math.max(0, Date.now() - Number(monitorCache.updatedAtMs || 0));
};

const buildMonitorResponse = ({ source = 'unknown', refreshInFlight = false } = {}) => {
    const rows = Array.isArray(monitorCache.data) ? monitorCache.data : [];
    return {
        success: true,
        count: rows.length,
        data: rows,
        source,
        cacheAgeMs: getMonitorCacheAgeMs(),
        refreshInFlight,
        computeMs: Number(monitorCache.lastDurationMs || 0)
    };
};

const withTimeout = async (promise, timeoutMs) => {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`MONITOR_REFRESH_TIMEOUT_${timeoutMs}MS`);
                    error.code = 'MONITOR_REFRESH_TIMEOUT';
                    reject(error);
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const runMonitorRefresh = ({ force = false } = {}) => {
    const nowMs = Date.now();
    const lastStartMs = Number(monitorCache.lastRefreshStartedAtMs || 0);
    const inCooldown = (nowMs - lastStartMs) < MONITOR_REFRESH_MIN_INTERVAL_MS;

    if (monitorRefreshInFlight) return monitorRefreshInFlight;
    if (!force && inCooldown) return null;

    monitorCache.lastRefreshStartedAtMs = nowMs;
    monitorRefreshInFlight = (async () => {
        const t0 = Date.now();
        const rows = await getLiveOddsComparison();
        const safeRows = Array.isArray(rows) ? rows : [];
        monitorCache.data = safeRows;
        monitorCache.updatedAtMs = Date.now();
        monitorCache.lastDurationMs = Date.now() - t0;
        monitorCache.lastError = null;
        monitorCache.lastRefreshCompletedAtMs = Date.now();
        void persistMonitorSample();
        return safeRows;
    })()
        .catch((error) => {
            monitorCache.lastError = error?.message || String(error);
            throw error;
        })
        .finally(() => {
            monitorRefreshInFlight = null;
        });

    return monitorRefreshInFlight;
};

// GET /api/monitor/live-odds
router.get('/live-odds', async (req, res) => {
    try {
        await loadPersistedMonitorSampleIfNeeded();

        const refreshRaw = String(req.query?.refresh || '').trim().toLowerCase();
        const forceRefresh = refreshRaw === '1' || refreshRaw === 'true' || refreshRaw === 'yes';
        const cacheAgeMs = getMonitorCacheAgeMs();
        const hasCache = hasMonitorCache();
        const hasFreshCache = hasCache && Number(cacheAgeMs) <= MONITOR_CACHE_TTL_MS;
        const hasUsableStale = hasCache && Number(cacheAgeMs) <= MONITOR_STALE_MAX_MS;

        if (!forceRefresh && hasFreshCache) {
            if (!monitorRefreshInFlight && Number(cacheAgeMs) > Math.floor(MONITOR_CACHE_TTL_MS / 2)) {
                runMonitorRefresh({ force: false });
            }
            return res.json(buildMonitorResponse({ source: 'cache', refreshInFlight: Boolean(monitorRefreshInFlight) }));
        }

        const refreshPromise = runMonitorRefresh({ force: forceRefresh || !hasCache });

        // Primera carga sin cache: responder rápido y calentar en background.
        if (!forceRefresh && !hasCache) {
            return res.json({
                success: true,
                count: 0,
                data: [],
                source: 'warming',
                refreshInFlight: Boolean(refreshPromise)
            });
        }

        // Si hay cache stale utilizable, preferimos responder inmediato y refrescar en segundo plano.
        if (!forceRefresh && hasUsableStale) {
            return res.json(buildMonitorResponse({
                source: 'stale-while-refresh',
                refreshInFlight: Boolean(refreshPromise || monitorRefreshInFlight)
            }));
        }

        if (!refreshPromise && monitorRefreshInFlight) {
            await withTimeout(monitorRefreshInFlight, MONITOR_COMPUTE_TIMEOUT_MS);
            return res.json(buildMonitorResponse({ source: 'fresh', refreshInFlight: false }));
        }

        if (refreshPromise) {
            await withTimeout(refreshPromise, MONITOR_COMPUTE_TIMEOUT_MS);
            return res.json(buildMonitorResponse({ source: 'fresh', refreshInFlight: false }));
        }

        return res.json(buildMonitorResponse({ source: hasCache ? 'cache-no-refresh' : 'empty', refreshInFlight: false }));
    } catch (error) {
        const hasUsableStale = hasMonitorCache() && Number(getMonitorCacheAgeMs()) <= MONITOR_STALE_MAX_MS;
        if (hasUsableStale) {
            return res.json({
                ...buildMonitorResponse({ source: 'stale-fallback', refreshInFlight: Boolean(monitorRefreshInFlight) }),
                warning: error?.message || 'Monitor refresh failed'
            });
        }

        if (error?.code === 'MONITOR_REFRESH_TIMEOUT') {
            return res.status(504).json({
                success: false,
                code: 'MONITOR_REFRESH_TIMEOUT',
                error: `Monitor refresh excedió ${MONITOR_COMPUTE_TIMEOUT_MS}ms`,
                refreshInFlight: Boolean(monitorRefreshInFlight)
            });
        }

        console.error("❌ Error en Monitor endpoint:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
