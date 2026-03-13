import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
// [MOD] Importamos AMBAS estrategias
import { scanLiveOpportunities as performValueScan, getLiveOverview } from './liveValueScanner.js';
import { scanLiveOpportunities as performTurnaroundScan } from './liveScannerService.js'; 
import { placeAutoBet, updateActiveBetsWithLiveData } from './paperTradingService.js';

const parseBooleanFromEnv = (rawValue, fallback = false) => {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return fallback;
    }
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
};

const parsePositiveIntOr = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const intN = Math.floor(n);
    return intN > 0 ? intN : fallback;
};

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER" (Background Worker)
// Estrategia: "La Volteada" (Favorito Pre-match perdiendo por 1 gol)
// + PAPER TRADING: Monitoreo de apuestas activas
// =====================================================================

// MEMORY CACHE
let cachedOpportunities = [];
let cachedPrematchIds = new Set(); // IDs de eventos ya detectados en Pre-Match
const liveQuoteStability = new Map();
const QUOTE_STABILITY_WINDOW_MS = 20000;
const LIVE_GLOBAL_STABILITY_ENABLED = parseBooleanFromEnv(process.env.LIVE_GLOBAL_STABILITY_ENABLED, true);
const QUOTE_STABILITY_MIN_HITS = parsePositiveIntOr(process.env.LIVE_GLOBAL_STABILITY_MIN_HITS, 2);

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

const buildOpportunityCoreKey = (op = {}) => {
    const eventId = String(op.eventId || op.id || 'na');
    const market = String(op.market || '').toLowerCase();
    const selection = String(op.selection || '').toLowerCase();
    const pick = String(op.pick || normalizePick(op) || '').toLowerCase();
    return `${eventId}|${market}|${selection}|${pick}`;
};

const roundOdd = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'na';
    return n.toFixed(2);
};

const buildOpportunitySignature = (op = {}) => {
    const altenarPrice = roundOdd(op.price ?? op.odd);
    const pinnaclePrice = roundOdd(op.pinnaclePrice);
    const score = String(op.score || 'na');
    return `${altenarPrice}|${pinnaclePrice}|${score}`;
};

const pruneQuoteStabilityCache = () => {
    const now = Date.now();
    for (const [key, state] of liveQuoteStability.entries()) {
        if ((now - state.lastSeenAt) > QUOTE_STABILITY_WINDOW_MS * 2) {
            liveQuoteStability.delete(key);
        }
    }
};

const filterStableLiveQuotes = (ops = []) => {
    if (!LIVE_GLOBAL_STABILITY_ENABLED) return ops;

    const now = Date.now();
    const stable = [];

    for (const op of ops) {
        const coreKey = buildOpportunityCoreKey(op);
        const signature = buildOpportunitySignature(op);
        const prev = liveQuoteStability.get(coreKey);

        if (!prev || (now - prev.lastSeenAt) > QUOTE_STABILITY_WINDOW_MS || prev.signature !== signature) {
            liveQuoteStability.set(coreKey, {
                signature,
                hits: 1,
                firstSeenAt: now,
                lastSeenAt: now
            });

            // Si el umbral es 1, no debe requerir una segunda confirmacion.
            if (QUOTE_STABILITY_MIN_HITS <= 1) {
                stable.push(op);
            }
            continue;
        }

        const next = {
            signature,
            hits: prev.hits + 1,
            firstSeenAt: prev.firstSeenAt,
            lastSeenAt: now
        };
        liveQuoteStability.set(coreKey, next);

        if (next.hits >= QUOTE_STABILITY_MIN_HITS) {
            stable.push(op);
        }
    }

    return stable;
};

export const discardOpportunity = async (opportunityId) => {
    await initDB();
    if (!db.data.blacklist) db.data.blacklist = [];
    const idStr = String(opportunityId);
    
    if (!db.data.blacklist.includes(idStr)) {
        db.data.blacklist.push(idStr);
        await db.write();
        console.log(`🗑️ Oportunidad DESCARTADA y añadida a Blacklist (Persistente): ${opportunityId}`);
    }
    return true;
};

// Getter para uso en rutas
export const getDiscardedIds = () => {
    if (!db.data || !db.data.blacklist) return [];
    return db.data.blacklist;
};

let lastScanTime = null;
let isScanning = false;
let ticks = 0; // Contador de ciclos

/**
 * INICIAR LOOP DE FONDO (BACKGROUND WORKER)
 */
