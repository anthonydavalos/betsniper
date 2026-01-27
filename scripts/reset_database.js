import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../db.json');

const defaultData = {
  config: { 
    bankroll: 1000, 
    kellyFraction: 0.25 
  },
  mappedTeams: { 
    "Man City": "Manchester City" 
  },
  upcomingMatches: [],
  altenarUpcoming: [],
  liveTracking: [],
  portfolio: {
    balance: 1000,
    initialCapital: 1000,
    activeBets: [],
    history: []
  }
};

console.log('🧹 Reiniciando Base de Datos a estado de fábrica...');
try {
    fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2));
    console.log('✅ Base de datos (db.json) ha sido reseteada exitosamente.');
    console.log('💰 Balance: 1000');
    console.log('📝 Apuestas limpiadas.');
    console.log('📅 Eventos limpiados.');
    console.log('\n⚠️ PASOS SIGUIENTES REQUERIDOS:');
    console.log('1. Ejecuta: node scripts/ingest-pinnacle.js');
    console.log('2. Ejecuta: node scripts/ingest-altenar.js');
    console.log('3. Ejecuta: node scripts/run_linker.js (Opcional, el servidor lo hará automático)');
    console.log('4. Reinicia el servidor: npm start');
} catch (error) {
    console.error('❌ Error al resetear la base de datos:', error);
}
