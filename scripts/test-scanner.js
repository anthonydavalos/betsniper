import db, { initDB } from '../src/db/database.js';
import { scanLiveOpportunities } from '../src/services/scannerService.js';
import altenarClient from '../src/config/axiosClient.js';

// =========================================================
// MOCKS & STUBS
// =========================================================

// 1. MOCK AXIOS (Interceptar llamadas a la API)
altenarClient.get = async (url, config) => {
    console.log(`\n🎭 MOCK AXIOS INTERCEPTED: ${url}`);
    
    // Generar fecha "ahora" para que coincida con el filtro de tiempo
    const now = new Date().toISOString();

    return {
        data: {
            events: [
                {
                    id: 99999,
                    name: "Manchester City vs Luton Town", // Nombre idéntico al de DB para match fácil
                    liveTime: "35'",
                    score: [0, 1], // FAVORITO PERDIENDO 0-1
                    marketIds: [1001],
                    startDate: now, // Coincide con DB
                    competitorIds: [10, 20]
                }
            ],
            markets: [
                { id: 1001, name: "1x2", typeId: 1, oddIds: [2001, 2002, 2003] }
            ],
            odds: [
                { id: 2001, typeId: 1, price: 2.15 }, // Cuota alza a 2.15 (Antes 1.25)
                { id: 2002, typeId: 2, price: 3.50 },
                { id: 2003, typeId: 3, price: 2.50 }
            ]
        }
    };
};

// 2. MOCK DATABASE (Evitar leer disco y sobrescribir memoria)
// "Congelamos" la función read para que scannerService use nuestros datos en memoria
const originalRead = db.read;
db.read = async () => {
    console.log('🛡️ MOCK DB: db.read() blocked to preserve test data.');
    return; 
};

const runTest = async () => {
    console.log('🧪 INICIANDO TEST: ESTRATEGIA "LA VOLTEADA"');
    
    // Inicializar estructura básica si está vacía (aunque sobreescribiremos)
    if (!db.data) db.data = { upcomingMatches: [], config: { bankroll: 1000 } };
    
    // Inyectar Configuración Básica
    db.data.config = { bankroll: 1000, kellyFraction: 0.25 };

    // Inyectar Partido Favorito en DB (Mock de Pinnacle)
    const now = new Date().toISOString();
    
    // Limpiamos la lista para aislar el test
    db.data.upcomingMatches = [
        {
            home: "Manchester City", // Favorito claro
            away: "Luton Town",
            date: now, // Jugando ahora
            league: { name: "Premier League Test" },
            realProbabilities: {
                home: 80.0, // 80% Probabilidad Real
                draw: 15.0,
                away: 5.0
            }
        }
    ];

    console.log('📝 Escenario: Man City (80% Prob) pierde 0-1 al min 35.');
    console.log('   Esperamos detectar oportunidad porque la cuota subió a 2.15');

    try {
        // 3. Ejecutar Scanner
        const opportunities = await scanLiveOpportunities();

        // 4. Validar Resultados
        console.log('\n📊 RESULTADOS:');
        const volteadaOp = opportunities.find(op => op.type === 'LA_VOLTEADA');

        if (volteadaOp) {
            console.log('✅ ÉXITO: Estrategia detectada correctamente.');
            console.log('--------------------------------------------------');
            console.log(`Partído: ${volteadaOp.match}`);
            console.log(`Mercado: ${volteadaOp.market}`);
            console.log(`Score:   ${volteadaOp.score}`);
            console.log(`Tiempo:  ${volteadaOp.time}`);
            console.log(`EV:      ${volteadaOp.ev.toFixed(2)}%`);
            console.log(`Stake:   $${volteadaOp.kellyStake.toFixed(2)}`);
            console.log('--------------------------------------------------');
        } else {
            console.error('❌ FALLO: No se detectó "La Volteada".');
            console.log('Oportunidades encontradas:', opportunities);
        }
    } catch (e) {
        console.error("CRASH:", e);
    }
};

runTest();
