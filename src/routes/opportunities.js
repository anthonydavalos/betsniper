import express from 'express';
import { getCachedLiveOpportunities, discardOpportunity, getDiscardedIds, getLiveDecisionDiagnostics } from '../services/scannerService.js';
import { scanPrematchOpportunities } from '../services/prematchScannerService.js';
import db from '../db/database.js';

const router = express.Router();

const PREMATCH_CACHE_TTL_MS = Math.max(
  5000,
  Number.isFinite(Number(process.env.PREMATCH_CACHE_TTL_MS))
    ? Number(process.env.PREMATCH_CACHE_TTL_MS)
    : 20000
);

let prematchCache = {
  timestamp: null,
  data: [],
  updatedAtMs: 0
};

let prematchInFlightPromise = null;

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

export default router;
