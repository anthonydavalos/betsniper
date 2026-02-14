import axios from 'axios';
import https from 'https';

// =====================================================================
// CONFIGURACIÓN AXIOS "INMORTAL" PARA ALTENAR (DoradoBet)
// =====================================================================
// Respetando el PROTOCOLO INMORTAL definido en copilot-instructions.md
// NO usar header Authorization para evitar bloqueos por token caducado.

const altenarClient = axios.create({
  baseURL: 'https://sb2frontend-altenar2.biahosted.com/api/widget',
  // Forzar IPv4 para evitar errores ENOTFOUND en redes con IPv6 inestable
  httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
  headers: {
    // Simulación exacta del navegador (Chrome 145)
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Referer': 'https://doradobet.com/deportes-en-vivo',
    'Origin': 'https://doradobet.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site'
  },
  params: {
    // Parámetros Globales Obligatorios (Capturados del tráfico real)
    culture: 'es-ES',
    timezoneOffset: 300, // UTC-5 (Perú)
    integration: 'doradobet',
    deviceType: 1, // Desktop
    numFormat: 'en-GB', // Formato decimal con punto
    countryCode: 'PE',
    sportId: 0 // Default a todos (luego se sobreescribe a 66 en los servicios)
  },
  timeout: 10000 // 10 segundos timeout
});

// Interceptor para debugging (opcional, ayuda a ver errores de red)
altenarClient.interceptors.response.use(
  response => response,
  error => {
    // Si falla, loguear pero no romper todo el proceso si es posible
    console.error(`[Axios Altenar Error] ${error.message}`, error.response?.status);
    return Promise.reject(error);
  }
);

export default altenarClient;
