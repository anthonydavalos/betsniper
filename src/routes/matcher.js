import express from 'express';
import db from '../db/database.js';
import { registerDynamicAlias } from '../utils/teamMatcher.js';

const router = express.Router();

// GET /api/matcher/data
// Devuelve todos los partidos de Pinnacle y Altenar para el matcher manual
router.get('/data', async (req, res) => {
    try {
        await db.read();
        const pinnacle = db.data.upcomingMatches || [];
        const altenar = db.data.altenarUpcoming || [];
        
        // Enviamos todo para que el cliente filtre
        res.json({ 
            pinnacle: pinnacle.map(m => ({
                id: m.id,
                home: m.home,
                away: m.away,
                date: m.date,
                league: m.league?.name,
                altenarId: m.altenarId,
                altenarName: m.altenarName
            })),
            altenar: altenar.map(m => ({
                id: m.id,
                name: m.name || `${m.home} - ${m.away}`,
                home: m.home,
                away: m.away,
                date: m.date || m.startDate,
                league: m.leagueName || m.championshipName
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/matcher/link
// Enlaza manualmente un partido
router.post('/link', async (req, res) => {
    const { pinnacleId, altenarId, altenarName } = req.body;
    
    console.log(`📥 [API] Link Request received: Pin=${pinnacleId} (${typeof pinnacleId}), Alt=${altenarId} (${typeof altenarId})`);

    try {
        await db.read();
        
        // Búsqueda robusta (String/Number agnostic)
        const match = db.data.upcomingMatches.find(m => m.id == pinnacleId); // Lazy compare
        
        // Altenar search: Asegurar que buscamos en el array correcto
        const altenarMatch = db.data.altenarUpcoming?.find(m => m.id == altenarId);
        
        if (!match) {
            console.error(`❌ Match no encontrado en DB con ID ${pinnacleId}`);
            return res.status(404).json({ error: "Pinnacle Match not found in DB" });
        }

        match.altenarId = altenarId;
        match.altenarName = altenarName;
        
        // APRENDIZAJE: Guardar nuevos alias encontrados
        if (altenarMatch) {
            console.log(`🎓 [Learning] Comparing names: "${match.home}" vs "${altenarMatch.home}"`);
            
            const pHome = match.home;
            const aHome = altenarMatch.home || (altenarMatch.name ? altenarMatch.name.split(/ vs\.? /i)[0] : '');
            
            const pAway = match.away;
            const aAway = altenarMatch.away || (altenarMatch.name ? altenarMatch.name.split(/ vs\.? /i)[1] : '');

            // Intentar registrar Home y Away
            if (pHome && aHome) registerDynamicAlias(pHome, aHome);
            if (pAway && aAway) registerDynamicAlias(pAway, aAway);
        } else {
            console.warn(`⚠️ [Learning] Altenar match object not found for ID ${altenarId}. Cannot learn aliases.`);
        }

        await db.write();
        console.log(`🔗 [Manual Linker] Linked Successfully: ${match.home} <-> ${altenarName}`);
        res.json({ success: true, match, learned: !!altenarMatch });
    } catch (e) {
        console.error("Link Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/matcher/unlink
// Rompe un enlace
router.post('/unlink', async (req, res) => {
    const { pinnacleId } = req.body;
    
    try {
        await db.read();
        const match = db.data.upcomingMatches.find(m => m.id === pinnacleId);
        
        if (match) {
            console.log(`✂️ [Manual Linker] Unlinked: ${match.home} (was ${match.altenarId})`);
            match.altenarId = null;
            match.altenarName = null;
            await db.write();
            res.json({ success: true, match });
        } else {
            res.status(404).json({ error: "Match not found" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;