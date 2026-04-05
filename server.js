import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDB, pruneStaleEventCaches } from './src/db/database.js';

// Cargar variables de entorno
dotenv.config({ override: true });

// Inicializar App Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Inicializar Base de Datos
await initDB();

// INICIALIZAR BACKGROUND WORKER (SCANNER)
// Esto arranca el bucle infinito que consulta a Altenar cada ~30s
import { startBackgroundScanner } from './src/services/scannerService.js';
import { stopAcityLiveSocketService } from './src/services/acityLiveSocketService.js';
import { ingestPinnaclePrematch } from './scripts/ingest-pinnacle.js'; // Importar Función Directa
import { startAltenarPrematchAdaptiveScheduler } from './src/services/altenarPrematchScheduler.js';
import { startPinnaclePrematchWsService, stopPinnaclePrematchWsService } from './src/services/pinnaclePrematchWsService.js';
import { runArbitrageDiagnosticsInventory } from './src/services/arbitrageService.js';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';

const backgroundWorkersEnabled = process.env.DISABLE_BACKGROUND_WORKERS !== 'true';
const liveScannerEnabled = process.env.DISABLE_LIVE_SCANNER !== 'true';
const prematchSchedulerEnabled = process.env.DISABLE_PREMATCH_SCHEDULER !== 'true';
const pinnacleIngestCronEnabled = process.env.DISABLE_PINNACLE_INGEST_CRON !== 'true';
const pinnacleIngestCronIntervalMs = (() => {
  const parsed = Number(process.env.PINNACLE_INGEST_CRON_INTERVAL_MS);
  if (Number.isFinite(parsed) && parsed >= 60000) return parsed;
  return 2 * 60 * 60 * 1000;
})();
const pinnaclePrematchWsEnabled = process.env.DISABLE_PINNACLE_PREMATCH_WS !== 'true';
const arbitrageDiagnosticsInventoryEnabled = process.env.ARBITRAGE_DIAGNOSTICS_INVENTORY_ENABLED !== 'false';
const arbitrageDiagnosticsInventoryIntervalMs = Math.max(
  15000,
  Number(process.env.ARBITRAGE_DIAGNOSTICS_INVENTORY_INTERVAL_MS || 60000)
);
const monitorDashboardEnabled = process.env.DISABLE_MONITOR_DASHBOARD !== 'true';
const pinnacleGatewayAutostart = process.env.PINNACLE_GATEWAY_AUTOSTART === 'true';
const PINNACLE_TRIGGER_FILE = path.resolve('data', 'pinnacle_stale.trigger');
const PINNACLE_GATEWAY_AUTOSTART_MIN_INTERVAL_MS = Math.max(60000, Number(process.env.PINNACLE_GATEWAY_AUTOSTART_MIN_INTERVAL_MS || 3600000));
const PINNACLE_GATEWAY_TRIGGER_CHECK_INTERVAL_MS = Math.max(1000, Number(process.env.PINNACLE_GATEWAY_TRIGGER_CHECK_INTERVAL_MS || 5000));

let pinnacleGatewayProcess = null;
let lastPinnacleGatewayLaunchAt = 0;

const isGatewayAlive = () => Boolean(pinnacleGatewayProcess && !pinnacleGatewayProcess.killed && pinnacleGatewayProcess.exitCode == null);

const ensurePinnacleGatewayRunning = (reason = 'autostart') => {
  if (isGatewayAlive()) return;

  const nowMs = Date.now();
  const elapsed = nowMs - lastPinnacleGatewayLaunchAt;
  const bypassCooldown = reason === 'startup';
  if (!bypassCooldown && lastPinnacleGatewayLaunchAt > 0 && elapsed < PINNACLE_GATEWAY_AUTOSTART_MIN_INTERVAL_MS) {
    const waitSec = Math.ceil((PINNACLE_GATEWAY_AUTOSTART_MIN_INTERVAL_MS - elapsed) / 1000);
    console.log(`⏱️ Autostart PinnacleGateway suprimido por cooldown (${waitSec}s restantes).`);
    return;
  }

  const gatewayPath = path.resolve('services', 'pinnacleGateway.js');
  try {
    lastPinnacleGatewayLaunchAt = nowMs;
    pinnacleGatewayProcess = spawn(process.execPath, [gatewayPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: false
    });

    console.log(`🛰️ PinnacleGateway lanzado (${reason}) PID=${pinnacleGatewayProcess.pid || 'n/a'}`);

    pinnacleGatewayProcess.on('exit', (code, signal) => {
      console.warn(`⚠️ PinnacleGateway finalizó (code=${code ?? 'null'}, signal=${signal || 'none'}).`);
      pinnacleGatewayProcess = null;
    });
  } catch (error) {
    console.error(`❌ No se pudo iniciar PinnacleGateway (${reason}): ${error.message}`);
  }
};

