const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Deep Spy initialized...");
    
    // Launch regular chrome if possible to be less detectable, or just standard puppeteer
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    console.log("📡 Listening...");

    client.on('Network.requestWillBeSent', ({ request }) => {
        // Log vital endpoints
        if (request.url.includes('arcadia') || request.url.includes('negotiate') || request.url.includes('token')) {
            console.log(`\n🔹 [REQ] ${request.method} ${request.url}`);
            if (request.headers.Authorization) console.log(`   🔑 Auth: ${request.headers.Authorization.substring(0, 40)}...`);
            if (request.postData) console.log(`   📤 PostData: ${request.postData}`);
        }
    });

    client.on('Network.responseReceived', async ({ requestId, response }) => {
        if (response.url.includes('arcadia') || response.url.includes('negotiate') || response.url.includes('token')) {
             console.log(`\n🔸 [RESP] ${response.status} ${response.url}`);
             // try capture body
             try {
                const r = await client.send('Network.getResponseBody', { requestId });
                if (r.body) {
                    const b = r.body.length > 500 ? r.body.substring(0, 500) + '...' : r.body;
                    console.log(`   📦 Body: ${b}`);
                }
             } catch(e) {}
        }
    });
    
    client.on('Network.webSocketCreated', ({ requestId, url }) => {
        console.log(`\n🔌 [WS OPEN] ${url}`);
    });

    client.on('Network.webSocketWillSendHandshakeRequest', ({ requestId, request }) => {
         console.log(`\n🤝 [WS HANDSHAKE] ID: ${requestId}`);
         // Log the critical headers used for connection
         console.log('   Headers:', JSON.stringify(request.headers, null, 2));
    });

    try {
        // Go to the live page directly
        await page.goto('https://www.pinnacle.com/es/soccer/live', { waitUntil: 'networkidle2', timeout: 60000 });
        console.log("✅ Page Loaded.");
    } catch (e) {
        console.error("Error loading:", e.message);
    }
    
    // Wait for late sockets
    await new Promise(r => setTimeout(r, 10000));
    await browser.close();
})();
