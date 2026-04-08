#!/usr/bin/env node

// Soak de Fase 1: valida estabilidad runtime de preview/diagnosticos live (sin placement real).

import process from 'process';

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DEFAULT_DURATION_MINUTES = Number(process.env.PHASE1_SOAK_MINUTES || 120);
const DEFAULT_INTERVAL_SECONDS = Number(process.env.PHASE1_SOAK_INTERVAL_SECONDS || 30);
const DEFAULT_PREVIEW_LIMIT = Number(process.env.PHASE1_SOAK_PREVIEW_LIMIT || 20);

const parseArg = (name, fallback = null) => {
  const pref = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(pref));
  if (!hit) return fallback;
  return hit.slice(pref.length);
};

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const baseUrl = String(parseArg('base-url', DEFAULT_BASE_URL)).replace(/\/$/, '');
const durationMinutes = toPositiveInt(parseArg('minutes', DEFAULT_DURATION_MINUTES), DEFAULT_DURATION_MINUTES);
const intervalSeconds = toPositiveInt(parseArg('interval', DEFAULT_INTERVAL_SECONDS), DEFAULT_INTERVAL_SECONDS);
const previewLimit = toPositiveInt(parseArg('limit', DEFAULT_PREVIEW_LIMIT), DEFAULT_PREVIEW_LIMIT);
const timeoutMs = Math.max(5000, intervalSeconds * 1000 - 500);

const runUntil = Date.now() + durationMinutes * 60 * 1000;

const state = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  okCycles: 0,
  failedCycles: 0,
  previewStatus200: 0,
  diagnosticsStatus200: 0,
  previewNon200: 0,
  diagnosticsNon200: 0,
  exceptions: 0,
  responseMs: {
    preview: [],
    diagnostics: []
  },
  totals: {
    opportunities: 0,
    linkedCandidates: 0,
    scannedLiveEvents: 0,
    skippedUnlinked: 0,
    skippedMissingPinnacleLive: 0,
    skippedMissingOdds: 0,
    skippedNoSurebetEdge: 0,
    skippedStaleAltenar: 0,
    skippedSameProvider: 0
  },
  lastDiagnosticsSummary: null,
  errors: []
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = async (url) => {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      data,
      raw: text
    };
  } finally {
    clearTimeout(timer);
  }
};

const addLatency = (bucket, ms) => {
  if (!Number.isFinite(ms) || ms < 0) return;
  bucket.push(ms);
  if (bucket.length > 5000) bucket.shift();
};

const p95 = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
};

const mean = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sum = rows.reduce((acc, n) => acc + n, 0);
  return sum / rows.length;
};

