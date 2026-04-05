#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const pref = `${name}=`;
  const found = args.find((a) => a.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
};

const toPosInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const percentile = (values = [], p = 95) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = String(getArg('--base', process.env.HEALTH_BASE_URL || 'http://localhost:3000'));
const LABEL = String(getArg('--label', 'run')).trim().toLowerCase();
const DURATION_MS = toPosInt(getArg('--durationMs', '600000'), 600000);
const INTERVAL_MS = toPosInt(getArg('--intervalMs', '30000'), 30000);
const TIMEOUT_MS = toPosInt(getArg('--timeoutMs', '8000'), 8000);
const OUT_DIR = path.resolve('data', 'booky');

const ENDPOINTS = [
  '/api/portfolio',
  '/api/opportunities/live',
  '/api/opportunities/prematch',
  '/api/booky/account?historyLimit=120',
  '/api/booky/kelly-diagnostics?horizonBets=200&simulations=400&ruinThreshold=0.5',
  '/api/opportunities/live/diagnostics?limit=20'
];

const fetchWithTiming = async (url) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort('timeout');
  }, TIMEOUT_MS);

  const startedAt = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    return {
      ok: res.ok,
      status: Number(res.status || 0),
      latencyMs: Date.now() - startedAt,
      timedOut: false,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      timedOut: timedOut || error?.name === 'AbortError',
      error: timedOut ? 'timeout' : (error?.message || 'request_error'),
      data: null
    };
  } finally {
    clearTimeout(timeout);
  }
};

const waitForServer = async () => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const probe = await fetchWithTiming(`${BASE}/api/portfolio`);
    if (probe.status >= 200 && probe.status < 500 && !probe.timedOut) return true;
    await sleep(2000);
  }
  return false;
};

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`[validate-hybrid-runtime] label=${LABEL} base=${BASE} durationMs=${DURATION_MS} intervalMs=${INTERVAL_MS}`);
const up = await waitForServer();
if (!up) {
  console.error('[validate-hybrid-runtime] server not reachable in 120s');
  process.exit(2);
}

const startedAtIso = new Date().toISOString();
const startedAtMs = Date.now();
const rows = [];
let sample = 0;

while ((Date.now() - startedAtMs) < DURATION_MS) {
  sample += 1;
  const at = new Date().toISOString();
  const row = { at, sample, endpoints: {}, diagnostics: null };

  for (const ep of ENDPOINTS) {
    const result = await fetchWithTiming(`${BASE}${ep}`);
    row.endpoints[ep] = {
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      timedOut: result.timedOut,
      error: result.error || null
    };

    if (ep.includes('/api/opportunities/live/diagnostics') && result?.data) {
      row.diagnostics = {
        generatedAt: result.data?.generatedAt || null,
        pipeline: result.data?.pipeline || null,
        acitySocketDiagnostics: result.data?.acitySocketDiagnostics || null
      };
    }
  }

  rows.push(row);

  const liveDiag = row?.diagnostics?.pipeline || {};
  console.log(
    `[validate-hybrid-runtime] sample=${sample} ` +
    `pollMode=${liveDiag?.pollMode || 'n/a'} ` +
    `hybrid=${Number(liveDiag?.hybridSelectiveCycle || 0)} ` +
    `rawCount=${Number(liveDiag?.rawCount || 0)} finalCount=${Number(liveDiag?.finalCount || 0)}`
  );

  await sleep(INTERVAL_MS);
}

const buildEndpointSummary = (endpoint) => {
  const stats = rows.map((r) => r?.endpoints?.[endpoint]).filter(Boolean);
  const okRows = stats.filter((s) => s.status >= 200 && s.status < 400);
  const latencies = okRows.map((s) => Number(s.latencyMs || 0)).filter((v) => Number.isFinite(v));
  const avgMs = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95Ms = latencies.length ? percentile(latencies, 95) : 0;
  const timeoutCount = stats.filter((s) => s.timedOut).length;

  return {
    endpoint,
    samples: stats.length,
    okCount: okRows.length,
    timeoutCount,
    avgMs: Number(avgMs.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2))
  };
};

const diagnosticsRows = rows
  .map((r) => r?.diagnostics?.pipeline)
  .filter((p) => p && typeof p === 'object');

const pollModeBreakdown = {};
for (const p of diagnosticsRows) {
  const key = String(p?.pollMode || 'unknown');
  pollModeBreakdown[key] = (pollModeBreakdown[key] || 0) + 1;
}

const hybridCycles = diagnosticsRows.filter((p) => Number(p?.hybridSelectiveCycle || 0) > 0).length;
const fullScanCycles = diagnosticsRows.filter((p) => Number(p?.rawCount || 0) > 0 || Number(p?.liveEventCount || 0) > 0).length;

const summary = {
  label: LABEL,
  startedAt: startedAtIso,
  endedAt: new Date().toISOString(),
  durationMs: DURATION_MS,
  intervalMs: INTERVAL_MS,
  samples: rows.length,
  endpoints: ENDPOINTS.map(buildEndpointSummary),
  scanner: {
    diagnosticsSamples: diagnosticsRows.length,
    hybridCycles,
    fullScanCycles,
    hybridRatio: diagnosticsRows.length > 0 ? Number((hybridCycles / diagnosticsRows.length).toFixed(4)) : 0,
    pollModeBreakdown
  }
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(OUT_DIR, `hybrid-validation-${LABEL}-${stamp}.json`);
const latestPath = path.join(OUT_DIR, `hybrid-validation-${LABEL}.latest.json`);
fs.writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2), 'utf8');
fs.writeFileSync(latestPath, JSON.stringify({ summary, rows }, null, 2), 'utf8');

console.log(`[validate-hybrid-runtime] saved=${outPath}`);
console.log(`[validate-hybrid-runtime] savedLatest=${latestPath}`);
