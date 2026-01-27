import altenarClient from '../src/config/axiosClient.js';
import db, { initDB } from '../src/db/database.js';

import { fileURLToPath } from 'url';

export const ingestAltenarPrematch = async () => {
  console.log('🚀 INICIANDO INGESTA MASIVA PRE-MATCH ALTENAR (DoradoBet)...');
  await initDB();

  try {
    // Calcular rango de fechas (SOLO HOY para optimizar tráfico)
    const now = new Date();
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999); // Final del día de hoy

    console.log(`📡 Consultando API Altenar /GetUpcoming (Hasta: ${endDate.toISOString()})...`);
    
    // PARAMS EXACTOS DEL APPS SCRIPT (Sin eventCount explicito si el default es masivo)
    // Añadimos endDate al request si la API lo soporta, pero filtramos localmente igual.
    // Altenar suele traer todo por defecto o paginado. Filtramos en memoria.
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
      // 🟢 FILTRO DE FECHAS (Solo próximos 2 días)
      if (!event.startDate) continue;
      const eventDate = new Date(event.startDate);
      if (eventDate < now || eventDate > endDate) continue;

      // Extraer cuotas 1x2, Totales y BTTS
      const odds = extractOdds(event, marketsMap, oddsMap);
      
      // Filtramos si no tiene al menos una cuota válida de algún tipo
      // Puede que solo tenga 1x2, o solo Totales, etc.
      // Modificamos para ser permisivos si hay ALGUNA información útil.
      if (odds.home || odds.draw || odds.away || odds.totals.length > 0 || odds.btts.yes) {
        cleanEvents.push({
          id: event.id,
          name: event.name,
          startDate: event.startDate,
          status: event.status, // 0 = Not started
          champId: event.champId,
          catId: event.catId,   // ID de Categoría/País
          competitors: event.competitorIds, // IDs para referencia futura
          odds: {
              home: odds.home,
              draw: odds.draw,
              away: odds.away,
              totals: odds.totals, // Array [{ line, over, under }]
              btts: odds.btts      // { yes, no }
          },
          lastUpdated: new Date().toISOString()
        });
      }
    }

    // 3. Persistir en DB con Fusión Inteligente (Merge)
    // Mantener eventos recientes de Altenar en memoria aunque desaparezcan del endpoint /Upcoming
    // LOGICA SIMPLIFICADA: Si es de HOY (00:00 - 23:59), se queda.
    
    const existingEvents = db.data.altenarUpcoming || [];
    
    // Definir límites del día de hoy
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const keptEvents = existingEvents.filter(oldEv => {
        const oldDate = new Date(oldEv.startDate);
        
        // Criterio: Es de HOY y no ha sido reemplazado por la nueva data
        const isToday = oldDate >= startOfToday && oldDate <= endOfToday;
        const isReplaced = cleanEvents.some(newEv => newEv.id === oldEv.id);
        
        return isToday && !isReplaced;
    });

    console.log(`   ♻️  Preservando ${keptEvents.length} eventos Altenar previos (pasaron a Live/Recientes).`);
    console.log(`   🆕 Insertando/Actualizando ${cleanEvents.length} eventos frescos.`);

    const finalEventList = [...keptEvents, ...cleanEvents];
    finalEventList.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
    
    console.log(`💾 Guardando Total: ${finalEventList.length} eventos optimizados en DB...`);
    
    db.data.altenarUpcoming = finalEventList;
    db.data.lastAltenarUpdate = new Date().toISOString();
    await db.write();

    console.log('✅ INGESTA ALTENAR COMPLETADA.');

  } catch (error) {
    console.error('❌ Error ingestion Altenar:', error.message);
  }
};

// Helper Unificado para extraer todas las cuotas
const extractOdds = (event, marketsMap, oddsMap) => {
  if (!event.marketIds) return { home: 0, draw: 0, away: 0, totals: [], btts: {} };
  
  let result = { 
      home: 0, 
      draw: 0, 
      away: 0,
      totals: [], // Lista de lineas over/under encontradas
      btts: {}    // Both Teams To Score
  };

  for (const marketId of event.marketIds) {
    const market = marketsMap.get(marketId);
    if (!market) continue;

    // A) Mercado 1x2 (typeId 1 o name '1x2')
    if (market.typeId === 1 || market.name === '1x2') {
      for (const oddId of market.oddIds) {
        const odd = oddsMap.get(oddId);
        if (odd) {
          if (odd.typeId === 1) result.home = odd.price;
          if (odd.typeId === 2) result.draw = odd.price; 
          if (odd.typeId === 3) result.away = odd.price; 
        }
      }
    }

    // B) Mercado Totales (typeId 18 o name 'Total')
    if (market.typeId === 18 || market.name === 'Total') {
        const lineVal = parseFloat(market.sv || market.sn); // sv="2.5" usually
        if (!isNaN(lineVal)) {
            let overPrice = 0;
            let underPrice = 0;
            
            for (const oddId of market.oddIds) {
                const odd = oddsMap.get(oddId);
                if (odd) {
                    // TypeId 12 = Over, TypeId 13 = Under (Segun Blueprint)
                    // A veces varía, pero confiamos en Blueprint + Data Real
                    // Tambien chequeamos name por si acaso (Más de / Menos de)
                    const nameLower = (odd.name || "").toLowerCase();
                    if (odd.typeId === 12 || nameLower.includes('más') || nameLower.includes('over')) overPrice = odd.price;
                    if (odd.typeId === 13 || nameLower.includes('menos') || nameLower.includes('under')) underPrice = odd.price;
                }
            }

            if (overPrice > 0 && underPrice > 0) {
                result.totals.push({
                    line: lineVal,
                    over: overPrice,
                    under: underPrice
                });
            }
        }
    }

    // C) Mercado BTTS (typeId 29 o name 'Ambos equipos marcan')
    if (market.typeId === 29 || (market.name && market.name.toLowerCase().includes('ambos teams'))) {
         let yesPrice = 0;
         let noPrice = 0;

         for (const oddId of market.oddIds) {
             const odd = oddsMap.get(oddId);
             if (odd) {
                 // TypeId 74 = Yes, TypeId 76 = No (Segun Blueprint)
                 const nameLower = (odd.name || "").toLowerCase();
                 if (odd.typeId === 74 || nameLower === 'sí' || nameLower === 'yes') yesPrice = odd.price;
                 if (odd.typeId === 76 || nameLower === 'no') noPrice = odd.price;
             }
         }

         if (yesPrice > 0 && noPrice > 0) {
             result.btts = { yes: yesPrice, no: noPrice };
         }
    }
  }
  
  // Ordenar totales por linea para consistencia (1.5, 2.5, 3.5)
  result.totals.sort((a,b) => a.line - b.line);
  
  return result;
};

// Ejecución directa si se llama desde CLI (node scripts/ingest-altenar.js)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    ingestAltenarPrematch();
}
