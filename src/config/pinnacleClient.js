import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = path.join(__dirname, 'pinnacle-creds.json');
// const REFRESHER_SCRIPT = path.join(__dirname, '../../scripts/harvest_token.js');
const REFRESHER_SCRIPT = path.join(__dirname, '../../scripts/direct_login.cjs');

// =====================================================================
// PINNACLE CAMALEÓN CLIENT (AUTO-HEALING)
// - Lee credenciales de JSON
// - Si falla (401), abre Chrome, renueva token y reintenta
// =====================================================================

const BASE_URL = 'https://api.arcadia.pinnacle.com/0.1';

// Cargar credenciales iniciales
let credentials = loadCredentials();

function loadCredentials() {
    try {
        if (fs.existsSync(CREDS_PATH)) {
            return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
        }
    } catch (e) {
        console.error("⚠️ No se pudo cargar pinnacle-creds.json:", e.message);
    }
    return { token: '', uuid: '', userAgent: '', apiKey: '' };
}

class PinnacleChameleon {
    constructor() {
        this.baseUrl = BASE_URL;
        this.startHeartbeat();
    }

    startHeartbeat() {
        // Mantiene la sesión viva enviando un PUT cada 60s
        // Esto imita el comportamiento del navegador real
        setInterval(async () => {
            if (!credentials.token) return;
            
            try {
                // Heartbeat silencioso (bypass makeRequest para evitar params extra)
                await axios({
                    method: 'PUT',
                    url: `${this.baseUrl}/sessions/${credentials.token}`,
                    headers: {
                        'User-Agent': credentials.userAgent,
                        'X-API-Key': credentials.apiKey,
                        'X-Device-UUID': credentials.uuid,
                        'X-Session': credentials.token,
                        'Origin': 'https://www.pinnacle.com',
                        'Referer': 'https://www.pinnacle.com/',
                         // Headers de mimetismo
                        'sec-ch-ua': credentials.secChUa,
                        'sec-ch-ua-mobile': credentials.secChUaMobile || '?0',
                        'sec-ch-ua-platform': credentials.secChUaPlatform || '"Windows"',
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'cross-site'
                    },
                    httpsAgent: new https.Agent({ rejectUnauthorized: false })
                });
                // console.log("💓 Peak"); 
            } catch (e) {
                // Si falla por 401, el siguiente get() normal disparará el refresh
                // No forzamos refresh aqui para evitar bucles zombis
            }
        }, 60000);
    }

    async get(endpoint, params = {}) {
        return this.makeRequest('GET', endpoint, { params });
    }

    async makeRequest(method, endpoint, config = {}, retries = 1) {
        const cacheBuster = Date.now();
        
        // Construir headers dinámicos basados en lo último del JSON
        const headers = {
            'User-Agent': credentials.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-API-Key': credentials.apiKey,
            'X-Device-UUID': credentials.uuid,
            'X-Session': credentials.token, 
            
            'Origin': 'https://www.pinnacle.com',
            'Referer': 'https://www.pinnacle.com/',
            
            // Mimetismo Avanzado
            'sec-ch-ua': credentials.secChUa,
            'sec-ch-ua-mobile': credentials.secChUaMobile || '?0',
            'sec-ch-ua-platform': credentials.secChUaPlatform || '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',

            ...config.headers
        };

        const requestConfig = {
            method,
            url: `${this.baseUrl}${endpoint}`,
            headers,
            params: {
                'brandId': 0,
                'withSpecials': false,
                '_t': Date.now(), // Cache Buster REACTIVADO
                ...config.params
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 10000
        };

        try {
            const response = await axios(requestConfig);
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
