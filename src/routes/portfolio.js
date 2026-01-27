import express from 'express';
import { getPortfolio, resetPortfolio, manualSettleBet } from '../services/paperTradingService.js';

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

// POST /api/portfolio/settle/:id
// Liquidación Manual o Re-Check de API
router.post('/settle/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { score } = req.body; // Opcional: "2-1"

        const updatedBet = await manualSettleBet(id, score);
        res.json({ success: true, bet: updatedBet });

    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
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
