import axios from 'axios';

// =====================================================================
// CONFIGURACIÓN AXIOS "INMORTAL" PARA ALTENAR (DoradoBet)
// =====================================================================
// Respetando el PROTOCOLO INMORTAL definido en copilot-instructions.md
// NO usar header Authorization para evitar bloqueos por token caducado.

const altenarClient = axios.create({
  baseURL: 'https://sb2frontend-altenar2.biahosted.com/api/widget',
  headers: {
    // Simulación de navegador real
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    'Referer': 'https://doradobet.com/',
    'Origin': 'https://doradobet.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    
    // Headers de Integración Específicos (NO BORRAR NI MODIFICAR)
    'integration': 'doradobet',
    'numFormat': 'en-GB', // Crucial para recibir decimales con punto (1.50)
    'countryCode': 'PE'   // Contexto de Perú
  },
  params: {
    // Parámetros Globales por Defecto
    culture: 'es-ES',
    timezoneOffset: 300, // UTC-5 (Perú)
    integration: 'doradobet',
    deviceType: 1, // Desktop
    numFormat: 'en-GB',
    countryCode: 'PE',
    sportId: 66 // Solo Fútbol por defecto
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
