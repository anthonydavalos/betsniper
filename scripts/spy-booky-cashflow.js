import puppeteer from 'puppeteer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'data', 'booky');

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const timeoutArg = args.find((arg) => arg.startsWith('--capture-ms='));
const waitCloseArg = args.includes('--wait-close');
const explicitNoWaitArg = args.includes('--no-wait-close');
const rawCaptureMs = Number(timeoutArg?.split('=')[1] || process.env.BOOKY_SPY_CAPTURE_MS || 180000);
const waitUntilClose = explicitNoWaitArg ? false : (waitCloseArg || (!headless && !timeoutArg));
const captureMs = waitUntilClose ? 0 : (rawCaptureMs > 0 ? rawCaptureMs : 180000);
const useSystemChrome = !args.includes('--no-system-chrome');
const fromArg = args.find((arg) => arg.startsWith('--from='));
const probeFromDate = (fromArg?.split('=')[1] || process.env.BOOKY_CASHFLOW_FROM_DATE || '').trim();

const bookProfile = String(process.env.BOOK_PROFILE || 'doradobet').trim().toLowerCase();
const requiredProfileArg = args.find((arg) => arg.startsWith('--require-profile='));
const requiredProfile = (requiredProfileArg?.split('=')[1] || '').trim().toLowerCase();

const targetArg = args.find((arg) => arg.startsWith('--url='));
const targetUrl = targetArg?.split('=')[1]
  || process.env.ALTENAR_BOOKY_URL
  || (bookProfile === 'acity'
    ? 'https://www.casinoatlanticcity.com/apuestas-deportivas#/overview'
    : 'https://doradobet.com/deportes-en-vivo');

const profileDir = path.join(outputDir, `chrome-profile-${bookProfile}`);
const RESPONSE_BODY_MAX_CHARS = Number(process.env.BOOKY_SPY_MAX_BODY_CHARS || 22000);

const movementKeywords = [
  'deposit',
  'withdraw',
  'withdrawal',
  'cashier',
  'payment',
  'wallet',
  'ledger',
  'transaction',
  'statement',
  'transfer',
  'bank',
  'topup',
  'recharge'
].map((item) => item.toLowerCase());

const apiDomainHints = [
  'biahosted.com/api/',
  '/api/',
  '/cashier',
  '/wallet',
  '/payments'
].map((item) => item.toLowerCase());

const sanitizeHeaders = (headers = {}) => {
  const redacted = { ...headers };
  const secretKeys = ['authorization', 'cookie', 'set-cookie', 'x-auth-token', 'token'];
  Object.keys(redacted).forEach((key) => {
    if (secretKeys.includes(String(key).toLowerCase())) {
      redacted[key] = '[REDACTED]';
    }
  });
  return redacted;
};

const sanitizeBodyText = (raw = '') => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (text.length <= RESPONSE_BODY_MAX_CHARS) return text;
  return `${text.slice(0, RESPONSE_BODY_MAX_CHARS)} ...[TRUNCATED ${text.length - RESPONSE_BODY_MAX_CHARS} chars]`;
};

const parseJsonIfPossible = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseFormEncoded = (raw = '') => {
  const source = String(raw || '').trim();
  if (!source) return {};
  const out = {};
  for (const chunk of source.split('&')) {
    if (!chunk) continue;
    const idx = chunk.indexOf('=');
    const keyRaw = idx >= 0 ? chunk.slice(0, idx) : chunk;
    const valRaw = idx >= 0 ? chunk.slice(idx + 1) : '';
    const key = decodeURIComponent(keyRaw || '').trim();
    const value = decodeURIComponent(valRaw || '').trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
};

const tryParseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const toMoney = (amount, scale = 1) => {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  return Number((value / scale).toFixed(2));
};

const detectMoneyScale = (rows = []) => {
  const amounts = rows
    .map((row) => Number(row?.amount))
    .filter((value) => Number.isFinite(value) && value !== 0);
  if (amounts.length === 0) return 1;
  const noDecimals = amounts.every((value) => Number.isInteger(value));
  const largeValues = amounts.filter((value) => Math.abs(value) >= 1000).length;
  if (noDecimals && largeValues >= Math.ceil(amounts.length * 0.6)) return 100;
  return 1;
};

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const toShortPath = (url = '') => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

const deepContainsKeyword = (value, keywords) => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const low = String(value).toLowerCase();
    return keywords.some((keyword) => low.includes(keyword));
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (deepContainsKeyword(item, keywords)) return true;
    }
    return false;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (deepContainsKeyword(key, keywords)) return true;
      if (deepContainsKeyword(nested, keywords)) return true;
    }
  }

  return false;
};

