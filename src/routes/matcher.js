import express from 'express';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { pruneStaleEventCaches, writeDBWithRetry } from '../db/database.js';
import { registerDynamicAlias } from '../utils/teamMatcher.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DYNAMIC_ALIASES_PATH = path.resolve(__dirname, '../utils/dynamicAliases.json');

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const MAX_BULK_LINK_ITEMS = 200;
const BULK_LINK_MAX_RETRIES = Math.max(1, Number(process.env.MATCHER_BULK_LINK_MAX_RETRIES || 8));
const BULK_LINK_RETRY_BASE_DELAY_MS = Math.max(80, Number(process.env.MATCHER_BULK_LINK_RETRY_BASE_DELAY_MS || 180));

const loadDynamicAliases = async () => {
    try {
        const raw = await readFile(DYNAMIC_ALIASES_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
};

const buildTupleKey = (row = {}) => {
    const home = String(row?.home || '').trim().toLowerCase();
    const away = String(row?.away || '').trim().toLowerCase();
    const ts = new Date(row?.date || '').getTime();
    if (!home || !away || !Number.isFinite(ts)) return null;
    return `${home}__${away}__${ts}`;
};

const hasPersistedManualLink = ({ rows = [], pinnacleId, altenarId, targetKey }) => {
    const expectedAlt = String(altenarId ?? '').trim();
    if (!expectedAlt) return false;

    return rows.some(row => {
        const sameId = String(row?.id ?? '') === String(pinnacleId ?? '');
        const sameTuple = targetKey && buildTupleKey(row) === targetKey;
        if (!sameId && !sameTuple) return false;

        const rowAlt = String(row?.altenarId ?? '').trim();
        const manual = String(row?.linkSource || '').toLowerCase() === 'manual';
        return manual && rowAlt === expectedAlt;
    });
};

// GET /api/matcher/data
// Devuelve todos los partidos de Pinnacle y Altenar para el matcher manual
router.get('/data', async (req, res) => {
    try {
        await pruneStaleEventCaches({
            upcomingGraceMinutes: Number(process.env.DB_UPCOMING_RETENTION_MINUTES || 180),
            altenarGraceMinutes: Number(process.env.DB_ALTENAR_RETENTION_MINUTES || 180),
            persist: true
        });
        await db.read();
        const pinnacle = db.data.upcomingMatches || [];
        const altenar = db.data.altenarUpcoming || [];
        const aliases = await loadDynamicAliases();
        
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
                league: m.league || m.leagueName || m.championshipName, // [MOD] Updated to use new prop
                country: m.country // [NEW] Country prop (if available)
            })),
            aliases
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
        await pruneStaleEventCaches({
            upcomingGraceMinutes: Number(process.env.DB_UPCOMING_RETENTION_MINUTES || 180),
            altenarGraceMinutes: Number(process.env.DB_ALTENAR_RETENTION_MINUTES || 180),
            persist: true
        });
        await db.read();
        
        // Búsqueda robusta (String/Number agnostic)
        const match = db.data.upcomingMatches.find(m => m.id == pinnacleId); // Lazy compare
        
        // Altenar search: Asegurar que buscamos en el array correcto
        const altenarMatch = db.data.altenarUpcoming?.find(m => m.id == altenarId);
        
        if (!match) {
            console.error(`❌ Match no encontrado en DB con ID ${pinnacleId}`);
            return res.status(404).json({ error: "Pinnacle Match not found in DB" });
        }

        const targetKey = buildTupleKey(match);
        let appliedCount = 0;
        let persisted = false;

        // Reintento interno para mitigar carreras con scanner/ingestor.
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            await db.read();

            let attemptApplied = 0;
            const updatedAt = new Date().toISOString();
            for (const row of (db.data.upcomingMatches || [])) {
                const sameId = String(row?.id || '') === String(pinnacleId);
                const sameTuple = targetKey && buildTupleKey(row) === targetKey;
                if (!sameId && !sameTuple) continue;

                row.altenarId = altenarId;
                row.altenarName = altenarName;
                row.linkSource = 'manual';
                row.linkUpdatedAt = updatedAt;
                attemptApplied += 1;
            }

            appliedCount = Math.max(appliedCount, attemptApplied);
            await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 140 });

            await db.read();
            persisted = hasPersistedManualLink({
                rows: db.data.upcomingMatches || [],
                pinnacleId,
                altenarId,
                targetKey
            });

            if (persisted) break;
            await wait(220 * attempt);
        }
        
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

        if (!persisted) {
            return res.status(409).json({
                error: 'Link no persistido tras reintentos (condición de carrera con scanner/ingestor). Reintenta en 1-2s.',
                pinnacleId,
                altenarId,
                appliedCount
            });
        }
        console.log(`🔗 [Manual Linker] Linked Successfully: ${match.home} <-> ${altenarName}`);
        res.json({ success: true, match, learned: !!altenarMatch });
    } catch (e) {
        console.error("Link Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/matcher/link/bulk
// Enlace masivo para high-confidence (una sola escritura de DB, menor latencia).
router.post('/link/bulk', async (req, res) => {
    const rawLinks = Array.isArray(req.body?.links) ? req.body.links : [];
    const learnAliases = req.body?.learnAliases === true;
    const dryRun = req.body?.dryRun === true;

    if (!rawLinks.length) {
        return res.status(400).json({
            success: false,
            error: 'Body inválido: links[] es requerido.'
        });
    }

    const links = rawLinks
        .slice(0, MAX_BULK_LINK_ITEMS)
        .map(item => ({
            pinnacleId: item?.pinnacleId,
            altenarId: item?.altenarId,
            altenarName: item?.altenarName
        }))
        .filter(item => item.pinnacleId != null && item.altenarId != null && String(item.altenarName || '').trim() !== '');

    if (!links.length) {
        return res.status(400).json({
            success: false,
            error: 'No hay items válidos para enlazar en links[].'
        });
    }

    try {
        await pruneStaleEventCaches({
            upcomingGraceMinutes: Number(process.env.DB_UPCOMING_RETENTION_MINUTES || 180),
            altenarGraceMinutes: Number(process.env.DB_ALTENAR_RETENTION_MINUTES || 180),
            persist: true
        });
        await db.read();

        const results = [];
        const toVerify = [];
        const upcomingRows = db.data.upcomingMatches || [];
        const altenarRows = db.data.altenarUpcoming || [];

        if (dryRun) {
            for (const link of links) {
                const { pinnacleId, altenarId, altenarName } = link;
                const match = upcomingRows.find(m => m.id == pinnacleId);

                if (!match) {
                    results.push({
                        pinnacleId,
                        altenarId,
                        altenarName,
                        status: 'failed',
                        error: 'Pinnacle Match not found in DB'
                    });
                    continue;
                }

                const targetKey = buildTupleKey(match);
                let wouldApplyCount = 0;
                for (const row of upcomingRows) {
                    const sameId = String(row?.id || '') === String(pinnacleId);
                    const sameTuple = targetKey && buildTupleKey(row) === targetKey;
                    if (sameId || sameTuple) wouldApplyCount += 1;
                }

                if (wouldApplyCount <= 0) {
                    results.push({
                        pinnacleId,
                        altenarId,
                        altenarName,
                        status: 'failed',
                        error: 'No se encontraron filas para aplicar link.'
                    });
                    continue;
                }

                results.push({
                    pinnacleId,
                    altenarId,
                    altenarName,
                    status: 'would-apply',
                    appliedCount: wouldApplyCount
                });
            }

            const wouldApply = results.filter(r => r.status === 'would-apply').length;
            const failed = results.length - wouldApply;

            return res.json({
                success: true,
                dryRun: true,
                requested: rawLinks.length,
                processed: links.length,
                wouldApply,
                failed,
                results
            });
        }

        const keyFor = (item = {}) => `${String(item.pinnacleId)}::${String(item.altenarId)}`;
        const metaByKey = new Map();
        const failedByKey = new Map();
        const appliedByKey = new Map();

        for (const link of links) {
            const key = keyFor(link);
            metaByKey.set(key, {
                ...link,
                match: null,
                targetKey: null,
                altenarMatch: altenarRows.find(m => m.id == link.altenarId) || null,
                appliedCount: 0
            });
        }

        for (let attempt = 1; attempt <= BULK_LINK_MAX_RETRIES; attempt += 1) {
            const pendingKeys = [...metaByKey.keys()].filter(k => !appliedByKey.has(k) && !failedByKey.has(k));
            if (!pendingKeys.length) break;

            await db.read();
            const runRows = db.data.upcomingMatches || [];
            let attemptTouchedAny = false;

            for (const key of pendingKeys) {
                const meta = metaByKey.get(key);
                if (!meta) continue;

                const match = runRows.find(m => m.id == meta.pinnacleId);
                if (!match) {
                    if (attempt === BULK_LINK_MAX_RETRIES) {
                        failedByKey.set(key, {
                            pinnacleId: meta.pinnacleId,
                            altenarId: meta.altenarId,
                            altenarName: meta.altenarName,
                            status: 'failed',
                            error: 'Pinnacle Match not found in DB'
                        });
                    }
                    continue;
                }

                meta.match = match;
                meta.targetKey = buildTupleKey(match);
                const thisUpdatedAt = new Date().toISOString();
                let appliedThisPass = 0;

                for (const row of runRows) {
                    const sameId = String(row?.id || '') === String(meta.pinnacleId);
                    const sameTuple = meta.targetKey && buildTupleKey(row) === meta.targetKey;
                    if (!sameId && !sameTuple) continue;

                    row.altenarId = meta.altenarId;
                    row.altenarName = meta.altenarName;
                    row.linkSource = 'manual';
                    row.linkUpdatedAt = thisUpdatedAt;
                    appliedThisPass += 1;
                }

                if (appliedThisPass <= 0) {
                    if (attempt === BULK_LINK_MAX_RETRIES) {
                        failedByKey.set(key, {
                            pinnacleId: meta.pinnacleId,
                            altenarId: meta.altenarId,
                            altenarName: meta.altenarName,
                            status: 'failed',
                            error: 'No se encontraron filas para aplicar link.'
                        });
                    }
                    continue;
                }

                meta.appliedCount += appliedThisPass;
                attemptTouchedAny = true;
                toVerify.push(key);
            }

            if (!attemptTouchedAny) {
                if (attempt < BULK_LINK_MAX_RETRIES) {
                    await wait(BULK_LINK_RETRY_BASE_DELAY_MS * attempt);
                }
                continue;
            }

            await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 140 });
            await db.read();

            const verifyRows = db.data.upcomingMatches || [];
            const verifyKeys = [...new Set(toVerify.splice(0, toVerify.length))];

            for (const key of verifyKeys) {
                if (appliedByKey.has(key) || failedByKey.has(key)) continue;
                const meta = metaByKey.get(key);
                if (!meta) continue;

                const persisted = hasPersistedManualLink({
                    rows: verifyRows,
                    pinnacleId: meta.pinnacleId,
                    altenarId: meta.altenarId,
                    targetKey: meta.targetKey
                });

                if (!persisted) {
                    if (attempt === BULK_LINK_MAX_RETRIES) {
                        failedByKey.set(key, {
                            pinnacleId: meta.pinnacleId,
                            altenarId: meta.altenarId,
                            altenarName: meta.altenarName,
                            status: 'failed',
                            error: 'Link no persistido tras reintentos (race condition con scanner/ingestor).',
                            appliedCount: meta.appliedCount
                        });
                    }
                    continue;
                }

                let learned = false;
                if (learnAliases && meta.match && meta.altenarMatch) {
                    const pHome = meta.match.home;
                    const pAway = meta.match.away;
                    const aHome = meta.altenarMatch.home || (meta.altenarMatch.name ? meta.altenarMatch.name.split(/ vs\.? /i)[0] : '');
                    const aAway = meta.altenarMatch.away || (meta.altenarMatch.name ? meta.altenarMatch.name.split(/ vs\.? /i)[1] : '');

                    const learnedHome = pHome && aHome ? registerDynamicAlias(pHome, aHome) : false;
                    const learnedAway = pAway && aAway ? registerDynamicAlias(pAway, aAway) : false;
                    learned = Boolean(learnedHome || learnedAway);
                }

                appliedByKey.set(key, {
                    pinnacleId: meta.pinnacleId,
                    altenarId: meta.altenarId,
                    altenarName: meta.altenarName,
                    status: 'applied',
                    learned,
                    appliedCount: meta.appliedCount
                });
            }

            if (attempt < BULK_LINK_MAX_RETRIES) {
                const remaining = [...metaByKey.keys()].filter(k => !appliedByKey.has(k) && !failedByKey.has(k)).length;
                if (remaining > 0) {
                    await wait(BULK_LINK_RETRY_BASE_DELAY_MS * attempt);
                }
            }
        }

        for (const [key, meta] of metaByKey.entries()) {
            if (appliedByKey.has(key) || failedByKey.has(key)) continue;
            failedByKey.set(key, {
                pinnacleId: meta.pinnacleId,
                altenarId: meta.altenarId,
                altenarName: meta.altenarName,
                status: 'failed',
                error: 'Link no persistido tras reintentos (race condition con scanner/ingestor).',
                appliedCount: meta.appliedCount
            });
        }

        results.push(...appliedByKey.values(), ...failedByKey.values());

        const applied = results.filter(r => r.status === 'applied').length;
        const failed = results.length - applied;

        res.json({
            success: true,
            dryRun: false,
            requested: rawLinks.length,
            processed: links.length,
            applied,
            failed,
            results
        });
    } catch (e) {
        console.error('Bulk Link Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/matcher/unlink
// Rompe un enlace
router.post('/unlink', async (req, res) => {
    const { pinnacleId } = req.body;
    
    try {
        await db.read();
        const match = db.data.upcomingMatches.find(m => m.id == pinnacleId);
        
        if (match) {
            console.log(`✂️ [Manual Linker] Unlinked: ${match.home} (was ${match.altenarId})`);
            match.altenarId = null;
            match.altenarName = null;
            match.linkSource = null;
            match.linkUpdatedAt = new Date().toISOString();
            await writeDBWithRetry({ maxAttempts: 10, baseDelayMs: 140 });
            res.json({ success: true, match });
        } else {
            res.status(404).json({ error: "Match not found" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

export default router;