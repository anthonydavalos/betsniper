import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDB, pruneStaleEventCaches } from './src/db/database.js';

// Cargar variables de entorno
dotenv.config();

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
import { ingestPinnaclePrematch } from './scripts/ingest-pinnacle.js'; // Importar Función Directa
import { startAltenarPrematchAdaptiveScheduler } from './src/services/altenarPrematchScheduler.js';
import { exec } from 'child_process';
import path from 'path';

const backgroundWorkersEnabled = process.env.DISABLE_BACKGROUND_WORKERS !== 'true';
const liveScannerEnabled = process.env.DISABLE_LIVE_SCANNER !== 'true';
const prematchSchedulerEnabled = process.env.DISABLE_PREMATCH_SCHEDULER !== 'true';
const pinnacleIngestCronEnabled = process.env.DISABLE_PINNACLE_INGEST_CRON !== 'true';

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
} else {
  console.log('⏸️ Workers de fondo desactivados (DISABLE_BACKGROUND_WORKERS=true).');
}

// --- TAREA PROGRAMADA: INGESTA AUTOMÁTICA PINNACLE ---
// Se ejecuta al iniciar y luego cada 2 hORAS para mantener DB fresca
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

// 2. Programar intervalo (2 Horas = 7200000 ms)
if (backgroundWorkersEnabled && pinnacleIngestCronEnabled) {
  setInterval(runPinnacleIngest, 2 * 60 * 60 * 1000);
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

app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/matcher', matcherRouter);
app.use('/api/monitor', monitorRouter);
app.use('/api/booky', bookyRouter);

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
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor BetSniper V3 corriendo en http://localhost:${PORT}`);
  console.log(`📝 Modo: ${process.env.NODE_ENV || 'development'}`);
});
