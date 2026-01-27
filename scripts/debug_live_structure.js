import altenarClient from '../src/config/axiosClient.js';

const debugLive = async () => {
    try {
        console.log("Fetching Live Data...");
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { sportId: 66, categoryId: 0 }
        });
        
        const events = data.events || [];
        console.log(`Events found: ${events.length}`);
        
        // Find Madureira if possible, otherwise pick first
        const match = events.find(e => e.name.includes("Madureira")) || events[0];
        
        if (match) {
            console.log("Match Found:", match.name);
            console.log("Keys:", Object.keys(match));
            console.log("SC (Score):", JSON.stringify(match.sc));
            console.log("Score Prop:", match.score);
        } else {
            console.log("No live matches found.");
        }

    } catch (e) {
        console.error(e);
    }
}

debugLive();