const isCandidateRequest = (url = '') => {
  const low = String(url).toLowerCase();
  const hasApiHint = apiDomainHints.some((hint) => low.includes(hint));
  if (!hasApiHint) return false;
  const hasMovementKeyword = movementKeywords.some((keyword) => low.includes(keyword));
  if (hasMovementKeyword) return true;
  if (low.includes('widgetplatform/')) return true;
  if (low.includes('widgetreports/')) return true;
  return false;
};

const scoreCapture = (entry) => {
  let score = 0;
  const url = String(entry?.url || '').toLowerCase();
  const reqBody = entry?.request?.bodyJson || entry?.request?.bodyRaw || null;
  const resBody = entry?.response?.bodyJson || entry?.response?.bodyRaw || null;

  if (movementKeywords.some((keyword) => url.includes(keyword))) score += 3;
  if (deepContainsKeyword(reqBody, movementKeywords)) score += 2;
  if (deepContainsKeyword(resBody, movementKeywords)) score += 2;
  if (deepContainsKeyword(resBody, ['amount', 'currency'])) score += 1;
  if (entry?.response?.status === 200) score += 1;

  return score;
};

const classifyCapture = (entry) => {
  const url = String(entry?.url || '').toLowerCase();
  const reqBody = entry?.request?.bodyJson || entry?.request?.bodyRaw || null;
  const resBody = entry?.response?.bodyJson || entry?.response?.bodyRaw || null;
  const content = [url, JSON.stringify(reqBody || ''), JSON.stringify(resBody || '')].join(' ').toLowerCase();

  if (content.includes('withdraw')) return 'withdraw';
  if (content.includes('deposit') || content.includes('topup') || content.includes('recharge')) return 'deposit';
  if (content.includes('transaction') || content.includes('ledger') || content.includes('statement')) return 'transaction-history';
  if (content.includes('wallet') || content.includes('balance')) return 'wallet-balance';
  return 'unknown';
};

const buildTransactionUniqueKey = (row = {}) => {
  const operation = String(row?.operation ?? row?.operation_id ?? row?.id ?? '').trim();
  const type = String(row?.type || '').trim().toUpperCase();
  const company = String(row?.company || '').trim().toUpperCase();
  const user = String(row?.user || '').trim();

  if (operation) {
    return `op:${operation}|type:${type}|company:${company}|user:${user}`;
  }

  const operationDate = String(row?.operation_date || row?.created_at || row?.date || '').trim();
  const amount = String(row?.amount ?? '').trim();
  const currency = String(row?.currency || '').trim().toUpperCase();
  const method = String(row?.method || row?.method_name || '').trim().toUpperCase();
  const status = String(row?.status || '').trim().toUpperCase();

  return [
    `date:${operationDate}`,
    `amount:${amount}`,
    `currency:${currency}`,
    `type:${type}`,
    `method:${method}`,
    `status:${status}`,
    `company:${company}`,
    `user:${user}`
  ].join('|');
};

const buildUniqueOperationsList = (rows = []) => {
  return rows
    .map((row) => ({
      operation: String(row?.operation ?? row?.operation_id ?? row?.id ?? '').trim() || null,
      type: String(row?.type || '').trim().toUpperCase() || null,
      status: String(row?.status || '').trim().toUpperCase() || null,
      amount: Number.isFinite(Number(row?.amount)) ? Number(row.amount) : null,
      currency: String(row?.currency || '').trim().toUpperCase() || null,
      operationDate: String(row?.operation_date || row?.created_at || row?.date || '').trim() || null,
      method: String(row?.method_name || row?.method || '').trim() || null,
      company: String(row?.company || '').trim().toUpperCase() || null,
      user: Number.isFinite(Number(row?.user)) ? Number(row.user) : null
    }))
    .sort((a, b) => {
      const timeA = a.operationDate ? new Date(a.operationDate).getTime() : 0;
      const timeB = b.operationDate ? new Date(b.operationDate).getTime() : 0;
      return timeB - timeA;
    });
};

const getRowDateKey = (row = {}) => {
  const raw = String(row?.operation_date || row?.created_at || row?.date || '').trim();
  if (!raw) return '';
  return raw.slice(0, 10);
};

const normalizeFromDate = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw.slice(0, 10);
};

