import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Configuration
const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
const CHECK_STALE_FILE = path.join(__dirname, '../data/pinnacle_stale.trigger'); // Trigger File

const OUTPUT_FILE = path.join(__dirname, '../data/pinnacle_live.json');
const TOKEN_FILE = path.join(__dirname, '../data/pinnacle_token.json');
const IS_STANDALONE = process.argv[1] === fileURLToPath(import.meta.url);
const BOOK_PROFILE = (process.env.BOOK_PROFILE || 'doradobet').toLowerCase();
const DEFAULT_SHARED_BOOKY_PROFILE_DIR = path.join(projectRoot, 'data', 'booky', `chrome-profile-${BOOK_PROFILE}`);
const PINNACLE_PROFILE_DIR = process.env.PINNACLE_CHROME_PROFILE_DIR
    ? (path.isAbsolute(process.env.PINNACLE_CHROME_PROFILE_DIR)
        ? process.env.PINNACLE_CHROME_PROFILE_DIR
        : path.join(projectRoot, process.env.PINNACLE_CHROME_PROFILE_DIR))
    : DEFAULT_SHARED_BOOKY_PROFILE_DIR;

class PinnacleGateway {
    constructor() {
        this.browser = null;
    // ... rest of constructor

        this.page = null;
        this.client = null;
        this.staleCheckInterval = null;
        this.autoSaveInterval = null;
        this.shuttingDown = false;
        this.dataStore = {
            events: {}, // Map by ID
            lastUpdate: Date.now()
        };
        this.autoCloseEnabled = (process.env.PINNACLE_AUTO_CLOSE_ON_VALID_SOCKET || 'true').toLowerCase() !== 'false';
        this.autoCloseDelayMs = Math.max(500, Number(process.env.PINNACLE_AUTO_CLOSE_DELAY_MS || 1800));
        this.autoCloseTriggered = false;
        this.socketDetected = false;
        this.sessionDetected = false;
        this.firstFrameReceived = false;
    }

    maybeAutoClose(reason = 'valid-socket') {
        if (!this.autoCloseEnabled) return;
        if (this.autoCloseTriggered) return;
        if (!this.socketDetected || !this.sessionDetected) return;

        this.autoCloseTriggered = true;
        console.log(`✅ Socket Arcadia válido detectado (${reason}). Cerrando Chrome automáticamente en ${this.autoCloseDelayMs}ms...`);

        setTimeout(async () => {
            try {
                await this.shutdown();
            } catch (_) {
                // noop
            }

            if (IS_STANDALONE) {
                process.exit(0);
            }
        }, this.autoCloseDelayMs);
    }

