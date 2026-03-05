import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { initDB } from '../src/db/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const normalizeProfile = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'dorado' || normalized === 'altenar') return 'doradobet';
  return normalized;
};

const getEntryTimestampMs = (entry = {}) => {
  const source = entry?.placedAt || entry?.updatedAt || entry?.createdAt || null;
  const ts = new Date(source || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const rowKey = (row = {}) => {
  if (row?.providerBetId !== null && row?.providerBetId !== undefined && row?.providerBetId !== '') {
    return `pb_${row.providerBetId}`;
  }
  return `${row?.match || 'na'}_${row?.placedAt || 'na'}_${row?.stake || 0}_${row?.selection || 'na'}`;
};

const calcLegacyPnl = (rows = []) => {
  let pnl = 0;
  for (const row of rows) {
    const status = Number(row?.status);
    const stake = Number(row?.stake);
    const payout = Number(row?.payout);
    const potential = Number(row?.potentialReturn);
    const safeStake = Number.isFinite(stake) ? stake : 0;

    if (status === 2) {
      pnl -= Math.abs(safeStake);
      continue;
    }
    if (status === 4 || status === 18) continue;
    if (status === 8) {
      pnl += (Number.isFinite(payout) ? payout : 0) - safeStake;
      continue;
    }
    if (status === 1) {
      const ret = (Number.isFinite(payout) && payout > 0)
        ? payout
        : (Number.isFinite(potential) ? potential : 0);
      pnl += ret - safeStake;
    }
  }
  return Number(pnl.toFixed(2));
};

const getProfileStats = (store = {}) => {
  const rows = Array.isArray(store?.history) ? store.history : [];
  const integrationCount = rows.reduce((acc, row) => {
    const key = normalizeProfile(row?.integration || '') || '<empty>';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    count: rows.length,
    pnlLegacy: calcLegacyPnl(rows),
    integrationCount
  };
};

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const aggressive = args.has('--aggressive');

await initDB();
await db.read();

if (!db.data.booky) db.data.booky = { pendingTickets: [], history: [], byProfile: {} };
if (!db.data.booky.byProfile || typeof db.data.booky.byProfile !== 'object') db.data.booky.byProfile = {};
if (!db.data.booky.byProfile.acity) db.data.booky.byProfile.acity = { history: [] };
if (!db.data.booky.byProfile.doradobet) db.data.booky.byProfile.doradobet = { history: [] };

const before = {
  acity: getProfileStats(db.data.booky.byProfile.acity),
  doradobet: getProfileStats(db.data.booky.byProfile.doradobet)
};

const providerIdToProfile = new Map();
const ambiguousProviderIds = new Set();
const localTickets = Array.isArray(db.data.booky.history) ? db.data.booky.history : [];

for (const ticket of localTickets) {
  const integration = normalizeProfile(ticket?.payload?.integration || ticket?.opportunity?.integration || '');
  const providerBetId = ticket?.realPlacement?.response?.bets?.[0]?.id;
  if (!integration) continue;
  if (providerBetId === null || providerBetId === undefined || providerBetId === '') continue;

  const key = String(providerBetId);
  const existing = providerIdToProfile.get(key);
  if (existing && existing !== integration) {
    ambiguousProviderIds.add(key);
    continue;
  }
  providerIdToProfile.set(key, integration);
}

for (const key of ambiguousProviderIds) {
  providerIdToProfile.delete(key);
}

const report = {
  mode: apply ? 'apply' : 'dry-run',
  aggressive,
  localProviderMapped: providerIdToProfile.size,
  localProviderAmbiguous: ambiguousProviderIds.size,
  labeledLegacyRows: 0,
  labeledByBucketRows: 0,
  movedRows: 0,
  dedupRemoved: 0,
  profiles: {}
};

for (const profileName of ['acity', 'doradobet']) {
  const store = db.data.booky.byProfile[profileName];
  const rows = Array.isArray(store?.history) ? store.history : [];
  const queue = [];
  const keep = [];

  for (const row of rows) {
    const currentIntegration = normalizeProfile(row?.integration || '');
    let resolvedIntegration = currentIntegration;

    if (!resolvedIntegration) {
      const providerBetId = row?.providerBetId;
      const key = (providerBetId === null || providerBetId === undefined || providerBetId === '') ? null : String(providerBetId);
      if (key && providerIdToProfile.has(key)) {
        resolvedIntegration = providerIdToProfile.get(key);
        row.integration = resolvedIntegration;
        report.labeledLegacyRows += 1;
      }
    }

    if (resolvedIntegration && resolvedIntegration !== profileName && db.data.booky.byProfile[resolvedIntegration]) {
      queue.push({ ...row });
      report.movedRows += 1;
    } else {
      keep.push(row);
    }
  }

  db.data.booky.byProfile[profileName].history = keep;

  if (!report.profiles[profileName]) report.profiles[profileName] = { movedOut: 0, movedIn: 0 };
  report.profiles[profileName].movedOut += queue.length;

  for (const moved of queue) {
    const target = normalizeProfile(moved?.integration || '');
    if (!target || !db.data.booky.byProfile[target]) continue;
    if (!report.profiles[target]) report.profiles[target] = { movedOut: 0, movedIn: 0 };
    report.profiles[target].movedIn += 1;
    db.data.booky.byProfile[target].history.push(moved);
  }
}

if (aggressive) {
  for (const profileName of ['acity', 'doradobet']) {
    const store = db.data.booky.byProfile[profileName];
    const rows = Array.isArray(store?.history) ? store.history : [];
    for (const row of rows) {
      const currentIntegration = normalizeProfile(row?.integration || '');
      if (currentIntegration) continue;
      row.integration = profileName;
      report.labeledByBucketRows += 1;
    }
  }
}

for (const profileName of ['acity', 'doradobet']) {
  const store = db.data.booky.byProfile[profileName];
  const rows = Array.isArray(store?.history) ? store.history : [];
  const merged = new Map();
  for (const row of rows) {
    merged.set(rowKey(row), row);
  }
  const deduped = Array.from(merged.values())
    .sort((a, b) => getEntryTimestampMs(b) - getEntryTimestampMs(a));
  report.dedupRemoved += Math.max(0, rows.length - deduped.length);
  db.data.booky.byProfile[profileName].history = deduped;
}

const after = {
  acity: getProfileStats(db.data.booky.byProfile.acity),
  doradobet: getProfileStats(db.data.booky.byProfile.doradobet)
};

const output = {
  ...report,
  before,
  after
};

if (apply) {
  const backupDir = path.join(projectRoot, 'data', 'booky');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `db-backup-before-legacy-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(path.join(projectRoot, 'db.json'), backupPath);

  db.data.booky.legacyIntegrationMigration = {
    at: new Date().toISOString(),
    version: '2026-03-04-v1',
    summary: {
      labeledLegacyRows: report.labeledLegacyRows,
      movedRows: report.movedRows,
      dedupRemoved: report.dedupRemoved,
      localProviderMapped: report.localProviderMapped,
      localProviderAmbiguous: report.localProviderAmbiguous,
      backupPath: path.relative(projectRoot, backupPath)
    }
  };

  await db.write();
  output.backupPath = path.relative(projectRoot, backupPath);
}

console.log(JSON.stringify(output, null, 2));