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
const ARCADIA_WS_PATH = 'api.arcadia.pinnacle.com/ws';
const ARCADIA_HTTP_HOST = 'api.arcadia.pinnacle.com';

const OUTPUT_FILE = path.join(__dirname, '../data/pinnacle_live.json');
const TOKEN_FILE = path.join(__dirname, '../data/pinnacle_token.json');
const IS_STANDALONE = process.argv[1] === fileURLToPath(import.meta.url);
const DEFAULT_PINNACLE_PROFILE_DIR = path.join(projectRoot, 'data', 'pinnacle', 'chrome-profile');
const PINNACLE_PROFILE_DIR = process.env.PINNACLE_CHROME_PROFILE_DIR
    ? (path.isAbsolute(process.env.PINNACLE_CHROME_PROFILE_DIR)
        ? process.env.PINNACLE_CHROME_PROFILE_DIR
        : path.join(projectRoot, process.env.PINNACLE_CHROME_PROFILE_DIR))
    : DEFAULT_PINNACLE_PROFILE_DIR;

function ensureDirForFile(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function parseBooleanFromEnv(rawValue, fallback = false) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return fallback;
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

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
        this.autoCloseMinReadyMs = Math.max(0, Number(process.env.PINNACLE_AUTO_CLOSE_MIN_READY_MS || 25000));
        this.arcadiaMinSockets = Math.max(1, Number(process.env.PINNACLE_ARCADIA_MIN_SOCKETS || 2));
        this.staleReloadGraceMs = Math.max(0, Number(process.env.PINNACLE_STALE_RELOAD_GRACE_MS || 600000));
        this.staleCheckIntervalMs = Math.max(500, Number(process.env.PINNACLE_STALE_CHECK_INTERVAL_MS || 1000));
        this.allowStaleReloadDuringGrace = parseBooleanFromEnv(process.env.PINNACLE_STALE_RELOAD_ALLOW_DURING_GRACE, true);
        this.autoLoginEnabled = parseBooleanFromEnv(process.env.PINNACLE_AUTO_LOGIN_ENABLED, false);
        this.autoLoginUsername = String(process.env.PINNACLE_LOGIN_USERNAME || '').trim();
        this.autoLoginPassword = String(process.env.PINNACLE_LOGIN_PASSWORD || '').trim();
        this.autoLoginAttempts = 0;
        this.autoLoginTimer = null;
        this.startedAtMs = Date.now();
        this.autoCloseTriggered = false;
        this.socketDetected = false;
        this.sessionDetected = false;
        this.firstFrameReceived = false;
        this.arcadiaSocketRequestIds = new Set();
    }

    buildAutoCloseChecklist(reason = 'valid-socket') {
        const elapsedMs = Date.now() - this.startedAtMs;
        const socketsSeen = this.arcadiaSocketRequestIds.size;

        return {
            reason,
            autoCloseEnabled: this.autoCloseEnabled,
            alreadyTriggered: this.autoCloseTriggered,
            sessionDetected: this.sessionDetected,
            socketDetected: this.socketDetected,
            firstFrameReceived: this.firstFrameReceived,
            arcadiaSockets: `${socketsSeen}/${this.arcadiaMinSockets}`,
            readyWindowOk: elapsedMs >= this.autoCloseMinReadyMs,
            elapsedMs,
            delayMs: this.autoCloseDelayMs
        };
    }

    maybeAutoClose(reason = 'valid-socket') {
        if (!this.autoCloseEnabled) return;
        if (this.autoCloseTriggered) return;
        if (!this.socketDetected || !this.sessionDetected) return;
        if (!this.firstFrameReceived) return;
        if (this.arcadiaSocketRequestIds.size < this.arcadiaMinSockets) {
            console.log(`⏳ Auto-close en espera: sockets Arcadia ${this.arcadiaSocketRequestIds.size}/${this.arcadiaMinSockets}.`);
            return;
        }

        const elapsedMs = Date.now() - this.startedAtMs;
        if (elapsedMs < this.autoCloseMinReadyMs) {
            const waitMs = this.autoCloseMinReadyMs - elapsedMs;
            console.log(`⏳ Socket detectado, pero esperando ${Math.ceil(waitMs / 1000)}s para evitar cierre prematuro durante login...`);
            setTimeout(() => this.maybeAutoClose('min-ready-window'), waitMs + 100);
            return;
        }

        const checklist = this.buildAutoCloseChecklist(reason);
        console.log(`🧪 Auto-close checklist: ${JSON.stringify(checklist)}`);

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

        if (this.autoLoginTimer) {
            clearInterval(this.autoLoginTimer);
            this.autoLoginTimer = null;
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
            if (String(url || '').includes(ARCADIA_WS_PATH)) {
                this.arcadiaSocketRequestIds.add(String(requestId || ''));
                this.socketDetected = true;
                console.log(`✅ Socket Arcadia detectado (${this.arcadiaSocketRequestIds.size}/${this.arcadiaMinSockets}).`);
                this.maybeAutoClose('arcadia-websocket-created');
            } else {
                console.log(`ℹ️ Socket ignorado (no Arcadia): ${url}`);
            }
            // Intentar obtener los headers extra de la solicitud original puede requerir 'Network.requestWillBeSent'
        });

        this.client.on('Network.webSocketFrameReceived', this.handleFrame.bind(this));
        
        this.client.on('Network.requestWillBeSent', (params) => {
            const reqUrl = params.request.url;
            const isArcadiaRequest = reqUrl.includes(ARCADIA_HTTP_HOST);
            // Capturar headers SOLO de Arcadia para evitar falsos positivos (geocomply/local ws)
            if (isArcadiaRequest) {
                // Filtrar headers irrelevantes
                const h = params.request.headers;
                if (h['X-Session'] || h['x-session']) {
                    console.log(`\n🔑 [AUTOGEN] Headers Capturados! Guardando en disco...`);
                    
                    const tokenData = {
                        headers: h,
                        url: reqUrl,
                        updatedAt: new Date().toISOString()
                    };

                    ensureDirForFile(TOKEN_FILE);
                    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
                    console.log("💾 Token actualizado en disco... (Sigue navegando/logueándote)");
                    this.sessionDetected = true;
                    this.maybeAutoClose('arcadia-x-session-captured');
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

            this.scheduleAutoLogin();
            
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
                        const elapsedMs = Date.now() - this.startedAtMs;
                        if (elapsedMs < this.staleReloadGraceMs && !this.allowStaleReloadDuringGrace) {
                            console.log('🛡️ Trigger stale diferido por ventana de gracia de login manual.');
                            return;
                        }

                        console.warn("⚠️ DETECTADA SOLICITUD DE REINICIO POR STALE DATA! ⚠️");
                        console.warn("🔄 Recargando página para renovar Socket...");
                        
                        // Eliminar trigger
                        fs.unlinkSync(CHECK_STALE_FILE);
                        
                        // Recargar página
                        this.page.reload({ waitUntil: 'domcontentloaded' })
                            .then(() => {
                                console.log("✅ Página Recargada.");
                                this.scheduleAutoLogin();
                            })
                            .catch(err => console.error("❌ Error recargando:", err));
                    }
                } catch(e) { console.error("Error check stale:", e); }
            }, this.staleCheckIntervalMs);

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

    scheduleAutoLogin() {
        if (!this.autoLoginEnabled) return;
        if (!this.autoLoginUsername || !this.autoLoginPassword) {
            console.warn('⚠️ Auto-login Pinnacle activado pero faltan PINNACLE_LOGIN_USERNAME/PINNACLE_LOGIN_PASSWORD.');
            return;
        }

        this.autoLoginAttempts = 0;
        if (this.autoLoginTimer) {
            clearInterval(this.autoLoginTimer);
            this.autoLoginTimer = null;
        }

        this.autoLoginTimer = setInterval(async () => {
            // No cortar solo por socket: puede haber feed guest activo sin sesion autenticada.
            if (this.sessionDetected || this.autoLoginAttempts >= 8) {
                clearInterval(this.autoLoginTimer);
                this.autoLoginTimer = null;
                return;
            }

            this.autoLoginAttempts += 1;
            const attempted = await this.tryAutoLoginOnce();
            if (attempted) {
                console.log(`🔐 Auto-login Pinnacle: intento ${this.autoLoginAttempts} enviado.`);
            }
        }, 7000);
    }

    async tryAutoLoginOnce() {
        const page = this.page;
        if (!page) return false;

        const frames = [page.mainFrame(), ...page.frames()];
        const loginTriggerSelectors = [
            '[data-test-id="header-login-loginButton"] button',
            'div[data-test-id="header-login-loginButton"] button',
            'button[data-test-id="header-login-loginButton"]',
            'button[data-test-id="Button"]'
        ];
        const userSelectors = [
            '[data-test-id="Forms-Element-username"] input',
            'input#username',
            'input[name="username"]',
            'input[name="email"]',
            'input[type="email"]',
            'input[type="text"]'
        ];
        const passSelectors = [
            '[data-test-id="Forms-Element-password"] input',
            'input#password',
            'input[name="password"]',
            'input[type="password"]'
        ];
        const submitSelectors = [
            '[data-test-id="header-login-loginButton"] button',
            'div[data-test-id="header-login-loginButton"] button',
            'button[type="submit"]',
            'button[data-test="login-submit"]',
            '[data-test-id="login-submit"] button',
            'button.login-button',
            'button[class*="login"]',
            '[data-test-id="Button"]'
        ];

        // Paso 0: detectar estado de sesion en header Pinnacle.
        const alreadyLoggedIn = await page.evaluate(() => {
            const hasAccountMenu = Boolean(document.querySelector('[data-test-id="Account-Menu"]'));
            const hasBankroll = Boolean(document.querySelector('[data-test-id="QuickCashier-BankRoll"]'));
            const hasDeposit = Boolean(document.querySelector('a[href*="/account/deposit"], .deposit-oF4Fv8zY5I'));
            return hasAccountMenu || (hasBankroll && hasDeposit);
        }).catch(() => false);

        if (alreadyLoggedIn) {
            this.sessionDetected = true;
            return true;
        }

        const hasVisibleLoginForm = await page.evaluate(() => {
            const hasHeaderLoginBtn = Boolean(document.querySelector('[data-test-id="header-login-loginButton"] button'));
            const hasUser = Boolean(document.querySelector('input#username, [data-test-id="Forms-Element-username"] input'));
            const hasPass = Boolean(document.querySelector('input#password, [data-test-id="Forms-Element-password"] input'));
            return hasHeaderLoginBtn && hasUser && hasPass;
        }).catch(() => false);

        // Paso 0: abrir modal/login panel cuando el boton superior es type="button".
        if (!hasVisibleLoginForm) {
            for (const frame of frames) {
                try {
                    for (const sel of loginTriggerSelectors) {
                        const triggerEl = await frame.$(sel);
                        if (!triggerEl) continue;

                        // Evitar clicks ciegos: si es un boton generico, exigir texto relacionado a login.
                        const shouldClick = await frame.evaluate((el) => {
                            const txt = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
                            if (!txt) return false;
                            return txt.includes('iniciar sesi') || txt.includes('login') || txt.includes('sign in');
                        }, triggerEl);
                        if (!shouldClick) continue;

                        await triggerEl.click();
                        await new Promise((r) => setTimeout(r, 250));
                        break;
                    }
                } catch (_) {
                    // Intentar siguiente frame
                }
            }
        }

        for (const frame of frames) {
            try {
                let userEl = null;
                for (const sel of userSelectors) {
                    userEl = await frame.$(sel);
                    if (userEl) break;
                }

                let passEl = null;
                for (const sel of passSelectors) {
                    passEl = await frame.$(sel);
                    if (passEl) break;
                }

                if (!userEl || !passEl) continue;

                await userEl.click({ clickCount: 3 });
                await userEl.type(this.autoLoginUsername, { delay: 25 });
                await passEl.click({ clickCount: 3 });
                await passEl.type(this.autoLoginPassword, { delay: 25 });

                let submitEl = null;
                for (const sel of submitSelectors) {
                    submitEl = await frame.$(sel);
                    if (submitEl) break;
                }

                if (submitEl) {
                    const clicked = await frame.evaluate((el) => {
                        const txt = String(el?.innerText || el?.textContent || '').trim().toLowerCase();
                        // Evitar click en botones auxiliares como MOSTRAR.
                        if (txt.includes('mostrar')) return false;
                        el.click();
                        return true;
                    }, submitEl);

                    if (!clicked) {
                        await passEl.press('Enter');
                    }
                } else {
                    const submittedByForm = await passEl.evaluate((el) => {
                        const form = el?.form || el?.closest?.('form');
                        if (!form) return false;

                        const btnCandidates = Array.from(form.querySelectorAll('button, [role="button"]'));
                        const submitBtn = btnCandidates.find((btn) => {
                            const txt = String(btn?.innerText || btn?.textContent || '').trim().toLowerCase();
                            if (!txt || txt.includes('mostrar')) return false;
                            if (txt.includes('iniciar sesi') || txt.includes('login') || txt.includes('sign in')) return true;
                            return btn?.type === 'submit';
                        });

                        if (submitBtn) {
                            submitBtn.click();
                            return true;
                        }

                        if (typeof form.requestSubmit === 'function') {
                            form.requestSubmit();
                            return true;
                        }

                        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                        return true;
                    });

                    if (!submittedByForm) {
                        await passEl.press('Enter');
                    }
                }

                return true;
            } catch (_) {
                // Intentar siguiente frame/selectores
            }
        }

        return false;
    }

    handleFrame({ requestId, response }) {
        if (!response.payloadData) return;
        if (!this.arcadiaSocketRequestIds.has(String(requestId || ''))) return;
        
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
                    this.maybeAutoClose('arcadia-first-websocket-frame');
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
            ensureDirForFile(LOCK_FILE);
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

