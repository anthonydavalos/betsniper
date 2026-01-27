
import { findMatch, normalizeName, TEAM_ALIASES } from '../src/utils/teamMatcher.js';

const cases = [
    {
        pinTeam: "Floridsdorfer AC",
        pinDate: "2026-01-23T14:30:00Z", // Estimated
        altTeam: "FAC Wien",
        altName: "FAC Wien vs. Bravo"
    },
    {
        pinTeam: "Al Hussein SC",
        pinDate: "2026-01-23T16:00:00Z", // Estimated
        altTeam: "AL Hussein Irbid",
        altName: "AL Hussein Irbid vs. Al Jazeera Amman"
    }
];

console.log("--- DEBUGGING MISSING MATCHES ---");

cases.forEach((c, idx) => {
    console.log(`\nCASE ${idx + 1}: ${c.pinTeam} vs ${c.altTeam}`);
    
    const normTarget = normalizeName(c.pinTeam);
    const aliasTarget = TEAM_ALIASES[normTarget];
    
    const normCand = normalizeName(c.altTeam);
    const aliasCand = TEAM_ALIASES[normCand];

    console.log(`Target: '${c.pinTeam}' -> Norm: '${normTarget}' -> Alias: '${aliasTarget}'`);
    console.log(`Cand:   '${c.altTeam}' -> Norm: '${normCand}'   -> Alias: '${aliasCand}'`);

    // Simulate candidate object
    const candidate = {
        id: 123 + idx,
        name: c.altName,
        home: c.altTeam,
        startDate: c.pinDate // Assume timestamps match for logic check
    };

    const match = findMatch(c.pinTeam, c.pinDate, [candidate]);
    
    if (match) {
        console.log("✅ MATCH SUCCESS:", match.method);
    } else {
        console.log("❌ MATCH FAILED");
    }
});
