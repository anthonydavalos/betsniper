import { readMergedDbSync } from './lib/read-split-db.mjs';

const db = readMergedDbSync();
console.log('Keys:', Object.keys(db));
if (db.pinnacle) {
	const pending = Array.isArray(db?.pinnacle?.pendingTickets) ? db.pinnacle.pendingTickets.length : 0;
	const history = Array.isArray(db?.pinnacle?.history) ? db.pinnacle.history.length : 0;
	console.log('Pinnacle Pending:', pending, '| History:', history);
}
if (Array.isArray(db.matches)) console.log('Matches Count:', db.matches.length);
if (Array.isArray(db.events)) console.log('Events Count:', db.events.length);
if (Array.isArray(db.scanned_prematch)) console.log('Scanned Prematch Count:', db.scanned_prematch.length);

