import fs from 'fs';
import path from 'path';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const durationMinutes = Math.max(5, Number(process.env.CANARY_MONITOR_MINUTES || 30));
const intervalMinutes = Math.max(1, Number(process.env.CANARY_MONITOR_INTERVAL_MINUTES || 5));
const requestTimeoutMs = Math.max(2000, Number(process.env.CANARY_MONITOR_TIMEOUT_MS || 10000));
const triggerSyncEnabled = String(process.env.CANARY_MONITOR_TRIGGER_SYNC_ENABLED || 'true').trim().toLowerCase() !== 'false';
const triggerSyncIntervalSamples = Math.max(1, Number(process.env.CANARY_MONITOR_TRIGGER_SYNC_INTERVAL_SAMPLES || 2));
const triggerSyncHistoryLimit = Math.max(60, Number(process.env.CANARY_MONITOR_TRIGGER_SYNC_HISTORY_LIMIT || 200));
const triggerSyncForceRefresh = String(process.env.CANARY_MONITOR_TRIGGER_SYNC_FORCE_REFRESH || 'true').trim().toLowerCase() !== 'false';

const durationMs = durationMinutes * 60 * 1000;
const intervalMs = intervalMinutes * 60 * 1000;
const totalSamples = Math.floor(durationMs / intervalMs) + 1;

const outDir = path.resolve('data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(outDir, `phase3-canary-monitor-${stamp}.json`);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeOutcome = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'CONFIRMED' || raw === 'REJECTED' || raw === 'UNCERTAIN') return raw;
  return null;
};

const toIso = (value) => {
  const ms = new Date(value || 0).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
};

const fetchJson = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body = null;

    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    return {
      ok: res.ok,
      status: res.status,
      body,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
};

