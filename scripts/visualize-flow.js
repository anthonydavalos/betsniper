import altenarClient from '../src/config/axiosClient.js';
import { calculateEV, calculateKellyStake } from '../src/utils/mathUtils.js';

// Función auxiliar para parsear nombres de equipos (simulación de normalización)
const cleanName = (name) => name ? name.replace(/\sU\d+$/, '') : 'Unknown';

const visualizeFlow = async () => {
  console.log('🧪 INICIANDO PRUEBA DE CONCEPTO: FLUJO DE VALOR (SIMULACIÓN)...\n');

  try {
    // 1. OBTENER DATA REAL DE ALTENAR (DoradoBet)
    console.log('📡 1. Consultando API Altenar (DoradoBet)...');
    const response = await altenarClient.get('/GetLivenow', {
      params: { eventCount: 5, sportId: 66 }
    });

    const events = response.data.events;
    if (!events || events.length === 0) {
      console.log('⚠️ No hay partidos en vivo en Altenar para probar. Intenta más tarde.');
      return;
    }

    // Tomamos el primer evento real que tenga cuotas 1x2
    // Necesitamos mapear mercados y odds porque vienen separados (Relacional)
    const marketsMap = new Map();
    response.data.markets.forEach(m => marketsMap.set(m.id, m));
    
    const oddsMap = new Map();
    response.data.odds.forEach(o => oddsMap.set(o.id, o));

    let targetMatch = null;
    let targetOdd = null;
    let oddName = '';

    // Buscamos un partido con mercado 1x2 y una cuota Local (1)
    for (const event of events) {
      for (const marketId of event.marketIds) {
        const market = marketsMap.get(marketId);
        // TypeId 1 suele ser 1x2 (Match Winner)
        if (market && (market.typeId === 1 || market.name === '1x2')) {
          for (const oddId of market.oddIds) {
            const odd = oddsMap.get(oddId);
            // TypeId 1 = Local (Home)
            if (odd && odd.typeId === 1) { 
              targetMatch = event;
              targetOdd = odd.price;
              oddName = odd.name || event.competitorIds[0]; // Nombre del equipo local
              break;
            }
          }
        }
        if (targetMatch) break;
      }
      if (targetMatch) break;
    }

    if (!targetMatch) {
      console.log('❌ No se encontró un partido con cuotas 1x2 disponibles en la muestra.');
      return;
    }

    console.log(`✅ Partido encontrado en Altenar: "${targetMatch.name}"`);
    console.log(`   💰 Cuota DoradoBet (Local - ${oddName}): ${targetOdd}`);


    // 2. SIMULAR DATA DE API-SPORTS (PINNACLE)
    // Supongamos que API-Sports nos dice que la probabilidad real de que gane el local es más alta de lo que cree Altenar.
    // Si la cuota de Dorado es 2.0 (50% implícito), simulemos que la probabilidad real es 55%.
    
    // Calculamos prob implícita de la cuota de Dorado para referencia
    const doradoImpliedProb = (1 / targetOdd * 100).toFixed(2);
    
    // Generamos un escenario de Value Bet (Simulación)
    // "La realidad es 5% más probable de lo que paga la casa"
    const simulatedRealProbability = parseFloat(doradoImpliedProb) + 5; 
    
    console.log('\n💾 2. Consultando "Base de Datos" (SIMULACIÓN API-SPORTS)...');
    console.log(`   ℹ️  Probabilidad Implícita Dorado: ${doradoImpliedProb}%`);
    console.log(`   ✅ [MOCK] Probabilidad Real (Pinnacle No-Vig): ${simulatedRealProbability.toFixed(2)}%`);
    

    // 3. CÁLCULO DE VALOR (EV + KELLY)
    console.log('\n🧮 3. Ejecutando Motor Matemático (MathUtils)...');
    
    const ev = calculateEV(simulatedRealProbability, targetOdd);
    const kelly = calculateKellyStake(simulatedRealProbability, targetOdd, 1000, 0.25);

    console.log('------------------------------------------------');
    console.log(`📈 RESULTS FOR: ${targetMatch.name}`);
    console.log(`   Cuota: ${targetOdd}`);
    console.log(`   Prob. Real: ${simulatedRealProbability.toFixed(2)}%`);
    console.log('------------------------------------------------');
    console.log(`💎 VALOR ESPERADO (EV): ${ev.toFixed(2)}% ${ev > 0 ? '✅ (Value Bet)' : '❌'}`);
    console.log(`⚖️  CRITERIO DE KELLY (x0.25):`);
    console.log(`   Stake Sugerido: ${kelly.percentage.toFixed(2)}%`);
    console.log(`   Monto (Bank $1000): $${kelly.amount}`);
    console.log('------------------------------------------------');

    if (ev > 0) {
      console.log('\n🚀 CONCLUSIÓN DEL TEST: El sistema detectaría esta oportunidad correctamente.');
    } else {
      console.log('\n📉 CONCLUSIÓN DEL TEST: El sistema descartaría esta apuesta (EV negativo).');
    }

  } catch (error) {
    console.error('❌ Error en la prueba:', error);
  }
};

visualizeFlow();
