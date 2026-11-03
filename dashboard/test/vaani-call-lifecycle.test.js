'use strict';
// Goal 22 call-lifecycle tests. Backend handler loaded from server.js source
// (never boots the server) with stubbed core/query paths; the terminal
// UPDATE statement is additionally executed for real inside an explicit
// transaction that always ROLLBACKs, so no rows persist. No secrets,
// no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
try { core.loadEnv(); } catch (_) {}
const vaaniSales = require('../lib/vaani-sales');
const hasDb = Boolean(process.env.VAANI_DATABASE_URL);

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadBound(core, vaaniSales, resolveOrganizationId, resolveVaaniCallOrg) {
  const m = serverSrc.match(/async function apiVaaniCallStatus\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'apiVaaniCallStatus found in server.js');
  // Bind the REAL shipped transition maps, not copies, so drift fails loudly.
  const t = serverSrc.match(/const VAANI_CALL_TRANSITIONS = (Object\.freeze\(\{[\s\S]*?\n\}\));[\s\S]*?const VAANI_CALL_STATUSES = (Object\.freeze\(\[[^\]]*\]\));/);
  assert.ok(t, 'shipped transition maps found in server.js');
  const VAANI_CALL_TRANSITIONS = eval('(' + t[1] + ')'); // eslint-disable-line no-eval
  const VAANI_CALL_STATUSES = eval('(' + t[2] + ')'); // eslint-disable-line no-eval
  assert.deepEqual(VAANI_CALL_STATUSES, REAL_STATUSES);
  assert.deepEqual(VAANI_CALL_TRANSITIONS, REAL_TRANSITIONS);
  void VAANI_CALL_TRANSITIONS; void VAANI_CALL_STATUSES;
  // Bind sibling resolvers explicitly so handler drift fails loudly here
  // instead of surfacing as a runtime ReferenceError.
  return eval('(function(core, vaaniSales, resolveOrganizationId, resolveVaaniCallOrg){ return (' + m[0] + '); })')(core, vaaniSales, resolveOrganizationId, resolveVaaniCallOrg); // eslint-disable-line no-eval
}

const REAL_TRANSITIONS = {
  initiated: ['connecting', 'failed'],
  connecting: ['connected', 'failed', 'no_answer', 'cancelled'],
  connected: ['completed', 'failed'],
};
const REAL_STATUSES = ['connecting', 'connected', 'completed', 'failed', 'no_answer', 'cancelled'];

function harness(row, ownerOrg) {
  const issued = [];
  const coreStub = { sendJson(res, status, body) { res.status = status; res.body = body; } };
  const vaaniSales = {
    queryPostgres: async (sql, params) => {
      issued.push(sql);
      if (/FROM vaani_calls WHERE id/.test(sql)) return row;
      if (/JOIN workflows/.test(sql)) return ownerOrg === null ? null : { organization_id: ownerOrg };
      if (/^UPDATE vaani_calls/.test(sql.trim())) return {};
      return null;
    },
  };
  const resolveOrganizationId = (ctx) => {
    if (!ctx || !ctx.tenant) return null;
    if (ctx.tenant.organization_id === undefined || ctx.tenant.organization_id === null) return null;
    const n = parseInt(ctx.tenant.organization_id, 10);
    return isNaN(n) ? null : n;
  };
  // Mirror production ownership: un-linkable runs resolve null (fail closed),
  // linked runs resolve the fixture owner org.
  const resolveVaaniCallOrg = async (callId) => {
    const ref = row && row.dograh_call_id !== null && row.dograh_call_id !== undefined
      ? String(row.dograh_call_id).trim() : '';
    if (!/^[0-9]+$/.test(ref)) return null;
    return ownerOrg;
  };
  const fn = loadBound(coreStub, vaaniSales, resolveOrganizationId, resolveVaaniCallOrg);
  const ctxFor = (callId, status, org) => ({
    tenant: { id: 't_1', organization_id: org },
    user: { id: 'u-1' },
    body: { callId, status },
  });
  return { fn, issued, ctxFor };
}
function res() { return { status: null, body: null }; }