const extractTransactionRowsFromCaptures = (captures = []) => {
  const rows = [];
  const uniqueRows = new Map();
  for (const entry of captures) {
    const shortPath = String(entry?.shortPath || '').toLowerCase();
    if (!shortPath.includes('/api/data/gettransactionshistory')) continue;
    const body = entry?.response?.bodyJson;
    if (!body || typeof body !== 'object') continue;
    const dataRows = Array.isArray(body?.data) ? body.data : [];
    for (const row of dataRows) {
      rows.push(row);
      const dedupeKey = buildTransactionUniqueKey(row);
      if (!uniqueRows.has(dedupeKey)) {
        uniqueRows.set(dedupeKey, row);
      }
    }
  }
  return {
    rows,
    uniqueRows: Array.from(uniqueRows.values()),
    duplicateRows: Math.max(0, rows.length - uniqueRows.size)
  };
};

const applyFromDateFilter = (rows = [], fromDate = '') => {
  const safeFromDate = normalizeFromDate(fromDate);
  if (!safeFromDate) {
    return {
      rows,
      fromDateApplied: null,
      filteredOutByFromDate: 0
    };
  }

  const filtered = rows.filter((row) => {
    const rowDate = getRowDateKey(row);
    if (!rowDate) return false;
    return rowDate >= safeFromDate;
  });

  return {
    rows: filtered,
    fromDateApplied: safeFromDate,
    filteredOutByFromDate: Math.max(0, rows.length - filtered.length)
  };
};

const buildCashflowStats = (captures = []) => {
  const extracted = extractTransactionRowsFromCaptures(captures);
  const fromDateFilter = applyFromDateFilter(extracted.uniqueRows, probeFromDate);
  const rows = fromDateFilter.rows;

  if (rows.length === 0) {
    return {
      rows: 0,
      rawRows: Number(extracted?.rows?.length || 0),
      duplicateRows: Number(extracted?.duplicateRows || 0),
      fromDateApplied: fromDateFilter.fromDateApplied,
      filteredOutByFromDate: Number(fromDateFilter.filteredOutByFromDate || 0),
      uniqueOperations: [],
      scale: 1,
      deposits: 0,
      withdrawals: 0,
      net: 0,
      byType: {},
      suggestionBaseCapital: null
    };
  }

  const scale = detectMoneyScale(rows);
  const byTypeRaw = new Map();
  for (const row of rows) {
    const type = String(row?.type || 'UNKNOWN').trim().toUpperCase();
    const amount = Number(row?.amount);
    if (!Number.isFinite(amount)) continue;
    byTypeRaw.set(type, (byTypeRaw.get(type) || 0) + amount);
  }

  const depositsRaw = byTypeRaw.get('DEPOSIT') || 0;
  const withdrawalsRaw = (byTypeRaw.get('WITHDRAW') || 0) + (byTypeRaw.get('WITHDRAWAL') || 0);

  const byType = {};
  for (const [type, value] of byTypeRaw.entries()) {
    byType[type] = toMoney(value, scale);
  }

  const deposits = toMoney(depositsRaw, scale);
  const withdrawals = toMoney(withdrawalsRaw, scale);
  const net = Number((deposits - withdrawals).toFixed(2));

  return {
    rows: rows.length,
    rawRows: extracted.rows.length,
    duplicateRows: extracted.duplicateRows,
    fromDateApplied: fromDateFilter.fromDateApplied,
    filteredOutByFromDate: fromDateFilter.filteredOutByFromDate,
    uniqueOperations: buildUniqueOperationsList(rows),
    scale,
    deposits,
    withdrawals,
    net,
    byType,
    suggestionBaseCapital: net
  };
};

const isTransactionHistoryPath = (url = '') => String(url || '').toLowerCase().includes('/api/data/gettransactionshistory');

