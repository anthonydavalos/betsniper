
import axios from 'axios';
import https from 'https';

const resultsBaseURL = 'https://sb2ris-altenar2.biahosted.com/api/WidgetResults';

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Referer': 'https://doradobet.com/',
    'Origin': 'https://doradobet.com',
};

// Params for Jong Sparta
const params = {
    sportId: 66,
    categoryId: 569,
    date: '2026-02-14T00:00:00.000Z', 
    culture: 'es-ES',
    timezoneOffset: 300,
    integration: 'doradobet',
    numFormat: 'en-GB',
    countryCode: 'PE'
};

async function test() {
    try {
        console.log(`📡 Fetching from: ${resultsBaseURL}/GetEventResults`);
        console.log('Params:', params);
        
        const res = await axios.get(`${resultsBaseURL}/GetEventResults`, { 
            params, 
            headers,
            httpsAgent: new https.Agent({ family: 4 }) 
        });
        
        console.log('✅ Response Status:', res.status);
        console.log('✅ Events Found:', res.data.events ? res.data.events.length : 0);
        
        if (res.data.events) {
            res.data.events.forEach(e => {
                console.log(`   🔸 ${e.id} [${e.name}] Score: ${JSON.stringify(e.score)} Status: ${e.status}`);
            });
        } else {
             console.log('RAW DATA:', JSON.stringify(res.data, null, 2).slice(0, 500));
        }

    } catch (e) {
        console.error('❌ Error:', e.message);
        if (e.response) {
            console.error('   Status:', e.response.status);
            console.error('   Data:', e.response.data);
        }
    }
}

test();
