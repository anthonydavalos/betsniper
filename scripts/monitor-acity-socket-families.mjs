import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  startAcityLiveSocketService,
  stopAcityLiveSocketService,
  getAcityLiveSocketDiagnostics
} from '../src/services/acityLiveSocketService.js';

const parsePositiveInt = (raw, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
};

const durationMs = parsePositiveInt(process.env.ACITY_SOCKET_MONITOR_DURATION_MS, 12 * 60 * 1000);
const tickMs = parsePositiveInt(process.env.ACITY_SOCKET_MONITOR_TICK_MS, 60 * 1000);
const startedAt = new Date().toISOString();
const snapshots = [];

const outDir = path.resolve('data', 'booky');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const summarize = () => {
  const diag = getAcityLiveSocketDiagnostics();
  const stats = diag?.stats || {};
  const familyCounts = stats?.dirtyFamilyCounts || {};
  const queueSize = Number(diag?.dirtyQueueSize || 0);
  const authOk = Number(stats?.authOk || 0);
  const sioEvents = Number(stats?.sioEventPackets || 0);

  const row = {
    at: new Date().toISOString(),
    queueSize,
    authOk,
    sioEvents,
    dirtySignalsDetected: Number(stats?.dirtySignalsDetected || 0),
    dirtyEventIdsDetected: Number(stats?.dirtyEventIdsDetected || 0),
    familyCounts: {
      match_result: Number(familyCounts.match_result || 0),
      totals: Number(familyCounts.totals || 0),
      double_chance: Number(familyCounts.double_chance || 0),
      unknown: Number(familyCounts.unknown || 0)
    }
  };

  snapshots.push(row);
  console.log(
    `[socket-monitor] ${row.at} events=${row.sioEvents} authOk=${row.authOk} queue=${row.queueSize} ` +
    `families=${JSON.stringify(row.familyCounts)}`
  );
};

const boot = startAcityLiveSocketService();
console.log(`[socket-monitor] start=${JSON.stringify(boot)} startedAt=${startedAt} durationMs=${durationMs}`);

const interval = setInterval(() => {
  summarize();
}, tickMs);

const shutdown = (reason = 'timeout') => {
  clearInterval(interval);
  summarize();

  const diag = getAcityLiveSocketDiagnostics();
  const preview = Array.isArray(diag?.dirtySignalsPreview) ? diag.dirtySignalsPreview : [];
  const unknownRows = preview.filter((row) => Array.isArray(row?.families) && row.families.includes('unknown'));

  const result = {
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    reason,
    boot,
    finalDiagnostics: diag,
    snapshots,
    unknownPreviewTop: unknownRows.slice(0, 40)
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `acity-socket-family-monitor-${stamp}.json`);
  const latestPath = path.join(outDir, 'acity-socket-family-monitor.latest.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf8');

  try {
    stopAcityLiveSocketService();
  } catch (_) {
    // noop
  }

  console.log(`[socket-monitor] saved=${outPath}`);
  console.log(`[socket-monitor] savedLatest=${latestPath}`);
  process.exit(0);
};

setTimeout(() => shutdown('timeout'), durationMs);
process.on('SIGINT', () => shutdown('sigint'));
process.on('SIGTERM', () => shutdown('sigterm'));
