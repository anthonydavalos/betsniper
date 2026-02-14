
import altenarClient from '../src/config/axiosClient.js';
// Note the `../` because this script is in `scripts/` folder

async function debugLive() {
    try {
        console.log("📡 Fetching LiveNow...");
        const { data } = await altenarClient.default.get('/GetLivenow', { 
            params: { 
                sportId: 66, 
                categoryId: 0,
                _: Date.now()
            }
        }).catch(e => {
            if(e.response && e.response.status === 404) {
                // Sometimes default export is tricky with CJS/ESM interop
                return altenarClient.get('/GetLivenow', { ... });
            }
            throw e;
        });
        
        // Handle both default import and named export scenarios
        const responseData = data || (await altenarClient.get('/GetLivenow', { params: { sportId: 66, categoryId: 0, _: Date.now() }} )).data;

        const events = responseData.events || [];
        
        if (events.length > 0) {
            const ev = events[0];
            console.log("\n🔍 FIRST EVENT KEYS:", Object.keys(ev).join(', '));
            console.log("\n------ SAMPLE EVENT: " + ev.name + " ------");
            
            ['id', 'name', 'champId', 'championshipId', 'catId', 'categoryId'].forEach(k => 
                console.log(`${k}: ${ev[k]}`)
            );
            
            console.log("\n--- POTENTIAL LEAGUE FIELDS ---");
            ['league', 'leagueName', 'championshipName', 'categoryName', 'sportName'].forEach(k => {
                if (ev[k] !== undefined) console.log(`👉 ${k}: "${ev[k]}"`);
            });
            
            // Check for nested objects
            if (ev.championship) console.log("🏆 ev.championship:", JSON.stringify(ev.championship));
            if (ev.category) console.log("📂 ev.category:", JSON.stringify(ev.category));

        } else {
            console.log("⚠️ No live events found.");
        }
    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

debugLive();
