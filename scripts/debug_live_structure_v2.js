
import altenarClient from '../src/config/axiosClient.js';

async function debugLive() {
    try {
        console.log("📡 Fetching LiveNow...");
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { 
                sportId: 66, 
                categoryId: 0,
                _: Date.now()
            }
        });
        
        if (data) {
            console.log("🔍 ROOT RESPONSE KEYS:", Object.keys(data));
            
            if (data.champs && data.champs.length > 0) {
                console.log("🏆 First Champ:", JSON.stringify(data.champs[0]));
            }
            if (data.categories && data.categories.length > 0) {
                console.log("📂 First Category:", JSON.stringify(data.categories[0]));
            }

            if (data.events && data.events.length > 0) {
                const ev = data.events[0];
                console.log("------ SAMPLE EVENT ------");
                console.log("Name:", ev.name);
                console.log("Champ ID:", ev.champId);
                console.log("Cat ID:", ev.catId);
            } else {
                console.log("⚠️ No events in data.");
            }
        } else {
            console.log("⚠️ No data received.");
        }
    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

debugLive();
