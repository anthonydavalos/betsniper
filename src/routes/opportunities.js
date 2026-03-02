import express from 'express';
import { getCachedLiveOpportunities, discardOpportunity, getDiscardedIds } from '../services/scannerService.js';
import { scanPrematchOpportunities } from '../services/prematchScannerService.js';
import db from '../db/database.js';

const router = express.Router();

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
    const line = parseFloat((selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/) || [0])[0]);
    return `over_${Number.isNaN(line) ? 0 : line}`;
  }

  if (combined.includes('UNDER') || combined.includes('MENOS')) {
    const line = parseFloat((selectionStr.match(/\d+(\.\d+)?/) || marketStr.match(/\d+(\.\d+)?/) || [0])[0]);
    return `under_${Number.isNaN(line) ? 0 : line}`;
  }

  return String(obj.selection || obj.action || obj.market || '').replace(/\s+/g, '_');
}

function getOpportunityId(op) {
  const eventId = String(op.eventId || op.id);
  return `${eventId}_${normalizePick(op)}`;
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

// GET /api/opportunities/prematch
// Retorna oportunidades Pre-Match calculadas vs Altenar (GetUpcoming)
router.get('/prematch', async (req, res) => {
  try {
    // Escaner Real vs Altenar
    const allOpportunities = await scanPrematchOpportunities();
    
    // [MOD] Filtro de descartados en tiempo real (por selección individual)
    const ignoredIds = new Set(getDiscardedIds());
    // console.log("Ignored IDs:", Array.from(ignoredIds)); 
    
    const filteredOpportunities = allOpportunities.filter(op => {
         const opId = getOpportunityId(op); // ID único por selección
         const isIgnored = ignoredIds.has(opId);
         // if (isIgnored) console.log(`Omitiendo Oportunidad ${opId} (Blacklisted)`);
         return !isIgnored;
    });

    res.json({
        timestamp: new Date().toISOString(),
        count: filteredOpportunities.length,
        data: filteredOpportunities
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
