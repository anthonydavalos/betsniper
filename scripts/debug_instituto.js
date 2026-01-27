
import { findMatch, normalizeName } from '../src/utils/teamMatcher.js';

const targetTeam = "Instituto";
const targetDate = "2026-01-23T01:15:00Z";

const candidateMatch = {
    id: 15064216,
    name: "Instituto AC Cordoba vs. Velez Sarsfield",
    startDate: "2026-01-23T01:15:00Z",
    competitors: [63476, 46817]
};

console.log("--- DEBUG INSTITUTO ---");
console.log(`Target: ${targetTeam}`);
console.log(`Candidate Name Raw: ${candidateMatch.name}`);

const splitMatch = candidateMatch.name.match(/\s+vs\.?\s+/i);
let candidateNameRaw = candidateMatch.name;
if (splitMatch) {
    candidateNameRaw = candidateNameRaw.split(splitMatch[0])[0];
}
console.log(`Candidate Home Extracted: ${candidateNameRaw}`);

const nT = normalizeName(targetTeam);
const nC = normalizeName(candidateNameRaw);

console.log(`Norm Target: '${nT}'`);
console.log(`Norm Candidate: '${nC}'`);

// We check aliases which are internal to module, but verified by effect
const candidates = [candidateMatch];
const result = findMatch(targetTeam, targetDate, candidates);

console.log("FindMatch Result:", result ? "FOUND" : "NOT FOUND");
if (result) {
    console.log("Score:", result.score);
    console.log("Method:", result.method);
}
