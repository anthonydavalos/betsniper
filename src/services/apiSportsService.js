import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_SPORTS_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';
const PINNACLE_ID = 4; // Bookmaker ID para Pinnacle

if (!API_KEY) {
  console.warn('⚠️ ADVERTENCIA: API_SPORTS_KEY no está definida en el archivo .env');
}

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'x-apisports-key': API_KEY,
    'x-rapidapi-host': 'v3.football.api-sports.io'
  },
  timeout: 15000
});

// Helper para manejar paginación automática
const fetchPaginatedData = async (endpoint, params = {}) => {
  let allData = [];
  let currentPage = 1;
  let totalPages = 1;

  console.log(`🌐 API-Sports: Fetching ${endpoint} (Page 1)...`);

  do {
    try {
      const response = await client.get(endpoint, {
        params: { ...params, page: currentPage }
      });

      if (response.data.errors && Object.keys(response.data.errors).length > 0) {
        console.error('❌ API-Sports Error:', response.data.errors);
        throw new Error('API-Sports returned an error');
      }

      const { response: data, paging } = response.data;
      
      if (Array.isArray(data)) {
        allData = [...allData, ...data];
      }

      totalPages = paging.total;
      console.log(`   Processed Page ${currentPage} of ${totalPages} (${data.length} items)`);
      
      currentPage++;
    } catch (error) {
      console.error(`❌ Falló petición a ${endpoint} página ${currentPage}:`, error.message);
      break; 
    }
  } while (currentPage <= totalPages);

  return allData;
};

export const getFixturesByDate = async (date) => {
  console.log(`🌐 API-Sports: Fetching /fixtures for ${date} (Sin paginación)...`);
  try {
    const response = await client.get('/fixtures', { 
      params: {
        date: date,
        timezone: 'America/Lima' // Sincronizado con Altenar (PE)
      }
    });

    if (response.data.errors && Object.keys(response.data.errors).length > 0) {
      // A veces la API devuelve errores en formato 200 OK
      console.error('❌ API-Sports Error (Fixtures):', response.data.errors);
      return [];
    }

    return response.data.response || [];

  } catch (error) {
    console.error(`❌ Falló petición a /fixtures:`, error.message);
    return [];
  }
};

export const getPinnacleOddsByDate = async (date) => {
  // Este endpoint consume 1 llamada por página.
  // Odds por fecha + bookmaker suele tener muchas páginas.
  // ¡CUIDADO! Si hay 50 páginas, son 50 llamadas.
  // Estrategia "Blueprint": Máximo 100 llamadas/día.
  // Si pedimos Fixtures (1 llamada) + Odds (N llamadas), podríamos romperlo.
  // Alternativa segura: Pedir Odds solo de las Ligas filtradas si son muchas?
  // El usuario pidió "Todas las ligas".
  // Vamos a intentarlo, pero logueando consumo.
  return fetchPaginatedData('/odds', {
    date: date,
    bookmaker: PINNACLE_ID
  });
};

export const getQuotaStatus = async () => {
    try {
        const response = await client.get('/status');
        return response.data;
    } catch (error) {
        return null;
    }
}

export default {
  getFixturesByDate,
  getPinnacleOddsByDate,
  getQuotaStatus
};