const countOutcomes = (rows = []) => {
  const out = { CONFIRMED: 0, REJECTED: 0, UNCERTAIN: 0 };
  for (const row of rows) {
    const normalized = normalizeOutcome(row?.outcome);
    if (normalized) out[normalized] += 1;
  }
  return out;
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const endMs = startMs + durationMs;

  const uniqueDecisionMap = new Map();
  const sampleRows = [];

  console.log(JSON.stringify({
    mode: 'phase3-canary-monitor',
    startedAt,
    baseUrl,
    durationMinutes,
    intervalMinutes,
    totalSamples,
    timeoutMs: requestTimeoutMs
  }, null, 2));

  for (let i = 0; i < totalSamples; i += 1) {
    const sampleAt = new Date().toISOString();

    let syncTrigger = null;
    const shouldTriggerSync = triggerSyncEnabled && (i % triggerSyncIntervalSamples === 0);
    if (shouldTriggerSync) {
      const refreshQuery = triggerSyncForceRefresh ? '&refresh=1' : '';
      syncTrigger = await fetchJson(`${baseUrl}/api/booky/account?historyLimit=${triggerSyncHistoryLimit}${refreshQuery}`);
    }

    const [diagRes, tokenRes, accountRes] = await Promise.all([
      fetchJson(`${baseUrl}/api/opportunities/live/diagnostics?limit=1200`),
      fetchJson(`${baseUrl}/api/booky/token-health`),
      fetchJson(`${baseUrl}/api/booky/account?historyLimit=200`)
    ]);

    const diag = diagRes.body || {};
    const scanner = diag.scanner || {};
    const pipeline = diag.pipeline || {};
    const recent = Array.isArray(diag.recent) ? diag.recent : [];

    const recentInWindow = recent.filter((row) => {
      const ts = new Date(row?.at || row?.ts || 0).getTime();
      return Number.isFinite(ts) && ts >= startMs;
    });

    for (const row of recentInWindow) {
      const normalized = normalizeOutcome(row?.outcome);
      if (!normalized) continue;

      const rowAt = toIso(row?.at || row?.ts || null);
      const key = [
        rowAt || 'n/a',
        String(row?.match || '').trim(),
        String(row?.selection || '').trim(),
        String(row?.provider || '').trim(),
        normalized,
        String(row?.reason || '').trim()
      ].join('|');

      if (!uniqueDecisionMap.has(key)) {
        uniqueDecisionMap.set(key, {
          at: rowAt,
          outcome: normalized,
          reason: row?.reason || null,
          match: row?.match || null,
          selection: row?.selection || null,
          provider: row?.provider || null,
          type: row?.type || null
        });
      }
    }

    const token = tokenRes.body?.token || {};
    const account = accountRes.body || {};

    const sample = {
      at: sampleAt,
      statuses: {
        liveDiagnostics: diagRes.status,
        tokenHealth: tokenRes.status,
        bookyAccount: accountRes.status
      },
      scanner: {
        autoSnipeEnabled: Boolean(scanner.autoSnipeEnabled),
        autoSnipeDryRun: Boolean(scanner.autoSnipeDryRun),
        provider: scanner.autoPlacementProvider || null,
        bookyRealPlacementEnabled: Boolean(scanner.bookyRealPlacementEnabled),
        pinnacleRealPlacementEnabled: Boolean(scanner.pinnacleRealPlacementEnabled),
        minEvPercent: Number(scanner.minEvPercent || 0),
        maxBetsPerHour: Number(scanner.maxBetsPerHour || 0),
        cooldownPerPickMs: Number(scanner.cooldownPerPickMs || 0),
        reentryMinOddImprovementPct: Number(scanner.reentryMinOddImprovementPct || 0),
        reentryMinOddPoints: Number(scanner.reentryMinOddPoints || 0),
        maxEntriesPerPick: Number(scanner.maxEntriesPerPick || 0)
      },
      pipeline: {
        at: pipeline.at || null,
        pollMode: pipeline.pollMode || null,
        finalCount: Number(pipeline.finalCount || 0),
        activeLiveBets: Number(pipeline.activeLiveBets || 0)
      },
      recentInWindow: {
        count: recentInWindow.length,
        outcomes: countOutcomes(recentInWindow)
      },
      token: {
        exists: Boolean(token.exists),
        jwtValid: Boolean(token.jwtValid),
        authenticated: Boolean(token.authenticated),
        remainingMinutes: Number(token.remainingMinutes || 0),
        minRequiredMinutes: Number(token.minRequiredMinutes || 0),
        minMonitorRequiredMinutes: Number(token.minMonitorRequiredMinutes || token.minRequiredMinutes || 0),
        autoRenewThresholdMinutes: Number(token.tokenAutoRenewThresholdMinutes || 0),
        renewalTriggered: Boolean(token.renewalTriggered),
        renewalBusy: Boolean(token.renewalBusy),
        expired: Boolean(token.expired)
      },
      booky: {
        historyCount: Number(account.historyCount || 0),
        historyTotalCount: Number(account.historyTotalCount || 0),
        balanceAmount: Number(account?.balance?.amount || 0),
        balanceCurrency: account?.balance?.currency || null,
        balanceStale: Boolean(account?.balance?.stale)
      },
      syncTrigger: syncTrigger
        ? {
            status: Number(syncTrigger.status || 0),
            ok: Boolean(syncTrigger.ok),
            error: syncTrigger.error || null,
            source: syncTrigger?.body?.source || null
          }
        : null
    };

    sampleRows.push(sample);

    const uniqueRows = Array.from(uniqueDecisionMap.values());
    const uniqueOutcomes = countOutcomes(uniqueRows);

    console.log(JSON.stringify({
      progress: `${i + 1}/${totalSamples}`,
      at: sampleAt,
      tokenRemainingMinutes: sample.token.remainingMinutes,
      tokenMinRequired: sample.token.minRequiredMinutes,
      tokenMinMonitorRequired: sample.token.minMonitorRequiredMinutes,
      tokenRenewalTriggered: sample.token.renewalTriggered,
      uniqueOutcomes,
      recentOutcomes: sample.recentInWindow.outcomes,
      pipeline: sample.pipeline
    }));

    if (i < totalSamples - 1) {
      await delay(intervalMs);
    }
  }

  const finishedAt = new Date().toISOString();
  const uniqueDecisionRows = Array.from(uniqueDecisionMap.values());
  const uniqueOutcomeCounts = countOutcomes(uniqueDecisionRows);

  const tokenHealthySamples = sampleRows.filter((s) => {
    const remaining = Number(s?.token?.remainingMinutes || 0);
    const minRequired = Number(s?.token?.minMonitorRequiredMinutes || s?.token?.minRequiredMinutes || 0);
    return Number.isFinite(remaining) && Number.isFinite(minRequired) && remaining >= minRequired;
  }).length;

  const canaryFlagsOkSamples = sampleRows.filter((s) => {
    const sc = s?.scanner || {};
    const provider = String(sc.provider || '').trim().toLowerCase();
    const providerRealOk = provider === 'auto'
      ? (sc.bookyRealPlacementEnabled === true && sc.pinnacleRealPlacementEnabled === true)
      : (provider === 'booky'
        ? sc.bookyRealPlacementEnabled === true
        : (provider === 'pinnacle' ? sc.pinnacleRealPlacementEnabled === true : false));
    return (
      sc.autoSnipeEnabled === true
      && sc.autoSnipeDryRun === false
      && providerRealOk
      && sc.minEvPercent >= 2
      && sc.maxBetsPerHour <= 2
      && sc.maxEntriesPerPick <= 1
    );
  }).length;

  const summary = {
    startedAt,
    finishedAt,
    elapsedMinutes: Number(((Date.now() - startMs) / 60000).toFixed(2)),
    baseUrl,
    durationMinutes,
    intervalMinutes,
    samples: sampleRows.length,
    checks: {
      canaryFlagsOkSamples,
      tokenHealthySamples,
      totalSamples: sampleRows.length,
      canaryFlagsOkRate: Number((canaryFlagsOkSamples / Math.max(1, sampleRows.length)).toFixed(3)),
      tokenHealthyRate: Number((tokenHealthySamples / Math.max(1, sampleRows.length)).toFixed(3))
    },
    outcomes: {
      uniqueDecisions: uniqueDecisionRows.length,
      confirmed: uniqueOutcomeCounts.CONFIRMED,
      rejected: uniqueOutcomeCounts.REJECTED,
      uncertain: uniqueOutcomeCounts.UNCERTAIN
    },
    rollbackSignal: uniqueOutcomeCounts.UNCERTAIN > 0,
    notes: uniqueOutcomeCounts.UNCERTAIN > 0
      ? 'Se detectaron decisiones UNCERTAIN durante la ventana; considerar volver a dry-run y reconciliar.'
      : 'Sin decisiones UNCERTAIN observadas en la ventana monitoreada.'
  };

  const payload = {
    mode: 'phase3-canary-monitor',
    summary,
    samples: sampleRows,
    uniqueDecisions: uniqueDecisionRows
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ success: true, reportPath: outPath, summary }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({ success: false, message: error?.message || String(error) }, null, 2));
  process.exit(1);
});
