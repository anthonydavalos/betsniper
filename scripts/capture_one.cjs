const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
    console.log("🚀 Capture One Frame...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    });
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
        try {
            const buffer = Buffer.from(response.payloadData, 'base64');
            const text = buffer.toString('utf8');
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            
            if (firstBrace !== -1 && lastBrace !== -1) {
                const jsonStr = text.substring(firstBrace, lastBrace + 1);
                const data = JSON.parse(jsonStr);
                
                // Check if it has ANY data
                if (data.rec) {
                    console.log("✅ FOUND DATA!");
                    fs.writeFileSync('data/sample.json', JSON.stringify(data.rec, null, 2));
                    console.log("💾 Saved to data/sample.json");
                    process.exit(0);
                }
            }
        } catch (e) {}
    });

    try {
        await page.goto('https://www.pinnacle.com/es/soccer/live', { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.log("Err:", e.message);
    }
    
    // Wait longer if needed
    await new Promise(r => setTimeout(r, 20000));
    await browser.close();
})();
