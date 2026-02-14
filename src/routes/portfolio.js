import express from 'express';
import { getPortfolio, resetPortfolio, manualSettleBet, placeAutoBet } from '../services/paperTradingService.js';
import { refreshOpportunity } from '../services/oddsService.js';

const router = express.Router();

// POST /api/portfolio/place-bet
// Colocar una apuesta manualmente desde el UI
router.post('/place-bet', async (req, res) => {
    try {
        const opportunity = req.body;
        
        // 1. Refrescar cuotas en tiempo real (Altenar)
        // Esto lanzará error si el mercado cerró o cambió drásticamente
        console.log(`⚡ Refreshing odds for manual bet: ${opportunity.match}`);
        
        let freshOpportunity;
        try {
            freshOpportunity = await refreshOpportunity(opportunity);
        } catch (refreshError) {
            console.error(`⚠️ Falló el refresco de cuotas: ${refreshError.message}`);
            // Si es Pre-Match, permitimos apostar con la cuota original (asumiendo riesgo menor)
            // Si es Live, es crítico tener la cuota al segundo, pero para UX manual permitimos intentar.
            if (opportunity.type === 'PREMATCH_VALUE') {
                 console.log("   ⚠️ Usando datos cacheados para Pre-Match (Bypass Refresh).");
                 freshOpportunity = { ...opportunity }; // Clone
            } else {
                 // Si es Live y falla, probablemente el mercado cerró.
                 return res.status(400).json({ success: false, message: `El mercado no está disponible (Refresh Failed): ${refreshError.message}` });
            }
        }

        // 2. Verificar si sigue siendo EV+ (Opcional: o simplemente informar al usuario)
        if (freshOpportunity.ev <= 0) {
            return res.json({ success: false, message: `El valor desapareció. Nueva cuota: ${freshOpportunity.price} (EV: ${freshOpportunity.ev}%)` });
        }

        // 3. Colocar apuesta con datos frescos
        const bet = await placeAutoBet(freshOpportunity);
        
        if (!bet) {
             return res.json({ success: false, message: 'Apuesta duplicada o omitida' });
        }
        res.json({ success: true, bet });
    } catch (error) {
        console.error("Error colocando apuesta manual:", error);
        res.status(500).json({ error: error.message });
    }
});

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
