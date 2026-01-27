
import { isSameTeam, normalizeTeamName } from '../src/utils/teamMatcher.js';

// Mock isTimeMatch from prematchScannerService
const isTimeMatch = (date1, date2) => {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const diff = Math.abs(d1 - d2);
    const minutes = diff / (1000 * 60);
    return minutes <= 25; // standard tolerance
};

const pin = { home: "Dinamo Zagreb", date: "2026-01-22T20:00:00Z" };
const alt = { name: "GNK Dinamo vs. FCSB", startDate: "2026-01-22T20:00:00Z", competitors: [43751, 43871] }; // Assuming IDs from user snippet

console.log("--- DEBUG START ---");

// 1. Check Team Name Normalization
const pinNorm = normalizeTeamName(pin.home);
const altHomeNameRaw = alt.name.split(" vs. ")[0];
const altNorm = normalizeTeamName(altHomeNameRaw);

console.log(`Pin Raw: '${pin.home}' -> Norm: '${pinNorm}'`);
console.log(`Alt Raw: '${altHomeNameRaw}' -> Norm: '${altNorm}'`);

// 2. Check isSameTeam
const isMatch = isSameTeam(altHomeNameRaw, pin.home);
console.log(`isSameTeam('${altHomeNameRaw}', '${pin.home}') = ${isMatch}`);

// 3. Check Manual 'includes' logic
const a = altNorm.toLowerCase();
const b = pinNorm.toLowerCase();
console.log(`Manual includes check: '${b}'.includes('${a}') = ${b.includes(a)}`);
console.log(`Manual includes check: '${a}'.includes('${b}') = ${a.includes(b)}`);

console.log("--- DEBUG END ---");
