const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 API Key Hunter...");
    
    // Minimal args, similar to what worked before
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    console.log("📡 Listening...");

    client.on('Network.requestWillBeSent', ({ request }) => {
        if (request.url.includes('arcadia')) {
            console.log(`\n🎯 [ARCADIA REQ] ${request.url}`);
            console.log('   Headers:', JSON.stringify(request.headers, null, 2));
        }
    });

    try {
        await page.goto('https://www.pinnacle.com/', { waitUntil: 'domcontentloaded' });
        console.log("✅ Page Loaded.");
    } catch (e) {
        console.error(e);
    }
    
    await new Promise(r => setTimeout(r, 8000));
    await browser.close();
})();
