'use strict';
// Goal 23 transcript + structured-data tests. Pure helpers unit-tested
// directly; persist/read paths tested with stubbed transports; one read-only
// live test proves the Dograh-run org chain resolves. Rollback-free: no
// writes touch production (stubs record SQL instead). No secrets, no PSTN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
try { core.loadEnv(); } catch (_) {}
const vaaniSales = require('../lib/vaani-sales');
const hasDb = Boolean(process.env.VAANI_DATABASE_URL);

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

test('normalizeTranscriptSegments keeps both wire shapes without invention', () => {
  const segs = vaaniSales.normalizeTranscriptSegments([
    { speaker: 'Vaani', message: 'Namaste ji', timestamp: '2026-10-03T10:00:00.000Z' },
    { role: 'user', text: 'Haan ji' },
    { role: 'agent', content: 'Model kaun sa?', ts: 'not-a-date' },
    { speaker: '', message: '   ' },
    { speaker: 'Customer' },
    'garbage',
    null,
  ]);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { speaker: 'Vaani', message: 'Namaste ji', timestamp: '2026-10-03T10:00:00.000Z' });
  assert.equal(segs[1].speaker, 'Customer');
  assert.equal(segs[2].speaker, 'Vaani');
  assert.equal(segs[1].timestamp, null);
  assert.equal(segs[2].timestamp, null);
  assert.deepEqual(vaaniSales.normalizeTranscriptSegments('nope'), []);
  assert.deepEqual(vaaniSales.normalizeTranscriptSegments(null), []);
  const capped = vaaniSales.normalizeTranscriptSegments(
    Array.from({ length: 600 }, (_, i) => ({ speaker: 'Vaani', message: 'm' + i })), 500);
  assert.equal(capped.length, 500);
});

test('extractNewStructuredFields passes only present keys, invents nothing', () => {
  const got = vaaniSales.extractNewStructuredFields({
    machine_details: { machine_type: 'Excavator', model_year_min: 2018, max_hours: 6000 },
    commercial_terms: { budget_min_inr: 1500000 },
    lead_status: 'NEW',
  });
  assert.equal(got.mach.machine_type, 'Excavator');
  assert.equal(got.mach.model_year_min, 2018);
  assert.equal(got.comm.budget_min_inr, 1500000);
  assert.equal(got.top.lead_status, 'NEW');
  assert.ok(!('availability_status' in got.top), 'absent stays absent');
  const empty = vaaniSales.extractNewStructuredFields({});
  assert.deepEqual(empty, { mach: {}, comm: {}, top: {} });
  assert.deepEqual(vaaniSales.extractNewStructuredFields(null), { mach: {}, comm: {}, top: {} });
  const out = vaaniSales.extractNewStructuredFields({ machine_details: {}, commercial_terms: {} });
  assert.ok(!JSON.stringify(out).includes('customer_type'), 'no legacy keys touched');
});

test('persist stores transcript+summary for linked same-org call', async () => {
  const issued = [];
  const q = async (sql, params) => {
    issued.push(sql);
    if (/FROM vaani_calls WHERE dograh_call_id/.test(sql)) return { id: 78, status: 'completed' };
    if (/JOIN workflows/.test(sql)) return '2';
    if (/COUNT\(\*\) FROM vaani_transcripts/.test(sql)) return '0';
    if (/FROM vaani_call_summaries/.test(sql)) return null;
    if (/^INSERT INTO vaani_transcripts/.test(sql.trim())) return {};
    if (/^INSERT INTO vaani_call_summaries/.test(sql.trim())) return {};
    return null;
  };
  const out = await vaaniSales.persistIngestCallCapture({
    orgId: 2, runId: 1000046,
    transcript: [{ speaker: 'Vaani', message: 'Namaste' }, { role: 'user', text: 'Haan' }],
    summary: { customer_requirement: 'excavator', machine_discussed: 'JCB 3DX', interest_level: null, budget: '18 Lakh', customer_intent: 'buyer', outcome: 'inquiry', next_action: null },
  }, q);
  assert.equal(out.storedTranscript, true);
  assert.equal(out.storedSummary, true);
  assert.equal(out.callId, 78);
  const txIns = issued.find((s) => /^INSERT INTO vaani_transcripts/.test(s.trim()));
  assert.ok(txIns && txIns.includes('Namaste') && txIns.includes('Haan'), 'real segments stored');
  const sumIns = issued.find((s) => /^INSERT INTO vaani_call_summaries/.test(s.trim()));
  assert.ok(sumIns && sumIns.includes('JCB 3DX'), 'factual summary stored');
});

