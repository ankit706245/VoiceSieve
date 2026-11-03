'use strict';
// Outbound organization tests. Loads the actual apiVaaniOutboundBuyer/Seller
// handlers from server.js source (never boots the server). Free references
// bind to injected stubs via eval scope, so no database, Dograh, PSTN,
// WhatsApp, or user changes can occur.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadBound(name, core, vaaniSales, mintDograhVoiceSession, resolveOrganizationId, primaryOrganizationId) {
  const re = new RegExp('async function ' + name + '\\(req, res, ctx\\) \\{[\\s\\S]*?\\n\\}');
  const m = serverSrc.match(re);
  assert.ok(m, name + ' found in server.js');
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}

function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}
function resolveOrgFromCtx(ctx) {
  if (!ctx || !ctx.tenant) return null;
  if (ctx.tenant.organization_id === undefined || ctx.tenant.organization_id === null) return null;
  const n = parseInt(ctx.tenant.organization_id, 10);
  return isNaN(n) ? null : n;
}
function primaryOrg() { return 1; }
function mockCtx(orgId) {
  return {
    user: { id: 'u-1', email: 'user@example.invalid' },
    tenant: { id: 't_1', organization_id: orgId },
    body: { name: 'Test Buyer', phone: '919999900000', machine_requirement: 'excavator' },
  };
}
function mockReq() {
  return { url: '/api/vaani/sales/outbound/buyer', headers: { host: 'localhost' } };
}
function dbStub() {
  const calls = [];
  return {
    calls,
    // The outbound handlers resolve the org-owned workflow before any write.
    resolveOrgWorkflowId: async (orgId) => (parseInt(orgId, 10) === 1 ? 3 : null),
    queryPostgres: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO vaani_customers/.test(sql)) return { id: 9001 };
      if (/INSERT INTO vaani_calls/.test(sql)) return { id: 9002 };
      if (/INSERT INTO workflow_runs/.test(sql)) return {};
      return {};
    },
  };
}

test('no hardcoded orgId = 1 remains in outbound handlers', () => {
  for (const name of ['apiVaaniOutboundBuyer', 'apiVaaniOutboundSeller']) {
    const re = new RegExp('async function ' + name + '\\(req, res, ctx\\) \\{[\\s\\S]*?\\n\\}');
    const src = serverSrc.match(re)[0].replace(/\/\/[^\n]*/g, '');
    assert.ok(!/orgId\s*=\s*1\b/.test(src), name + ' must not hardcode org 1');
    assert.ok(src.includes('resolveOrganizationId(ctx)'), name + ' derives org from ctx');
    assert.ok(src.includes('primaryOrganizationId()'), name + ' enforces the primary org');
  }
});

test('buyer path with Org 1 uses the resolved workflow and tags the run Org 1', async () => {
  const db = dbStub();
  let mintArg = null;
  const mint = async (req, context) => { mintArg = context; return { workflowRunId: '9003' }; };
  const fn = loadBound('apiVaaniOutboundBuyer', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(1));
  assert.equal(res.status, 200);
  assert.equal(res.body.call_status, 'DISPATCHED');
  assert.ok(mintArg, 'Dograh mint reached');
  assert.equal(mintArg.crmVariables.organization_id, 1);
  assert.ok(db.calls.some((c) => /INSERT INTO vaani_customers/.test(c.sql)), 'customer write issued');
  assert.ok(db.calls.some((c) => /INSERT INTO vaani_calls/.test(c.sql)), 'call write issued');

  const wfInserts = db.calls.filter((c) => /INSERT INTO workflow_runs/.test(c.sql));
  assert.equal(wfInserts.length, 1, 'exactly one workflow_runs pre-create INSERT');
  assert.equal(wfInserts[0].params[2], 3, 'workflow_id = resolved Vaani workflow 3');
});

test('buyer path with Org 2 is rejected as non-primary', async () => {
  const db = dbStub();
  let minted = false;
  const mint = async () => { minted = true; return { workflowRunId: 'wr-1' }; };
  const fn = loadBound('apiVaaniOutboundBuyer', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(2));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'primary_org_required');
  assert.equal(db.calls.length, 0, 'no writes for non-primary outbound');
  assert.equal(minted, false, 'no Dograh session for non-primary outbound');
});

