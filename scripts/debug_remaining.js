import { normalizeName, getSimilarity, getTokenSimilarity, TEAM_ALIASES } from '../src/utils/teamMatcher.js';

const cases = [
    { a: 'Auckland FC II vs Bula', b: 'Auckland FC Reserves vs. Bula FC' },
    { a: 'Mahar United vs Ispe', b: 'Sagaing vs. Ispe FC' },
    { a: 'WE SC vs Maleyet Kafr El Zayiat', b: 'Telecom Egypt vs. Maleyeit Kafr El Zayiat' }
];

function parseTeams(matchString) {
    const parts = matchString.split(/ vs\.? /i);
    if (parts.length === 2) return [parts[0].trim(), parts[1].trim()];
    if (matchString.includes(' vs ')) return matchString.split(' vs ').map(t => t.trim());
    return [matchString, ''];
}

console.log('í´ Deep Debug of Remaining 3 Failures...');

cases.forEach((c) => {
    const [homeA, awayA] = parseTeams(c.a);
    const [homeB, awayB] = parseTeams(c.b);

    console.log('\n--- Case: ' + c.a + ' vs ' + c.b + ' ---');

    // Home
    const h1 = normalizeName(homeA);
    const h2 = normalizeName(homeB);
    const hAlias1 = TEAM_ALIASES[h1];
    const hAlias2 = TEAM_ALIASES[h2];
    
    console.log('HOME Check:');
    console.log('  Original:', homeA, '|', homeB);
    console.log('  Norm:', h1, '|', h2);
    console.log('  Alias Lookup:', h1, '->', hAlias1, '|', h2, '->', hAlias2);
    console.log('  Token Sim:', getTokenSimilarity(h1, h2).toFixed(2));
    console.log('  Fuzzy Sim:', getSimilarity(h1, h2).toFixed(2));

    // Away
    const a1 = normalizeName(awayA);
    const a2 = normalizeName(awayB);
    
    console.log('AWAY Check:');
    console.log('  Original:', awayA, '|', awayB);
    console.log('  Norm:', a1, '|', a2);
    console.log('  Token Sim:', getTokenSimilarity(a1, a2).toFixed(2));
    console.log('  Fuzzy Sim:', getSimilarity(a1, a2).toFixed(2));
});
