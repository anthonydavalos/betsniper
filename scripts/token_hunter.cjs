const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Token Hunter started...");
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.responseReceived', async ({ requestId, response }) => {
        // Only check JSON or text responses
        if (response.mimeType.includes('json') || response.mimeType.includes('text')) {
             try {
                const r = await client.send('Network.getResponseBody', { requestId });
                const body = r.body;
                
                // Hunt for pattern AD<digits>
                // OR hunt for the token format (long char string with pipe)
                if (body.match(/AD\d{5,}/)) {
                    console.log(`\n🎯 FOUND USERNAME PATTERN in ${response.url}`);
                    console.log(`   matches: ${body.match(/AD\d{5,}/)[0]}`);
                    // console.log(`   FULL: ${body}`);
                }
                
                // Hunt for specific token known from previous run (just part of it to see if it's there)
                // "LQI2Lct8" was part of the previous token. But tokens change.
                // Let's look for any long string followed by |<4chars>
                // Regex: [a-zA-Z0-9]{20,}\|[a-zA-Z0-9]{4}
                if (body.match(/[a-zA-Z0-9\%]{30,}\|[a-zA-Z0-9]{4}/)) {
                     console.log(`\n💎 FOUND TOKEN PATTERN in ${response.url}`);
                     const match = body.match(/[a-zA-Z0-9\%]{30,}\|[a-zA-Z0-9]{4}/)[0];
                     console.log(`   matches: ${match}`);
                }
             } catch(e) {}
        }
    });

    try {
        await page.goto('https://www.pinnacle.com/es/soccer/live', { waitUntil: 'networkidle2', timeout: 60000 });
        console.log("✅ Page Loaded.");
    } catch (e) {
        console.error("Error loading:", e.message);
    }
    
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
})();
