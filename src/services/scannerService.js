import altenarClient from '../config/axiosClient.js';
import db, { initDB } from '../db/database.js';
import { scanLiveOpportunities as performLiveScan } from './liveScannerService.js';
import { scanPrematchOpportunities } from './prematchScannerService.js';
import { placeAutoBet, updateActiveBetsWithLiveData } from './paperTradingService.js';

// =====================================================================
// SERVICE: LIVE SCANNER "THE SNIPER" (Background Worker)
// Estrategia: "La Volteada" (Favorito Pre-match perdiendo por 1 gol)
// + PAPER TRADING: Monitoreo de apuestas activas
// =====================================================================

// MEMORY CACHE
let cachedOpportunities = [];
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
            // 1. ESCANEAR LIVE (Cada ciclo ~30s)
            // ---------------------------------------------------------
            
            // IMPORTANDO de liveScannerService
            const { getLiveOverview, scanLiveOpportunities } = await import('./liveScannerService.js');
            
            // A) Obtener RAW Events (Solo 1 llamada HTTP)
            const rawEvents = await getLiveOverview();

            // B) Pasar a lógica de detección
            const ops = await scanLiveOpportunities(); 
            
            // C) AUTO-TRADING LIVE (Detectar entrada)
            if (ops && ops.length > 0) {
                for (const op of ops) {
                    await placeAutoBet(op);
                }
            }

            // ---------------------------------------------------------
            // 2. ESCANEAR PRE-MATCH (Al inicio y cada 4 ciclos ~2 min)
            // ---------------------------------------------------------
            if (ticks === 1 || ticks % 4 === 0) {
                 // console.log("   🔎 Ejecutando escaneo Pre-Match...");
                 const prematchOps = await scanPrematchOpportunities();
                 if (prematchOps && prematchOps.length > 0) {
                    // console.log(`   🔎 Detectadas ${prematchOps.length} Oportunidades Pre-Match para Auto-Bet.`);
                    for (const op of prematchOps) {
                        await placeAutoBet(op);
                    }
                 }
            }

            // ---------------------------------------------------------
            // 3. MONITORING (Actualizar salidas)
            // ---------------------------------------------------------
            // Usamos los rawEvents para el tracking.
            if (rawEvents && rawEvents.length > 0) {
                await updateActiveBetsWithLiveData(rawEvents);
            }

            cachedOpportunities = ops;
            lastScanTime = new Date();

        } catch (e) {
            console.error('⚠️ Background Scan Error:', e.message);
        } finally {
            // Jitter para evitar ban (15s - 30s)
            const delay = Math.floor(Math.random() * (15000)) + 15000; 
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

