import fs from 'fs';

const endpoint = 'http://localhost:3000/api/opportunities/arbitrage/diagnostics/inventory';
const outFile = 'data/burnin-60m-final-check.json';
const sampleEveryMs = 5 * 60 * 1000;
const totalSamples = 13; // t0..t60

const toNum = (v, fallback = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const sorted = (arr) => [...arr].sort((a, b) => a - b);
const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = sorted(arr);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
};
const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null);
const stat = (arr) => ({
  min: arr.length ? Math.min(...arr) : null,
  max: arr.length ? Math.max(...arr) : null,
  avg: avg(arr),
  p90: percentile(arr, 90),
  p95: percentile(arr, 95),
  series: arr
});

function readLinkedFreshness() {
  const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
  const altenar = Array.isArray(db.altenarUpcoming) ? db.altenarUpcoming : [];
  const linkedSet = new Set(
    (Array.isArray(db.upcomingMatches) ? db.upcomingMatches : [])
      .filter((m) => m && m.altenarId != null)
      .map((m) => String(m.altenarId))
  );

  const now = Date.now();
  const windowStart = now - (10 * 60 * 1000);
  const windowEnd = now + (120 * 60 * 1000);

  const ages = altenar
    .filter((e) => {
      const id = String(e?.id ?? '');
      if (!linkedSet.has(id)) return false;
      const st = new Date(e?.startDate || 0).getTime();
      return Number.isFinite(st) && st >= windowStart && st <= windowEnd;
    })
    .map((e) => now - new Date(e?.lastUpdated || 0).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  return {
    rows: ages.length,
    older3m: ages.filter((ms) => ms > 180000).length,
    older6m: ages.filter((ms) => ms > 360000).length,
    p50AgeMs: ages.length ? ages[Math.floor(ages.length * 0.5)] : null,
    p90AgeMs: ages.length ? ages[Math.floor(ages.length * 0.9)] : null,
    maxAgeMs: ages.length ? ages[ages.length - 1] : null
  };
}

async function runInventory(tag) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag,
        bankroll: 100,
        limit: 80,
        minRoiPercent: 0.8,
        minProfitAbs: 1
      }),
      signal: controller.signal
    });
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const startedAt = new Date().toISOString();
const startedMs = new Date(startedAt).getTime();
const samples = [];

for (let i = 0; i < totalSamples; i += 1) {
  const tag = `burnin-60m-final-${i + 1}`;
  const sample = {
    at: new Date().toISOString(),
    index: i + 1,
    tag,
    stale: null,
    unlinked: null,
    count: null,
    linked: null,
    error: null
  };

  try {
    const payload = await runInventory(tag);
    sample.stale = toNum(payload?.diagnostics?.skippedStaleAltenar, null);
    sample.unlinked = toNum(payload?.diagnostics?.skippedUnlinked, null);
    sample.count = toNum(payload?.count, null);
  } catch (error) {
    sample.error = error?.message || String(error);
  }

  sample.linked = readLinkedFreshness();
  samples.push(sample);

  console.log(
    `[burnin60 ${sample.index}/${totalSamples}] stale=${sample.stale} older3m=${sample.linked?.older3m} ` +
    `p50=${sample.linked?.p50AgeMs} err=${sample.error ? 'yes' : 'no'}`
  );

  if (i < totalSamples - 1) {
    await new Promise((resolve) => setTimeout(resolve, sampleEveryMs));
  }
}

const endedAt = new Date().toISOString();
const endedMs = new Date(endedAt).getTime();

const fromSamples = {
  stale: stat(samples.map((s) => s.stale).filter((v) => Number.isFinite(v))),
  linkedOlder3m: stat(samples.map((s) => s.linked?.older3m).filter((v) => Number.isFinite(v))),
  linkedP50AgeMs: stat(samples.map((s) => s.linked?.p50AgeMs).filter((v) => Number.isFinite(v))),
  count: stat(samples.map((s) => s.count).filter((v) => Number.isFinite(v))),
  errors: samples.filter((s) => s.error).map((s) => ({ index: s.index, at: s.at, error: s.error }))
};

const db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const history = ((db.arbitrageDiagnostics || {}).history || []).filter((h) => {
  const t = new Date(h?.at || 0).getTime();
  return Number.isFinite(t) && t >= startedMs && t <= endedMs;
});

const historyStale = history.map((h) => toNum(h?.diagnostics?.skippedStaleAltenar, 0));
const historyUnlinked = history.map((h) => toNum(h?.diagnostics?.skippedUnlinked, 0));
const historyCount = history.map((h) => toNum(h?.result?.count, 0));

const fromHistory = {
  snapshots: history.length,
  stale: stat(historyStale),
  unlinked: stat(historyUnlinked),
  count: stat(historyCount),
  withOpportunities: historyCount.filter((v) => v > 0).length,
  recent: history.slice(-12).map((h) => ({
    at: h.at,
    trigger: h.trigger,
    tag: h.tag || null,
    stale: toNum(h?.diagnostics?.skippedStaleAltenar, 0),
    unlinked: toNum(h?.diagnostics?.skippedUnlinked, 0),
    count: toNum(h?.result?.count, 0)
  }))
};

const passCriteria = {
  target: 'p95_stale_below_10',
  bySamples: Number.isFinite(fromSamples.stale.p95) ? fromSamples.stale.p95 < 10 : false,
  byHistory: Number.isFinite(fromHistory.stale.p95) ? fromHistory.stale.p95 < 10 : false
};

const summary = {
  startedAt,
  endedAt,
  minutesMonitored: 60,
  sampleEveryMinutes: 5,
  samples: totalSamples,
  runtimeConfig: {
    linkedMaxIntervalMs: process.env.ALTENAR_PREMATCH_SCHEDULER_LINKED_MAX_INTERVAL_MS || null,
    sweepEnabled: process.env.ALTENAR_PREMATCH_SCHEDULER_STALE_SWEEP_ENABLED || null,
    sweepThresholdMs: process.env.ALTENAR_PREMATCH_SCHEDULER_STALE_SWEEP_THRESHOLD_MS || null,
    sweepMaxPerTick: process.env.ALTENAR_PREMATCH_SCHEDULER_STALE_SWEEP_MAX_EVENTS_PER_TICK || null
  },
  fromSamples,
  fromHistory,
  passCriteria,
  sampleDetails: samples
};

fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
console.log('BURNIN_60M_FINAL_SUMMARY=' + JSON.stringify(summary));
