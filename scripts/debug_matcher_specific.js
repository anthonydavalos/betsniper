
import { findMatch } from '../src/utils/teamMatcher.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DATA_PATH = path.join(__dirname, '../data/pinnacle_live.json');

async function run() {
    console.log("🔍 Debugging findMatch Logic...");

    // 1. Load Pinnacle Feed
    const fileContent = fs.readFileSync(LOCAL_DATA_PATH, 'utf-8');
    const feed = JSON.parse(fileContent);
    
    // Transform feed to array format expected by findMatch (objects with .match property)
    const pinLiveArray = feed.events.map(ev => {
        const homePart = ev.participants?.find(p => p.alignment === 'home') || { name: ev.home || "Unknown" };
        const awayPart = ev.participants?.find(p => p.alignment === 'away') || { name: ev.away || "Unknown" };
        
        // Simular objeto que devuelve getAllPinnacleLiveOdds
        return {
            id: ev.id,
            match: `${homePart.name} vs ${awayPart.name}`,
            home: homePart.name,
            away: awayPart.name,
            date: ev.startTime // Important for matcher
        };
    });

    console.log(`✅ Pinnacle Feed Loaded: ${pinLiveArray.length} items.`);
    
    // 2. Test Case: Bangkok United
    const testAltenarName = "Bangkok United vs. Macarthur FC";
    const testAltenarDate = "2026-02-12T12:15:00Z";
    
    const parts = testAltenarName.split(/ vs\.? /i);
    const homeName = parts[0];
    
    console.log(`\n🧪 Testing Match: "${homeName}" (${testAltenarDate})`);
    
    const result = findMatch(homeName, testAltenarDate, pinLiveArray);
    
    if (result) {
        console.log(`✅ Match Found! ID: ${result.match.id} | Score: ${result.score}`);
        console.log(`   Pin Match: ${result.match.match}`);
    } else {
        console.log("❌ No Match Found.");
        
        // Debug candidates
        console.log("   Candidates in Pinnacle:");
        pinLiveArray.forEach(p => {
            if (p.home.toLowerCase().includes("bangkok")) {
                console.log(`   - [${p.date}] ${p.match}`);
            }
        });
    }
}

run();
