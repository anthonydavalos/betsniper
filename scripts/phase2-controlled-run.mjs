import fs from 'fs';
import path from 'path';

const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');

const outDir = path.resolve('data');
const outPath = path.join(outDir, `phase2-controlled-run-${stamp}.json`);

const postRun = async () => {
  const response = await fetch(`${baseUrl}/api/opportunities/arbitrage/live/simulation/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit: 3,
      useDefaultControlledScenarios: true
    })
  });

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    body
  };
};

const getSummary = async () => {
  const response = await fetch(`${baseUrl}/api/opportunities/arbitrage/live/simulation/summary?windowMinutes=180`);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    body
  };
};

const main = async () => {
  const runResult = await postRun();
  const summaryResult = await getSummary();

  const payload = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    runResult,
    summaryResult
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const opSummary = runResult?.body?.summary || null;
  const total = Number(opSummary?.total || 0);
  const closed = Number(opSummary?.closed || 0);
  const hasAllOutcomes = ['confirmed', 'rejected', 'uncertain'].every((k) => Number(opSummary?.[k] || 0) >= 1);

  console.log(JSON.stringify({
    success: Boolean(runResult.ok && summaryResult.ok),
    reportPath: outPath,
    runStatus: runResult.status,
    summaryStatus: summaryResult.status,
    totals: opSummary,
    checks: {
      allClosed: total > 0 && total === closed,
      hasRequiredOutcomes: hasAllOutcomes
    }
  }, null, 2));

  if (!runResult.ok || !summaryResult.ok) {
    process.exit(1);
  }

  if (!(total > 0 && total === closed && hasAllOutcomes)) {
    process.exit(2);
  }
};

main().catch((error) => {
  console.error(JSON.stringify({ success: false, message: error?.message || String(error) }, null, 2));
  process.exit(1);
});
