import express from 'express';
import { scanLiveOpportunities } from '../services/scannerService.js';
import { scanPrematchOpportunities } from '../services/prematchScannerService.js';
import db from '../db/database.js';

const router = express.Router();

// GET /api/opportunities/live
// Retorna las oportunidades en vivo (Live Value)
router.get('/live', async (req, res) => {
  try {
    const opportunities = await scanLiveOpportunities();
    res.json({
      timestamp: new Date().toISOString(),
      count: opportunities.length,
      data: opportunities
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
    const opportunities = await scanPrematchOpportunities();
    res.json({
        timestamp: new Date().toISOString(),
        count: opportunities.length,
        data: opportunities
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