test('pre-call workflow_runs record created with Dograh workflowRunId', async () => {
  const db = dbStub();
  const mint = async () => ({ workflowRunId: '9003' });
  const fn = loadBound('apiVaaniOutboundBuyer', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(1));
  assert.equal(res.status, 200);

  const wfInserts = db.calls.filter((c) => /INSERT INTO workflow_runs/.test(c.sql));
  assert.equal(wfInserts.length, 1, 'exactly one workflow_runs pre-create INSERT');
  const wfSql = wfInserts[0].sql;
  const wfParams = wfInserts[0].params;

  assert.equal(wfParams[0], 9003, 'workflow_runs.id = Dograh workflowRunId');
  assert.equal(wfParams[2], 3, 'workflow_id = 3 (buyer workflow)');
  assert.equal(wfParams[5], 'outbound', 'call_type = outbound');

  assert.ok(/\$1/.test(wfSql) && /\$2/.test(wfSql) && /\$3/.test(wfSql) && /\$4/.test(wfSql) && /\$5/.test(wfSql) && /\$6/.test(wfSql), 'uses $n parameter placeholders');
  assert.ok(!wfSql.includes('${'), 'no template literal interpolation in SQL');

  const gathered = wfParams[4];
  assert.ok(gathered, 'gathered_context present');
  assert.equal(gathered.extracted_variables.customer_type, 'buyer', 'customer_type = buyer in gathered_context');
  assert.equal(gathered.call_session.seller_or_buyer, 'buyer', 'call_session.seller_or_buyer = buyer');
});

test('pre-call workflow_runs creation skipped for non-numeric workflowRunId', async () => {
  const db = dbStub();
  const mint = async () => ({ workflowRunId: 'wr-ctx' });
  const fn = loadBound('apiVaaniOutboundBuyer', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(1));
  assert.equal(res.status, 200);

  const wfInserts = db.calls.filter((c) => /INSERT INTO workflow_runs/.test(c.sql));
  assert.equal(wfInserts.length, 0, 'no workflow_runs INSERT for non-numeric workflowRunId');
});

test('pre-call workflow_runs creation skipped when workflowRunId missing', async () => {
  const db = dbStub();
  const mint = async () => ({});
  const fn = loadBound('apiVaaniOutboundBuyer', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(1));
  assert.equal(res.status, 200);

  const wfInserts = db.calls.filter((c) => /INSERT INTO workflow_runs/.test(c.sql));
  assert.equal(wfInserts.length, 0, 'no workflow_runs INSERT when workflowRunId absent');
});

test('seller path with Org 1 is dispatched', async () => {
  const db = dbStub();
  let mintArg = null;
  const mint = async (req, context) => { mintArg = context; return { workflowRunId: 'wr-2' }; };
  const fn = loadBound('apiVaaniOutboundSeller', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(1));
  assert.equal(res.status, 200);
  assert.equal(res.body.call_status, 'DISPATCHED');
  assert.equal(mintArg.crmVariables.organization_id, 1);
});

test('seller path with Org 2 is rejected as non-primary', async () => {
  const db = dbStub();
  let minted = false;
  const mint = async () => { minted = true; return { workflowRunId: 'wr-2' }; };
  const fn = loadBound('apiVaaniOutboundSeller', stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
  const res = { status: null, body: null };
  await fn(mockReq(), res, mockCtx(2));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'primary_org_required');
  assert.equal(db.calls.length, 0, 'no writes for non-primary outbound');
  assert.equal(minted, false, 'no Dograh session for non-primary outbound');
});

test('missing organization fails safely with no writes and no Dograh call', async () => {
  for (const name of ['apiVaaniOutboundBuyer', 'apiVaaniOutboundSeller']) {
    for (const badOrg of [null, undefined, 0]) {
      const db = dbStub();
      let minted = false;
      const mint = async () => { minted = true; return {}; };
      const fn = loadBound(name, stubCore(), db, mint, resolveOrgFromCtx, primaryOrg);
      const res = { status: null, body: null };
      const ctx = mockCtx(badOrg);
      await fn(mockReq(), res, ctx);
      assert.equal(res.status, 403, name + ' org=' + badOrg + ' must 403');
      assert.equal(res.body.code, 'forbidden', name + ' org=' + badOrg);
      assert.equal(db.calls.length, 0, name + ' org=' + badOrg + ' must not write');
      assert.equal(minted, false, name + ' org=' + badOrg + ' must not mint');
    }
  }
});

test('Dograh embed/init flow is unchanged', () => {
  assert.ok(serverSrc.includes('/api/v1/public/embed/init'), 'embed init intact');
  assert.ok(serverSrc.includes('AbortSignal.timeout(30000)'), 'Goal 19 timeout intact');
  for (const name of ['apiVaaniOutboundBuyer', 'apiVaaniOutboundSeller']) {
    const re = new RegExp('async function ' + name + '\\(req, res, ctx\\) \\{[\\s\\S]*?\\n\\}');
    const src = serverSrc.match(re)[0];
    assert.ok(src.includes('mintDograhVoiceSession(req,'), name + ' still mints voice session');
  }
});