test('creation starts initiated and mint moves to connecting, never connected', () => {
  const buyer = serverSrc.match(/async function apiVaaniOutboundBuyer\(req, res, ctx\) \{[\s\S]*?\n\}/)[0];
  const seller = serverSrc.match(/async function apiVaaniOutboundSeller\(req, res, ctx\) \{[\s\S]*?\n\}/)[0];
  for (const [name, src] of [['buyer', buyer], ['seller', seller]]) {
    assert.ok(src.includes("'initiated'"), name + ' creates initiated rows');
    assert.ok(!/'queued'/.test(src), name + ' no longer uses queued');
    assert.ok(src.includes("status = 'connecting'"), name + ' mint moves to connecting');
    assert.ok(!src.includes("'connected'"), name + ' HTTP/init path never marks connected');
  }
});

test('connecting call becomes connected only via the status endpoint', async () => {
  const h = harness({ id: 11, status: 'connecting', dograh_call_id: '200', started_at: new Date().toISOString() }, 2);
  const r = res();
  await h.fn({}, r, h.ctxFor(11, 'connected', 2));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, id: 11, status: 'connected' });
  assert.ok(h.issued.some((s) => /^UPDATE vaani_calls/.test(s.trim())), 'transition persisted');
});

test('initiated cannot jump to connected', async () => {
  const h = harness({ id: 12, status: 'initiated', dograh_call_id: '', started_at: new Date().toISOString() }, 2);
  const r = res();
  await h.fn({}, r, h.ctxFor(12, 'connected', 2));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'bad_transition');
  assert.ok(!h.issued.some((s) => /^UPDATE vaani_calls/.test(s.trim())), 'no write on rejected transition');
});

test('failure and no-answer paths persist from connecting', async () => {
  for (const want of ['failed', 'no_answer', 'cancelled']) {
    const h = harness({ id: 13, status: 'connecting', dograh_call_id: '201', started_at: new Date().toISOString() }, 2);
    const r = res();
    await h.fn({}, r, h.ctxFor(13, want, 2));
    assert.equal(r.status, 200, want + ' accepted');
  }
});

test('completed requires connected and computes end state in SQL', async () => {
  const h = harness({ id: 14, status: 'connected', dograh_call_id: '202', started_at: new Date().toISOString() }, 2);
  const r = res();
  await h.fn({}, r, h.ctxFor(14, 'completed', 2));
  assert.equal(r.status, 200);
  const upd = h.issued.find((s) => /^UPDATE vaani_calls/.test(s.trim()));
  assert.ok(upd, 'completion UPDATE issued');
  assert.ok(upd.includes('ended_at'), 'end time recorded');
  assert.ok(upd.includes('started_at IS NOT NULL'), 'duration only with valid timestamps');
  assert.ok(upd.includes("status = 'connected'"), 'duration only when previously connected');
  const h2 = harness({ id: 15, status: 'connecting', dograh_call_id: '203', started_at: new Date().toISOString() }, 2);
  const r2 = res();
  await h2.fn({}, r2, h2.ctxFor(15, 'completed', 2));
  assert.equal(r2.status, 409, 'connecting cannot complete directly');
});

test('same-state repeats are idempotent with no write', async () => {
  const h = harness({ id: 16, status: 'connected', dograh_call_id: '204', started_at: new Date().toISOString() }, 2);
  const r = res();
  await h.fn({}, r, h.ctxFor(16, 'connected', 2));
  assert.equal(r.status, 200);
  assert.ok(!h.issued.some((s) => /^UPDATE vaani_calls/.test(s.trim())), 'no write on repeat');
});

test('terminal states reject further changes', async () => {
  for (const terminal of ['completed', 'failed', 'no_answer', 'cancelled']) {
    const h = harness({ id: 17, status: terminal, dograh_call_id: '205', started_at: new Date().toISOString() }, 2);
    const r = res();
    await h.fn({}, r, h.ctxFor(17, 'connected', 2));
    assert.equal(r.status, 409, terminal + ' is terminal');
  }
});

test('cross-organization updates are rejected with no write', async () => {
  const h = harness({ id: 18, status: 'connecting', dograh_call_id: '206', started_at: new Date().toISOString() }, 1);
  const r = res();
  await h.fn({}, r, h.ctxFor(18, 'connected', 2));
  assert.equal(r.status, 403);
  assert.ok(!h.issued.some((s) => /^UPDATE vaani_calls/.test(s.trim())), 'no write on cross-org attempt');
});

