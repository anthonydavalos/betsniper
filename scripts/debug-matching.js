import { findMatch, normalizeName } from '../src/utils/teamMatcher.js';

// DATOS DE PRUEBA (Nuevos casos problemáticos)
const knownMatches = [
    { api1_home: "Hampton and Richmond Borough", api2_home: "Hampton & Richmond", match_time_utc: "2026-01-17T15:00:00Z" },
    { api1_home: "Correcaminos de la UAT III", api2_home: "Correcaminos U.A.T. Reserves", match_time_utc: "2026-01-16T16:00:00Z" },
    { api1_home: "Elche Ilicitano", api2_home: "Elche B", match_time_utc: "2026-01-17T16:00:00Z" },
    { api1_home: "Hertha BSC", api2_home: "Hertha Berlin", match_time_utc: "2026-01-17T19:30:00Z" },
    { api1_home: "Negele Arsi Ketema", api2_home: "Negelle Arsi", match_time_utc: "2026-01-16T12:00:00Z" },
    // Previous known working ones just to ensure no regression
    { api1_home: "Sheffield United W", api2_home: "Sheffield United (F)", match_time_utc: "2026-01-12T19:00:00Z" },
    { api1_home: "Al Orubah", api2_home: "Al-Orobah", match_time_utc: "2026-01-13T12:45:00Z" }
];

console.log('🧪 Iniciando Test de Algoritmo de Coincidencias...\n');

let successCount = 0;

knownMatches.forEach((tc, index) => {
    // Simulamos que API B (Altenar) es la lista de candidatos
    // Creamos un objeto falso de Altenar con el nombre B
    const mockAltenarCandidate = {
        name: `${tc.api2_home} vs UnEquipoRandom`,
        startDate: tc.match_time_utc
    };

    // Simulamos una lista de base de datos que contiene SOLO al correcto (para probar la lógica de nombre/fecha)
    // En la realidad, esta lista tendría 100+ items, pero la función findMatch filtra lo que no coincide.
    const candidates = [mockAltenarCandidate];

    // Ejecutamos el matcher: Buscamos API A (Target) dentro de la lista (Candidates)
    const result = findMatch(tc.api1_home, tc.match_time_utc, candidates);

    const normA = normalizeName(tc.api1_home);
    const normB = normalizeName(tc.api2_home);

    if (result) {
        console.log(`✅ [${index+1}] MATCH: "${tc.api1_home}" == "${tc.api2_home}" | Score: ${result.score.toFixed(2)} (${result.method})`);
        successCount++;
    } else {
        console.log(`❌ [${index+1}] FAIL:  "${tc.api1_home}" != "${tc.api2_home}"`);
        console.log(`   Debug Norm: "${normA}" vs "${normB}"`);
    }
});

console.log(`\n📊 Resultado Final: ${successCount}/${knownMatches.length} detectados correctamente.`);
