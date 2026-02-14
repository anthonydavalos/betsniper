
import altenarClient from '../src/config/axiosClient.js';

const runDebug = async () => {
    // ID from previous context (Japanese League match likely to be standardized)
    // Or fetch Livenow to pick one fresh
    try {
        console.log("Fetching Live List...");
        const { data: liveData } = await altenarClient.get('/GetLivenow', {
            params: { sportId: 66, categoryId: 0 }
        });
        
        const event = liveData.events && liveData.events[0];
        if (!event) {
            console.log("No live events found.");
            return;
        }

        console.log(`Inspecting Match: ${event.name} (ID: ${event.id})`);

        const { data: details } = await altenarClient.get('/GetEventDetails', {
            params: { eventId: event.id }
        });
        
        if (!details || !details.markets) {
            console.log("No market details found.");
            return;
        }

        const totalMarkets = details.markets.filter(m => 
            m.typeId === 18 || 
            (m.name && (m.name.includes('Total') || m.name.includes('Over') || m.name.includes('Más')))
        );

        console.log(`Found ${totalMarkets.length} Total-like markets.`);

        const oddMap = new Map();
        (details.odds || []).forEach(o => oddMap.set(o.id, o));

        totalMarkets.forEach(m => {
            const regex = /(\d+\.?\d*)/;
            const match = (m.name || "").match(regex);
            const regexVal = match ? parseFloat(match[0]) : "N/A";

            let line = parseFloat(m.activeLine || m.specialOddValue || m.sv || m.sn);
            
            console.log(`\nMarket: "${m.name}" (ID: ${m.id}, Type: ${m.typeId})`);
            console.log(`   Keys -> activeLine: ${m.activeLine}, specialOddValue: ${m.specialOddValue}, sv: ${m.sv}, sn: ${m.sn}`);
            console.log(`   Calc -> Parsed: ${line}, Regex: ${regexVal}`);

            // Inspect Odds to see if they give clues (e.g. name "Over 2.5")
            const oddIds = (m.desktopOddIds || []).flat();
            const odds = oddIds.map(id => oddMap.get(id)).filter(Boolean);
            odds.forEach(o => {
                console.log(`      Odd: "${o.name}" (Type: ${o.typeId}) Price: ${o.price}`);
            });
        });

    } catch (e) {
        console.error(e);
    }
};

runDebug();
