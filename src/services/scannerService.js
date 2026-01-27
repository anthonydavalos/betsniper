import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { scanLiveOpportunities as performLiveScan, getLiveOverview } from './liveValueScanner.js';
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
                    // console.log(`   🔎 Detectadas ${prematchOps.length} Oportunidades Pre-Match para Auto-Bet.`);
                    for (const op of prematchOps) {
                        await placeAutoBet(op);
                    }
                 }
            }

            // ---------------------------------------------------------
            // 2. ESCANEAR LIVE (Cada ciclo ~30s)
            // ---------------------------------------------------------
            
            // A) Obtener RAW Events (Solo 1 llamada HTTP)
            const rawEvents = await getLiveOverview();

            // B) Pasar a lógica de detección (Inyectamos eventos para ahorrar calls)
            let ops = await performLiveScan(rawEvents); 
            
            // FILTRADO ROBUSTO:
            // 1. Remover eventos que ya eran Oportunidades Pre-Match (Memoria sesión actual)
            // 2. Remover eventos que YA TIENEN APUESTAS ACTIVAS (Persistencia DB)
            if (ops && ops.length > 0) {
                const initialCount = ops.length;
                
                // IDs de apuestas activas
                const activeBetIds = new Set((db.data.portfolio.activeBets || []).map(b => String(b.eventId)));

                ops = ops.filter(op => {
                    const idStr = String(op.id || op.eventId);
                    // Solo filtramos si YA EXISTE una apuesta activa.
                    // (Permitimos que un evento Pre-Match "fallido" sea re-capturado en Live)
                    return !activeBetIds.has(idStr);
                });

                if (ops.length < initialCount) {
                    console.log(`   🧹 Ocultando ${initialCount - ops.length} oportunidades LIVE (Repetidas o Ya Apostadas).`);
                }
            }

            // C) AUTO-TRADING LIVE (Detectar entrada)
            if (ops && ops.length > 0) {
                 console.log(`   🎯 Oportunidades LIVE encontradas: ${ops.length}`);
                for (const op of ops) {
                    await placeAutoBet(op);
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
                await updateActiveBetsWithLiveData(rawEvents);
            }

            cachedOpportunities = ops;
            lastScanTime = new Date();

        } catch (e) {
            console.error('⚠️ Background Scan Error:', e.message);
        } finally {
            // POLÍTICA DE POLLING OFICIAL (Basada en app.json)
            // Regla: "events.matchups" (5000ms) * "guest_multiplier" (3) = 15,000ms Mínimo Requerido
            // Si bajamos de 15s, activamos el "botManagement" y nos mandan a la cola de delay.
            const MIN_POLL_INTERVAL = 15000; 
            const RANDOM_JITTER = 4000; // +0-4s de variabilidad humana
            
            const delay = MIN_POLL_INTERVAL + Math.floor(Math.random() * RANDOM_JITTER);
            // Resultante: 15s - 19s entre ciclos
            
            setTimeout(loop, delay);
        }
    };

    loop();
    console.log('🔄 Background Scanner Iniciado (Modo Seguro Anti-Ban) + AUTO-TRADING ACTIVO');
};

export const getCachedLiveOpportunities = () => {
    return {
        timestamp: lastScanTime,
        data: cachedOpportunities
    };
};

/**
 * LÓGICA CORE: The Sniper
 * (Wrapper para compatibilidad, redirige al servicio especializado)
 */
export const scanLiveOpportunities = async () => {
    return await performLiveScan();
};

