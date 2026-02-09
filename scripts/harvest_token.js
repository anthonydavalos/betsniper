import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Ruta al JSON de credenciales
const CREDENTIALS_PATH = path.join(__dirname, '../src/config/pinnacle-creds.json');
// Ruta para persistir la sesión de Chrome (cookies, local storage)
const CHROME_SESSION_PATH = path.join(__dirname, '../.chrome_session');

console.log("🚀 Iniciando Auto-Refresher de Token Pinnacle...");
console.log("----------------------------------------------------------------");
console.log("💾 Perfil de Chrome: Persistente (Recuerda sesión)");
console.log("📂 Guardando credenciales en: src/config/pinnacle-creds.json");
console.log("----------------------------------------------------------------");

(async () => {
    const browser = await puppeteer.launch({
        headless: false, // Debe verse para que el usuario interactúe si es necesario
        defaultViewport: null,
        userDataDir: CHROME_SESSION_PATH, // <--- MAGIA: Guarda la sesión
        args: [
            '--start-maximized',
            '--disable-features=IsolateOrigins,site-per-process',
            '--no-sandbox'
        ]
    });

    const page = await browser.newPage();
    
    // Variable para controlar si ya obtuvimos lo que queríamos
    let capturedData = null;

    page.on('request', async (request) => {
        const url = request.url();
        const method = request.method();
        const resourceType = request.resourceType();
        
        // --- SPY MODE: ACTIVATED ---
        // Filtramos solo peticiones de API (XHR/Fetch) relevantes para ignorar imagénes/css
        if (resourceType === 'xhr' || resourceType === 'fetch') {
             // Ignorar tracking/analytics basura
             if (!url.includes('google') && !url.includes('sentry') && !url.includes('hotjar') && !url.includes('optimizely')) {
                 
                 console.log(`\n🕵️ [SPY] ${method} ${url}`);
                 
                 // Si es un POST/PUT, intentar ver el Payload
                 if (method === 'POST' || method === 'PUT') {
                     try {
                         const postData = request.postData();
                         if (postData) {
                             console.log(`   📦 Payload: ${postData.substring(0, 300)}...`); // Truncado
                         }
                     } catch(err) {}
                 }
             }
        }

        if (capturedData) return;

        const headers = request.headers();
        const xSession = headers['x-session'] || headers['X-Session'];
        
        // Si detectamos el token
        if (xSession && xSession.length > 20) {
            
            capturedData = {
                token: xSession,
                uuid: headers['x-device-uuid'] || headers['X-Device-UUID'],
                userAgent: headers['user-agent'],
                apiKey: headers['x-api-key'] || headers['X-API-Key'],
                secChUa: headers['sec-ch-ua'],
                secChUaMobile: headers['sec-ch-ua-mobile'],
                secChUaPlatform: headers['sec-ch-ua-platform']
            };

            console.log("\n✅ ¡NUEVOS DATOS CAPTURADOS!");
            console.log("🎟️  Token:", capturedData.token.substring(0, 15) + "...");
            
            saveCredentials(capturedData);
            
            console.log("⚡ Espiando 5 minutos más antes de cerrar (o cerrar manualmente)...");
            // setTimeout(async () => {
            //     await browser.close();
            //     process.exit(0);
            // }, 2000);
            
            // Solo cerrar después de un rato largo para dar tiempo al usuario de navegar
            setTimeout(async () => {
                await browser.close();
                process.exit(0);
            }, 300000); // 5 Minutos (300,000 ms)
        }
    });

    page.on('request', request => {
        const url = request.url();
        if ((url.includes('/leagues/') || url.includes('/matchups')) && !url.endsWith('.js') && !url.endsWith('.css')) {
             // console.log(`📡 [SPY] ${request.method()} ${url}`);
        }
    });

    try {
        console.log("🌍 Navegando a Pinnacle...");
        await page.goto('https://www.pinnacle.com/es/account/login/', { waitUntil: 'networkidle2' });
        
        // Si la sesión anterior sigue viva, el sitio redireccionará al home y hará requests
        // Si no, el usuario verá el login y deberá ingresar.
        console.log("⏳ Esperando actividad de red o login manual...");

    } catch (e) {
        console.log("⚠️ Error de navegación (puede ser normal si se cerró):", e.message);
    }

    // Timeout de seguridad: 60s
    setTimeout(async () => {
        if (!capturedData) {
            console.error("❌ Tiempo agotado (60s).");
            await browser.close();
            process.exit(1);
        }
    }, 60000);

})();

function saveCredentials(newData) {
    try {
        // Leer actual para preservar datos si alguno viene null (ej. UUID a veces no viaja en todos los req)
        let current = {};
        if (fs.existsSync(CREDENTIALS_PATH)) {
            current = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        }

        const merged = {
            token: newData.token, // El token SIEMPRE se actualiza
            uuid: newData.uuid || current.uuid || 'NO_UUID',
            userAgent: newData.userAgent || current.userAgent,
            apiKey: newData.apiKey || current.apiKey || 'PINNACLE_API_KEY_PLACEHOLDER',
            secChUa: newData.secChUa || current.secChUa,
            secChUaMobile: newData.secChUaMobile || current.secChUaMobile,
            secChUaPlatform: newData.secChUaPlatform || current.secChUaPlatform
        };

        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(merged, null, 4), 'utf8');
        console.log("💾 JSON actualizado exitosamente.");
    } catch (err) {
        console.error("❌ Error guardando JSON:", err);
    }
}