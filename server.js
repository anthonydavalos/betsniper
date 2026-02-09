import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDB } from './src/db/database.js';

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
import { ingestAltenarPrematch } from './scripts/ingest-altenar.js'; 
import { ingestPinnaclePrematch } from './scripts/ingest-pinnacle.js'; // Importar Función Directa
import { exec } from 'child_process';
import path from 'path';

startBackgroundScanner();

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

// --- TAREA PROGRAMADA: INGESTA AUTOMÁTICA ALTENAR ---
// Usamos la función importada para compartir memoria (Singleton DB) y evitar race conditions
const runAltenarIngest = async () => {
    console.log("⏰ [CRON] Ejecutando Ingesta Automática de Altenar (DoradoBet)...");
    try {
        await ingestAltenarPrematch();
        // No necesitamos log stdout, la función ya hace sus logs
    } catch (err) {
        console.error(`❌ Error en Ingesta Altenar (Interna): ${err.message}`);
    }
};

// 1. Ejecutar al inicio (con pequeño delay para no chocar con initDB)
setTimeout(runPinnacleIngest, 5000); 
setTimeout(runAltenarIngest, 65000); // 1 minuto después de Pinnacle

// 2. Programar intervalo (2 Horas = 7200000 ms)
setInterval(runPinnacleIngest, 2 * 60 * 60 * 1000);
setTimeout(() => {
    setInterval(runAltenarIngest, 2 * 60 * 60 * 1000);
}, 60000); // Offset de 1 minuto para el intervalo también

// Rutas de API
import opportunitiesRouter from './src/routes/opportunities.js';
import portfolioRouter from './src/routes/portfolio.js';
import matcherRouter from './src/routes/matcher.js';

app.use('/api/opportunities', opportunitiesRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/matcher', matcherRouter);

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
