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
    bankroll: 1000, 
    kellyFraction: 0.25 
  },
  mappedTeams: { 
    "Man City": "Manchester City" 
  },
  upcomingMatches: [],
  altenarUpcoming: [], // Caché de cuotas Pre-Match Altenar
  liveTracking: [],
  // PORTFOLIO Y SIMULACIÓN
  portfolio: {
    balance: 1000,
    initialCapital: 1000,
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
  
  // Si falta data, escribir los defaults
  db.data ||= defaultData; 
  
  // Asegurar que existan todas las claves principales
  db.data.upcomingMatches ||= [];
  db.data.config ||= defaultData.config;
  db.data.mappedTeams ||= defaultData.mappedTeams;
  db.data.liveTracking ||= [];

  await db.write();
  console.log('✅ Base de Datos LowDB (JSON) cargada correctamente.');
};

export default db;
