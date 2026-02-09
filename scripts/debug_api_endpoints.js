import { pinnacleClient } from '../src/config/pinnacleClient.js';

// League ID known to exist (Scotland League One from logs)
const LEAGUE_ID = 2418; 

async function testEndpoints() {
    console.log(`🧪 Probando endpoints para League ID: ${LEAGUE_ID}`);

    const variations = [
        { url: `/leagues/${LEAGUE_ID}/matchups`, params: {} },
        { url: `/leagues/${LEAGUE_ID}/matchups`, params: { brandId: undefined } }, // Try to remove brandId if client allows
        { url: `/leagues/${LEAGUE_ID}/matchups`, params: { brandId: 1 } },
        { url: `/leagues/${LEAGUE_ID}/matchups`, params: { brandId: 2 } },
        { url: `/leagues/${LEAGUE_ID}/matchups`, params: { withSpecials: null } }
    ];

    for (const item of variations) {
        try {
            console.log(`\n➡️  GET ${item.url} (Params: ${JSON.stringify(item.params)})...`);
            // Nota: pinnacleClient mezcla params. Si pasamos null, necesitamos ver si lo borra.
            // Para probar esto realmente, tendríamos que editar pinnacleClient.js temporalmente
            // Pero probemos suerte.
            const data = await pinnacleClient.get(item.url, item.params);
            
            const type = typeof data;
            const isArray = Array.isArray(data);
            const length = isArray ? data.length : (data ? Object.keys(data).length : 0);
            
            console.log(`   ✅ Status: 200 OK`);
            console.log(`   📦 Type: ${type}`);
            console.log(`   📏 Size: ${length}`);
            
            if (type === 'string') {
                 console.log(`   📝 Content: "${data.substring(0, 100)}..."`);
            } else if (isArray && length > 0) {
                console.log(`   🎉 MATCH FOUND! First ID: ${data[0].id}`);
            } else if (data && data.matchups) {
                console.log(`   🎉 MATCH FOUND (Wrapped)! Count: ${data.matchups.length}`);
            }

        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
            if (e.response) console.log(`      Status: ${e.response.status}`);
        }
    }
}

testEndpoints();