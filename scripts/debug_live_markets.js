
import altenarClient from '../src/config/axiosClient.js';

const run = async () => {
    try {
        console.log("Fetching live events...");
        const { data } = await altenarClient.get('/GetLivenow', {
            params: { sportId: 66, categoryId: 0, _: Date.now() }
        });

        const events = data.events;
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

        console.log("--- TESTING FILTERS ON MARKETS ---");
        
        details.markets.forEach(m => {
            const n = (m.name || "").toLowerCase();
            const valid = ['total', 'over/under', 'línea de gol', 'goals', 'goles'];
            const forbidden = [
                'corner', 'esquina', 'card', 'tarjeta', 'half', 'mitad', 'tiempo', '1st', '2nd', '1er', '2do',
                'team', 'equipo', 'player', 'doble', 'btts', 'result', 'handicap', 'asian', 'exact', 'rest',
                'both', 'ambos', 'marca', 'combinada', 'combo', 'winning', 'ganador', 'margin'
            ];

            let status = 'IGNORED';
            let reason = '';

            const containsValid = valid.some(v => n.includes(v));
            if (!containsValid && m.typeId !== 18) {
                reason = 'No valid keywords';
            } else {
                const hitForbidden = forbidden.find(word => n.includes(word));
                if (hitForbidden) {
                    status = 'BLOCKED';
                    reason = `Blacklist: "${hitForbidden}"`;
                } else {
                    status = 'ACCEPTED';
                    reason = 'Clean Name';
                }
            }
            
            // Only print interesing ones (Accepted or Blocked near-misses)
            if (status === 'ACCEPTED' || m.typeId === 18 || containsValid) {
                console.log(`[${status}] ID:${m.typeId} "${m.name}" -> ${reason}`);
                if (status === 'ACCEPTED') {
                     const oddIds = (m.desktopOddIds || []).flat();
                     const odds = (details.odds || []).filter(o => oddIds.includes(o.id));
                     console.log(`      Allowed Sample: ${odds.slice(0,3).map(o => `${o.name}=${o.price}`).join(', ')}...`);
                }
            }
        });

    } catch (e) {
        console.error(e.message);
    }
};

run();
