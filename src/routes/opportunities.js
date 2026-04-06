import express from 'express';
import {
  getCachedLiveOpportunities,
  discardOpportunity,
  getDiscardedIds,
  getLiveDecisionDiagnostics,
  getAutoPlacementProvider,
  setAutoPlacementProvider
} from '../services/scannerService.js';
import { scanPrematchOpportunities, getPrematchDecisionDiagnostics } from '../services/prematchScannerService.js';
import {
  getArbitragePreview1x2,
  getArbitrageDiagnosticsReport,
  runArbitrageDiagnosticsInventory
} from '../services/arbitrageService.js';
import { refreshAltenarEventDetailsNow } from '../services/altenarPrematchScheduler.js';
import db from '../db/database.js';

const router = express.Router();

const PREMATCH_CACHE_TTL_MS = Math.max(
  5000,
  Number.isFinite(Number(process.env.PREMATCH_CACHE_TTL_MS))
    ? Number(process.env.PREMATCH_CACHE_TTL_MS)
    : 20000
);
const PREMATCH_STREAM_REFRESH_INTERVAL_MS = Math.max(
  5000,
  Number.isFinite(Number(process.env.PREMATCH_STREAM_REFRESH_INTERVAL_MS))
    ? Number(process.env.PREMATCH_STREAM_REFRESH_INTERVAL_MS)
    : 12000
);
const PREMATCH_STREAM_HEARTBEAT_MS = Math.max(
  10000,
  Number.isFinite(Number(process.env.PREMATCH_STREAM_HEARTBEAT_MS))
    ? Number(process.env.PREMATCH_STREAM_HEARTBEAT_MS)
    : 20000
);

let prematchCache = {
  timestamp: null,
  data: [],
  updatedAtMs: 0
};

let prematchInFlightPromise = null;
let prematchStreamTicker = null;
const prematchStreamClients = new Set();

const runPrematchRefresh = async () => {
  const allOpportunities = await scanPrematchOpportunities();
  prematchCache = {
    timestamp: new Date().toISOString(),
    data: Array.isArray(allOpportunities) ? allOpportunities : [],
    updatedAtMs: Date.now()
  };
  return prematchCache;
};

const ensurePrematchRefresh = ({ deferred = false } = {}) => {
  if (prematchInFlightPromise) return prematchInFlightPromise;

  if (deferred) {
    prematchInFlightPromise = new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          const latest = await runPrematchRefresh();
          resolve(latest);
        } catch (error) {
          reject(error);
        } finally {
          prematchInFlightPromise = null;
        }
      }, 0);
    });
    return prematchInFlightPromise;
  }

  prematchInFlightPromise = runPrematchRefresh().finally(() => {
    prematchInFlightPromise = null;
  });
  return prematchInFlightPromise;
};

// Helper: Generar ID único por oportunidad (eventId + selection)
// Debe coincidir con la función del frontend
function normalizePick(obj = {}) {
  if (obj.pick) return String(obj.pick).toLowerCase();

  const actionStr = (obj.action || '').toUpperCase();
  const selectionStr = (obj.selection || '').toUpperCase();
  const marketStr = (obj.market || '').toUpperCase();
  const combined = `${selectionStr} ${actionStr} ${marketStr}`;

  if (selectionStr === 'HOME' || actionStr.includes('LOCAL')) return 'home';
  if (selectionStr === 'AWAY' || actionStr.includes('VISITA')) return 'away';
  if (selectionStr === 'DRAW' || actionStr.includes('EMPATE')) return 'draw';

  if (combined.includes('BTTS') && (combined.includes('YES') || combined.includes('SI') || combined.includes('SÍ'))) return 'btts_yes';
  if (combined.includes('BTTS') && combined.includes('NO')) return 'btts_no';

  if (combined.includes('OVER') || combined.includes('MÁS') || combined.includes('MAS')) {
    const lineMatch = selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/);
    const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
    return Number.isFinite(line) ? `over_${line}` : 'over';
  }

  if (combined.includes('UNDER') || combined.includes('MENOS')) {
    const lineMatch = selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/);
    const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
    return Number.isFinite(line) ? `under_${line}` : 'under';
  }

  return String(obj.selection || obj.action || obj.market || '').replace(/\s+/g, '_');
}

function getOpportunityId(op) {
  const eventId = String(op.eventId || op.id);
  return `${eventId}_${normalizePick(op)}`;
}

function filterIgnoredPrematchRows(rows = []) {
  const ignoredIds = new Set(getDiscardedIds());
  return rows.filter(op => {
    const opId = getOpportunityId(op);
    return !ignoredIds.has(opId);
  });
}

function emitPrematchSseEvent(eventName, payload) {
  const body = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of prematchStreamClients) {
    try {
      client.write(body);
    } catch (_) {
      // noop
    }
  }
}

