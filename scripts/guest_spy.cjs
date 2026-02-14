const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Guest Spy (Home)...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', ({ request }) => {
        if (request.url.includes('api.arcadia')) {
            console.log(`REQ: ${request.url}`);
            if (request.postData) console.log(`   POST: ${request.postData}`);
        }
    });

    client.on('Network.responseReceived', async ({ requestId, response }) => {
        if (response.url.includes('api.arcadia')) {
             try {
                const r = await client.send('Network.getResponseBody', { requestId });
                console.log(`\n📦 BODY (${response.url}):\n${r.body.substring(0, 300)}...\n`);
             } catch(e) {}
        }
    });

    try {
        await page.goto('https://www.pinnacle.com/', { waitUntil: 'domcontentloaded' });
        console.log("✅ Loaded.");
    } catch (e) {
        console.log("Err:", e.message);
    }
    
    await new Promise(r => setTimeout(r, 10000));
    await browser.close();
})();
