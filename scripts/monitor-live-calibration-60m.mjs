import fs from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.MONITOR_BASE_URL || 'http://localhost:3000';
const MINUTES = Math.max(1, Number(process.env.MONITOR_MINUTES || 60));
const INTERVAL_MS = Math.max(5000, Number(process.env.MONITOR_INTERVAL_MS || 60000));
const WEAK_ROI_THRESHOLD = Number(process.env.MONITOR_WEAK_ROI_THRESHOLD || 0.25);
const OUTPUT_DIR = process.env.MONITOR_OUTPUT_DIR || 'data';
const RUN_ID = String(process.env.MONITOR_RUN_ID || `ops-monitor-60m-${new Date().toISOString().replace(/[.:]/g, '-')}`).trim();
const OUTPUT_FILE = process.env.MONITOR_OUTPUT_FILE || path.join(OUTPUT_DIR, `${RUN_ID}.json`);
const OUTPUT_FILE_LATEST = process.env.MONITOR_OUTPUT_FILE_LATEST || path.join(OUTPUT_DIR, 'ops-monitor-60m.latest.json');
const PROGRESS_FILE = process.env.MONITOR_PROGRESS_FILE || path.join(OUTPUT_DIR, `${RUN_ID}.progress.json`);
const PROGRESS_FILE_LATEST = process.env.MONITOR_PROGRESS_FILE_LATEST || path.join(OUTPUT_DIR, 'ops-monitor-60m.progress.latest.json');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timeoutMs = Math.max(3000, Number(options.timeoutMs || 15000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    const json = JSON.parse(text);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
};

const run = async () => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const totalSamples = Math.ceil((MINUTES * 60 * 1000) / INTERVAL_MS);
  const samples = [];

  console.log(`MONITOR_START runId=${RUN_ID} base=${BASE_URL} minutes=${MINUTES} intervalMs=${INTERVAL_MS} samples=${totalSamples} startedAt=${startedAtIso}`);
  console.log(`MONITOR_OUTPUT outputFile=${OUTPUT_FILE} latestFile=${OUTPUT_FILE_LATEST} progressFile=${PROGRESS_FILE}`);

  for (let i = 0; i < totalSamples; i += 1) {
    const cycleStart = Date.now();
    let sample;

    try {
      const [preview, inventory] = await Promise.all([
        fetchJson(`${BASE_URL}/api/opportunities/arbitrage/live/preview?limit=250`),
        fetchJson(`${BASE_URL}/api/opportunities/arbitrage/live/diagnostics/inventory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag: 'ops-monitor-60m',
            limit: 250
          })
        })
      ]);

      const d = inventory?.diagnostics || {};
      const previewRows = Array.isArray(preview?.data) ? preview.data : [];
      const weakEntries = previewRows.filter((row) => Number(row?.plan?.roiPercent || 0) < WEAK_ROI_THRESHOLD).length;

      sample = {
        ok: true,
        at: new Date().toISOString(),
        activeEvents: Number(d?.activeEvents || 0),
        linkedCandidates: Number(d?.linkedCandidates || 0),
        evaluatedEvents: Number(d?.evaluatedEvents || 0),
        generatedTotals: Number(d?.generatedByType?.surebetTotalsLive || 0),
        generatedBtts: Number(d?.generatedByType?.surebetBttsLive || 0),
        generated1x2: Number(d?.generatedByType?.surebet1x2Live || 0),
        generatedDcOpposite: Number(d?.generatedByType?.surebetDcOppositeLive || 0),
        skippedUnlinked: Number(d?.skippedUnlinked || 0),
        skippedStaleAltenar: Number(d?.skippedStaleAltenar || 0),
        skippedMissingPinnacleLive: Number(d?.skippedMissingPinnacleLive || 0),
        skippedNoSurebetEdge: Number(d?.skippedNoSurebetEdge || 0),
        skippedTotalsLineMismatch: Number(d?.skippedTotalsLineMismatch || 0),
        skippedTotalsLowLiquidity: Number(d?.skippedTotalsLowLiquidity || 0),
        skippedBttsLowLiquidity: Number(d?.skippedBttsLowLiquidity || 0),
        skippedTotalsMissingMarket: Number(d?.skippedTotalsMissingMarket || 0),
        skippedBttsMissingMarket: Number(d?.skippedBttsMissingMarket || 0),
        weakEntries
      };
    } catch (error) {
      sample = {
        ok: false,
        at: new Date().toISOString(),
        error: error?.message || String(error)
      };
    }

    samples.push(sample);

    const okCount = samples.filter((row) => row.ok).length;
    const evalCount = samples.filter((row) => row.ok && row.evaluatedEvents > 0).length;
    const completed = i + 1;
    const etaMs = startedAtMs + (totalSamples * INTERVAL_MS);
    const progress = {
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      startedAt: startedAtIso,
      eta: new Date(etaMs).toISOString(),
      sample: completed,
      totalSamples,
      okSamples: okCount,
      evaluatedSamples: evalCount,
      lastSample: sample
    };
    await Promise.all([
      fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8'),
      fs.writeFile(PROGRESS_FILE_LATEST, JSON.stringify(progress, null, 2), 'utf8')
    ]);
    console.log(
      `MONITOR_SAMPLE ${completed}/${totalSamples} ok=${sample.ok ? 1 : 0} active=${sample.activeEvents || 0} linked=${sample.linkedCandidates || 0} evaluated=${sample.evaluatedEvents || 0} ` +
      `unlinked=${sample.skippedUnlinked || 0} staleAlt=${sample.skippedStaleAltenar || 0} missingPin=${sample.skippedMissingPinnacleLive || 0} ` +
      `line=${sample.skippedTotalsLineMismatch || 0} lowT=${sample.skippedTotalsLowLiquidity || 0} lowB=${sample.skippedBttsLowLiquidity || 0} weak=${sample.weakEntries || 0}`
    );

    if ((i + 1) % 10 === 0 || i === totalSamples - 1) {
      console.log(`MONITOR_PROGRESS sample=${i + 1}/${totalSamples} ok=${okCount} evaluated=${evalCount}`);
    }

    const elapsed = Date.now() - cycleStart;
    const idleMs = INTERVAL_MS - elapsed;
    if (i < totalSamples - 1 && idleMs > 0) {
      await wait(idleMs);
    }
  }

  const okSamples = samples.filter((row) => row.ok);
  const sum = (key) => okSamples.reduce((acc, row) => acc + Number(row?.[key] || 0), 0);
  const freq = (predicate) => okSamples.filter(predicate).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    runId: RUN_ID,
    outputFile: OUTPUT_FILE,
    outputLatestFile: OUTPUT_FILE_LATEST,
    monitorMinutes: MINUTES,
    intervalMs: INTERVAL_MS,
    totalSamples: samples.length,
    okSamples: okSamples.length,
    failedSamples: samples.length - okSamples.length,
    samplesWithEvaluatedEvents: freq((row) => row.evaluatedEvents > 0),
    aggregated: {
      generated1x2: sum('generated1x2'),
      generatedDcOpposite: sum('generatedDcOpposite'),
      generatedTotals: sum('generatedTotals'),
      generatedBtts: sum('generatedBtts'),
      skippedUnlinked: sum('skippedUnlinked'),
      skippedStaleAltenar: sum('skippedStaleAltenar'),
      skippedMissingPinnacleLive: sum('skippedMissingPinnacleLive'),
      skippedNoSurebetEdge: sum('skippedNoSurebetEdge'),
      skippedTotalsLineMismatch: sum('skippedTotalsLineMismatch'),
      skippedTotalsLowLiquidity: sum('skippedTotalsLowLiquidity'),
      skippedBttsLowLiquidity: sum('skippedBttsLowLiquidity'),
      skippedTotalsMissingMarket: sum('skippedTotalsMissingMarket'),
      skippedBttsMissingMarket: sum('skippedBttsMissingMarket'),
      weakEntries: sum('weakEntries')
    },
    frequency: {
      lineMismatchSnapshots: freq((row) => row.skippedTotalsLineMismatch > 0),
      lowLiquiditySnapshots: freq((row) => row.skippedTotalsLowLiquidity > 0 || row.skippedBttsLowLiquidity > 0),
      weakEntrySnapshots: freq((row) => row.weakEntries > 0),
      unlinkedSnapshots: freq((row) => row.skippedUnlinked > 0),
      staleAltenarSnapshots: freq((row) => row.skippedStaleAltenar > 0)
    }
  };

  const topCauses = Object.entries({
    skippedUnlinked: summary.aggregated.skippedUnlinked,
    skippedStaleAltenar: summary.aggregated.skippedStaleAltenar,
    skippedMissingPinnacleLive: summary.aggregated.skippedMissingPinnacleLive,
    skippedNoSurebetEdge: summary.aggregated.skippedNoSurebetEdge,
    skippedTotalsLineMismatch: summary.aggregated.skippedTotalsLineMismatch,
    skippedTotalsLowLiquidity: summary.aggregated.skippedTotalsLowLiquidity,
    skippedBttsLowLiquidity: summary.aggregated.skippedBttsLowLiquidity,
    skippedTotalsMissingMarket: summary.aggregated.skippedTotalsMissingMarket,
    skippedBttsMissingMarket: summary.aggregated.skippedBttsMissingMarket
  })
    .map(([key, total]) => ({ cause: key, total: Number(total || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const passChecks = {
    noFailedSamples: summary.failedSamples === 0,
    hasEvaluatedSnapshots: summary.samplesWithEvaluatedEvents > 0
  };

  const report = {
    summary: {
      ...summary,
      pass: Object.values(passChecks).every(Boolean),
      passChecks,
      topCauses
    },
    samples
  };

  await Promise.all([
    fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf8'),
    fs.writeFile(OUTPUT_FILE_LATEST, JSON.stringify(report, null, 2), 'utf8')
  ]);

  const donePayload = {
    generatedAt: new Date().toISOString(),
    done: true,
    runId: RUN_ID,
    outputFile: OUTPUT_FILE,
    outputLatestFile: OUTPUT_FILE_LATEST,
    summary: report.summary
  };

  await Promise.all([
    fs.writeFile(PROGRESS_FILE, JSON.stringify(donePayload, null, 2), 'utf8'),
    fs.writeFile(PROGRESS_FILE_LATEST, JSON.stringify(donePayload, null, 2), 'utf8')
  ]);

  console.log(`MONITOR_DONE runId=${RUN_ID} output=${OUTPUT_FILE}`);
  console.log(`MONITOR_SUMMARY ${JSON.stringify(report.summary)}`);
};

run().catch((error) => {
  console.error(`MONITOR_FATAL ${error?.message || error}`);
  process.exit(1);
});