while (Date.now() < runUntil) {
  state.cycles += 1;
  const cycleId = state.cycles;

  const previewUrl = `${baseUrl}/api/opportunities/arbitrage/live/preview?limit=${previewLimit}`;
  const diagnosticsUrl = `${baseUrl}/api/opportunities/arbitrage/live/diagnostics?limit=5`;

  try {
    const [preview, diagnostics] = await Promise.all([
      requestJson(previewUrl),
      requestJson(diagnosticsUrl)
    ]);

    addLatency(state.responseMs.preview, preview.ms);
    addLatency(state.responseMs.diagnostics, diagnostics.ms);

    if (preview.status === 200) state.previewStatus200 += 1;
    else state.previewNon200 += 1;

    if (diagnostics.status === 200) state.diagnosticsStatus200 += 1;
    else state.diagnosticsNon200 += 1;

    if (preview.ok && diagnostics.ok) {
      state.okCycles += 1;
    } else {
      state.failedCycles += 1;
      state.errors.push({
        at: new Date().toISOString(),
        cycleId,
        kind: 'non_200',
        previewStatus: preview.status,
        diagnosticsStatus: diagnostics.status,
        previewBody: preview.raw?.slice(0, 300) || null,
        diagnosticsBody: diagnostics.raw?.slice(0, 300) || null
      });
    }

    const d = preview.data || {};
    const dg = diagnostics.data || {};
    state.totals.opportunities += Number(d?.count || 0);
    state.totals.linkedCandidates += Number(d?.diagnostics?.linkedCandidates || 0);
    state.totals.scannedLiveEvents += Number(d?.diagnostics?.scannedLiveEvents || 0);
    state.totals.skippedUnlinked += Number(d?.diagnostics?.skippedUnlinked || 0);
    state.totals.skippedMissingPinnacleLive += Number(d?.diagnostics?.skippedMissingPinnacleLive || 0);
    state.totals.skippedMissingOdds += Number(d?.diagnostics?.skippedMissingOdds || 0);
    state.totals.skippedNoSurebetEdge += Number(d?.diagnostics?.skippedNoSurebetEdge || 0);
    state.totals.skippedStaleAltenar += Number(d?.diagnostics?.skippedStaleAltenar || 0);
    state.totals.skippedSameProvider += Number(d?.diagnostics?.skippedSameProvider || 0);

    state.lastDiagnosticsSummary = dg?.summary || null;

    console.log(JSON.stringify({
      cycle: cycleId,
      at: new Date().toISOString(),
      preview: {
        status: preview.status,
        ms: preview.ms,
        count: Number(d?.count || 0),
        linkedCandidates: Number(d?.diagnostics?.linkedCandidates || 0),
        skippedUnlinked: Number(d?.diagnostics?.skippedUnlinked || 0),
        skippedMissingPinnacleLive: Number(d?.diagnostics?.skippedMissingPinnacleLive || 0)
      },
      diagnostics: {
        status: diagnostics.status,
        ms: diagnostics.ms,
        snapshotsInWindow: Number(dg?.summary?.snapshotsInWindow || 0)
      }
    }));
  } catch (error) {
    state.failedCycles += 1;
    state.exceptions += 1;
    state.errors.push({
      at: new Date().toISOString(),
      cycleId,
      kind: 'exception',
      message: error?.message || String(error)
    });

    console.log(JSON.stringify({
      cycle: cycleId,
      at: new Date().toISOString(),
      error: error?.message || String(error)
    }));
  }

  if (Date.now() >= runUntil) break;
  await sleep(intervalSeconds * 1000);
}

const previewAvg = mean(state.responseMs.preview);
const previewP95 = p95(state.responseMs.preview);
const diagnosticsAvg = mean(state.responseMs.diagnostics);
const diagnosticsP95 = p95(state.responseMs.diagnostics);

const summary = {
  startedAt: state.startedAt,
  endedAt: new Date().toISOString(),
  durationMinutes,
  intervalSeconds,
  baseUrl,
  totals: {
    cycles: state.cycles,
    okCycles: state.okCycles,
    failedCycles: state.failedCycles,
    previewStatus200: state.previewStatus200,
    diagnosticsStatus200: state.diagnosticsStatus200,
    previewNon200: state.previewNon200,
    diagnosticsNon200: state.diagnosticsNon200,
    exceptions: state.exceptions,
    opportunitiesSeen: state.totals.opportunities,
    linkedCandidatesSeen: state.totals.linkedCandidates,
    scannedLiveEventsSeen: state.totals.scannedLiveEvents,
    skippedUnlinked: state.totals.skippedUnlinked,
    skippedMissingPinnacleLive: state.totals.skippedMissingPinnacleLive,
    skippedMissingOdds: state.totals.skippedMissingOdds,
    skippedNoSurebetEdge: state.totals.skippedNoSurebetEdge,
    skippedStaleAltenar: state.totals.skippedStaleAltenar,
    skippedSameProvider: state.totals.skippedSameProvider
  },
  latencyMs: {
    preview: {
      avg: previewAvg ? Number(previewAvg.toFixed(2)) : null,
      p95: previewP95
    },
    diagnostics: {
      avg: diagnosticsAvg ? Number(diagnosticsAvg.toFixed(2)) : null,
      p95: diagnosticsP95
    }
  },
  lastDiagnosticsSummary: state.lastDiagnosticsSummary,
  errors: state.errors.slice(-25)
};

console.log('=== PHASE1_LIVE_ARBITRAGE_SOAK_SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));

if (state.failedCycles > 0) {
  process.exitCode = 1;
}