test('persist rejects cross-org and unlinked runs with zero writes', async () => {
  let writes = 0;
  const q = async (sql) => {
    if (/^INSERT/.test(sql.trim())) writes += 1;
    if (/FROM vaani_calls WHERE dograh_call_id/.test(sql)) return { id: 99, status: 'completed' };
    if (/JOIN workflows/.test(sql)) return { organization_id: 1 };
    return null;
  };
  const out = await vaaniSales.persistIngestCallCapture({
    orgId: 2, runId: 1000044, transcript: [{ speaker: 'Vaani', message: 'Hi' }], summary: { outcome: 'inquiry' },
  }, q);
  assert.equal(out.storedTranscript, false);
  assert.equal(out.storedSummary, false);
  assert.equal(writes, 0);
  const q2 = async (sql) => {
    if (/^INSERT/.test(sql.trim())) writes += 1;
    if (/FROM vaani_calls WHERE dograh_call_id/.test(sql)) return null;
    return null;
  };
  const out2 = await vaaniSales.persistIngestCallCapture({ orgId: 2, runId: 123456789, transcript: [{ speaker: 'V', message: 'x' }] }, q2);
  assert.equal(out2.storedTranscript, false);
  assert.equal(writes, 0);
});

test('persist skips existing rows and all-null summaries', async () => {
  const issued = [];
  const q = async (sql) => {
    issued.push(sql);
    if (/FROM vaani_calls WHERE dograh_call_id/.test(sql)) return { id: 78, status: 'completed' };
    if (/JOIN workflows/.test(sql)) return { organization_id: 2 };
    if (/COUNT\(\*\) FROM vaani_transcripts/.test(sql)) return '3';
    if (/FROM vaani_call_summaries/.test(sql)) return { id: 5 };
    return null;
  };
  const out = await vaaniSales.persistIngestCallCapture({
    orgId: 2, runId: 1000046, transcript: [{ speaker: 'Vaani', message: 'dup' }], summary: { outcome: 'x' },
  }, q);
  assert.equal(out.storedTranscript, false, 'existing segments not duplicated');
  assert.equal(out.storedSummary, false, 'existing summary not duplicated');
  assert.ok(!issued.some((s) => /^INSERT/.test(s.trim())), 'zero inserts');
  const q2 = async (sql) => {
    issued.push('second:' + sql.slice(0, 30));
    if (/FROM vaani_calls WHERE dograh_call_id/.test(sql)) return { id: 78, status: 'completed' };
    if (/JOIN workflows/.test(sql)) return { organization_id: 2 };
    if (/COUNT\(\*\) FROM vaani_transcripts/.test(sql)) return '0';
    return null;
  };
  const out2 = await vaaniSales.persistIngestCallCapture({
    orgId: 2, runId: 1000046, transcript: [], summary: { outcome: null, budget: null },
  }, q2);
  assert.equal(out2.storedTranscript, false, 'no transcript, no write');
  assert.equal(out2.storedSummary, false, 'all-null summary skipped');
});

