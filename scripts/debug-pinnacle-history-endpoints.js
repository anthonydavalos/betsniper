import fs from 'fs';
import path from 'path';
import axios from 'axios';
import https from 'https';

const ARCADIA_BASE = 'https://api.arcadia.pinnacle.com/0.1';
const TOKEN_FILE = path.resolve('data', 'pinnacle_token.json');

const DEFAULT_START = new Date(Date.now() - (120 * 24 * 60 * 60 * 1000)).toISOString();
const DEFAULT_END = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString();

const CANDIDATE_ENDPOINTS = [
  '/bets',
  '/bets?limit=50',
  `/bets?startDate=${encodeURIComponent(DEFAULT_START)}&endDate=${encodeURIComponent(DEFAULT_END)}&status=open`,
  `/bets?startDate=${encodeURIComponent(DEFAULT_START)}&endDate=${encodeURIComponent(DEFAULT_END)}&status=settled`,
  `/bets?startDate=${encodeURIComponent(DEFAULT_START)}&endDate=${encodeURIComponent(DEFAULT_END)}&status=pending_acceptance`,
  `/bets?startDate=${encodeURIComponent(DEFAULT_START)}&endDate=${encodeURIComponent(DEFAULT_END)}&status=all`,
  '/bets/open',
  '/bets/settled',
  '/bets/history',
  '/bets/straight',
  '/bets/straight?limit=50',
  '/bets/straight?status=open',
  '/bets/straight?status=settled',
  '/bets/straight/open',
  '/bets/straight/settled',
  '/accounts/bets',
  '/accounts/transactions',
  '/wallet/transactions',
  '/transactions',
  `/transactions?startDate=${encodeURIComponent(DEFAULT_START)}&endDate=${encodeURIComponent(DEFAULT_END)}`,
  '/statement',
  '/bet-history',
  '/open-bets'
];

const summarizeBody = (body) => {
  if (Array.isArray(body)) return { shape: `array(${body.length})`, keys: [] };
  if (body && typeof body === 'object') {
    return {
      shape: 'object',
      keys: Object.keys(body).slice(0, 12)
    };
  }
  return { shape: typeof body, keys: [] };
};

const compactDetail = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  for (const key of ['title', 'detail', 'status', 'type', 'errors', 'message']) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return Object.keys(out).length > 0 ? out : null;
};

const run = async () => {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error(`Token no encontrado: ${TOKEN_FILE}`);
    process.exit(1);
  }

  const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const authHeaders = tokenData?.headers || {};

  if (!authHeaders || Object.keys(authHeaders).length === 0) {
    console.error('Headers vacios en pinnacle_token.json');
    process.exit(1);
  }

  console.log('=== Arcadia History Endpoint Probe ===');
  console.log(`Base: ${ARCADIA_BASE}`);
  console.log(`Date window: ${DEFAULT_START} -> ${DEFAULT_END}`);
  console.log(`Candidates: ${CANDIDATE_ENDPOINTS.length}`);

  for (const endpoint of CANDIDATE_ENDPOINTS) {
    const url = `${ARCADIA_BASE}${endpoint}`;

    try {
      const response = await axios({
        method: 'GET',
        url,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: 'https://www.pinnacle.com',
          Referer: 'https://www.pinnacle.com/',
          ...authHeaders
        },
        timeout: 15000,
        validateStatus: () => true,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });

      const summary = summarizeBody(response.data);
      const keyText = summary.keys.length > 0 ? ` keys=[${summary.keys.join(',')}]` : '';
      console.log(`${response.status}\t${endpoint}\t${summary.shape}${keyText}`);
      if (response.status >= 200 && response.status < 300) {
        const body = response.data;
        if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.bets)) {
          const sample = body.bets[0] || null;
          console.log(`  bets.count=${body.bets.length} summaryKeys=${Object.keys(body.summary || {}).join(',')}`);
          if (sample && typeof sample === 'object') {
            console.log(`  bets.sample.keys=[${Object.keys(sample).slice(0, 24).join(',')}]`);
          }
        }
        if (Array.isArray(body) && endpoint.startsWith('/transactions')) {
          const tx = body[0] || null;
          console.log(`  tx.count=${body.length}`);
          if (tx && typeof tx === 'object') {
            console.log(`  tx.sample.keys=[${Object.keys(tx).slice(0, 24).join(',')}]`);
          }
        }
      }
      if (response.status >= 400) {
        const detail = compactDetail(response.data);
        if (detail) console.log(`  detail=${JSON.stringify(detail)}`);
      }
    } catch (error) {
      console.log(`ERR\t${endpoint}\t${error?.message || error}`);
    }
  }
};

run().catch((error) => {
  console.error('Probe failed:', error?.message || error);
  process.exit(1);
});
