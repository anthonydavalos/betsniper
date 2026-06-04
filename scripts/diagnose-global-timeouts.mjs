#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const DEFAULT_BASE_URL = process.env.HEALTH_BASE_URL || 'http://localhost:3000';
const DEFAULT_INTERVAL_MS = Math.max(250, Number(process.env.GLOBAL_DIAG_INTERVAL_MS || 1000));
const DEFAULT_DURATION_MINUTES = Math.max(1, Number(process.env.GLOBAL_DIAG_DURATION_MINUTES || 10));
const DEFAULT_TIMEOUT_MS = Math.max(500, Number(process.env.GLOBAL_DIAG_TIMEOUT_MS || 1200));

const ENDPOINTS = [
  '/api/health',
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
  return found.slice(name.length + 1);
};

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const BASE_URL = getArgValue('--base', DEFAULT_BASE_URL);
const INTERVAL_MS = toPositiveInt(getArgValue('--interval', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS);
const DURATION_MINUTES = toPositiveInt(getArgValue('--minutes', DEFAULT_DURATION_MINUTES), DEFAULT_DURATION_MINUTES);
const TIMEOUT_MS = toPositiveInt(getArgValue('--timeout', DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
const SAMPLES = Math.max(1, Math.floor((DURATION_MINUTES * 60 * 1000) / INTERVAL_MS));
const GLOBAL_STALL_MIN_ENDPOINTS = Math.max(2, Math.floor(ENDPOINTS.length / 2));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString();

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const runRequest = async (endpoint) => {
  const start = Date.now();
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort('timeout');
  }, TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'GET',
      signal: controller.signal
    });

    return {
      endpoint,
      status: response.status,
      ok: response.ok,
      timedOut: false,
      latencyMs: Date.now() - start,
      error: null
    };
  } catch (error) {
    return {
      endpoint,
      status: 0,
      ok: false,
      timedOut: didTimeout || error?.name === 'AbortError',
      latencyMs: Date.now() - start,
      error: didTimeout ? 'timeout' : (error?.message || 'request_error')
    };
  } finally {
    clearTimeout(timer);
  }
};

const identifyBottleneck = ({ endpointStats, stallSamples }) => {
  const ranked = [...endpointStats]
    .map(([endpoint, stats]) => ({
      endpoint,
      timeoutRate: stats.timeoutCount / Math.max(1, stats.totalCount),
      errorRate: stats.errorCount / Math.max(1, stats.totalCount),
      p95Ms: percentile(stats.okLatencies, 95),
      p99Ms: percentile(stats.okLatencies, 99),
      maxMs: stats.okLatencies.length ? Math.max(...stats.okLatencies) : 0,
      okCount: stats.okCount,
      totalCount: stats.totalCount
    }))
    .sort((a, b) => {
      if (b.timeoutRate !== a.timeoutRate) return b.timeoutRate - a.timeoutRate;
      if (b.p95Ms !== a.p95Ms) return b.p95Ms - a.p95Ms;
      return b.maxMs - a.maxMs;
    });

  const worstEndpoint = ranked[0] || null;
  const healthStalls = stallSamples.filter((sample) => {
    const health = sample.results.find((r) => r.endpoint === '/api/health');
    return Boolean(health && (health.timedOut || health.status === 0));
  }).length;
  const healthImpactRate = stallSamples.length ? (healthStalls / stallSamples.length) : 0;

  if (stallSamples.length >= 3 && healthImpactRate >= 0.7) {
    return {
      type: 'global_server_stall',
      reason: 'Se detectaron timeouts simultaneos en multiples rutas incluyendo /api/health, lo que apunta a pausa global del proceso (event loop bloqueado o saturacion severa).',
      healthImpactRate,
      worstEndpoint
    };
  }

  return {
    type: 'route_hotspot',
    reason: `La ruta con mayor presion fue ${worstEndpoint?.endpoint || 'n/a'} por tasa de timeout/latencia.`,
    healthImpactRate,
    worstEndpoint
  };
};

