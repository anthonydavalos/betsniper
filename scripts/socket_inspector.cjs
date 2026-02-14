const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Iniciando Inspector de Sockets (Spyware Mode) v2...");
    
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--window-size=1920,1080',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Create a CDP session
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    console.log("📡 Escuchando tráfico...");

    client.on('Network.requestWillBeSent', ({ request }) => {
        if (request.url.match(/\.(png|jpg|jpeg|gif|css|woff|woff2|svg|ico)$/)) return;
        
        if (request.url.toLowerCase().includes('guest') || 
            request.url.toLowerCase().includes('token') || 
            request.url.toLowerCase().includes('negotiate') ||
            request.url.toLowerCase().includes('config')) {
             console.log(`\n🎯 [TARGET REQ] ${request.method} ${request.url}`);
             if (request.headers['Authorization']) console.log(`   🔑 Auth: ${request.headers['Authorization'].substring(0, 50)}...`);
             if (request.headers['X-API-Key']) console.log(`   🔑 API-Key: ${request.headers['X-API-Key']}`);
        } else if (request.url.includes('api.arcadia')) {
             console.log(`\n🌊 [ARCADIA REQ] ${request.method} ${request.url}`);
        }
    });
    
    client.on('Network.responseReceived', async ({ requestId, response }) => {
        if (response.url.toLowerCase().includes('guest') || 
            response.url.toLowerCase().includes('token') ||
            response.url.toLowerCase().includes('config')) {
            
            try {
                const responseBody = await client.send('Network.getResponseBody', { requestId });
                if (responseBody.body) {
                     const logBody = responseBody.body.length > 500 ? responseBody.body.substring(0, 500) + '...' : responseBody.body;
                     console.log(`   📦 Body (${response.url}): ${logBody}`);
                }
            } catch (e) {
                // Ignore
            }
        }
    });

    client.on('Network.webSocketCreated', ({ requestId, url }) => {
        console.log(`\n🔌 [WS OPEN] ${url}`);
    });

    // Start navigation
    try {
        await page.goto('https://www.pinnacle.com/es/soccer/live', { waitUntil: 'domcontentloaded' });
        console.log("✅ DOM Loaded. Waiting...");
    } catch (e) {
        console.error("Error loading:", e);
    }
    
    // Explicit wait for 20s
    await new Promise(r => setTimeout(r, 20000));
    await browser.close();
})();
