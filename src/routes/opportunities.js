import express from 'express';
import { scanLiveOpportunities } from '../services/scannerService.js';
import db from '../db/database.js';
import { calculateEV, calculateKellyStake } from '../utils/mathUtils.js';

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
// Retorna oportunidades Pre-Match guardadas en DB
router.get('/prematch', async (req, res) => {
  try {
    await db.read();
    const matches = db.data.upcomingMatches || [];
    const bankroll = db.data.config.bankroll || 1000;
    
    // Filtramos solo las que tengan EV positivo ahora con las cuotas que guardamos?
    // En realidad, ingest.js guarda las probabilidades reales.
    // Para saber si hay Value PRE-MATCH, deberíamos comparar vs Altenar Pre-Match.
    // Por ahora, devolvemos todo lo analizado que tenga alta probabilidad para que el usuario decida,
    // o calculamos un "Theoretical EV" vs la bookie Pinnacle (si es que Pinnacle paga mal, raro).
    // LO MEJOR: Frontend pedirá cuota actual de Altenar y calculará ahí, o el backend lo hace si cruzamos.
    // DE MOMENTO: Devolvemos la data cruda "Source of Truth" para el Frontend.
    
    res.json(matches);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
