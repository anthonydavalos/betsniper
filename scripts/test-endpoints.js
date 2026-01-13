import axios from 'axios';

const TEST_URL = 'http://localhost:3000/api/opportunities';

const testEndpoints = async () => {
    console.log('🔌 PROBANDO ENDPOINTS HTTP (Simulando Frontend React)...\n');

    try {
        // 1. Probar Endpoint Pre-Match
        console.log('1️⃣  GET /api/opportunities/prematch');
        const start = Date.now();
        const prematchRes = await axios.get(`${TEST_URL}/prematch`);
        const duration = Date.now() - start;
        
        console.log(`   ✅ Status: ${prematchRes.status}`);
        console.log(`   ⏱️  Latencia: ${duration}ms`);
        console.log(`   📦 Items encontrados: ${prematchRes.data.count}`);
        
        if (prematchRes.data.count > 0) {
            console.log('   🔍 Ejemplo de Data JSON (Lo que recibirá React):');
            console.log(JSON.stringify(prematchRes.data.data[0], null, 2));
        } else {
            console.log('   ℹ️  Array vacío (Normal si no hay value bets reales ahora mismo).');
        }

        console.log('\n----------------------------------------\n');

        // 2. Probar Endpoint Live
        console.log('2️⃣  GET /api/opportunities/live');
        const startLive = Date.now();
        const liveRes = await axios.get(`${TEST_URL}/live`);
        const durationLive = Date.now() - startLive;

        console.log(`   ✅ Status: ${liveRes.status}`);
        console.log(`   ⏱️  Latencia: ${durationLive}ms`);
        console.log(`   📦 Items encontrados: ${liveRes.data.count}`);
        
        if (liveRes.data.count > 0) {
            console.log(JSON.stringify(liveRes.data.data[0], null, 2));
        }

    } catch (error) {
        console.error('❌ Error testing endpoints:');
        if (error.code === 'ECONNREFUSED') {
            console.error('   El servidor no parece estar corriendo en localhost:3000');
        } else {
            console.error(`   Status: ${error.response?.status}`);
            console.error(`   Message: ${error.message}`);
        }
    }
};

testEndpoints();
