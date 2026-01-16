// src/services/pinnacleService.js

import axios from 'axios';
import { randomUUID } from 'crypto';

// --- CONFIGURATION ---
// Misma API Key y Headers que ingest-pinnacle.js
const API_KEY = 'PINNACLE_API_KEY_PLACEHOLDER';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'host': 'guest.api.arcadia.pinnacle.com',
    'X-API-Key': API_KEY,
};

// Conversor de American Odds a Decimal (Pinnacle usa American)
const americanToDecimal = (american) => {
    if (!american) return 0;
    if (american > 0) {
        return (american / 100) + 1;
    } else {
        return (100 / Math.abs(american)) + 1;
    }
};

/**
 * Obtiene las cuotas en vivo de un partido específico desde Pinnacle Arcadia.
 * @param {string|number} pinnacleMatchId - ID del partido en Pinnacle.
 * @returns {Object|null} Objeto con propiedad { home, draw, away, timestamp } o null.
 */
export const getPinnacleLiveOdds = async (pinnacleMatchId) => {
    if (!pinnacleMatchId) return null;
    
    // Necesitamos un UUID fresco para evitar cache/bloqueo
    const DEVICE_UUID = randomUUID();
    
    try {
        // Usamos el endpoint que devuelve mercados "straight" (1x2, OU, HC)
        // Este endpoint es el mismo para prematch y live, la API actualiza los valores.
        const url = `https://guest.api.arcadia.pinnacle.com/0.1/matchups/${pinnacleMatchId}/markets/related/straight`;
        
        const { data } = await axios.get(url, { 
            headers: { ...HEADERS, 'X-Device-UUID': DEVICE_UUID },
            timeout: 5000 // Timeout corto para no detener el scanner
        });

        // Buscar mercado 1x2 (Moneyline - Full Match - Open)
        // Key suele ser "s;0;m" (Straight, Period 0, Moneyline)
        const mlMarket = data.find(m => (m.key === 's;0;m' || m.type === 'moneyline') && m.period === 0 && m.status === 'open');

        if (!mlMarket || !mlMarket.prices) {
            return null; // Mercado cerrado o no disponible
        }

        const prices = {};
        mlMarket.prices.forEach(p => {
            const decimal = americanToDecimal(p.price);
            if (decimal) prices[p.designation] = Number(decimal.toFixed(3));
        });

        // Validar que tengamos las 3 cuotas para un 1x2 normal
        if (prices.home && prices.away) {
            return {
                home: prices.home,
                away: prices.away,
                draw: prices.draw || 0, // A veces en 2-way no hay empate, pero en futbol sí
                timestamp: Date.now()
            };
        }
        
        return null;

    } catch (error) {
        // Silenciar errores 404/403 para no ensuciar logs excesivamente
        // console.error(`❌ Error fetching Pinnacle Live Odds (${pinnacleMatchId}):`, error.message);
        return null;
    }
};

/**
 * Calcula la Probabilidad Implícita Real (Fair Chance) removiendo el Vig (Margen).
 * Usa método multiplicativo simple o Power method si se requiere más precisión.
 * @param {number} odd 
 * @param {number} totalImpliedProb - Suma de 1/odd de todas las opciones del mercado
 * @returns {number} Probabilidad en % (0-100)
 */
export const calculateNoVigProb = (odd, totalImpliedProb) => {
    if (!odd || odd <= 1) return 0;
    // Implied Prob raw
    const rawP = 1 / odd;
    // Fair Prob = Raw / Total (Normalización)
    const fairP = rawP / totalImpliedProb;
    return fairP * 100;
};
