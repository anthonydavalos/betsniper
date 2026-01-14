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
startBackgroundScanner();

// Rutas de API
import opportunitiesRouter from './src/routes/opportunities.js';
app.use('/api/opportunities', opportunitiesRouter);

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
