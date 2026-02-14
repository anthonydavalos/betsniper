import altenarClient from '../src/config/axiosClient.js';

const run = async () => {
    try {
        console.log("Fetching Live List...");
        const { data } = await altenarClient.get('/GetLivenow?catId=0&langId=8');
        
        if (!data || !data.events || data.events.length === 0) {
            console.log("No events.");
            return;
        }

        // Pick the first event with markets
        const targetEvent = data.events[0];
        console.log(`Inspecting Event: ${targetEvent.name} (ID: ${targetEvent.id})`);

        console.log("Fetching Details...");
        const detailsRes = await altenarClient.get('/GetEventDetails', {
            params: { eventId: targetEvent.id }
        });
        
        const details = detailsRes.data;
        if (!details || !details.markets) {
            console.log("No markets in details.");
            return;
        }

        const markets = details.markets;
        console.log(`Total Markets: ${markets.length}`);

        // Filter for Totals
        const totalMarkets = markets.filter(m => 
            m.typeId === 18 || 
            (m.name && (m.name.includes('Total') || m.name.includes('Goles') || m.name.includes('Goals') || m.name.includes('Over')))
        );

        console.log(`Found ${totalMarkets.length} TOTALS candidates:`);
        
        totalMarkets.forEach(m => {
            console.log(`\n--- Market: ${m.name} (TypeID: ${m.typeId}) ---`);
            console.log(`   ActiveLine: ${m.activeLine}`);
            console.log(`   Specials: sv=${m.sv}, sn=${m.sn}, specialOddValue=${m.specialOddValue}`);
            
            // Check Odds
            const oddIds = (m.desktopOddIds || []).flat();
            console.log(`   Odd IDs: ${oddIds.length}`);
            
            // Map odds if available (fake map since we don't have the full odds list easily here without map logic)
            // But usually details.odds is separate. Let's check details.odds
            const eventOdds = details.odds || [];
            const relatedOdds = eventOdds.filter(o => oddIds.includes(o.id));
            
            relatedOdds.forEach(o => {
                console.log(`      Odd: ${o.name}  Price: ${o.price}  TypeID: ${o.typeId}`);
            });
        });

    } catch (e) {
        console.error(e);
    }
};

run();
