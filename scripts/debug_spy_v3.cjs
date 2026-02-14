const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Debug Spy v3 (Home)...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
    });
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    client.on('Network.requestWillBeSent', ({ request }) => {
        if (request.url.includes('arcadia') || request.url.includes('guest') || request.url.includes('api')) {
            console.log(`REQ: ${request.url}`);
            if (request.url.includes('session')) {
                console.log('!!! BINGO SESSION REQUEST !!!');
            }
        }
    });

    try {
        await page.goto('https://www.pinnacle.com/', { waitUntil: 'domcontentloaded' });
        console.log("✅ Home Loaded. Going to Live...");
        // Wait a bit
        await new Promise(r => setTimeout(r, 2000));
        
        // Try to go to live
        await page.goto('https://www.pinnacle.com/es/soccer/live', { waitUntil: 'domcontentloaded' });
        console.log("✅ Live Loaded.");
    } catch (e) {
        console.log("Err:", e.message);
    }
    
    await new Promise(r => setTimeout(r, 8000));
    await browser.close();
})();