if (backgroundWorkersEnabled) {
  if (liveScannerEnabled) {
    startBackgroundScanner();
  } else {
    console.log('⏸️ Live scanner desactivado (DISABLE_LIVE_SCANNER=true).');
  }

  if (prematchSchedulerEnabled) {
    startAltenarPrematchAdaptiveScheduler();
  } else {
    console.log('⏸️ Prematch scheduler desactivado (DISABLE_PREMATCH_SCHEDULER=true).');
  }

  if (pinnaclePrematchWsEnabled) {
    startPinnaclePrematchWsService().catch((error) => {
      console.error(`❌ Error iniciando Pinnacle Prematch WS: ${error.message}`);
    });
  } else {
    console.log('⏸️ Pinnacle Prematch WS desactivado (DISABLE_PINNACLE_PREMATCH_WS=true).');
  }
} else {
  console.log('⏸️ Workers de fondo desactivados (DISABLE_BACKGROUND_WORKERS=true).');
}

if (backgroundWorkersEnabled && pinnacleGatewayAutostart) {
  setTimeout(() => ensurePinnacleGatewayRunning('startup'), 3500);

  // Si aparece trigger stale y no hay gateway vivo, levantarlo de inmediato.
  setInterval(() => {
    if (!fs.existsSync(PINNACLE_TRIGGER_FILE)) return;
    ensurePinnacleGatewayRunning('stale-trigger');
  }, PINNACLE_GATEWAY_TRIGGER_CHECK_INTERVAL_MS);
}

// --- TAREA PROGRAMADA: INGESTA AUTOMÁTICA PINNACLE ---
// Se ejecuta al iniciar y luego en intervalo configurable para mantener DB fresca
const runPinnacleIngest = async () => {
    console.log("⏰ [CRON] Ejecutando Ingesta Automática de Pinnacle...");
    try {
        await ingestPinnaclePrematch();
    } catch (err) {
        console.error(`❌ Error en Ingesta Pinnacle: ${err.message}`);
    }
};

// 1. Ejecutar al inicio (con pequeño delay para no chocar con initDB)
if (backgroundWorkersEnabled && pinnacleIngestCronEnabled) {
  setTimeout(runPinnacleIngest, 5000);
} else if (backgroundWorkersEnabled && !pinnacleIngestCronEnabled) {
  console.log('⏸️ Ingesta automática de Pinnacle desactivada (DISABLE_PINNACLE_INGEST_CRON=true).');
}

// 2. Programar intervalo configurable via env (PINNACLE_INGEST_CRON_INTERVAL_MS)
if (backgroundWorkersEnabled && pinnacleIngestCronEnabled) {
  setInterval(runPinnacleIngest, pinnacleIngestCronIntervalMs);
}

// --- INVENTARIO PERIODICO: DIAGNOSTICOS DE ARBITRAJE ---
const runArbitrageInventory = async () => {
  try {
    const result = await runArbitrageDiagnosticsInventory({ tag: 'scheduler-cron' });
    const diag = result?.diagnostics || {};
    console.log(
      `📒 [ARB_DIAG] snapshot count=${Number(result?.count || 0)} ` +
      `eligible=${Number(diag?.eligiblePinnacleRows || 0)} ` +
      `unlinked=${Number(diag?.skippedUnlinked || 0)} ` +
      `missingOdds=${Number(diag?.skippedMissingOdds || 0)} ` +
      `riskFiltered=${Number(diag?.filteredByRisk || 0)}`
    );
  } catch (err) {
    console.error(`❌ Error en inventario de arbitraje: ${err.message}`);
  }
};

