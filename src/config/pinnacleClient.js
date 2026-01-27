import axios from 'axios';
import { randomUUID } from 'crypto';
import https from 'https';

// =====================================================================
// PINNACLE CAMALEÓN CLIENT (ANTI-DELAY / ANTI-BAN)
// Implementa rotación de identidad (UUID + User-Agent) y Headers reales.
// =====================================================================

const BASE_URL = 'https://guest.api.arcadia.pinnacle.com/0.1';
const STATIC_API_KEY = 'PINNACLE_API_KEY_PLACEHOLDER';

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0"
];

class PinnacleChameleon {
    constructor() {
        this.baseUrl = BASE_URL;
        this.apiKey = STATIC_API_KEY;
        this.identity = this.generateNewIdentity();
        
        console.log(`🦎 [PinnacleClient] Camaleón Iniciado | UUID: ${this.identity.uuid}`);
    }

    generateNewIdentity() {
        return {
            uuid: randomUUID(),
            userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
        };
    }

    async get(endpoint, params = {}) {
        return this.makeRequest('GET', endpoint, { params });
    }

    async makeRequest(method, endpoint, config = {}) {
        // Cache Buster global
        const cacheBuster = Date.now();
        
        // Headers Específicos para parecer Navegador Real (Mimetismo con app.json)
        // Usamos los dominios oficiales descubiertos en la config 'integration.domains.guest'
        const headers = {
            'User-Agent': this.identity.userAgent,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            'X-Device-UUID': this.identity.uuid,
            
            // Headers Oficiales para pasar desapercibido
            'Origin': 'https://www.pinnacle.com',
            'Referer': 'https://www.pinnacle.com/',
            
            // Headers de Navegación Moderna
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
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
                '_t': cacheBuster,  // Anti-Cache
                ...config.params
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Por si acaso
            timeout: 10000
        };

        try {
            const response = await axios(requestConfig);
            
            // Check Live Delay Warning en Matchups
            if (endpoint.includes('matchups') && Array.isArray(response.data) && response.data.length > 0) {
                const firstMatch = response.data[0];
                if (firstMatch?.liveMode === 'live_delay') {
                    console.warn("🚨 [Pinnacle] ALERTA: Delay detectado. Identidad comprometida.");
                }
            }

            return response.data;

        } catch (error) {
            // ESTRATEGIA DE ROTACIÓN EN ERROR 401/403
            if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                console.warn(`⚠️ [Pinnacle] Identidad quemada (${error.response.status}). Generando nueva piel...`);
                this.identity = this.generateNewIdentity();
                // Opcional: Reintentar (recursion simple con limite?)
                // Por ahora retornamos null para manejarlo en la capa superior
            } else {
                // console.error(`❌ [Pinnacle] Error en ${endpoint}:`, error.message);
            }
            throw error; // Re-lanzar para que el servicio lo maneje
        }
    }
}

// Exportar Singleton
export const pinnacleClient = new PinnacleChameleon();
