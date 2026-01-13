import { findMatch, normalizeName } from '../src/utils/teamMatcher.js';

// DATOS DE PRUEBA (Ground Truth proporcionado por el usuario)
const knownMatches = [
    { api1_home: "Sheffield United W", api2_home: "Sheffield United (F)", match_time_utc: "2026-01-12T19:00:00Z" },
    { api1_home: "Huesca", api2_home: "Huesca", match_time_utc: "2026-01-12T19:30:00Z" },
    { api1_home: "Salernitana", api2_home: "Salernitana", match_time_utc: "2026-01-12T19:30:00Z" },
    { api1_home: "Giugliano", api2_home: "Giugliano", match_time_utc: "2026-01-12T19:30:00Z" },
    { api1_home: "Juventus", api2_home: "Juventus", match_time_utc: "2026-01-12T19:45:00Z" },
    { api1_home: "Carshalton Athletic", api2_home: "Carshalton", match_time_utc: "2026-01-12T19:45:00Z" },
    { api1_home: "Sevilla", api2_home: "Sevilla FC", match_time_utc: "2026-01-12T20:00:00Z" },
    { api1_home: "Alanyaspor", api2_home: "Alanyaspor", match_time_utc: "2026-01-13T10:00:00Z" },
    { api1_home: "Başakşehir", api2_home: "Basaksehir", match_time_utc: "2026-01-13T12:30:00Z" },
    { api1_home: "Al-Raed", api2_home: "Al Raed FC", match_time_utc: "2026-01-13T12:35:00Z" },
    { api1_home: "Al Orubah", api2_home: "Al-Orobah", match_time_utc: "2026-01-13T12:45:00Z" },
    { api1_home: "Al Okhdood", api2_home: "Al-Okhdood Club", match_time_utc: "2026-01-13T15:25:00Z" },
    { api1_home: "VfB Stuttgart", api2_home: "Stuttgart", match_time_utc: "2026-01-13T17:30:00Z" },
    { api1_home: "Al-Fateh", api2_home: "Al Fateh SC", match_time_utc: "2026-01-13T17:30:00Z" },
    { api1_home: "Damac", api2_home: "Damac FC", match_time_utc: "2026-01-13T17:30:00Z" },
    { api1_home: "Fethiyespor", api2_home: "Fethiyespor", match_time_utc: "2026-01-13T17:30:00Z" },
    { api1_home: "Real Madrid W", api2_home: "Real Madrid CF (F)", match_time_utc: "2026-01-13T18:00:00Z" },
    { api1_home: "Antwerp", api2_home: "Royal Antwerpen FC", match_time_utc: "2026-01-13T19:30:00Z" }
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
