import express from 'express';
import { getLiveOddsComparison } from '../services/liveValueScanner.js';

const router = express.Router();

// GET /api/monitor/live-odds
router.get('/live-odds', async (req, res) => {
    try {
        console.log("📊 [API] Solicitando Comparación de Cuotas en Vivo...");
        const data = await getLiveOddsComparison();
        res.json({
            success: true,
            count: data.length,
            data: data
        });
    } catch (error) {
        console.error("❌ Error en Monitor endpoint:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