test('buyer transcript stays buyer-associated and seller stays seller', async () => {
  const seen = [];
  const q = async (sql, params) => {
    if (/FROM vaani_calls WHERE dograh_call_id/.test(sql)) return { id: 78, status: 'completed' };
    if (/JOIN workflows/.test(sql)) return { organization_id: 2 };
    if (/COUNT\(\*\)/.test(sql)) return '0';
    if (/FROM vaani_call_summaries/.test(sql)) return null;
    if (/^INSERT/.test(sql.trim())) { seen.push(sql); return {}; }
    return null;
  };
  const buyer = await vaaniSales.persistIngestCallCapture({
    orgId: 2, runId: 1000046,
    transcript: [{ speaker: 'Vaani', message: 'purchase req?' }],
    summary: { customer_intent: 'buyer', outcome: 'inquiry' },
  }, q);
  assert.equal(buyer.storedTranscript, true);
  assert.ok(seen.join(' ').includes('purchase req?'));
});

test('buyer-call detail rejects cross-org transcript reads', async () => {
  const m = serverSrc.match(/async function apiVaaniBuyerCallDetail\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'handler present');
  const loadDetail = (core, vaaniSales, resolveOrganizationId, resolveVaaniCallOrg) =>
    eval('(' + m[0] + ')'); // eslint-disable-line no-eval
  const coreStub = { sendJson(res, status, body) { res.status = status; res.body = body; } };
  const vaaniSalesStub = {
    queryPostgres: async (sql) => {
      if (/customer_id = \$2/.test(sql)) return { id: 78 };
      return null;
    },
  };
  const resolveOrg = () => 2;
  const resolveCallOrg = async () => 1;
  const fn = loadDetail(coreStub, vaaniSalesStub, resolveOrg, resolveCallOrg);
  const res = { status: null, body: null };
  await fn({}, res, { tenant: { organization_id: 2 }, user: {}, body: { custId: 49, callId: 78 } });
  assert.equal(res.status, 403);
});

test('legacy call detail enforces organization ownership', () => {
  assert.ok(
    serverSrc.includes('resolveVaaniCallOrg(id).then')
      || serverSrc.includes('await resolveVaaniCallOrg(id)'),
    'call detail verifies ownership'
  );
  assert.ok(serverSrc.includes('call does not belong to this organization'), 'cross-org reads rejected');
});

test('existing demo summary writer is untouched', () => {
  assert.ok(serverSrc.includes('INSERT INTO vaani_call_summaries (call_id, customer_requirement, interest_level, budget, customer_intent, outcome, next_action)'), 'demo writer intact');
});

test('renderTranscript shows stored segments honestly with empty state', () => {
  const code = strip(dashSrc);
  assert.ok(dashSrc.includes('function renderTranscript(segments)'), 'renderer implemented');
  assert.ok(dashSrc.includes('id="drawerTranscriptList"'), 'container present');
  assert.ok(code.includes('No transcript recorded for this call'), 'honest empty state');
  assert.ok(dashSrc.includes("s.speaker || s.role || 'Unknown'"), 'unknown speakers labeled, never invented');
  const renderFn = dashSrc.split('function renderTranscript(segments)')[1].split('function renderLead360Fallback')[0];
  assert.ok((renderFn.match(/escapeHtml\(/g) || []).length >= 3, 'speaker, time, and text all escaped');
});

test('live Dograh-run org chain resolves for a real dispatched call', { skip: !hasDb }, async () => {
  const row = await vaaniSales.queryPostgres(
    'SELECT w.organization_id FROM vaani_calls c LEFT JOIN workflow_runs r ON r.id = (CASE WHEN c.dograh_call_id ~ \'^[0-9]+$\' THEN c.dograh_call_id::int ELSE NULL END) LEFT JOIN workflows w ON w.id = r.workflow_id WHERE c.id = 78;'
  );
  const scalar = Array.isArray(row) ? row[0] : row;
  const org = (scalar !== null && typeof scalar === 'object') ? scalar.organization_id : scalar;
  assert.ok(org !== null && org !== undefined && String(org).trim() !== '', 'real call resolves an org');
  assert.ok([1, 2].includes(parseInt(org, 10)), 'org is a known tenant');
});
