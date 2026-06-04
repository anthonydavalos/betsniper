import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

const triggerCheckIntervalSeconds = Math.max(5, Number(process.env.TRIGGER_CHECK_INTERVAL_SECONDS || 30));
const triggerTimeoutMinutes = Math.max(1, Number(process.env.TRIGGER_TIMEOUT_MINUTES || 120));
const triggerRequiredHits = Math.max(1, Math.floor(Number(process.env.TRIGGER_REQUIRED_HITS || 3)));

const triggerMinLiveEvents = Math.max(1, Number(process.env.TRIGGER_MIN_LIVE_EVENTS || 12));
const triggerMinFinalCount = Math.max(1, Number(process.env.TRIGGER_MIN_FINAL_COUNT || 1));
const triggerMinOpportunities = Math.max(1, Number(process.env.TRIGGER_MIN_OPPORTUNITIES || 1));
const triggerRequireTokenHealthy = String(process.env.TRIGGER_REQUIRE_TOKEN_HEALTHY || 'true').trim().toLowerCase() !== 'false';
const triggerRequireCanaryFlags = String(process.env.TRIGGER_REQUIRE_CANARY_FLAGS || 'true').trim().toLowerCase() !== 'false';
const triggerDiagLimit = Math.max(100, Math.floor(Number(process.env.TRIGGER_DIAG_LIMIT || 400)));
const requestTimeoutMs = Math.max(2000, Number(process.env.TRIGGER_REQUEST_TIMEOUT_MS || 10000));

const smartTriggerDryRun = ['1', 'true', 'yes', 'on'].includes(String(process.env.SMART_TRIGGER_DRY_RUN || '').trim().toLowerCase());

const outDir = path.resolve('data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(outDir, `phase3-canary-smart-trigger-${stamp}.json`);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const isTokenHealthy = (token = null) => {
  if (!token || typeof token !== 'object') return false;
  const remaining = Number(token.remainingMinutes);
  const minRequired = Number(token.minRequiredMinutes || 0);

  return Boolean(
    token.exists
    && token.jwtValid
    && token.authenticated
    && !token.expired
    && Number.isFinite(remaining)
    && remaining >= minRequired
  );
};

const areCanaryFlagsReady = (scanner = null) => {
  if (!scanner || typeof scanner !== 'object') return false;
  const provider = String(scanner.autoPlacementProvider || '').trim().toLowerCase();
  const providerRealOk = provider === 'auto'
    ? (scanner.bookyRealPlacementEnabled === true && scanner.pinnacleRealPlacementEnabled === true)
    : (provider === 'booky'
      ? scanner.bookyRealPlacementEnabled === true
      : (provider === 'pinnacle' ? scanner.pinnacleRealPlacementEnabled === true : false));

  return Boolean(
    scanner.autoSnipeEnabled === true
    && scanner.autoSnipeDryRun === false
    && providerRealOk
    && Number(scanner.minEvPercent || 0) >= 2
    && Number(scanner.maxBetsPerHour || 0) <= 2
    && Number(scanner.maxEntriesPerPick || 0) <= 1
  );
};

