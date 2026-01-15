import express from 'express';
import { getPortfolio, resetPortfolio } from '../services/paperTradingService.js';

const router = express.Router();

// GET /api/portfolio
// Obtener estado actual (Balance, Historial, Activas)
router.get('/', async (req, res) => {
  try {
    const data = await getPortfolio();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portfolio/reset
// Reiniciar simulación
router.post('/reset', async (req, res) => {
  try {
    const data = await resetPortfolio();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