export const startBackgroundScanner = () => {
    if (isScanning) return;
    isScanning = true;
    
    const loop = async () => {
        let pollMode = 'idle';
        try {
            await initDB(); // Refrescar DB en cada ciclo
            ticks++;
            pruneQuoteStabilityCache();
            
            // ---------------------------------------------------------
            // 1. REFRESCO LIVIANO PRE-MATCH (sin scan pesado)
            // ---------------------------------------------------------
            // En picos de sábados, scanPrematchOpportunities() puede bloquear el event loop.
            // Aquí solo refrescamos IDs desde DB para evitar duplicados Live vs Prematch.
            if (ticks === 1 || ticks % 30 === 0) {
                 const nextPrematchIds = new Set();
                 const dbUpcoming = Array.isArray(db.data?.upcomingMatches) ? db.data.upcomingMatches : [];
                 for (const row of dbUpcoming) {
                     if (row?.id != null) nextPrematchIds.add(String(row.id));
                     if (row?.altenarId != null) nextPrematchIds.add(String(row.altenarId));
                 }
                 cachedPrematchIds = nextPrematchIds;
                 if (ticks % 60 === 0) {
                     console.log(`   🧠 Prematch IDs cache refrescado: ${cachedPrematchIds.size}`);
                 }
            }

            // ---------------------------------------------------------
            // 2. ESCANEAR LIVE (Cada ciclo ~30s)
            // ---------------------------------------------------------
            
            // A) Obtener RAW Events (Solo 1 llamada HTTP)
            const rawEvents = await getLiveOverview();
            const liveEventCount = Array.isArray(rawEvents) ? rawEvents.length : 0;

            // Contar apuestas activas que siguen en juego para mantener modo rápido
            const activeLiveBets = (db.data.portfolio?.activeBets || []).filter(b => {
                const isLiveOrigin = b.type === 'LIVE_SNIPE' || b.type === 'LIVE_VALUE' || b.type === 'LA_VOLTEADA' || b.isLive;
                const hasLiveClock = b.liveTime && b.liveTime !== 'Final' && b.liveTime !== 'FT';
                return isLiveOrigin || hasLiveClock;
            }).length;

            // B) Pasar a lógica de detección (Inyectamos eventos para ahorrar calls)
            // STRATEGY 1: VALUE BETS (Arbitraje Live)
            let opsValue = [];
            try {
                 opsValue = await performValueScan(rawEvents);
            } catch (e) {
                 console.error("⚠️ Error en Value Scan:", e.message);
            }
            
            // STRATEGY 2: TURNAROUNDS ("La Volteada")
            let opsTurnaround = [];
            try {
                 opsTurnaround = await performTurnaroundScan(rawEvents); // Inyectamos eventos
            } catch (e) {
                 console.error("⚠️ Error en Turnaround Scan:", e.message);
            }

            // Combinar Oportunidades
            let rawOps = [...(opsValue || []), ...(opsTurnaround || [])];
            
            // [MOD] Deduplicación estricta para evitar filas repetidas en UI
            // Filtramos por key única compuesta: EventID + Market + Selection + Line
            // Preferimos la estrategia "Value" si colisiona con "Turnaround"
            const uniqueMap = new Map();
            rawOps.forEach(op => {
                const key = `${op.eventId}_${op.market}_${op.selection}_${op.line||''}`;
                if (!uniqueMap.has(key)) {
                    uniqueMap.set(key, op);
                } else {
                    // Si ya existe, nos quedamos con la que tenga mejor EV (o la más reciente)
                    const existing = uniqueMap.get(key);
                    if ((op.ev || 0) > (existing.ev || 0)) {
                        uniqueMap.set(key, op);
                    }
                }
            });
            let ops = Array.from(uniqueMap.values());
            const dedupCount = ops.length;

            // [ANTI-VOLATILIDAD] Requiere 2 confirmaciones con la misma firma de cuota
            // antes de exponer oportunidad en UI (aplica a VALUE + TURNAROUND).
            const preStableCount = ops.length;
            ops = filterStableLiveQuotes(ops);
            const stableCount = ops.length;
            if (preStableCount > 0 && ops.length < preStableCount && ticks % 3 === 0) {
                console.log(`   🧱 Filtro de estabilidad: ${preStableCount - ops.length} oportunidades en enfriamiento.`);
            }
            
            // FILTRADO ROBUSTO:
            // 1. Remover eventos que ya eran Oportunidades Pre-Match (Memoria sesión actual)
            // 2. Remover selecciones específicas que ya tienen apuestas activas (Persistencia DB)
            if (ops && ops.length > 0) {
                const initialCount = ops.length;
                
                // [FIX] IDs de apuestas activas (usar ID único: eventId + selection)
                const activeBetIds = new Set(
                    (db.data.portfolio.activeBets || []).map(b => {
                        const eventId = String(b.eventId);
                        return `${eventId}_${normalizePick(b)}`;
                    })
                );
                const hiddenIds = new Set(db.data.blacklist || []);

                ops = ops.filter(op => {
                    const opId = getOpportunityId(op); // ID único para ambos checks
                    
                    // 1. Filtrar si ya se apostó ESTA SELECCIÓN ESPECÍFICA
                    if (activeBetIds.has(opId)) return false;
                    // 2. Filtrar si se descartó esta selección específica
                    if (hiddenIds.has(opId)) return false;
                    
                    return true;
                });

                if (ops.length < initialCount) {
                    console.log(`   🧹 Ocultando ${initialCount - ops.length} oportunidades LIVE (Repetidas o Ya Apostadas).`);
                }

                if ((rawOps.length > 0 || dedupCount > 0) && ticks % 2 === 0) {
                    console.log(`   📊 Pipeline LIVE: raw=${rawOps.length} dedup=${dedupCount} stable=${stableCount} final=${ops.length}`);
                }
            }

            // C) AUTO-TRADING LIVE (Detectar entrada)
            if (ops && ops.length > 0) {
                 console.log(`   🎯 Oportunidades LIVE encontradas: ${ops.length}`);
                for (const op of ops) {
                    // [MOD] MODO SEMI-AUTOMÁTICO
                    // Deshabilitamos el auto-bet para que el usuario confirme manualmente (botón APOSTAR)
                    // await placeAutoBet(op);
                    console.log(`      👀 Oportunidad detectada (Esperando confirmación manual): ${op.match}`);
                }
            } else {
                 if(ticks % 2 === 0) console.log(`   ... Escaneo Live completado. Sin oportunidades (nuevas).`);
            }

              // [AUTO-ADAPTIVO] Mantener modo agresivo solo si hay actividad real
              // Actividad = eventos live en feed o apuestas activas live u oportunidades detectadas
              pollMode = (liveEventCount > 0 || activeLiveBets > 0 || (ops && ops.length > 0)) ? 'live-hot' : 'idle';

            // (Pre-match block moved up)

            // ---------------------------------------------------------
            // 3. MONITORING (Actualizar salidas)
            // ---------------------------------------------------------
            // Usamos los rawEvents para el tracking.
            // IMPORTANTE: Ejecutar siempre, incluso si rawEvents está vacío, para detectar partidos finalizados (Zombies)
            if (rawEvents) {
                // [MOD] Obtener Pinnacle Feed para sincronizar activeBets también
                let pinFeed = [];
                try {
                     const { getAllPinnacleLiveOdds } = await import('./pinnacleService.js');
                     const map = await getAllPinnacleLiveOdds(); // Reusa cache de la llamada previa en scanner si la hubo
                     if (map) pinFeed = Array.from(map.values());
                } catch(e) {}
                
                await updateActiveBetsWithLiveData(rawEvents, pinFeed);
            }

            cachedOpportunities = ops;
            lastScanTime = new Date();

        } catch (e) {
            pollMode = 'error';
            console.error('⚠️ Background Scan Error:', e.message);
            // [FIX] Si hay error, limpiar caché para no mostrar partidos congelados "zombis" (Arkadag Min 19)
            if (cachedOpportunities.length > 0) {
                 console.log("   🧹 Datos de caché obsoletos/congelados. Limpiando para evitar errores visuales.");
                 cachedOpportunities = [];
            }
        } finally {
            // POLLING AUTO-ADAPTATIVO
            // - live-hot: máxima frescura para EN VIVO
            // - idle: baja frecuencia cuando no hay actividad live
            // - error: backoff para reducir presión ante fallos
            let MIN_POLL_INTERVAL = 4500;
            let RANDOM_JITTER = 1500;

            if (pollMode === 'live-hot') {
                MIN_POLL_INTERVAL = 2000;
                RANDOM_JITTER = 600;
            } else if (pollMode === 'error') {
                MIN_POLL_INTERVAL = 7000;
                RANDOM_JITTER = 2000;
            }
            
            const delay = MIN_POLL_INTERVAL + Math.floor(Math.random() * RANDOM_JITTER);

            if (ticks % 10 === 0) {
                console.log(`   ⏱️ Poll Mode: ${pollMode} (${MIN_POLL_INTERVAL}-${MIN_POLL_INTERVAL + RANDOM_JITTER}ms)`);
            }
            
            setTimeout(loop, delay);
        }
    };

    loop();
    console.log('🔄 Background Scanner Iniciado (Modo Seguro Anti-Ban) + AUTO-TRADING ACTIVO');
};

export const getCachedLiveOpportunities = () => {
    // [FIX] Filtrar al momento de servir también, por si el caché tiene datos viejos o hubo una desconexión
    const hiddenMap = new Set(db.data.blacklist || []);
    const filtered = (cachedOpportunities || []).filter(op => {
        const opId = getOpportunityId(op); // ID único por selección
        return !hiddenMap.has(opId);
    });
    
    return {
        timestamp: lastScanTime,
        data: filtered
    };
};

/**
 * LÓGICA CORE: The Sniper
 * (Wrapper para compatibilidad, redirige al servicio especializado)
 */
export const scanLiveOpportunities = async () => {
    return await performLiveScan();
};