function startPrematchStreamTickerIfNeeded() {
  if (prematchStreamTicker) return;

  prematchStreamTicker = setInterval(async () => {
    if (prematchStreamClients.size === 0) return;

    try {
      const latest = await ensurePrematchRefresh({ deferred: false });
      const filtered = filterIgnoredPrematchRows(latest.data || []);
      emitPrematchSseEvent('prematch-update', {
        timestamp: latest.timestamp || new Date().toISOString(),
        count: filtered.length,
        data: filtered,
        source: 'sse-refresh'
      });
    } catch (error) {
      emitPrematchSseEvent('prematch-error', {
        at: new Date().toISOString(),
        error: error?.message || 'Error refrescando prematch stream'
      });
    }
  }, PREMATCH_STREAM_REFRESH_INTERVAL_MS);
}

function stopPrematchStreamTickerIfIdle() {
  if (prematchStreamClients.size > 0) return;
  if (!prematchStreamTicker) return;
  clearInterval(prematchStreamTicker);
  prematchStreamTicker = null;
}

// POST /api/opportunities/discard
// Añade un evento a la lista negra
router.post('/discard', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Missing ID" });
    
    discardOpportunity(id);
    res.json({ success: true, message: `Oportunidad ${id} descartada.` });
});

// GET /api/opportunities/live
// Retorna las oportunidades en vivo (USA CACHÉ EN MEMORIA)
router.get('/live', async (req, res) => {
  try {
    // Ya no invoca el escaneo real, sino que lee la memoria del worker
    const result = getCachedLiveOpportunities();
    res.json({
      timestamp: result.timestamp || new Date().toISOString(),
      count: result.data.length,
      data: result.data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opportunities/live/diagnostics
// Retorna razones de auto-snipe/no-auto y métricas de pipeline live.
router.get('/live/diagnostics', async (req, res) => {
  try {
    const limit = Number(req.query?.limit || 200);
    const result = getLiveDecisionDiagnostics({ limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opportunities/prematch/diagnostics
// Retorna breakdown de filtros prematch y métricas del último pipeline.
router.get('/prematch/diagnostics', async (req, res) => {
  try {
    const limit = Number(req.query?.limit || 200);
    const result = getPrematchDecisionDiagnostics({ limit });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opportunities/live/placement-provider
// Muestra proveedor activo de auto-placement (booky|pinnacle).
router.get('/live/placement-provider', async (_req, res) => {
  try {
    res.json({
      success: true,
      provider: getAutoPlacementProvider(),
      allowed: ['booky', 'pinnacle']
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/opportunities/live/placement-provider
// Cambia proveedor activo en caliente sin reiniciar backend.
router.post('/live/placement-provider', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim().toLowerCase();
    const result = setAutoPlacementProvider(provider);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// GET /api/opportunities/prematch
// Retorna oportunidades Pre-Match calculadas vs Altenar (GetUpcoming)
router.get('/prematch', async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '').toLowerCase();
    const forceRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const nowMs = Date.now();
    const hasFreshCache = (nowMs - Number(prematchCache.updatedAtMs || 0)) <= PREMATCH_CACHE_TTL_MS;

    if (!forceRefresh && hasFreshCache) {
      const filteredFromCache = filterIgnoredPrematchRows(prematchCache.data || []);
      return res.json({
        timestamp: prematchCache.timestamp || new Date().toISOString(),
        count: filteredFromCache.length,
        data: filteredFromCache,
        source: 'cache',
        cacheAgeMs: nowMs - Number(prematchCache.updatedAtMs || nowMs)
      });
    }

    // Modo rápido por defecto: no bloquear request esperando el scan pesado.
    // Se devuelve último snapshot (o vacío) y el refresco sigue en background.
    if (!forceRefresh) {
      ensurePrematchRefresh({ deferred: true });
      const filteredSnapshot = filterIgnoredPrematchRows(prematchCache.data || []);
      return res.json({
        timestamp: prematchCache.timestamp || new Date().toISOString(),
        count: filteredSnapshot.length,
        data: filteredSnapshot,
        source: filteredSnapshot.length > 0 ? 'stale-while-revalidate' : 'warming',
        warming: true,
        cacheAgeMs: nowMs - Number(prematchCache.updatedAtMs || nowMs)
      });
    }

    const latest = await ensurePrematchRefresh({ deferred: false });
    const filteredOpportunities = filterIgnoredPrematchRows(latest.data || []);

    res.json({
      timestamp: latest.timestamp || new Date().toISOString(),
      count: filteredOpportunities.length,
      data: filteredOpportunities,
      source: 'fresh-forced'
    });
  } catch (error) {
    if (Array.isArray(prematchCache.data) && prematchCache.data.length > 0) {
      const filteredFallback = filterIgnoredPrematchRows(prematchCache.data || []);
      return res.json({
        timestamp: prematchCache.timestamp || new Date().toISOString(),
        count: filteredFallback.length,
        data: filteredFallback,
        source: 'stale-fallback',
        warning: error.message
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// GET /api/opportunities/prematch/stream
// Stream SSE para push de oportunidades prematch (sin polling fijo en frontend).
router.get('/prematch/stream', async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  prematchStreamClients.add(res);
  startPrematchStreamTickerIfNeeded();

  const warmRows = filterIgnoredPrematchRows(prematchCache.data || []);
  res.write(`event: prematch-update\ndata: ${JSON.stringify({
    timestamp: prematchCache.timestamp || new Date().toISOString(),
    count: warmRows.length,
    data: warmRows,
    source: 'sse-warm'
  })}\n\n`);

  ensurePrematchRefresh({ deferred: true })
    .then((latest) => {
      const filtered = filterIgnoredPrematchRows(latest.data || []);
      if (!prematchStreamClients.has(res)) return;
      res.write(`event: prematch-update\ndata: ${JSON.stringify({
        timestamp: latest.timestamp || new Date().toISOString(),
        count: filtered.length,
        data: filtered,
        source: 'sse-connect-refresh'
      })}\n\n`);
    })
    .catch((error) => {
      if (!prematchStreamClients.has(res)) return;
      res.write(`event: prematch-error\ndata: ${JSON.stringify({
        at: new Date().toISOString(),
        error: error?.message || 'Error inicializando prematch stream'
      })}\n\n`);
    });

  const heartbeat = setInterval(() => {
    if (!prematchStreamClients.has(res)) return;
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, PREMATCH_STREAM_HEARTBEAT_MS);

  _req.on('close', () => {
    clearInterval(heartbeat);
    prematchStreamClients.delete(res);
    stopPrematchStreamTickerIfIdle();
  });
});

// GET /api/opportunities/arbitrage/preview
// Preview de arbitraje matematico (sin ejecucion real): 1x2 + DC/opuesto.
router.get('/arbitrage/preview', async (req, res) => {
  try {
    const bankrollRaw = Number(req.query?.bankroll);
    const limitRaw = Number(req.query?.limit);
    const minRoiPercentRaw = Number(req.query?.minRoiPercent);
    const minProfitAbsRaw = Number(req.query?.minProfitAbs);
    const refreshAltenarNow = ['1', 'true', 'yes'].includes(String(req.query?.refreshAltenarNow || '').trim().toLowerCase());
    const refreshAltenarEventId = String(req.query?.refreshAltenarEventId || '').trim();

    let onDemandRefresh = null;
    if (refreshAltenarNow && refreshAltenarEventId) {
      onDemandRefresh = await refreshAltenarEventDetailsNow({ eventId: refreshAltenarEventId });
    }

    const payload = await getArbitragePreview1x2({
      bankroll: Number.isFinite(bankrollRaw) ? bankrollRaw : null,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      minRoiPercent: Number.isFinite(minRoiPercentRaw) ? minRoiPercentRaw : undefined,
      minProfitAbs: Number.isFinite(minProfitAbsRaw) ? minProfitAbsRaw : undefined
    });

    if (onDemandRefresh) {
      payload.onDemandRefresh = {
        altenarEvent: onDemandRefresh
      };
    }

    res.json(payload);
  } catch (error) {
    res.status(500).json({
      success: false,
      mode: 'preview-only',
      error: error?.message || 'No se pudo generar preview de arbitraje.'
    });
  }
});

// GET /api/opportunities/arbitrage/diagnostics
// Historial persistido + resumen estadistico de rechazos/snapshots de arbitraje.
router.get('/arbitrage/diagnostics', async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit);
    const triggerRaw = String(req.query?.trigger || 'all').trim().toLowerCase();
    const windowMinutesRaw = Number(req.query?.windowMinutes);

    const payload = await getArbitrageDiagnosticsReport({
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      trigger: triggerRaw || 'all',
      windowMinutes: Number.isFinite(windowMinutesRaw) ? windowMinutesRaw : undefined
    });

    res.json({
      success: true,
      ...payload
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || 'No se pudo consultar diagnosticos de arbitraje.'
    });
  }
});

// POST /api/opportunities/arbitrage/diagnostics/inventory
// Ejecuta un inventario inmediato del snapshot de arbitraje para auditoria.
router.post('/arbitrage/diagnostics/inventory', async (req, res) => {
  try {
    const bankrollRaw = Number(req.body?.bankroll);
    const limitRaw = Number(req.body?.limit);
    const minRoiPercentRaw = Number(req.body?.minRoiPercent);
    const minProfitAbsRaw = Number(req.body?.minProfitAbs);
    const tag = String(req.body?.tag || 'manual-api').trim() || 'manual-api';

    const payload = await runArbitrageDiagnosticsInventory({
      bankroll: Number.isFinite(bankrollRaw) ? bankrollRaw : null,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
      minRoiPercent: Number.isFinite(minRoiPercentRaw) ? minRoiPercentRaw : null,
      minProfitAbs: Number.isFinite(minProfitAbsRaw) ? minProfitAbsRaw : null,
      tag
    });

    res.json({
      success: true,
      ...payload
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error?.message || 'No se pudo ejecutar inventario de arbitraje.'
    });
  }
});

export default router;