const main = async () => {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const endpointStats = new Map(ENDPOINTS.map((ep) => [ep, {
    okCount: 0,
    timeoutCount: 0,
    errorCount: 0,
    totalCount: 0,
    okLatencies: []
  }]));
  const samples = [];
  const stallSamples = [];

  console.log('=== Global Timeout Diagnostic ===');
  console.log(`base=${BASE_URL}`);
  console.log(`durationMinutes=${DURATION_MINUTES} intervalMs=${INTERVAL_MS} timeoutMs=${TIMEOUT_MS}`);
  console.log(`samples=${SAMPLES} endpoints=${ENDPOINTS.length} globalStallMinEndpoints=${GLOBAL_STALL_MIN_ENDPOINTS}`);

  for (let i = 1; i <= SAMPLES; i += 1) {
    const scheduledAtMs = startedMs + ((i - 1) * INTERVAL_MS);
    const waitMs = scheduledAtMs - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const launchedAtMs = Date.now();
    const driftMs = launchedAtMs - scheduledAtMs;

    const results = await Promise.all(ENDPOINTS.map((endpoint) => runRequest(endpoint)));
    const timeoutOrErrorCount = results.filter((r) => r.timedOut || r.status === 0).length;
    const isGlobalStall = timeoutOrErrorCount >= GLOBAL_STALL_MIN_ENDPOINTS;

    for (const result of results) {
      const stats = endpointStats.get(result.endpoint);
      if (!stats) continue;
      stats.totalCount += 1;
      if (result.timedOut) {
        stats.timeoutCount += 1;
      } else if (result.status === 0) {
        stats.errorCount += 1;
      } else if (result.status >= 200 && result.status < 400) {
        stats.okCount += 1;
        stats.okLatencies.push(result.latencyMs);
      } else {
        stats.errorCount += 1;
      }
    }

    const sample = {
      i,
      at: nowIso(),
      driftMs,
      timeoutOrErrorCount,
      globalStall: isGlobalStall,
      results
    };

    samples.push(sample);
    if (isGlobalStall) stallSamples.push(sample);

    const compact = results
      .map((r) => {
        if (r.timedOut) return `${r.endpoint}=TIMEOUT`;
        if (r.status === 0) return `${r.endpoint}=ERR`;
        return `${r.endpoint}=${r.status}@${r.latencyMs}ms`;
      })
      .join(' | ');

    console.log(`[${i}/${SAMPLES}] drift=${driftMs}ms stalls=${timeoutOrErrorCount}/${ENDPOINTS.length} global=${isGlobalStall ? 'Y' : 'N'} :: ${compact}`);
  }

  const finishedAt = nowIso();
  const elapsedMs = Date.now() - startedMs;

  const endpointSummary = ENDPOINTS.map((endpoint) => {
    const stats = endpointStats.get(endpoint);
    const total = stats?.totalCount || 0;
    const avgMs = stats?.okLatencies?.length
      ? stats.okLatencies.reduce((acc, cur) => acc + cur, 0) / stats.okLatencies.length
      : 0;
    return {
      endpoint,
      ok: stats?.okCount || 0,
      timeouts: stats?.timeoutCount || 0,
      errors: stats?.errorCount || 0,
      total,
      timeoutRate: Number((((stats?.timeoutCount || 0) / Math.max(1, total)) * 100).toFixed(2)),
      p95Ms: Math.round(percentile(stats?.okLatencies || [], 95)),
      p99Ms: Math.round(percentile(stats?.okLatencies || [], 99)),
      avgMs: Math.round(avgMs)
    };
  });

  const bottleneck = identifyBottleneck({ endpointStats, stallSamples });
  const driftValues = samples.map((s) => s.driftMs).filter((n) => Number.isFinite(n));
  const driftP95Ms = Math.round(percentile(driftValues, 95));
  const driftMaxMs = driftValues.length ? Math.max(...driftValues) : 0;

  const summary = {
    startedAt,
    finishedAt,
    elapsedMinutes: Number((elapsedMs / 60000).toFixed(2)),
    baseUrl: BASE_URL,
    intervalMs: INTERVAL_MS,
    timeoutMs: TIMEOUT_MS,
    samples: SAMPLES,
    globalStallSamples: stallSamples.length,
    globalStallRate: Number(((stallSamples.length / Math.max(1, SAMPLES)) * 100).toFixed(2)),
    driftP95Ms,
    driftMaxMs,
    bottleneck,
    endpoints: endpointSummary
  };

  const outDir = path.resolve('data');
  const stamp = nowIso().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `global-timeout-diag-${stamp}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ summary, samples }, null, 2)}\n`, 'utf8');

  console.log('\n=== Summary ===');
  console.log(`globalStalls=${summary.globalStallSamples}/${summary.samples} (${summary.globalStallRate}%) driftP95=${summary.driftP95Ms}ms driftMax=${summary.driftMaxMs}ms`);
  for (const endpoint of endpointSummary) {
    console.log(
      `${endpoint.endpoint} | ok=${endpoint.ok}/${endpoint.total} timeouts=${endpoint.timeouts} errors=${endpoint.errors} avg=${endpoint.avgMs}ms p95=${endpoint.p95Ms}ms p99=${endpoint.p99Ms}ms`
    );
  }
  console.log(`bottleneckType=${summary.bottleneck.type}`);
  console.log(`bottleneckReason=${summary.bottleneck.reason}`);
  if (summary.bottleneck.worstEndpoint) {
    const w = summary.bottleneck.worstEndpoint;
    console.log(
      `worstEndpoint=${w.endpoint} timeoutRate=${(w.timeoutRate * 100).toFixed(2)}% p95=${Math.round(w.p95Ms)}ms p99=${Math.round(w.p99Ms)}ms max=${Math.round(w.maxMs)}ms`
    );
  }
  console.log(`report=${outPath}`);
};

main().catch((error) => {
  console.error('global-timeout-diag failed:', error?.message || error);
  process.exit(1);
});