test('unverifiable ownership fails closed', async () => {
  const h = harness({ id: 19, status: 'connecting', dograh_call_id: 'not-a-run', started_at: new Date().toISOString() }, 2);
  const r = res();
  await h.fn({}, r, h.ctxFor(19, 'connected', 2));
  assert.equal(r.status, 403);
});

test('unknown call, bad status, and missing org fail safely', async () => {
  const h404 = harness(null, 2);
  const r404 = res();
  await h404.fn({}, r404, h404.ctxFor(999999, 'connected', 2));
  assert.equal(r404.status, 404);
  const h422 = harness({ id: 20, status: 'connecting', dograh_call_id: '207', started_at: new Date().toISOString() }, 2);
  const r422 = res();
  await h422.fn({}, r422, h422.ctxFor(20, 'dispatched', 2));
  assert.equal(r422.status, 422);
  const h403 = harness({ id: 21, status: 'connecting', dograh_call_id: '208', started_at: new Date().toISOString() }, 2);
  const r403 = res();
  await h403.fn({}, r403, { tenant: {}, user: {}, body: { callId: 21, status: 'connected' } });
  assert.equal(r403.status, 403);
});

test('buyer and seller calls keep their customer association at creation', () => {
  const buyer = serverSrc.match(/async function apiVaaniOutboundBuyer\(req, res, ctx\) \{[\s\S]*?\n\}/)[0];
  const seller = serverSrc.match(/async function apiVaaniOutboundSeller\(req, res, ctx\) \{[\s\S]*?\n\}/)[0];
  for (const [name, src] of [['buyer', buyer], ['seller', seller]]) {
    assert.ok(src.includes('INSERT INTO vaani_calls (customer_id, direction, status, mode, started_at)'), name + ' links customer_id');
  }
});

test('terminal UPDATE semantics hold on real SQL inside a rolled-back transaction', { skip: !hasDb }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.VAANI_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN;');
    await client.query("INSERT INTO vaani_customers (name, phone, machine_requirement) VALUES ('LIFECYCLE TEST.ABC', '+919999009001', 'probe') ON CONFLICT DO NOTHING;");
    const cust = await client.query("SELECT id FROM vaani_customers WHERE phone = '+919999009001' LIMIT 1;");
    const custId = cust.rows[0].id;
    const ins = await client.query(
      "WITH r AS (INSERT INTO vaani_calls (customer_id, direction, status, mode, started_at) VALUES ($1, 'outbound', 'connecting', 'live', CURRENT_TIMESTAMP - INTERVAL '90 seconds') RETURNING id) SELECT id FROM r;",
      [custId]
    );
    const callId = ins.rows[0].id;
    const updSql = serverSrc.match(/UPDATE vaani_calls SET status = \$2,[\s\S]*?WHERE id = \$1;/)[0];
    assert.ok(updSql.includes('ended_at') && updSql.includes('duration'), 'shipped SQL carries end-state math');
    await client.query(vaaniSales.formatSql(updSql, [callId, 'completed']));
    const done = await client.query('SELECT status, ended_at, duration, started_at FROM vaani_calls WHERE id = $1;', [callId]);
    // NOTE: completed-from-connecting is rejected by the endpoint gate; here
    // the row is connecting so duration stays NULL per the shipped CASE rule.
    assert.equal(done.rows[0].status, 'completed');
    assert.ok(done.rows[0].ended_at, 'end time set');
    assert.equal(done.rows[0].duration, null);
    await client.query(
      "UPDATE vaani_calls SET status = 'connected' WHERE id = $1;", [callId]
    );
    await client.query(vaaniSales.formatSql(updSql, [callId, 'completed']));
    const done2 = await client.query('SELECT status, duration FROM vaani_calls WHERE id = $1;', [callId]);
    assert.equal(done2.rows[0].status, 'completed');
    assert.ok(Number.isInteger(done2.rows[0].duration) && done2.rows[0].duration >= 0, 'duration computed from valid timestamps');
  } finally {
    await client.query('ROLLBACK;').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
});
