import db, { initDB } from '../src/db/database.js';
await initDB();
await db.read();

const local = Array.isArray(db.data?.booky?.history) ? db.data.booky.history : [];
const setA = new Set();
const setD = new Set();
for (const ticket of local) {
  const providerBetId = ticket?.realPlacement?.response?.bets?.[0]?.id;
  if (providerBetId === null || providerBetId === undefined || providerBetId === '') continue;
  const integration = String(ticket?.payload?.integration || '').trim().toLowerCase();
  if (integration === 'acity') setA.add(String(providerBetId));
  if (integration === 'doradobet') setD.add(String(providerBetId));
}

const acityRows = Array.isArray(db.data?.booky?.byProfile?.acity?.history)
  ? db.data.booky.byProfile.acity.history
  : [];

const emptyRows = acityRows
  .filter((row) => {
    const integration = String(row?.integration || '').trim();
    return !integration && row?.providerBetId !== null && row?.providerBetId !== undefined && row?.providerBetId !== '';
  })
  .map((row) => String(row.providerBetId));

let onlyA = 0;
let onlyD = 0;
let both = 0;
let none = 0;
for (const id of emptyRows) {
  const inA = setA.has(id);
  const inD = setD.has(id);
  if (inA && inD) both += 1;
  else if (inA) onlyA += 1;
  else if (inD) onlyD += 1;
  else none += 1;
}

console.log(JSON.stringify({
  emptyWithProvider: emptyRows.length,
  localAProviderIds: setA.size,
  localDProviderIds: setD.size,
  onlyA,
  onlyD,
  both,
  none
}, null, 2));