const triggerCashflowProbe = async (page, probeKey, { endpoint, session, company = 'ACP', fromDate = '' }) => {
  if (!session || !endpoint) return false;

  const safeEndpoint = String(endpoint);
  const safeSession = String(session);
  const safeCompany = String(company || 'ACP');
  const safeFromDate = String(fromDate || '').trim();

  const buildFilter = (base) => {
    const filter = { ...base };
    if (safeFromDate) filter.op_date_init = safeFromDate;
    return filter;
  };

  const payloads = [
    {
      limits: { init: 0, end: 200 },
      filter: buildFilter({ type: 'DEPOSIT', status: 'SUCCESS' })
    },
    {
      limits: { init: 0, end: 200 },
      filter: buildFilter({ type: 'WITHDRAW', status: 'SUCCESS' })
    },
    {
      limits: { init: 0, end: 200 },
      filter: buildFilter({ status: 'SUCCESS' })
    }
  ];

  await page.evaluate(async ({ url, companyValue, sessionValue, queries }) => {
    for (const item of queries) {
      const form = new URLSearchParams();
      form.set('company', companyValue);
      form.set('session', sessionValue);
      form.set('limits', JSON.stringify(item.limits));
      form.set('filter', JSON.stringify(item.filter));
      try {
        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'access-control-allow-origin': '*'
          },
          body: form.toString(),
          credentials: 'include'
        });
      } catch {}
    }
  }, {
    url: safeEndpoint,
    companyValue: safeCompany,
    sessionValue: safeSession,
    queries: payloads
  });

  return true;
};

const buildSummary = ({ requestLogs, startedAt }) => {
  const capturesWithScore = requestLogs.map((entry) => ({
    ...entry,
    score: scoreCapture(entry),
    movementType: classifyCapture(entry)
  }));

  const endpointMap = new Map();
  for (const entry of capturesWithScore) {
    const key = entry.shortPath;
    const prev = endpointMap.get(key) || {
      shortPath: key,
      count: 0,
      maxScore: 0,
      movementTypes: new Set(),
      statuses: new Set()
    };
    prev.count += 1;
    prev.maxScore = Math.max(prev.maxScore, Number(entry.score || 0));
    prev.movementTypes.add(entry.movementType || 'unknown');
    if (Number.isFinite(Number(entry?.response?.status))) prev.statuses.add(Number(entry.response.status));
    endpointMap.set(key, prev);
  }

  const endpointCandidates = Array.from(endpointMap.values())
    .map((item) => ({
      shortPath: item.shortPath,
      count: item.count,
      maxScore: item.maxScore,
      movementTypes: Array.from(item.movementTypes).sort(),
      statuses: Array.from(item.statuses).sort((a, b) => a - b)
    }))
    .sort((a, b) => (b.maxScore - a.maxScore) || (b.count - a.count));

  const strongCandidates = endpointCandidates.filter((item) => item.maxScore >= 4);
  const cashflowStats = buildCashflowStats(capturesWithScore);

  return {
    generatedAt: new Date().toISOString(),
    startedAt,
    bookProfile,
    targetUrl,
    waitUntilClose,
    captureMs,
    movementKeywords,
    probeFromDate: probeFromDate || null,
    totalCaptured: capturesWithScore.length,
    strongCandidateCount: strongCandidates.length,
    cashflowStats,
    endpointCandidates,
    captures: capturesWithScore
  };
};

const saveSummary = (summary) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `spy-cashflow-${bookProfile}-${stamp}.json`;
  const filePath = path.join(outputDir, fileName);
  const latestPath = path.join(outputDir, `spy-cashflow-${bookProfile}.latest.json`);
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestPath, JSON.stringify(summary, null, 2), 'utf8');
  return { filePath, latestPath };
};