if (backgroundWorkersEnabled && arbitrageDiagnosticsInventoryEnabled) {
  setTimeout(runArbitrageInventory, 9000);
  setInterval(runArbitrageInventory, arbitrageDiagnosticsInventoryIntervalMs);
} else if (backgroundWorkersEnabled && !arbitrageDiagnosticsInventoryEnabled) {
  console.log('⏸️ Inventario de diagnosticos de arbitraje desactivado (ARBITRAGE_DIAGNOSTICS_INVENTORY_ENABLED=false).');
}

// --- TAREA PROGRAMADA: PODA DE CACHES (anti-saturación db.json) ---
const runCachePrune = async () => {
  try {
    const result = await pruneStaleEventCaches({
      upcomingGraceMinutes: Number(process.env.DB_UPCOMING_RETENTION_MINUTES || 180),
      altenarGraceMinutes: Number(process.env.DB_ALTENAR_RETENTION_MINUTES || 180),
      persist: true
    });

    if (result.changed) {
      console.log(
        `🧹 Cache prune: upcoming -${result.removedUpcoming}, altenar -${result.removedAltenar}. ` +
        `Restante: upcoming=${result.remainingUpcoming}, altenar=${result.remainingAltenar}`
      );
    }
  } catch (err) {
    console.error(`❌ Error en cache prune: ${err.message}`);
  }
};

setTimeout(runCachePrune, 7000);
setInterval(runCachePrune, 15 * 60 * 1000);

// Rutas de API
import opportunitiesRouter from './src/routes/opportunities.js';
import portfolioRouter from './src/routes/portfolio.js';
import matcherRouter from './src/routes/matcher.js';
import monitorRouter from './src/routes/monitor.js';
import bookyRouter from './src/routes/booky.js';
import pinnacleRouter from './src/routes/pinnacle.js';

app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/matcher', matcherRouter);
if (monitorDashboardEnabled) {
  app.use('/api/monitor', monitorRouter);
} else {
  console.log('⏸️ Monitor dashboard desactivado (DISABLE_MONITOR_DASHBOARD=true).');
  app.use('/api/monitor', (_req, res) => {
    res.status(503).json({
      success: false,
      code: 'MONITOR_DISABLED',
      message: 'Monitor desactivado por configuración (DISABLE_MONITOR_DASHBOARD=true).'
    });
  });
}
app.use('/api/booky', bookyRouter);
app.use('/api/pinnacle', pinnacleRouter);

// Rutas Básicas (API Health Check)
app.get('/', (req, res) => {
  res.send('🔫 BetSniper V3 API is Running - Oportunidades en la mira.');
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'BetSniper Backend' 
  });
});

// Iniciar Servidor
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Servidor BetSniper V3 corriendo en http://localhost:${PORT}`);
  console.log(`📝 Modo: ${process.env.NODE_ENV || 'development'}`);
});

let shuttingDown = false;

const shutdownPrematchWs = (signal = 'SIGTERM') => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 Señal ${signal} recibida. Cerrando BetSniper...`);

  try {
    stopAcityLiveSocketService();
  } catch (_) {
    // noop
  }

  try {
    stopPinnaclePrematchWsService();
  } catch (_) {
    // noop
  }

  if (isGatewayAlive()) {
    try {
      pinnacleGatewayProcess.kill('SIGTERM');
    } catch (_) {
      // noop
    }
  }

  const hardExitTimer = setTimeout(() => {
    console.warn('⚠️ Cierre forzado tras timeout de 5s.');
    process.exit(1);
  }, 5000);
  hardExitTimer.unref();

  server.close(() => {
    clearTimeout(hardExitTimer);
    console.log('✅ Servidor HTTP cerrado.');
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdownPrematchWs('SIGINT'));
process.on('SIGTERM', () => shutdownPrematchWs('SIGTERM'));
