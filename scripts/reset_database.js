import { DEFAULT_CORE_DATA, DEFAULT_DIAGNOSTICS_DATA, writeMergedDbSync } from './lib/read-split-db.mjs';

const cloneJson = (value, fallback = {}) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
};

const defaultData = {
  ...cloneJson(DEFAULT_CORE_DATA, {}),
  ...cloneJson(DEFAULT_DIAGNOSTICS_DATA, {})
};

console.log('🧹 Reiniciando Base de Datos a estado de fábrica...');
try {
    writeMergedDbSync(defaultData);
    console.log('✅ Base de datos split (db-core.json + db-diagnostics.json) ha sido reseteada exitosamente.');
    console.log('💰 Balance: 100');
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