const run = async () => {
  if (requiredProfile && requiredProfile !== bookProfile) {
    console.error(`❌ Perfil inválido. Requerido=${requiredProfile} | Actual=${bookProfile}`);
    process.exit(1);
  }

  ensureDir(outputDir);
  ensureDir(profileDir);

  console.log('🕵️ Spy Booky Cashflow iniciando...');
  console.log(`   BOOK_PROFILE=${bookProfile}`);
  console.log(`   URL=${targetUrl}`);
  console.log(`   Modo=${headless ? 'headless' : 'headed'}`);
  console.log(`   Estrategia=${waitUntilClose ? 'esperar cierre manual del navegador' : `timeout ${captureMs}ms`}`);
  if (probeFromDate) console.log(`   Filtro cashflow desde=${probeFromDate}`);

  const launchOptions = {
    headless,
    defaultViewport: null,
    userDataDir: profileDir,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--lang=es-ES'
    ]
  };

  if (useSystemChrome) launchOptions.channel = 'chrome';

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();

  const startedAt = new Date().toISOString();
  const requestLogs = [];
  const requestMap = new Map();
  const probeDispatched = new Set();
  let seq = 0;
  let finalized = false;

  const finalize = async (reason = 'normal') => {
    if (finalized) return;
    finalized = true;

    const summary = buildSummary({ requestLogs, startedAt });
    const { filePath, latestPath } = saveSummary(summary);

    console.log(`\n✅ Spy cashflow finalizado (${reason}).`);
    console.log(`   Capturas: ${summary.totalCaptured}`);
    console.log(`   Candidatos fuertes: ${summary.strongCandidateCount}`);
    if (summary?.cashflowStats?.suggestionBaseCapital !== null) {
      console.log(`   Cashflow neto detectado: ${summary.cashflowStats.net}`);
      console.log(`   Sugerencia base PnL: ${summary.cashflowStats.suggestionBaseCapital}`);
    }
    console.log(`   Archivo: ${filePath}`);
    console.log(`   Latest:  ${latestPath}`);

    const top = summary.endpointCandidates.slice(0, 15);
    if (top.length > 0) {
      console.log('   Top endpoints candidatos:');
      for (const item of top) {
        console.log(`   - score=${item.maxScore} hits=${item.count} types=${item.movementTypes.join(',')} ${item.shortPath}`);
      }
    }

    try {
      await browser.close();
    } catch {}
  };

  process.once('SIGINT', async () => {
    console.log('\n⛔ SIGINT detectado. Guardando captura parcial...');
    await finalize('interrupted');
    process.exit(130);
  });

  process.once('SIGTERM', async () => {
    console.log('\n⛔ SIGTERM detectado. Guardando captura parcial...');
    await finalize('interrupted');
    process.exit(143);
  });

  page.on('request', async (request) => {
    try {
      const url = request.url();
      if (!isCandidateRequest(url)) return;

      const id = ++seq;
      const postData = request.postData() || null;
      const entry = {
        id,
        ts: new Date().toISOString(),
        method: request.method(),
        url,
        shortPath: toShortPath(url),
        resourceType: request.resourceType(),
        request: {
          headers: sanitizeHeaders(request.headers()),
          bodyRaw: sanitizeBodyText(postData),
          bodyJson: parseJsonIfPossible(postData)
        },
        response: null
      };

      requestLogs.push(entry);
      requestMap.set(request, entry);
      console.log(`📌 #${id} ${entry.method} ${entry.shortPath}`);

      if (entry.method === 'POST' && isTransactionHistoryPath(url)) {
        const rawBody = String(postData || '');
        const form = parseFormEncoded(rawBody);
        const session = form.session || '';
        const company = form.company || 'ACP';
        const filter = tryParseJson(form.filter || '{}') || {};
        const filterType = String(filter?.type || '').toUpperCase();
        const probeKey = `${entry.shortPath}|${session}`;

        if (session && filterType === 'DEPOSIT' && !probeDispatched.has(probeKey)) {
          probeDispatched.add(probeKey);
          console.log('🧪 Detectado filtro DEPOSIT: ejecutando probe automático de cashflow (DEPOSIT/WITHDRAW/ALL)...');
          triggerCashflowProbe(page, probeKey, {
            endpoint: entry.shortPath,
            session,
            company,
            fromDate: probeFromDate
          }).catch(() => {});
        }
      }
    } catch {}
  });

  page.on('response', async (response) => {
    try {
      const req = response.request();
      const entry = requestMap.get(req);
      if (!entry) return;

      let bodyText = null;
      try {
        bodyText = await response.text();
      } catch {
        bodyText = null;
      }

      entry.response = {
        status: response.status(),
        ok: response.ok(),
        headers: sanitizeHeaders(response.headers()),
        bodyRaw: sanitizeBodyText(bodyText),
        bodyJson: parseJsonIfPossible(bodyText)
      };
    } catch {}
  });

  await page.setUserAgent(
    process.env.ALTENAR_USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': process.env.ALTENAR_ACCEPT_LANGUAGE || 'es-ES,es;q=0.9,en;q=0.8'
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
  } catch (error) {
    console.warn(`⚠️ Navegación con timeout (${error.message}). Continuando...`);
  }

  console.log('🧭 Acción recomendada: abrir Caja/Cajero/Wallet, historial de transacciones y flujos de depósito/retiro para capturar endpoints reales.');

  if (waitUntilClose) {
    browser.on('disconnected', async () => {
      await finalize('browser-closed');
      process.exit(0);
    });
    return;
  }

  setTimeout(async () => {
    await finalize('timeout');
    process.exit(0);
  }, captureMs);
};

run().catch((error) => {
  console.error(`❌ Error en spy-booky-cashflow: ${error.message}`);
  process.exit(1);
});
