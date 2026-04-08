import fs from 'fs';
import axios from 'axios';

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const rows = Array.isArray(db.upcomingMatches) ? db.upcomingMatches : [];
const now = Date.now();

const candidates = rows
  .filter((r) => r && r.id && r.odds && r.odds.doubleChance && new Date(r.date || 0).getTime() > now)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

if (candidates.length === 0) {
  throw new Error('No hay candidatos DC en upcomingMatches.');
}

const pickMap = [
  { k: 'homeDraw', sel: '1X', action: 'Apostar 1X' },
  { k: 'homeAway', sel: '12', action: 'Apostar 12' },
  { k: 'drawAway', sel: 'X2', action: 'Apostar X2' }
];

let chosen = null;
for (const c of candidates) {
  const dc = c.odds?.doubleChance || {};
  const p = pickMap.find((x) => Number(dc?.[x.k]) > 1.01);
  if (p) {
    chosen = { c, p, odd: Number(dc[p.k]) };
    break;
  }
}

if (!chosen) {
  throw new Error('No hay cuota DC utilizable en candidatos.');
}

const c = chosen.c;
const opp = {
  type: 'PREMATCH_VALUE',
  strategy: 'PREMATCH_VALUE',
  eventId: String(c.id),
  pinnacleId: String(c.id),
  match: c.match || `${c.home || ''} vs ${c.away || ''}`,
  league: c.league?.name || c.league || '',
  date: c.date,
  market: 'Double Chance',
  selection: chosen.p.sel,
  action: chosen.p.action,
  odd: Number(chosen.odd.toFixed(3)),
  price: Number(chosen.odd.toFixed(3)),
  kellyStake: 1.05,
  ev: 0.01,
  realProb: 55,
  provider: 'pinnacle',
  source: 'CONTROLLED_E2E_DC'
};

const api = axios.create({ baseURL: 'http://localhost:3000', timeout: 30000 });

const prep = (await api.post('/api/pinnacle/prepare', opp)).data;
const ticketId = prep?.ticket?.id;
if (!ticketId) {
  throw new Error('Prepare no devolvio ticketId.');
}

const dry = (await api.post(`/api/pinnacle/real/dryrun/${ticketId}`)).data;
const marketKey = dry?.draft?.preview?.marketKey || dry?.draft?.payload?.selections?.[0]?.marketKey || null;
if (String(marketKey || '').toLowerCase() !== 's;0;dc') {
  throw new Error(`Dryrun no resolvio marketKey DC. marketKey=${marketKey}`);
}

const conf = (await api.post(`/api/pinnacle/real/confirm-fast/${ticketId}`)).data;
const provider = conf?.providerResponse || {};
const accepted = conf?.ticket?.realPlacement?.accepted || {};

console.log(JSON.stringify({
  step: 'REAL_DC_E2E',
  candidate: {
    eventId: c.id,
    match: opp.match,
    start: c.date,
    league: opp.league,
    selection: opp.selection,
    odd: opp.odd,
    stake: opp.kellyStake
  },
  ticketId,
  dryrun: {
    marketKey,
    designation: dry?.draft?.preview?.designation || null,
    price: dry?.draft?.preview?.price || null,
    stake: dry?.draft?.preview?.stake || null
  },
  confirm: {
    ticketStatus: conf?.ticket?.status || null,
    providerStatus: provider?.status || null,
    providerRequestId: provider?.requestId || null,
    providerBetId: provider?.id || accepted?.providerBetId || null,
    acceptedOdd: provider?.price || accepted?.acceptedOdd || null,
    acceptedStake: provider?.stake || accepted?.acceptedStake || null
  },
  mirroredBetId: conf?.mirroredBet?.id || null
}, null, 2));
