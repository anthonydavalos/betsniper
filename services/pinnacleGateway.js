import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
const OUTPUT_FILE = path.join(__dirname, '../data/pinnacle_live.json');
const TOKEN_FILE = path.join(__dirname, '../data/pinnacle_token.json');

class PinnacleGateway {
    constructor() {
        this.browser = null;
    // ... rest of constructor

        this.page = null;
        this.client = null;
        this.dataStore = {
            events: {}, // Map by ID
            lastUpdate: Date.now()
        };
    }

    async start() {
        console.log("🚀 Starting Pinnacle Gateway (Puppeteer)...");
        
        this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized' 
            ]
        });

        this.page = await this.browser.newPage();
        this.client = await this.page.target().createCDPSession();
        await this.client.send('Network.enable');

        // Setup Interception
        // Escuchar cuando se CREA el socket para robar la URL y Headers
        this.client.on('Network.webSocketCreated', ({ requestId, url, initiator }) => {
            console.log(`\n🕵️‍♂️ SOCKET DETECTADO:`);
            console.log(`   🔗 URL: ${url}`);
            console.log(`   📂 Initiator: ${JSON.stringify(initiator || {}, null, 2)}`);
            this.socketUrl = url;
            // Intentar obtener los headers extra de la solicitud original puede requerir 'Network.requestWillBeSent'
        });

        this.client.on('Network.webSocketFrameReceived', this.handleFrame.bind(this));
        
        this.client.on('Network.requestWillBeSent', (params) => {
            const reqUrl = params.request.url;
            // Capturar headers de Arcadio o Websocket
            if (reqUrl.includes('api.arcadia.pinnacle.com') || reqUrl.startsWith('wss://')) {
                // Filtrar headers irrelevantes
                const h = params.request.headers;
                if (h['X-Session'] || h['x-session']) {
                    console.log(`\n🔑 [AUTOGEN] Headers Capturados! Guardando en disco...`);
                    
                    const tokenData = {
                        headers: h,
                        url: reqUrl,
                        updatedAt: new Date().toISOString()
                    };

                    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
                    console.log("💾 Token actualizado en disco... (Sigue navegando/logueándote)");
                    
                    // YA NO CERRAMOS AUTOMÁTICAMENTE.
                    // Esperamos a que el usuario cierre la ventana cuando haya terminado.
                }
            }
        });

        // Detectar cuando el usuario cierra la ventana manualmente
        this.browser.on('disconnected', () => {
            console.log("👋 Navegador cerrado por el usuario. Terminando proceso...");
            process.exit(0);
        });
        
        // Go to Live Soccer (URL Correcta)
        try {
            const TARGET_URL = 'https://www.pinnacle.com/es/soccer/matchups/live/'; 
            console.log(`📡 Navigating to ${TARGET_URL}...`);
            
            await this.page.goto(TARGET_URL, { 
                waitUntil: 'domcontentloaded', // Más rápido que networkidle
                timeout: 60000 
            });
            
            console.log("✅ Navigation Complete. Waiting for socket traffic...");

            // --- INICIAR BUCLE DE PERSISTENCIA ---
            console.log("💾 Iniciando Auto-Save (Cada 5s)...");
            setInterval(() => {
                 // Solo guardamos si han pasado al menos 2 segundos desde el último update de datos
                 // para evitar escribir en medio de una ráfaga.
                 const timeSinceObjUpdate = Date.now() - this.dataStore.lastUpdate;
                 if (Object.keys(this.dataStore.events).length > 0 && timeSinceObjUpdate < 30000) {
                     this.saveData();
                 }
            }, 5000);

            // BACKUP: Robar cookies directamente
            const cookies = await this.page.cookies();
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            if(cookieString) {
                console.log("\n🍪 COOKIES (Respaldo):");
                console.log(cookieString.substring(0, 100) + "..."); // Solo muestra el inicio para confirmar
            }

        } catch (e) {
            console.error("❌ Navigation failed:", e.message);
            this.restart();
        }
    }

    handleFrame({ requestId, response }) {
        if (!response.payloadData) return;
        
        try {
            // Decoding
            const buffer = Buffer.from(response.payloadData, 'base64');
            const text = buffer.toString('utf8');
            
            // Debug Log
            if (this.dataStore.events && Object.keys(this.dataStore.events).length === 0) {
                 fs.appendFileSync(path.join(__dirname, '../data/debug_frames.txt'), text + '\n---\n');
            }

            // Clean up binary noise to find JSON
            // Look for first '{' and last '}'
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                const jsonStr = text.substring(firstBrace, lastBrace + 1);
                const data = JSON.parse(jsonStr);
                
                // DEBUG: Log everything to a raw dump file to analyze structure
                const debugFile = path.join(this.baseDir, '../data/pinnacle_frames_dump.jsonl');
                fs.appendFileSync(debugFile, JSON.stringify(data) + '\n');

                this.processData(data);
            }
        } catch (e) {
            // Ignore parse errors (heartbeats, etc)
        }
    }

    processData(data) {
        // Estructura Típica de Pinnacle Arcadia:
        // { op: "upd", rec: { id: 123, ...cambios } } -> Actualización parcial
        // { op: "snap", rec: [ ... ] } -> Snapshot inicial (todos los eventos)
        
        // 1. SNAPSHOT (Carga Inicial)
        if (data.op === 'snap' && Array.isArray(data.rec)) {
            console.log(`📸 SNAPSHOT recibido: ${data.rec.length} eventos.`);
            data.rec.forEach(item => {
                if (item.id) {
                    this.dataStore.events[item.id] = item;
                }
            });
            this.dataStore.lastUpdate = Date.now();
            this.saveData(); // Guardado inmediato
            return;
        }

        // 2. UPDATE (Actualización Incremental)
        if (data.op === 'upd' && data.rec) {
            const incoming = data.rec;
            // A veces incoming es un array en updates? Validar.
            // Normalmente es objeto único. Si es array, iterar.
            const updates = Array.isArray(incoming) ? incoming : [incoming];
            
            updates.forEach(upd => {
                if (!upd.id) return;
                const existing = this.dataStore.events[upd.id];
                if (existing) {
                    // FUSIÓN INTELIGENTE (Deep Merge simplificado)
                    this.recursiveMerge(existing, upd);
                    this.logChange(existing, upd);
                } else {
                    // Si es nuevo, lo guardamos tal cual
                    this.dataStore.events[upd.id] = upd;
                }
            });
            
            this.dataStore.lastUpdate = Date.now();
        }
    }

    // Helper para fusionar objetos anidados (precios, periodos) sin borrar datos
    recursiveMerge(target, source) {
        for (const key of Object.keys(source)) {
            if (source[key] instanceof Object && key in target && !(source[key] instanceof Array)) {
                // Si es objeto y existe en target, profundizamos
                Object.assign(source[key], this.recursiveMerge(target[key], source[key]));
            }
        }
        // Aplica cambios del nivel actual
        Object.assign(target || {}, source);
        return target;
    }

    logChange(existingEvent, changes) {
        // Solo para debug visual: detectar cambios de cuotas
        try {
            const home = existingEvent.participants?.find(p => p.alignment === 'home')?.name || "Home";
            const away = existingEvent.participants?.find(p => p.alignment === 'away')?.name || "Away";
            
            // Si hay cambios en precios...
            if (JSON.stringify(changes).includes('price')) {
                 console.log(`⚡ Cambio en ${home} vs ${away} (ID: ${existingEvent.id})`);
            }
        } catch (e) { /* ignore log errors */ }
    }

    saveData() {
        // Convert map to array
        const events = Object.values(this.dataStore.events);
        const output = {
            updatedAt: new Date().toISOString(),
            count: events.length,
            events: events
        };
        
        // Ensure directory exists
        const dir = path.dirname(OUTPUT_FILE);
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        // console.log(`💾 Saved ${events.length} events to disk.`);
    }

    async restart() {
        if (this.browser) await this.browser.close();
        this.start();
    }
}

// Start standalone
// ES Modules don't have require.main
// We check if process.argv[1] matches this file
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const gateway = new PinnacleGateway();
    gateway.start();
}

export default PinnacleGateway;

