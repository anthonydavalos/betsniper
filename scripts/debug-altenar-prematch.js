import altenarClient from '../src/config/axiosClient.js';

const peekUpcoming = async () => {
  try {
    console.log('🔍 Consultando Altenar GetUpcoming...');
    const response = await altenarClient.get('/GetUpcoming', {
      params: { eventCount: 5, sportId: 66 }
    });

    if (!response.data.events || response.data.events.length === 0) {
      console.log('No events found.');
      return;
    }

    console.log('Eventos disponibles en Altenar:');
    response.data.events.forEach(e => {
        // Extraer nombres y cuotas si es posible para ver
        console.log(`- [${e.id}] ${e.name} (Start: ${e.startDate})`);
    });

  } catch (error) {
    console.error(error);
  }
};

peekUpcoming();
