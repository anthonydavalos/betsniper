import fs from 'fs';

const args = process.argv.slice(2);
const baseArg = args.find(a => a.startsWith('--base='));
const baseUrl = (baseArg?.split('=')[1] || 'http://localhost:3000').replace(/\/$/, '');
const liveMode = args.includes('--live');
const maxCandidatesArg = args.find(a => a.startsWith('--max='));
const maxCandidates = Number(maxCandidatesArg?.split('=')[1] || 25);

const out = (label, payload) => {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(payload, null, 2));
};

const jfetch = async (url, options = {}) => {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
};

const run = async () => {
  const health = await jfetch(`${baseUrl}/api/health`);
  if (!health.ok) {
    out('HEALTH_FAIL', health);
    process.exit(1);
  }
  out('HEALTH', health.body);

  const token = await jfetch(`${baseUrl}/api/booky/token-health`);
  if (!token.ok || !token.body?.success) {
    out('TOKEN_HEALTH_FAIL', token);
    process.exit(1);
  }
  out('TOKEN_HEALTH', token.body.token);

  if (!liveMode) {
    const probe = await jfetch(`${baseUrl}/api/booky/real/confirm-fast/fake-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    out('SAFE_PROBE', {
      status: probe.status,
      success: probe.body?.success,
      code: probe.body?.code || null,
      message: probe.body?.message || null
    });

    console.log('\n✅ Smoke check (safe) completado. Usa --live para probar placement real controlado.');
    return;
  }

  const prematch = await jfetch(`${baseUrl}/api/opportunities/prematch`);
  if (!prematch.ok || !prematch.body?.data?.length) {
    out('PREMATCH_FAIL', prematch);
    process.exit(1);
  }

  const candidates = prematch.body.data.slice(0, maxCandidates);
  let prepared = null;

  for (const opportunity of candidates) {
    const prep = await jfetch(`${baseUrl}/api/booky/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opportunity)
    });

    if (prep.body?.success && prep.body?.ticket?.id) {
      prepared = prep.body;
      break;
    }
  }

  if (!prepared) {
    out('PREPARE_FAIL', { message: `No se pudo preparar ticket con top ${candidates.length}` });
    process.exit(1);
  }

  const ticketId = prepared.ticket.id;
  fs.writeFileSync('tmp_smoke_prepare.json', JSON.stringify(prepared, null, 2));
  out('PREPARE_OK', { ticketId, eventId: prepared.ticket?.opportunity?.eventId, pick: prepared.ticket?.payload?.pick });

  const confirm = await jfetch(`${baseUrl}/api/booky/real/confirm-fast/${ticketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  fs.writeFileSync('tmp_smoke_confirm.json', JSON.stringify(confirm.body || {}, null, 2));
  out('CONFIRM_FAST', {
    status: confirm.status,
    success: confirm.body?.success || false,
    code: confirm.body?.code || null,
    message: confirm.body?.message || null,
    hasProviderResponse: Boolean(confirm.body?.providerResponse),
    hasMirroredBet: Boolean(confirm.body?.mirroredBet),
    mirrorResolvedFromExisting: Boolean(confirm.body?.mirrorResolvedFromExisting)
  });

  if (!confirm.body?.success) process.exit(1);

  console.log('\n✅ Smoke check LIVE completado. Archivos: tmp_smoke_prepare.json / tmp_smoke_confirm.json');
};

run().catch((error) => {
  console.error('❌ Smoke check error:', error.message);
  process.exit(1);
});
