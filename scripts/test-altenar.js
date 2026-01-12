import altenarClient from '../src/config/axiosClient.js';

const testAltenarConnection = async () => {
  console.log('📡 Probando conexión con Altenar (DoradoBet)...');
  console.log('Configuración Axios:', {
    baseURL: altenarClient.defaults.baseURL,
    headers: altenarClient.defaults.headers
  });

  try {
    // Probamos el endpoint GetLivenow con un límite pequeño solo para verificar conectividad
    // params extra para asegurar respuesta ligera
    const response = await altenarClient.get('/GetLivenow', {
      params: {
        eventCount: 5,
        sportId: 66 // Fútbol
      }
    });

    console.log('\n✅ Conexión EXITOSA!');
    console.log(`Status: ${response.status} ${response.statusText}`);
    
    // Verificar estructura de datos básica
    if (response.data && response.data.events) {
      console.log(`📦 Eventos recibidos: ${response.data.events.length}`);
      if (response.data.events.length > 0) {
        console.log('⚽ Ejemplo de partido:', response.data.events[0].name);
      }
    } else {
      console.warn('⚠️ La respuesta no tiene la estructura esperada (events array missing).');
      console.log('Data sample:', JSON.stringify(response.data, null, 2).substring(0, 200));
    }

  } catch (error) {
    console.error('\n❌ ERROR DE CONEXIÓN:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
};

testAltenarConnection();
