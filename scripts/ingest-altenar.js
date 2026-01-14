import altenarClient from '../src/config/axiosClient.js';
import db, { initDB } from '../src/db/database.js';

const ingestAltenarPrematch = async () => {
  console.log('🚀 INICIANDO INGESTA MASIVA PRE-MATCH ALTENAR (DoradoBet)...');
  await initDB();

  try {
    // Calcular rango de fechas para coincidir con Pinnacle (Hoy + 2 días)
    const now = new Date();
    const endDate = new Date();
    endDate.setDate(now.getDate() + 2); // 48 horas de ventana

    console.log('📡 Consultando API Altenar /GetUpcoming (Massive Fetch)...');
    
    // PARAMS EXACTOS DEL APPS SCRIPT (Sin eventCount explicito si el default es masivo)
    const response = await altenarClient.get('/GetUpcoming', {
      params: { 
          culture: 'es-ES',
          timezoneOffset: 300,
          integration: 'doradobet',
          deviceType: 1,
          numFormat: 'en-GB',
          countryCode: 'PE',
          sportId: 66
          // eventCount REMOVIDO intencionalmente para probar el default behavior
      } 
    });

    const events = response.data.events || [];
    if (events.length === 0) {
      console.log('⚠️ No se recibieron eventos de Altenar.');
      return;
    }

    console.log(`📦 Recibidos ${events.length} eventos crudos.`);

    // 2. Procesar y Limpiar Data
    // No necesitamos guardar TODA la basura relacional, solo lo útil para el cruce
    // Aplanamos la estructura aquí para que el Scanner sea rápido.
    
    const marketsMap = new Map((response.data.markets || []).map(m => [m.id, m]));
    const oddsMap = new Map((response.data.odds || []).map(o => [o.id, o]));

    const cleanEvents = [];

    for (const event of events) {
      // Extraer cuotas 1x2 usando la lógica que ya conocemos
      const odds1x2 = extract1x2Odds(event, marketsMap, oddsMap);
      
      if (odds1x2) {
        cleanEvents.push({
          id: event.id,
          name: event.name,
          startDate: event.startDate,
          status: event.status, // 0 = Not started
          champId: event.champId,
          competitors: event.competitorIds, // IDs para referencia futura
          odds: odds1x2, // { home: 1.5, draw: 3.2, away: 5.0 }
          lastUpdated: new Date().toISOString()
        });
      }
    }

    // 3. Persistir en DB
    console.log(`💾 Guardando ${cleanEvents.length} eventos optimizados en DB...`);
    
    db.data.altenarUpcoming = cleanEvents;
    db.data.lastAltenarUpdate = new Date().toISOString();
    await db.write();

    console.log('✅ INGESTA ALTENAR COMPLETADA.');

  } catch (error) {
    console.error('❌ Error ingestion Altenar:', error.message);
  }
};

// Helper Duplicado (Idealmente mover a utils compartido si se usa en 3 sitios)
const extract1x2Odds = (event, marketsMap, oddsMap) => {
  if (!event.marketIds) return null;
  let odds = { home: 0, draw: 0, away: 0 };
  let found = false;

  for (const marketId of event.marketIds) {
    const market = marketsMap.get(marketId);
    if (!market) continue;
    if (market.typeId === 1 || market.name === '1x2') {
      for (const oddId of market.oddIds) {
        const odd = oddsMap.get(oddId);
        if (odd) {
          if (odd.typeId === 1) odds.home = odd.price;
          if (odd.typeId === 2) odds.draw = odd.price; 
          if (odd.typeId === 3) odds.away = odd.price; 
        }
      }
      found = true;
      break; 
    }
  }
  return found ? odds : null;
};

ingestAltenarPrematch();
