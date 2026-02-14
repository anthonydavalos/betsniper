import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKEN_FILE = path.join(__dirname, '../data/pinnacle_token.json');

const API_URL_FIXTURES = "https://api.arcadia.pinnacle.com/0.1/sports/29/matchups/live";

const run = async () => {
    if (!fs.existsSync(TOKEN_FILE)) {
        console.error("No token file found.");
        return;
    }

    const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    const headers = tokenData.headers;

    try {
        console.log("Fetching Live Fixtures...");
        const { data } = await axios.get(API_URL_FIXTURES, { headers });
        
        console.log(`Received ${data.length} fixtures.`);
        
        if (data.length > 0) {
            // Find a match that is likely in play (has period or score)
            const activeMatch = data.find(m => m.liveStatus && (m.liveStatus.period > 0 || m.liveStatus.score));
            const sample = activeMatch || data[0];

            console.log("\n--- SAMPLE FIXTURE STRUCTURE ---");
            console.log(JSON.stringify(sample, null, 2));
            
            // Check for specific keys
            console.log("\n--- KEY CHECKS ---");
            console.log("Has liveStatus?", !!sample.liveStatus);
            if (sample.liveStatus) {
                console.log("liveStatus keys:", Object.keys(sample.liveStatus));
            }
        }
    } catch (e) {
        console.error("Error:", e.message);
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Data:", e.response.data);
        }
    }
};

run();
