
import altenarClient from '../src/config/axiosClient.js';

const testLiveEndpoint = async () => {
    console.log('📡 Testing /GetLivenow endpoint...');
    
    try {
        // Test 1: With explicit eventCount (Original way)
        console.log('   👉 Attempt 1: With eventCount=100');
        await altenarClient.get('/GetLivenow', { 
            params: { eventCount: 100 } 
        });
        console.log('   ✅ Attempt 1 Success!');
    } catch (e) {
        console.log('   ❌ Attempt 1 Failed:', e.message, e.response?.status);
    }

    try {
        // Test 2: Without eventCount (New way)
        console.log('   👉 Attempt 2: WITHOUT eventCount');
        const res = await altenarClient.get('/GetLivenow');
        const events = res.data.events || [];
        console.log(`   ✅ Attempt 2 Success! Found ${events.length} live events.`);
    } catch (e) {
        console.log('   ❌ Attempt 2 Failed:', e.message, e.response?.status);
    }
}

testLiveEndpoint();