    async shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        if (this.staleCheckInterval) {
            clearInterval(this.staleCheckInterval);
            this.staleCheckInterval = null;
        }

        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }

        try {
            if (this.browser && this.browser.isConnected()) {
                await this.browser.close();
            }
        } catch (error) {
            // Ignorar errores esperados de cierre en Windows (proceso ya finalizado)
        }
    }

    async start() {
        console.log("🚀 Starting Pinnacle Gateway (Puppeteer)...");

        if (!fs.existsSync(PINNACLE_PROFILE_DIR)) {
            fs.mkdirSync(PINNACLE_PROFILE_DIR, { recursive: true });
        }

        const useSystemChrome = (process.env.PINNACLE_USE_SYSTEM_CHROME || 'true').toLowerCase() !== 'false';
        const launchOptions = {
            headless: false,
            defaultViewport: null,
            userDataDir: PINNACLE_PROFILE_DIR,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--lang=es-ES'
            ]
        };

        if (useSystemChrome) {
            launchOptions.channel = 'chrome';
        }

        console.log(`👤 Perfil Chrome Pinnacle: ${PINNACLE_PROFILE_DIR}`);
        console.log(`👤 BOOK_PROFILE activo: ${BOOK_PROFILE}`);
        console.log(`🌐 Chrome del sistema: ${useSystemChrome ? 'Sí' : 'No (Chromium de Puppeteer)'}`);
        
        this.browser = await puppeteer.launch(launchOptions);

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
            if (String(url || '').includes('api.arcadia.pinnacle.com/ws')) {
                this.socketDetected = true;
                this.maybeAutoClose('websocket-created');
            }
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
                    this.sessionDetected = true;
                    this.maybeAutoClose('x-session-captured');
                }
            }
        });

        // Detectar cuando el usuario cierra la ventana manualmente
        this.browser.on('disconnected', () => {
            if (this.shuttingDown) return;
            this.shuttingDown = true;
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
            if (this.autoCloseEnabled) {
                console.log("🤖 Auto-close activo: la ventana se cerrará al detectar sesión+socket válido.");
            }

            // --- INICIAR BUCLE DE PERSISTENCIA ---
            console.log("💾 Iniciando Auto-Save (Cada 5s)...");
            
            // Watch por el archivo TRIGGER de Stale Data para reiniciar
            this.staleCheckInterval = setInterval(() => {
                try {
                    if (fs.existsSync(CHECK_STALE_FILE)) {
                        console.warn("⚠️ DETECTADA SOLICITUD DE REINICIO POR STALE DATA! ⚠️");
                        console.warn("🔄 Recargando página para renovar Socket...");
                        
                        // Eliminar trigger
                        fs.unlinkSync(CHECK_STALE_FILE);
                        
                        // Recargar página
                        this.page.reload({ waitUntil: 'domcontentloaded' })
                            .then(() => console.log("✅ Página Recargada."))
                            .catch(err => console.error("❌ Error recargando:", err));
                    }
                } catch(e) { console.error("Error check stale:", e); }
            }, 5000);

            this.autoSaveInterval = setInterval(() => {
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
                if (!this.firstFrameReceived) {
                    this.firstFrameReceived = true;
                    this.maybeAutoClose('first-websocket-frame');
                }
                
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
        await this.shutdown();
        this.shuttingDown = false;
        this.start();
    }
}

// Start standalone
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    (async () => {
        const LOCK_FILE = path.join(__dirname, '../data/pinnacle_refresh.lock');
        const MAX_LOCK_AGE_MS = 120000; // 2 minutes maximum wait

        // 1. Check for existing lock (Another process running)
        if (fs.existsSync(LOCK_FILE)) {
            try {
                const stats = fs.statSync(LOCK_FILE);
                const age = Date.now() - stats.mtimeMs;

                if (age < MAX_LOCK_AGE_MS) {
                    console.log(`🔒 [Gateway] Otro proceso ya está refrescando token (Lock activo, ${(age / 1000).toFixed(1)}s). Esperando...`);
                    
                    // Wait loop until lock is gone
                    let waited = 0;
                    while (fs.existsSync(LOCK_FILE) && waited < MAX_LOCK_AGE_MS) {
                        await new Promise(r => setTimeout(r, 1000));
                        waited += 1000;
                    }

                    console.log(`🔓 [Gateway] Lock liberado o expirado. Verificando token...`);
                    
                    // Check if token was updated recently
                    if (fs.existsSync(TOKEN_FILE)) {
                        try {
                            const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
                            const tokenAge = Date.now() - new Date(tokenData.updatedAt).getTime();
                            if (tokenAge < 60000) { // Updated < 1 min ago
                                console.log(`✅ Token encontrado y reciente (${(tokenAge/1000).toFixed(1)}s). Usando existente.`);
                                process.exit(0);
                            }
                        } catch (e) {
                            console.warn("⚠️ Error leyendo token existente:", e.message);
                        }
                    }
                } else {
                    console.warn(`⚠️ [Gateway] Lock antiguo detectado (> 2 mins). Eliminando y forzando refresh.`);
                    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
                }
            } catch (e) {
                // If stat fails (file disappeared), continue
            }
        }

        // 2. Create Lock and Start
        try {
            fs.writeFileSync(LOCK_FILE, Date.now().toString());
            
            const gateway = new PinnacleGateway();
            
            // Hook into process exit to clean up lock
            let isCleaningUp = false;
            let isShuttingDown = false;
            const cleanup = () => {
                if (isCleaningUp) return;
                isCleaningUp = true;
                try { 
                    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); 
                } catch (e) {}
            };

            const shutdownAndExit = async (exitCode = 0, err = null) => {
                if (isShuttingDown) return;
                isShuttingDown = true;

                if (err) {
                    console.error("Uncaught Exception:", err);
                }

                try {
                    await gateway.shutdown();
                } catch (e) {
                    // Ignorar errores de cierre para evitar ruido en consola
                }

                cleanup();
                process.exit(exitCode);
            };
            
            // Handle process termination events
            process.on('exit', cleanup);
            process.on('SIGINT', () => { shutdownAndExit(0); });
            process.on('SIGTERM', () => { shutdownAndExit(0); });
            process.on('uncaughtException', (err) => { shutdownAndExit(1, err); });

            await gateway.start();
            
            // Keep process alive if start() returns but listeners are active
            // Do NOT call cleanup() here manually unless we are sure it's done.
            // Given that PinnacleGateway relies on user closing window or internal logic calling process.exit(),
            // we should just let the event loop keep running.

        } catch (error) {
            console.error("❌ Gateway Error:", error);
            try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) {}
            process.exit(1);
        }

    })();
}

export default PinnacleGateway;

