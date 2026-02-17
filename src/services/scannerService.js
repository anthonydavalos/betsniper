import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
// [MOD] Importamos AMBAS estrategias
import { scanLiveOpportunities as performValueScan, getLiveOverview } from './liveValueScanner.js';
import { scanLiveOpportunities as performTurnaroundScan } from './liveScannerService.js'; 
import { scanPrematchOpportunities } from './prematchScannerService.js';
import { placeAutoBet, updateActiveBetsWithLiveData } from './paperTradingService.js';

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER" (Background Worker)
// Estrategia: "La Volteada" (Favorito Pre-match perdiendo por 1 gol)
// + PAPER TRADING: Monitoreo de apuestas activas
// =====================================================================

// MEMORY CACHE
let cachedOpportunities = [];
let cachedPrematchIds = new Set(); // IDs de eventos ya detectados en Pre-Match

// Helper: Generar ID único por oportunidad (eventId + selection)
// Debe coincidir con la función del frontend
function getOpportunityId(op) {
  const eventId = String(op.eventId || op.id);
  const selection = op.selection || op.action || op.market || '';
  return `${eventId}_${selection.replace(/\s+/g, '_')}`;
}

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
        try {
            await initDB(); // Refrescar DB en cada ciclo
            ticks++;
            
            // ---------------------------------------------------------
            // 1. ESCANEAR PRE-MATCH (Al inicio y cada 4 ciclos ~2 min)
            // (PRIORIDAD ALTA: Para poblar Cache de "Ignorados en Live")
            // ---------------------------------------------------------
            if (ticks === 1 || ticks % 4 === 0) {
                 // console.log("   🔎 Ejecutando escaneo Pre-Match...");
                 const prematchOps = await scanPrematchOpportunities();
                 
                 // Actulizar Cache de IDs ignorados
                 if (prematchOps) {
                     prematchOps.forEach(op => {
                         if (op.eventId) cachedPrematchIds.add(String(op.eventId));
                         if (op.altenarId) cachedPrematchIds.add(String(op.altenarId));
                     });
                 }

                 if (prematchOps && prematchOps.length > 0) {
                    console.log(`   🔎 Detectadas ${prematchOps.length} Oportunidades Pre-Match (Disponibles en UI).`);
                    // [MOD] Auto-Bet DESHABILITADO para Pre-Match. El usuario debe decidir.
                    /* 
                    for (const op of prematchOps) {
                        await placeAutoBet(op);
                    }
                    */
                 }
            }

            // ---------------------------------------------------------
            // 2. ESCANEAR LIVE (Cada ciclo ~30s)
            // ---------------------------------------------------------
            
            // A) Obtener RAW Events (Solo 1 llamada HTTP)
            const rawEvents = await getLiveOverview();

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
            
            // FILTRADO ROBUSTO:
            // 1. Remover eventos que ya eran Oportunidades Pre-Match (Memoria sesión actual)
            // 2. Remover selecciones específicas que ya tienen apuestas activas (Persistencia DB)
            if (ops && ops.length > 0) {
                const initialCount = ops.length;
                
                // [FIX] IDs de apuestas activas (usar ID único: eventId + selection)
                const activeBetIds = new Set(
                    (db.data.portfolio.activeBets || []).map(b => {
                        const eventId = String(b.eventId);
                        const selection = b.selection || b.pick || '';
                        return `${eventId}_${selection.replace(/\s+/g, '_')}`;
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
            console.error('⚠️ Background Scan Error:', e.message);
            // [FIX] Si hay error, limpiar caché para no mostrar partidos congelados "zombis" (Arkadag Min 19)
            if (cachedOpportunities.length > 0) {
                 console.log("   🧹 Datos de caché obsoletos/congelados. Limpiando para evitar errores visuales.");
                 cachedOpportunities = [];
            }
        } finally {
            // POLÍTICA DE POLLING OFICIAL (Basada en app.json)
            // Regla: "events.matchups" (5000ms) * "guest_multiplier" (3) = 15,000ms Mínimo Requerido
            // [MOD] MODO BALANCEADO (Fast but Safer)
            // 3.5 segundos + Jitter. Total ~4-5s entre ciclos.
            const MIN_POLL_INTERVAL = 3500; 
            const RANDOM_JITTER = 1500;
            
            const delay = MIN_POLL_INTERVAL + Math.floor(Math.random() * RANDOM_JITTER);
            // Resultante: 30s - 35s entre ciclos
            
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

