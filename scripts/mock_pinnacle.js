import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_FILE = path.join(__dirname, '../data/pinnacle_live.json');

const MOCK_EVENTS = [
    {
        id: 10001,
        league: { id: 5001, name: "Premier League" },
        sport: { id: 29, name: "Soccer" },
        participants: [
            { name: "Manchester City", alignment: "home" },
            { name: "Liverpool", alignment: "away" }
        ],
        home: "Manchester City",
        away: "Liverpool",
        prices: [
            { designation: "home", price: 2.10, points: 0 },
            { designation: "draw", price: 3.50, points: 0 },
            { designation: "away", price: 3.20, points: 0 }
        ],
        startTime: new Date(Date.now() + 30 * 60000).toISOString() // Starts in 30 mins
    },
    {
        id: 10002,
        league: { id: 5002, name: "La Liga" },
        sport: { id: 29, name: "Soccer" },
        participants: [
            { name: "Real Madrid", alignment: "home" },
            { name: "Barcelona", alignment: "away" }
        ],
        home: "Real Madrid",
        away: "Barcelona",
        prices: [
            { designation: "home", price: 1.90, points: 0 },
            { designation: "draw", price: 3.80, points: 0 },
            { designation: "away", price: 4.00, points: 0 }
        ],
        startTime: new Date(Date.now() + 10 * 60000).toISOString()
    },
    {
         id: 10003,
         league: { id: 5003, name: "Senegal Ligue 1" },
         sport: { id: 29, name: "Soccer" },
         participants: [
             { name: "AS Douanes", alignment: "home" },
             { name: "Teungueth", alignment: "away" }
         ],
         home: "AS Douanes",
         away: "Teungueth",
         prices: [
             { designation: "home", price: 2.50, points: 0 },
             { designation: "draw", price: 2.80, points: 0 },
             { designation: "away", price: 3.10, points: 0 }
         ],
         startTime: new Date().toISOString() // Live now
    }
];

function generate() {
    // Jitter the odds slightly to simulate live updates
    const events = MOCK_EVENTS.map(ev => {
        ev.prices = ev.prices.map(p => ({
            ...p,
            price: Number((p.price + (Math.random() * 0.1 - 0.05)).toFixed(2))
        }));
        return ev;
    });

    const output = {
        updatedAt: new Date().toISOString(),
        count: events.length,
        events: events
    };

    if (!fs.existsSync(path.dirname(OUTPUT_FILE))) {
        fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`🎲 Generated ${events.length} mock events.`);
}

// Run once immediately
generate();

// Optional: Keep running
if (process.argv.includes('--watch')) {
    setInterval(generate, 5000);
}
