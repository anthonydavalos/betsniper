#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.HEALTH_BASE_URL || 'http://localhost:3000';
const DEFAULT_SAMPLES = Number(process.env.HEALTH_LATENCY_SAMPLES || 3);
const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_LATENCY_TIMEOUT_MS || 8000);
const DEFAULT_INTERVAL_MS = Number(process.env.HEALTH_LATENCY_INTERVAL_MS || 1200);

const ENDPOINTS = [
  '/api/portfolio',
  '/api/opportunities/live',
  '/api/opportunities/prematch',
  '/api/booky/account?historyLimit=120',
  '/api/booky/kelly-diagnostics?horizonBets=200&simulations=400&ruinThreshold=0.5'
];

const args = process.argv.slice(2);

const getArgValue = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  if (!found) return fallback;
  return found.split('=').slice(1).join('=');
};

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const BASE_URL = getArgValue('--base', DEFAULT_BASE_URL);
const SAMPLES = toPositiveInt(getArgValue('--samples', DEFAULT_SAMPLES), DEFAULT_SAMPLES);
const TIMEOUT_MS = toPositiveInt(getArgValue('--timeout', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
const INTERVAL_MS = toPositiveInt(getArgValue('--interval', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const runRequest = async (path) => {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort('timeout');
  }, TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      signal: controller.signal
    });

    const totalMs = Date.now() - start;
    return {
      path,
      ok: response.ok,
      status: response.status,
      totalMs,
      timedOut: false
    };
  } catch (error) {
    const totalMs = Date.now() - start;
    const timedOut = didTimeout || error?.name === 'AbortError';
    return {
      path,
      ok: false,
      status: 0,
      totalMs,
      timedOut,
      error: timedOut ? 'timeout' : (error?.message || 'request_error')
    };
  } finally {
    clearTimeout(timeout);
  }
};

const main = async () => {
  console.log('=== BetSniper Latency Health ===');
  console.log(`base=${BASE_URL}`);
  console.log(`samples=${SAMPLES} timeoutMs=${TIMEOUT_MS} intervalMs=${INTERVAL_MS}`);

  const byEndpoint = new Map(ENDPOINTS.map((ep) => [ep, []]));

  for (let i = 1; i <= SAMPLES; i += 1) {
    console.log(`\n--- Sample ${i}/${SAMPLES} ---`);
    for (const endpoint of ENDPOINTS) {
      const result = await runRequest(endpoint);
      byEndpoint.get(endpoint).push(result);

      const marker = result.timedOut
        ? 'TIMEOUT'
        : (result.status > 0 ? `HTTP ${result.status}` : `ERROR ${result.error || 'request_error'}`);
      console.log(`${endpoint} -> ${marker} in ${(result.totalMs / 1000).toFixed(3)}s`);
    }

    if (i < SAMPLES) {
      await sleep(INTERVAL_MS);
    }
  }

  console.log('\n=== Summary ===');
  for (const endpoint of ENDPOINTS) {
    const rows = byEndpoint.get(endpoint) || [];
    const okRows = rows.filter((r) => r.status >= 200 && r.status < 400);
    const timeoutRows = rows.filter((r) => r.timedOut);
    const latencies = okRows.map((r) => r.totalMs);

    const avgMs = latencies.length
      ? (latencies.reduce((acc, cur) => acc + cur, 0) / latencies.length)
      : 0;
    const p95Ms = latencies.length ? percentile(latencies, 95) : 0;

    console.log(
      `${endpoint} | ok=${okRows.length}/${rows.length} timeouts=${timeoutRows.length} avg=${(avgMs / 1000).toFixed(3)}s p95=${(p95Ms / 1000).toFixed(3)}s`
    );
  }

  const totalTimeouts = Array.from(byEndpoint.values())
    .flat()
    .filter((r) => r.timedOut).length;

  if (totalTimeouts > 0) {
    process.exitCode = 2;
  }
};

main().catch((error) => {
  console.error('health-latency failed:', error?.message || error);
  process.exit(1);
});
