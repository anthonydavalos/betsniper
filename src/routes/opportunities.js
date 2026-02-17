import express from 'express';
import { getCachedLiveOpportunities, discardOpportunity, getDiscardedIds } from '../services/scannerService.js';
import { scanPrematchOpportunities } from '../services/prematchScannerService.js';
import db from '../db/database.js';

const router = express.Router();

// Helper: Generar ID único por oportunidad (eventId + selection)
// Debe coincidir con la función del frontend
function getOpportunityId(op) {
  const eventId = String(op.eventId || op.id);
  const selection = op.selection || op.action || op.market || '';
  return `${eventId}_${selection.replace(/\s+/g, '_')}`;
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