const runCanaryMonitor = async () => {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  return new Promise((resolve) => {
    const child = spawn(npmCmd, ['run', 'phase3:canary:monitor'], {
      stdio: 'inherit',
      shell: false,
      env: process.env
    });

    child.on('close', (code) => {
      resolve({ exitCode: Number(code || 0) });
    });

    child.on('error', (error) => {
      resolve({ exitCode: 1, error: error?.message || String(error) });
    });
  });
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const timeoutMs = triggerTimeoutMinutes * 60 * 1000;
  const deadlineMs = startedMs + timeoutMs;
  const intervalMs = triggerCheckIntervalSeconds * 1000;

  const checks = [];
  let consecutiveHits = 0;
  let triggered = false;
  let triggerAt = null;
  let monitorResult = null;

  console.log(JSON.stringify({
    mode: 'phase3-canary-smart-trigger',
    startedAt,
    baseUrl,
    trigger: {
      checkIntervalSeconds: triggerCheckIntervalSeconds,
      timeoutMinutes: triggerTimeoutMinutes,
      requiredHits: triggerRequiredHits,
      minLiveEvents: triggerMinLiveEvents,
      minFinalCount: triggerMinFinalCount,
      minOpportunities: triggerMinOpportunities,
      requireTokenHealthy: triggerRequireTokenHealthy,
      requireCanaryFlags: triggerRequireCanaryFlags,
      diagLimit: triggerDiagLimit,
      requestTimeoutMs,
      dryRun: smartTriggerDryRun
    }
  }, null, 2));

  while (Date.now() < deadlineMs) {
    const at = new Date().toISOString();

    const [liveRes, diagRes, tokenRes] = await Promise.all([
      fetchJson(`${baseUrl}/api/opportunities/live`),
      fetchJson(`${baseUrl}/api/opportunities/live/diagnostics?limit=${triggerDiagLimit}`),
      fetchJson(`${baseUrl}/api/booky/token-health`)
    ]);

    const liveCount = Number(liveRes?.body?.count || 0);
    const pipeline = diagRes?.body?.pipeline || {};
    const scanner = diagRes?.body?.scanner || {};
    const token = tokenRes?.body?.token || {};

    const conditions = {
      liveEvents: Number(pipeline.liveEventCount || 0) >= triggerMinLiveEvents,
      finalCount: Number(pipeline.finalCount || 0) >= triggerMinFinalCount,
      opportunities: liveCount >= triggerMinOpportunities,
      tokenHealthy: triggerRequireTokenHealthy ? isTokenHealthy(token) : true,
      canaryFlags: triggerRequireCanaryFlags ? areCanaryFlagsReady(scanner) : true
    };

    const passed = Object.values(conditions).every(Boolean);
    consecutiveHits = passed ? (consecutiveHits + 1) : 0;

    const row = {
      at,
      statuses: {
        live: liveRes.status,
        diagnostics: diagRes.status,
        token: tokenRes.status
      },
      metrics: {
        liveCount,
        liveEventCount: Number(pipeline.liveEventCount || 0),
        finalCount: Number(pipeline.finalCount || 0),
        pollMode: pipeline.pollMode || null,
        tokenRemainingMinutes: Number(token.remainingMinutes || 0),
        tokenMinRequiredMinutes: Number(token.minRequiredMinutes || 0)
      },
      conditions,
      passed,
      consecutiveHits
    };

    checks.push(row);

    console.log(JSON.stringify({
      at,
      passed,
      consecutiveHits: `${consecutiveHits}/${triggerRequiredHits}`,
      metrics: row.metrics,
      conditions
    }));

    if (consecutiveHits >= triggerRequiredHits) {
      triggered = true;
      triggerAt = at;
      break;
    }

    await delay(intervalMs);
  }

  if (triggered) {
    if (!smartTriggerDryRun) {
      monitorResult = await runCanaryMonitor();
    } else {
      monitorResult = { exitCode: 0, dryRun: true };
    }
  }

  const finishedAt = new Date().toISOString();

  const payload = {
    mode: 'phase3-canary-smart-trigger',
    startedAt,
    finishedAt,
    elapsedMinutes: Number(((Date.now() - startedMs) / 60000).toFixed(2)),
    baseUrl,
    triggered,
    triggerAt,
    smartTriggerDryRun,
    triggerConfig: {
      checkIntervalSeconds: triggerCheckIntervalSeconds,
      timeoutMinutes: triggerTimeoutMinutes,
      requiredHits: triggerRequiredHits,
      minLiveEvents: triggerMinLiveEvents,
      minFinalCount: triggerMinFinalCount,
      minOpportunities: triggerMinOpportunities,
      requireTokenHealthy: triggerRequireTokenHealthy,
      requireCanaryFlags: triggerRequireCanaryFlags,
      diagLimit: triggerDiagLimit,
      requestTimeoutMs
    },
    monitorResult,
    checks
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  if (!triggered) {
    console.log(JSON.stringify({
      success: false,
      reason: 'trigger-timeout',
      reportPath: outPath,
      lastCheck: checks[checks.length - 1] || null
    }, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify({
    success: true,
    triggered,
    triggerAt,
    reportPath: outPath,
    monitorResult
  }, null, 2));

  if (monitorResult && Number(monitorResult.exitCode || 0) !== 0) {
    process.exit(Number(monitorResult.exitCode || 1));
  }
};

main().catch((error) => {
  console.error(JSON.stringify({ success: false, message: error?.message || String(error) }, null, 2));
  process.exit(1);
});
