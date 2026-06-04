import express from 'express';
import {
  prepareSemiAutoTicket,
  confirmSemiAutoTicket,
  cancelSemiAutoTicket,
  getSemiAutoTickets,
  getBookyTokenHealth,
  requestBookyTokenRenewal,
  getLatestBookyCapture,
  getRealPlacementDryRun,
  confirmRealPlacement,
  confirmRealPlacementFast
} from '../services/bookySemiAutoService.js';
import {
  getBookyAccountSnapshot,
  importBookyPnlBaseFromSpy,
  getBookyPnlBaseSnapshot,
  getBookyKellyDiagnostics
} from '../services/bookyAccountService.js';

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

const BOOKY_ACCOUNT_CACHE_TTL_MS = parsePositiveIntOr(process.env.BOOKY_ACCOUNT_CACHE_TTL_MS, 15000);
const BOOKY_ACCOUNT_STALE_MAX_MS = Math.max(
  BOOKY_ACCOUNT_CACHE_TTL_MS,
  parsePositiveIntOr(process.env.BOOKY_ACCOUNT_STALE_MAX_MS, 180000)
);
const BOOKY_ACCOUNT_COMPUTE_TIMEOUT_MS = parsePositiveIntOr(process.env.BOOKY_ACCOUNT_COMPUTE_TIMEOUT_MS, 7000);
const BOOKY_ACCOUNT_REFRESH_MIN_INTERVAL_MS = parsePositiveIntOr(process.env.BOOKY_ACCOUNT_REFRESH_MIN_INTERVAL_MS, 1500);
const BOOKY_ACCOUNT_TIMEOUT_CACHE_ONLY_FALLBACK = parseBooleanFromEnv(
  process.env.BOOKY_ACCOUNT_TIMEOUT_CACHE_ONLY_FALLBACK,
  true
);
const BOOKY_KELLY_CACHE_TTL_MS = parsePositiveIntOr(process.env.BOOKY_KELLY_CACHE_TTL_MS, 20000);
const BOOKY_KELLY_STALE_MAX_MS = Math.max(
  BOOKY_KELLY_CACHE_TTL_MS,
  parsePositiveIntOr(process.env.BOOKY_KELLY_STALE_MAX_MS, 180000)
);
const BOOKY_KELLY_COMPUTE_TIMEOUT_MS = parsePositiveIntOr(process.env.BOOKY_KELLY_COMPUTE_TIMEOUT_MS, 7000);
const BOOKY_KELLY_REFRESH_MIN_INTERVAL_MS = parsePositiveIntOr(process.env.BOOKY_KELLY_REFRESH_MIN_INTERVAL_MS, 1500);
const BOOKY_KELLY_TIMEOUT_WARMING_FALLBACK = parseBooleanFromEnv(
  process.env.BOOKY_KELLY_TIMEOUT_WARMING_FALLBACK,
  true
);

const bookyAccountCacheByKey = new Map();
const bookyKellyCacheByKey = new Map();

const buildBookyAccountCacheKey = ({ historyLimit = 300, cleanupOld = false, retentionDays = null } = {}) => {
  const retention = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0
    ? Number(retentionDays)
    : 'na';
  return `h${Number(historyLimit) || 300}_c${cleanupOld ? 1 : 0}_r${retention}`;
};

const getBookyAccountCacheState = (cacheKey) => {
  const key = String(cacheKey || 'default');
  if (!bookyAccountCacheByKey.has(key)) {
    bookyAccountCacheByKey.set(key, {
      data: null,
      updatedAtMs: 0,
      lastDurationMs: null,
      lastError: null,
      lastRefreshStartedAtMs: 0,
      refreshInFlight: null
    });
  }
  return bookyAccountCacheByKey.get(key);
};

const hasBookyAccountCache = (state) => {
  return Boolean(state && state.data && typeof state.data === 'object' && Number(state.updatedAtMs) > 0);
};

