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
        this.startHeartbeat();
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
        const cacheBuster = Date.now();
        
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
