import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// UNIFICACIÓN DE SISTEMAS: Usar el token generado por el nuevo Gateway (pinnacleGateway.js)
const CREDS_PATH = path.join(__dirname, '../../data/pinnacle_token.json');
// Script de refresco unificado
const REFRESHER_SCRIPT = path.join(__dirname, '../../services/pinnacleGateway.js');

const BASE_URL = 'https://api.arcadia.pinnacle.com/0.1';
const BASE_MIN_REQUEST_GAP_MS = 500; // ~2 RPS máximo por proceso
const MAX_MIN_REQUEST_GAP_MS = 3000;

// Cargar credenciales iniciales
let credentials = loadCredentials();

function loadCredentials() {
    try {
        if (fs.existsSync(CREDS_PATH)) {
            const data = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
            // Si tiene estructura nueva { headers: {...} }
            if (data.headers) {
                return { headers: data.headers };
            }
            // Soporte Legacy (si fuera necesario)
            return { headers: {
                'X-Session': data.token,
                'X-API-Key': data.apiKey,
                'X-Device-UUID': data.uuid,
                'User-Agent': data.userAgent,
                'Cookie': data.cookies // Si existen
            }};
        }
    } catch (e) {
        console.error("⚠️ No se pudo cargar token:", e.message);
    }
    return { headers: {} };
}

class PinnacleChameleon {
    constructor() {
        this.baseUrl = BASE_URL;
        this.requestQueue = Promise.resolve();
        this.lastRequestAt = 0;
        this.minRequestGapMs = BASE_MIN_REQUEST_GAP_MS;
        this.backoffUntil = 0;
        this.startHeartbeat();
    }

    async scheduleArcadiaRequest(requestFn) {
        const task = async () => {
            const now = Date.now();

            // Backoff global por señales de rate-limit/WAF
            if (this.backoffUntil > now) {
                await new Promise(r => setTimeout(r, this.backoffUntil - now));
            }

            // Gap mínimo entre requests para respetar techo RPS
            const elapsed = Date.now() - this.lastRequestAt;
            if (elapsed < this.minRequestGapMs) {
                await new Promise(r => setTimeout(r, this.minRequestGapMs - elapsed));
            }

            this.lastRequestAt = Date.now();

            try {
                const result = await requestFn();
                // Recuperación gradual al baseline si todo va bien
                if (this.minRequestGapMs > BASE_MIN_REQUEST_GAP_MS) {
                    this.minRequestGapMs = Math.max(BASE_MIN_REQUEST_GAP_MS, this.minRequestGapMs - 100);
                }
                return result;
            } catch (error) {
                const status = error?.response?.status;
                if (status === 429 || status === 403) {
                    // Endurecer techo automáticamente ante señales de ban/rate-limit
                    this.minRequestGapMs = Math.min(MAX_MIN_REQUEST_GAP_MS, this.minRequestGapMs + 400);
                    this.backoffUntil = Date.now() + 2000;
                    console.warn(`⚠️ Arcadia throttle/backoff activo. Gap=${this.minRequestGapMs}ms`);
                }
                throw error;
            }
        };

        const run = this.requestQueue.then(task, task);
        this.requestQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    startHeartbeat() {
        // Mantiene la sesión viva enviando un PUT cada 60s
        setInterval(async () => {
             // Extraer token de los headers (soportando mayus/minus)
             const token = credentials.headers?.['X-Session'] || credentials.headers?.['x-session'];
             if (!token) return;
            
            try {
                // Heartbeat silencioso
                await axios({
                    method: 'PUT',
                    url: `${this.baseUrl}/sessions/${token}`,
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Origin': 'https://www.pinnacle.com',
                        'Referer': 'https://www.pinnacle.com/',
                        ...credentials.headers
                    },
                    httpsAgent: new https.Agent({ rejectUnauthorized: false })
                });
                // console.log("💓 Peak"); 
            } catch (e) {
                // Ignorar errores de heartbeat
            }
        }, 60000);
    }

    async get(endpoint, params = {}) {
        return this.makeRequest('GET', endpoint, { params });
    }

    async makeRequest(method, endpoint, config = {}, retries = 1) {
        // Construir headers usando lo que tenemos en archivo (Exactos del navegador)
        // Mantenemos headers estáticos mínimos por si acaso
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': 'https://www.pinnacle.com',
            'Referer': 'https://www.pinnacle.com/',
            
            // INYECTAR HEADERS CAPTURADOS (Session, cookies, device-uuid, user-agent)
            ...credentials.headers,

            ...config.headers
        };

        const requestConfig = {
            method,
            url: `${this.baseUrl}${endpoint}`,
            headers,
            params: {
                'brandId': 0,
                'withSpecials': false,
                // '_t': Date.now(), // Cache Buster DESACTIVADO (Causa problemas en endpoints estrictos)
                ...config.params
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 10000
        };

        try {
            const response = await this.scheduleArcadiaRequest(() => axios(requestConfig));
            return response.data;

        } catch (error) {
            // DETECCIÓN DE TOKEN QUEMADO (401 / 403)
            if (retries > 0 && error.response && (error.response.status === 401 || error.response.status === 403)) {
                
                console.warn(`\n🔥 [Pinnacle] SESIÓN QUEMADA (${error.response.status}). Iniciando Auto-Refresh...`);
                console.log("🖥️  Abriendo navegador para renovar credenciales...");

                try {
                    // Ejecutar el script harvest de forma síncrona (bloqueante)
                    // Esto abrirá la ventana de Chrome.
                    execSync(`node "${REFRESHER_SCRIPT}"`, { stdio: 'inherit' });
                    
                    console.log("♻️  Refresher finalizado. Recargando credenciales...");
                    credentials = loadCredentials(); // Leer el JSON actualizado
                    
                    console.log("🔄 Reintentando petición original...");
                    return this.makeRequest(method, endpoint, config, retries - 1);

                } catch (spawnError) {
                    console.error("❌ Error ejecutando Auto-Refresh:", spawnError.message);
                    throw error;
                }
            } else {
                throw error;
            }
        }
    }
}

export const pinnacleClient = new PinnacleChameleon();