const getBookyAccountCacheAgeMs = (state) => {
  if (!hasBookyAccountCache(state)) return null;
  return Math.max(0, Date.now() - Number(state.updatedAtMs || 0));
};

const withTimeout = async (promise, timeoutMs, code = 'BOOKY_ACCOUNT_REFRESH_TIMEOUT') => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${code}_${timeoutMs}MS`);
          error.code = code;
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const buildBookyAccountResponse = (state, { source = 'unknown', refreshInFlight = false } = {}) => {
  const data = state?.data && typeof state.data === 'object' ? state.data : {};
  return {
    success: true,
    ...data,
    source,
    cacheAgeMs: getBookyAccountCacheAgeMs(state),
    refreshInFlight,
    computeMs: Number(state?.lastDurationMs || 0)
  };
};

const runBookyAccountRefresh = (state, args = {}, { force = false } = {}) => {
  const nowMs = Date.now();
  const lastStartMs = Number(state?.lastRefreshStartedAtMs || 0);
  const inCooldown = (nowMs - lastStartMs) < BOOKY_ACCOUNT_REFRESH_MIN_INTERVAL_MS;

  if (state?.refreshInFlight) return state.refreshInFlight;
  if (!force && inCooldown) return null;

  state.lastRefreshStartedAtMs = nowMs;
  state.refreshInFlight = (async () => {
    const t0 = Date.now();
    const payload = await getBookyAccountSnapshot(args);
    state.data = payload;
    state.updatedAtMs = Date.now();
    state.lastDurationMs = Date.now() - t0;
    state.lastError = null;
    return payload;
  })()
    .catch((error) => {
      state.lastError = error?.message || String(error);
      throw error;
    })
    .finally(() => {
      state.refreshInFlight = null;
    });

  return state.refreshInFlight;
};

const buildBookyKellyCacheKey = ({ profile = null, horizonBets = 300, simulations = 2000, ruinThreshold = 0.2 } = {}) => {
  const p = String(profile || '').trim().toLowerCase() || 'default';
  const h = Number.isFinite(Number(horizonBets)) ? Number(horizonBets) : 300;
  const s = Number.isFinite(Number(simulations)) ? Number(simulations) : 2000;
  const r = Number.isFinite(Number(ruinThreshold)) ? Number(ruinThreshold) : 0.2;
  return `p${p}_h${h}_s${s}_r${r}`;
};

const getBookyKellyCacheState = (cacheKey) => {
  const key = String(cacheKey || 'default');
  if (!bookyKellyCacheByKey.has(key)) {
    bookyKellyCacheByKey.set(key, {
      data: null,
      updatedAtMs: 0,
      lastDurationMs: null,
      lastError: null,
      lastRefreshStartedAtMs: 0,
      refreshInFlight: null
    });
  }
  return bookyKellyCacheByKey.get(key);
};

const hasBookyKellyCache = (state) => {
  return Boolean(state && state.data && typeof state.data === 'object' && Number(state.updatedAtMs) > 0);
};

const getBookyKellyCacheAgeMs = (state) => {
  if (!hasBookyKellyCache(state)) return null;
  return Math.max(0, Date.now() - Number(state.updatedAtMs || 0));
};

const buildBookyKellyResponse = (state, { source = 'unknown', refreshInFlight = false } = {}) => {
  const data = state?.data && typeof state.data === 'object' ? state.data : {};
  return {
    success: true,
    ...data,
    source,
    cacheAgeMs: getBookyKellyCacheAgeMs(state),
    refreshInFlight,
    computeMs: Number(state?.lastDurationMs || 0)
  };
};

const buildBookyKellyWarmingPayload = (state, args = {}, { source = 'warming', warning = null } = {}) => {
  const payload = {
    success: true,
    profile: args?.profileKey || null,
    fetchedAt: new Date().toISOString(),
    bankrollBase: null,
    sample: null,
    simultaneity: null,
    fractions: null,
    riskOfRuin: null,
    notes: [],
    source,
    cacheAgeMs: getBookyKellyCacheAgeMs(state),
    refreshInFlight: Boolean(state?.refreshInFlight),
    computeMs: Number(state?.lastDurationMs || 0)
  };
  if (warning) payload.warning = warning;
  return payload;
};

const runBookyKellyRefresh = (state, args = {}, { force = false } = {}) => {
  const nowMs = Date.now();
  const lastStartMs = Number(state?.lastRefreshStartedAtMs || 0);
  const inCooldown = (nowMs - lastStartMs) < BOOKY_KELLY_REFRESH_MIN_INTERVAL_MS;

  if (state?.refreshInFlight) return state.refreshInFlight;
  if (!force && inCooldown) return null;

  state.lastRefreshStartedAtMs = nowMs;
  state.refreshInFlight = (async () => {
    const t0 = Date.now();
    const payload = await getBookyKellyDiagnostics(args);
    state.data = payload;
    state.updatedAtMs = Date.now();
    state.lastDurationMs = Date.now() - t0;
    state.lastError = null;
    return payload;
  })()
    .catch((error) => {
      state.lastError = error?.message || String(error);
      throw error;
    })
    .finally(() => {
      state.refreshInFlight = null;
    });

  return state.refreshInFlight;
};

const sendBookyError = (res, error, fallbackStatus = 400) => {
  const status = Number(error?.statusCode) || fallbackStatus;
  const payload = {
    success: false,
    message: error?.message || 'Error inesperado en Booky.'
  };

  if (error?.code) payload.code = error.code;
  if (error?.diagnostic) payload.diagnostic = error.diagnostic;

  return res.status(status).json(payload);
};

// GET /api/booky/tickets
router.get('/tickets', async (req, res) => {
  try {
    const data = await getSemiAutoTickets();
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/capture/latest
router.get('/capture/latest', async (req, res) => {
  try {
    const data = await getLatestBookyCapture();
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/token-health
router.get('/token-health', async (req, res) => {
  try {
    const data = getBookyTokenHealth();
    res.json({ success: true, token: data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/account?refresh=1&historyLimit=60
router.get('/account', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const historyLimitRaw = Number(req.query?.historyLimit || 300);
    const historyLimit = Number.isFinite(historyLimitRaw)
      ? (historyLimitRaw <= 0
        ? 0
        : Math.max(10, Math.min(5000, historyLimitRaw)))
      : 300;
    const cleanup = String(req.query?.cleanup || '').toLowerCase();
    const cleanupOld = cleanup === '1' || cleanup === 'true' || cleanup === 'yes';
    const retentionDaysRaw = Number(req.query?.retentionDays);
    const retentionDays = Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0
      ? retentionDaysRaw
      : null;

    const args = {
      forceRefresh,
      historyLimit,
      cleanupOld,
      retentionDays
    };

    const cacheKey = buildBookyAccountCacheKey({ historyLimit, cleanupOld, retentionDays });
    const cacheState = getBookyAccountCacheState(cacheKey);
    const cacheAgeMs = getBookyAccountCacheAgeMs(cacheState);
    const hasCache = hasBookyAccountCache(cacheState);
    const hasFreshCache = hasCache && Number(cacheAgeMs) <= BOOKY_ACCOUNT_CACHE_TTL_MS;
    const hasUsableStale = hasCache && Number(cacheAgeMs) <= BOOKY_ACCOUNT_STALE_MAX_MS;

    if (!forceRefresh && hasFreshCache) {
      if (!cacheState.refreshInFlight && Number(cacheAgeMs) > Math.floor(BOOKY_ACCOUNT_CACHE_TTL_MS / 2)) {
        runBookyAccountRefresh(cacheState, { ...args, forceRefresh: false }, { force: false });
      }
      return res.json(buildBookyAccountResponse(cacheState, {
        source: 'cache',
        refreshInFlight: Boolean(cacheState.refreshInFlight)
      }));
    }

    const refreshPromise = runBookyAccountRefresh(cacheState, args, { force: forceRefresh || !hasCache });

    if (!forceRefresh && hasUsableStale) {
      return res.json(buildBookyAccountResponse(cacheState, {
        source: 'stale-while-refresh',
        refreshInFlight: Boolean(refreshPromise || cacheState.refreshInFlight)
      }));
    }

    if (!refreshPromise && cacheState.refreshInFlight) {
      await withTimeout(cacheState.refreshInFlight, BOOKY_ACCOUNT_COMPUTE_TIMEOUT_MS);
      return res.json(buildBookyAccountResponse(cacheState, {
        source: 'fresh',
        refreshInFlight: false
      }));
    }

    if (refreshPromise) {
      await withTimeout(refreshPromise, BOOKY_ACCOUNT_COMPUTE_TIMEOUT_MS);
      return res.json(buildBookyAccountResponse(cacheState, {
        source: 'fresh',
        refreshInFlight: false
      }));
    }

    if (hasCache) {
      return res.json(buildBookyAccountResponse(cacheState, {
        source: 'cache-no-refresh',
        refreshInFlight: false
      }));
    }

    const data = await getBookyAccountSnapshot({ ...args, forceRefresh: false, useCachedOnly: true });
    return res.json({ success: true, ...data, source: 'cache-only-empty' });
  } catch (error) {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const historyLimitRaw = Number(req.query?.historyLimit || 300);
    const historyLimit = Number.isFinite(historyLimitRaw)
      ? (historyLimitRaw <= 0
        ? 0
        : Math.max(10, Math.min(5000, historyLimitRaw)))
      : 300;
    const cleanup = String(req.query?.cleanup || '').toLowerCase();
    const cleanupOld = cleanup === '1' || cleanup === 'true' || cleanup === 'yes';
    const retentionDaysRaw = Number(req.query?.retentionDays);
    const retentionDays = Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0
      ? retentionDaysRaw
      : null;
    const cacheKey = buildBookyAccountCacheKey({ historyLimit, cleanupOld, retentionDays });
    const cacheState = getBookyAccountCacheState(cacheKey);
    const hasUsableStale = hasBookyAccountCache(cacheState)
      && Number(getBookyAccountCacheAgeMs(cacheState)) <= BOOKY_ACCOUNT_STALE_MAX_MS;

    if (hasUsableStale) {
      return res.json({
        ...buildBookyAccountResponse(cacheState, {
          source: 'stale-fallback',
          refreshInFlight: Boolean(cacheState.refreshInFlight)
        }),
        warning: error?.message || 'Booky account refresh failed'
      });
    }

    if (error?.code === 'BOOKY_ACCOUNT_REFRESH_TIMEOUT' && BOOKY_ACCOUNT_TIMEOUT_CACHE_ONLY_FALLBACK) {
      try {
        const fallbackData = await getBookyAccountSnapshot({
          forceRefresh: false,
          historyLimit,
          cleanupOld: false,
          retentionDays: null,
          useCachedOnly: true
        });
        return res.json({
          success: true,
          ...fallbackData,
          source: 'cache-only-timeout-fallback',
          warning: `Booky account refresh excedió ${BOOKY_ACCOUNT_COMPUTE_TIMEOUT_MS}ms`
        });
      } catch (_) {
        // Sin fallback disponible, devolvemos timeout explícito.
      }
    }

    if (error?.code === 'BOOKY_ACCOUNT_REFRESH_TIMEOUT') {
      return res.status(504).json({
        success: false,
        code: 'BOOKY_ACCOUNT_REFRESH_TIMEOUT',
        error: `Booky account refresh excedió ${BOOKY_ACCOUNT_COMPUTE_TIMEOUT_MS}ms`,
        refreshInFlight: Boolean(cacheState?.refreshInFlight)
      });
    }

    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/pnl-base
router.get('/pnl-base', async (req, res) => {
  try {
    const profile = String(req.query?.profile || '').trim() || null;
    const data = await getBookyPnlBaseSnapshot({ profileKey: profile });
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// GET /api/booky/kelly-diagnostics?horizonBets=300&simulations=2000&ruinThreshold=0.2
router.get('/kelly-diagnostics', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const profile = String(req.query?.profile || '').trim() || null;
    const horizonBetsRaw = Number(req.query?.horizonBets);
    const simulationsRaw = Number(req.query?.simulations);
    const ruinThresholdRaw = Number(req.query?.ruinThreshold);

    const args = {
      profileKey: profile,
      horizonBets: Number.isFinite(horizonBetsRaw) ? horizonBetsRaw : 300,
      simulations: Number.isFinite(simulationsRaw) ? simulationsRaw : 2000,
      ruinThreshold: Number.isFinite(ruinThresholdRaw) ? ruinThresholdRaw : 0.2
    };

    const cacheKey = buildBookyKellyCacheKey({
      profile,
      horizonBets: args.horizonBets,
      simulations: args.simulations,
      ruinThreshold: args.ruinThreshold
    });
    const cacheState = getBookyKellyCacheState(cacheKey);
    const cacheAgeMs = getBookyKellyCacheAgeMs(cacheState);
    const hasCache = hasBookyKellyCache(cacheState);
    const hasFreshCache = hasCache && Number(cacheAgeMs) <= BOOKY_KELLY_CACHE_TTL_MS;
    const hasUsableStale = hasCache && Number(cacheAgeMs) <= BOOKY_KELLY_STALE_MAX_MS;

    if (!forceRefresh && hasFreshCache) {
      if (!cacheState.refreshInFlight && Number(cacheAgeMs) > Math.floor(BOOKY_KELLY_CACHE_TTL_MS / 2)) {
        runBookyKellyRefresh(cacheState, args, { force: false });
      }
      return res.json(buildBookyKellyResponse(cacheState, {
        source: 'cache',
        refreshInFlight: Boolean(cacheState.refreshInFlight)
      }));
    }

    const refreshPromise = runBookyKellyRefresh(cacheState, args, { force: forceRefresh || !hasCache });

    if (!forceRefresh && !hasCache) {
      return res.json(buildBookyKellyWarmingPayload(cacheState, args, { source: 'warming' }));
    }

    if (!forceRefresh && hasUsableStale) {
      return res.json(buildBookyKellyResponse(cacheState, {
        source: 'stale-while-refresh',
        refreshInFlight: Boolean(refreshPromise || cacheState.refreshInFlight)
      }));
    }

    if (!refreshPromise && cacheState.refreshInFlight) {
      await withTimeout(cacheState.refreshInFlight, BOOKY_KELLY_COMPUTE_TIMEOUT_MS, 'BOOKY_KELLY_REFRESH_TIMEOUT');
      return res.json(buildBookyKellyResponse(cacheState, {
        source: 'fresh',
        refreshInFlight: false
      }));
    }

    if (refreshPromise) {
      await withTimeout(refreshPromise, BOOKY_KELLY_COMPUTE_TIMEOUT_MS, 'BOOKY_KELLY_REFRESH_TIMEOUT');
      return res.json(buildBookyKellyResponse(cacheState, {
        source: 'fresh',
        refreshInFlight: false
      }));
    }

    if (hasCache) {
      return res.json(buildBookyKellyResponse(cacheState, {
        source: 'cache-no-refresh',
        refreshInFlight: false
      }));
    }

    return res.json(buildBookyKellyWarmingPayload(cacheState, args, { source: 'warming-empty' }));
  } catch (error) {
    const profile = String(req.query?.profile || '').trim() || null;
    const horizonBetsRaw = Number(req.query?.horizonBets);
    const simulationsRaw = Number(req.query?.simulations);
    const ruinThresholdRaw = Number(req.query?.ruinThreshold);
    const cacheKey = buildBookyKellyCacheKey({
      profile,
      horizonBets: Number.isFinite(horizonBetsRaw) ? horizonBetsRaw : 300,
      simulations: Number.isFinite(simulationsRaw) ? simulationsRaw : 2000,
      ruinThreshold: Number.isFinite(ruinThresholdRaw) ? ruinThresholdRaw : 0.2
    });
    const cacheState = getBookyKellyCacheState(cacheKey);
    const hasUsableStale = hasBookyKellyCache(cacheState)
      && Number(getBookyKellyCacheAgeMs(cacheState)) <= BOOKY_KELLY_STALE_MAX_MS;

    if (hasUsableStale) {
      return res.json({
        ...buildBookyKellyResponse(cacheState, {
          source: 'stale-fallback',
          refreshInFlight: Boolean(cacheState.refreshInFlight)
        }),
        warning: error?.message || 'Kelly diagnostics refresh failed'
      });
    }

    if (error?.code === 'BOOKY_KELLY_REFRESH_TIMEOUT' && BOOKY_KELLY_TIMEOUT_WARMING_FALLBACK) {
      return res.json(buildBookyKellyWarmingPayload(cacheState, {
        profileKey: profile
      }, {
        source: 'warming-timeout-fallback',
        warning: `Kelly diagnostics refresh excedió ${BOOKY_KELLY_COMPUTE_TIMEOUT_MS}ms`
      }));
    }

    if (error?.code === 'BOOKY_KELLY_REFRESH_TIMEOUT') {
      return res.status(504).json({
        success: false,
        code: 'BOOKY_KELLY_REFRESH_TIMEOUT',
        error: `Kelly diagnostics refresh excedió ${BOOKY_KELLY_COMPUTE_TIMEOUT_MS}ms`,
        refreshInFlight: Boolean(cacheState?.refreshInFlight)
      });
    }

    sendBookyError(res, error, 500);
  }
});

// POST /api/booky/pnl-base/import-spy
router.post('/pnl-base/import-spy', async (req, res) => {
  try {
    const profile = String(req.body?.profile || '').trim() || null;
    const filePath = String(req.body?.filePath || '').trim() || null;
    const result = await importBookyPnlBaseFromSpy({ profileKey: profile, filePath });
    if (!result?.success) {
      return res.status(400).json({ success: false, ...result });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// POST /api/booky/pnl-base/sync
router.post('/pnl-base/sync', async (req, res) => {
  try {
    const profile = String(req.body?.profile || '').trim() || null;
    const filePath = String(req.body?.filePath || '').trim() || null;

    const imported = await importBookyPnlBaseFromSpy({ profileKey: profile, filePath });
    if (!imported?.success) {
      return res.status(400).json({ success: false, imported, snapshot: null });
    }

    const snapshot = await getBookyPnlBaseSnapshot({ profileKey: profile });
    res.json({ success: true, imported, snapshot });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// POST /api/booky/token/renew
router.post('/token/renew', async (req, res) => {
  try {
    const data = requestBookyTokenRenewal();
    res.json({ success: true, ...data });
  } catch (error) {
    sendBookyError(res, error, 500);
  }
});

// POST /api/booky/prepare
router.post('/prepare', async (req, res) => {
  try {
    const opportunity = req.body;
    const ticket = await prepareSemiAutoTicket(opportunity);
    res.json({ success: true, ticket });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/confirm/:id
router.post('/confirm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmSemiAutoTicket(id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/cancel/:id
router.post('/cancel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await cancelSemiAutoTicket(id);
    res.json({ success: true, ticket });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/real/dryrun/:id
router.post('/real/dryrun/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const draft = await getRealPlacementDryRun(id);
    res.json({ success: true, draft });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/real/confirm/:id
router.post('/real/confirm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmRealPlacement(id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

// POST /api/booky/real/confirm-fast/:id
router.post('/real/confirm-fast/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmRealPlacementFast(id);
    res.json({ success: true, ...result });
  } catch (error) {
    sendBookyError(res, error, 400);
  }
});

export default router;
