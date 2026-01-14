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
        // DETECCIÓN DE LÍMITE DE PAGINACIÓN (Free Plan)
        const errors = response.data.errors;
        if (errors.plan && errors.plan.includes('maximum value of 3')) {
          console.warn(`⚠️ Límite de paginación (Page 3) alcanzado. Deteniendo fetch para este endpoint sin romper el flujo.`);
          break; // Salimos del loop suavemente y devolvemos lo recolectado
        }
        
        console.error('❌ API-Sports Error:', errors);
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
  return fetchPaginatedData('/odds', {
    date: date,
    bookmaker: PINNACLE_ID
  });
};

export const getOddsByLeague = async (leagueId, date, season) => {
  return fetchPaginatedData('/odds', {
    league: leagueId,
    date: date,
    season: season, // Requerido cuando se filtra por liga
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
  getOddsByLeague,
  getQuotaStatus
};
