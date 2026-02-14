import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuración de rutas para ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../../db.json');

// Estructura por defecto de la Base de Datos
const defaultData = {
  config: { 
    bankroll: 100, 
    kellyFraction: 0.25 
  },
  mappedTeams: { 
    "Man City": "Manchester City" 
  },
  upcomingMatches: [],
  altenarUpcoming: [], // Caché de cuotas Pre-Match Altenar
  liveTracking: [],
  blacklist: [], // [NEW] Lista negra persistente de eventos descartados
  // PORTFOLIO Y SIMULACIÓN
  portfolio: {
    balance: 100,
    initialCapital: 100,
    activeBets: [], // Apuestas en juego
    history: []     // Apuestas cerradas
  }
};

// Inicialización de LowDB
const adapter = new JSONFile(dbPath);
const db = new Low(adapter, defaultData);

// Función para inicializar/leer la DB
export const initDB = async () => {
  await db.read();
  
  let modified = false;

  // Si falta data, escribir los defaults
  if (!db.data) {
    db.data = defaultData;
    modified = true;
  }
  
  // Asegurar que existan todas las claves principales
  if (!db.data.upcomingMatches) { db.data.upcomingMatches = []; modified = true; }
  if (!db.data.config) { db.data.config = defaultData.config; modified = true; }
  if (!db.data.mappedTeams) { db.data.mappedTeams = defaultData.mappedTeams; modified = true; }
  if (!db.data.blacklist) { db.data.blacklist = []; modified = true; } // [NEW] Ensure blacklist exists
  if (!db.data.liveTracking) { db.data.liveTracking = []; modified = true; }
  
  // Solo escribir si hubo cambios estructurales (evita trigger nodemon loop)
  if (modified) {
      await db.write();
      console.log('✅ Base de Datos LowDB (JSON) inicializada y guardada.');
  } else {
      // console.log('✅ Base de Datos LowDB (JSON) cargada.');
  }
};

export default db;
