import fs from 'fs';
import path from 'path';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const intervalSeconds = Math.max(1, Number(process.env.LOOP_GUARD_INTERVAL_SECONDS || 2));
const durationMinutesRaw = Number(process.env.LOOP_GUARD_DURATION_MINUTES || 15);
const durationMinutes = Number.isFinite(durationMinutesRaw) ? durationMinutesRaw : 15;
const triggerWindowSeconds = Math.max(30, Number(process.env.LOOP_GUARD_TRIGGER_WINDOW_SECONDS || 90));
const maxTriggersPerWindow = Math.max(1, Number(process.env.LOOP_GUARD_MAX_TRIGGERS_PER_WINDOW || 1));
const retryJumpMinSeconds = Math.max(10, Number(process.env.LOOP_GUARD_RETRY_JUMP_MIN_SECONDS || 20));
const requestTimeoutMs = Math.max(1000, Number(process.env.LOOP_GUARD_TIMEOUT_MS || 5000));

const durationMs = durationMinutes > 0 ? durationMinutes * 60 * 1000 : 0;
const intervalMs = intervalSeconds * 1000;

const nowIso = () => new Date().toISOString();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const outDir = path.resolve('data');
const stamp = nowIso().replace(/[:.]/g, '-');
const outPath = path.join(outDir, `booky-renew-loop-guard-${stamp}.json`);

const fetchTokenHealth = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const res = await fetch(`${baseUrl}/api/booky/token-health`, { signal: controller.signal });
    const body = await res.json();
    const token = body?.token || {};
    return {
      ok: res.ok,
      status: res.status,
      token: {
        remainingMinutes: Number(token?.remainingMinutes || 0),
        minMonitorRequiredMinutes: Number(token?.minMonitorRequiredMinutes || 0),
        tokenAutoRenewThresholdMinutes: Number(token?.tokenAutoRenewThresholdMinutes || 0),
        renewalTriggered: Boolean(token?.renewalTriggered),
        renewalBusy: Boolean(token?.renewalBusy),
        renewalRetryAfterSeconds: Number(token?.renewalRetryAfterSeconds || 0),
        autoRefreshEnabled: Boolean(token?.autoRefreshEnabled),
        tokenHealthInteractiveAutoRenewEnabled: Boolean(token?.tokenHealthInteractiveAutoRenewEnabled)
      },
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      token: null,
      error: error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
};

const pruneOldTriggers = (arr, nowMs) => {
  const cutoff = nowMs - (triggerWindowSeconds * 1000);
  while (arr.length > 0 && arr[0] < cutoff) {
    arr.shift();
  }
};

const main = async () => {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const triggerEventsMs = [];
  const samples = [];

  let prevRetryAfter = null;
  let alerts = 0;

  console.log(JSON.stringify({
    mode: 'booky-renew-loop-guard',
    startedAt,
    baseUrl,
    intervalSeconds,
    durationMinutes,
    triggerWindowSeconds,
    maxTriggersPerWindow,
    retryJumpMinSeconds,
    timeoutMs: requestTimeoutMs,
    outPath
  }, null, 2));

  while (true) {
    const nowMs = Date.now();
    if (durationMs > 0 && (nowMs - startedMs) > durationMs) break;

    const at = nowIso();
    const poll = await fetchTokenHealth();

    let inferredTrigger = false;
    let explicitTrigger = false;

    if (poll?.token) {
      explicitTrigger = poll.token.renewalTriggered === true;

      const currentRetry = Number.isFinite(poll.token.renewalRetryAfterSeconds)
        ? Number(poll.token.renewalRetryAfterSeconds)
        : null;

      if (
        Number.isFinite(prevRetryAfter)
        && Number.isFinite(currentRetry)
        && currentRetry > (prevRetryAfter + retryJumpMinSeconds)
      ) {
        inferredTrigger = true;
      }

      prevRetryAfter = currentRetry;

      if (explicitTrigger || inferredTrigger) {
        triggerEventsMs.push(nowMs);
      }
    }

    pruneOldTriggers(triggerEventsMs, nowMs);

    const triggerCountWindow = triggerEventsMs.length;
    const loopSuspected = triggerCountWindow > maxTriggersPerWindow;
    if (loopSuspected) alerts += 1;

    const sample = {
      at,
      status: poll.status,
      ok: poll.ok,
      error: poll.error,
      token: poll.token,
      explicitTrigger,
      inferredTrigger,
      triggerCountWindow,
      loopSuspected
    };

    samples.push(sample);

    const logRow = {
      at,
      status: poll.status,
      remainingMinutes: poll?.token?.remainingMinutes ?? null,
      thresholdMinutes: poll?.token?.tokenAutoRenewThresholdMinutes ?? null,
      renewalTriggered: explicitTrigger,
      renewalBusy: poll?.token?.renewalBusy ?? null,
      retryAfterSeconds: poll?.token?.renewalRetryAfterSeconds ?? null,
      inferredTrigger,
      triggerCountWindow,
      loopSuspected
    };

    if (loopSuspected) {
      console.log(`ALERT ${JSON.stringify(logRow)}`);
    } else {
      console.log(JSON.stringify(logRow));
    }

    await wait(intervalMs);
  }

  const finishedAt = nowIso();
  const totalSamples = samples.length;
  const unhealthySamples = samples.filter((s) => {
    const remaining = Number(s?.token?.remainingMinutes);
    const minMonitor = Number(s?.token?.minMonitorRequiredMinutes);
    return Number.isFinite(remaining) && Number.isFinite(minMonitor) && remaining < minMonitor;
  }).length;

  const explicitTriggers = samples.filter((s) => s.explicitTrigger).length;
  const inferredTriggers = samples.filter((s) => s.inferredTrigger).length;

  const summary = {
    startedAt,
    finishedAt,
    elapsedMinutes: Number(((Date.now() - startedMs) / 60000).toFixed(2)),
    totalSamples,
    explicitTriggers,
    inferredTriggers,
    alerts,
    unhealthySamples,
    unhealthyRate: Number((unhealthySamples / Math.max(1, totalSamples)).toFixed(3)),
    loopDetected: alerts > 0
  };

  const payload = {
    mode: 'booky-renew-loop-guard',
    summary,
    samples
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ success: true, outPath, summary }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({ success: false, message: error?.message || String(error) }, null, 2));
  process.exit(1);
});
