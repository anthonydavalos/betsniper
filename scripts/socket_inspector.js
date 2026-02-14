const puppeteer = require('puppeteer');

(async () => {
    console.log("🚀 Iniciando Inspector de Sockets (Spyware Mode)...");
    
    // Launch regular chrome if possible to be less detectable, or just standard puppeteer
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Create a CDP session
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    console.log("📡 Escuchando tráfico de Red y WebSocket...");

    client.on('Network.requestWillBeSent', ({ request }) => {
        // Filter noise (images, fonts, css, js files)
        if (request.url.match(/\.(png|jpg|jpeg|gif|css|js|woff|woff2|svg|ico)$/)) return;
        if (request.url.includes('google-analytics')) return;
        
        // Log interesting HTTP requests
        if (request.url.includes('pinnacle.com') || request.url.includes('api')) {
             console.log(`\n🌐 [HTTP REQ] ${request.method} ${request.url}`);
             if (request.headers['X-API-Key']) console.log(`   🔑 X-API-Key: ${request.headers['X-API-Key']}`);
             if (request.headers['Authorization']) console.log(`   🔑 Authorization: ${request.headers['Authorization'].substring(0, 30)}...`);
        }
    });

    client.on('Network.responseReceived', async ({ requestId, response }) => {
        // Look for responses that might contain config or tokens
        if (response.url.includes('config') || response.url.includes('negotiate') || response.url.includes('token') || response.url.includes('guest')) {
            console.log(`\n📥 [HTTP RESP] ${response.status} ${response.url}`);
            
            // Try to get body for specific interesting endpoints
            try {
                const responseBody = await client.send('Network.getResponseBody', { requestId });
                if (responseBody.body && responseBody.body.length < 500) {
                     console.log(`   📦 Body: ${responseBody.body}`);
                } else if (responseBody.body) {
                     console.log(`   📦 Body (truncated): ${responseBody.body.substring(0, 200)}...`);
                }
            } catch (e) {
                // Ignore errors (sometimes body is not available)
            }
        }
    });

    client.on('Network.webSocketCreated', ({ requestId, url }) => {
        console.log(`\n🔌 [WS OPEN] ${url}`);
        console.log(`   ID: ${requestId}`);
    });

    client.on('Network.webSocketWillSendHandshakeRequest', ({ requestId, request }) => {
        console.log(`\n🤝 [WS HANDSHAKE DOING] ID: ${requestId}`);
    });

    client.on('Network.webSocketFrameSent', ({ requestId, response }) => {
        if (response.payloadData && response.payloadData.length < 500) {
            console.log(`\n⬆️ [WS SENT] ID: ${requestId}`);
            console.log(`   Payload: ${response.payloadData}`);
        }
    });

    try {
        await page.goto('https://www.pinnacle.com/es/soccer/live', { waitUntil: 'networkidle2' });
        console.log("✅ Página cargada. Esperando trafico...");
    } catch (e) {
        console.error("Error cargando pagina:", e);
    }
    
    // Keep alive for a bit
    await new Promise(r => setTimeout(r, 20000));
    await browser.close();
})();
