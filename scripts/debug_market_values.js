
import altenarClient from '../src/config/axiosClient.js';

const run = async () => {
    try {
        console.log("Fetching live events...");
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { sportId: 66, categoryId: 0, _: Date.now() }
        });

        // Search for the match mentioned
        const events = data.events;
        // User said: "St George City FA vs. St."
        const target = events.find(e => e.name.toLowerCase().includes('george')) || events[0];

        if (!target) {
            console.log("No stored events found.");
            return;
        }

        console.log(`Analyzing: ${target.name} (ID: ${target.id})`);

        console.log("Fetching details...");
        const { data: details } = await altenarClient.get('/GetEventDetails', {
            params: { eventId: target.id, _: Date.now() }
        });

        if (!details || !details.markets) {
             console.log("No markets details.");
             return;
        }

        console.log("--- SEARCHING FOR ROGUE ODDS ---");
        // We are looking for Over 1.5 @ ~9.0 or Under 1.5 @ ~1.24
        // Or similar mixups.
        
        details.markets.forEach(m => {
            const oddIds = (m.desktopOddIds || []).flat();
            if (oddIds.length === 0) return;

            const odds = (details.odds || []).filter(o => oddIds.includes(o.id));
            
            // Check if this market looks like a Total
            const isTotal = m.typeId === 18 || (m.name && (m.name.includes('Total') || m.name.includes('Over/Under')));
            
            if (isTotal) {
                 console.log(`\nMARKET [${m.id}] Type: ${m.typeId} | Name: "${m.name}"`);
                 
                 odds.forEach(o => {
                     // Check for the specific problematic values
                     const isSuspect = (o.price > 8.0 && o.price < 10.0) || (o.price > 1.2 && o.price < 1.3);
                     
                     if (isSuspect) {
                         console.log(`   🚨 SUSPECT ODD: "${o.name}" @ ${o.price} (ID: ${o.id})`);
                     } else {
                         // Print first few normal ones
                        //  console.log(`   - "${o.name}" @ ${o.price}`);
                     }
                 });
                 // Print all odds for potential bad markets
                 if (m.typeId !== 18 && !m.name.includes("Total")) {
                      // print nothing
                 } else {
                     // print first 2
                     console.log(`   Sample: ${odds.slice(0,2).map(x => `${x.name}=${x.price}`).join(', ')}`);
                 }
            }
        });

    } catch (e) {
        console.error(e.message);
    }
};

run();
