'use strict';
// Internal inventory API isolation tests. No live database, no network,
// no Supabase, no real secrets. The dummy secret below lives only in the
// test process env and is restored afterwards.
// Run: node --test dashboard/test/vaani-internal-machines.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');

const DUMMY_SECRET = 'test-only-dummy-internal-secret-xyz';
const realSecret = process.env.VAANI_INTERNAL_API_SECRET;
process.env.VAANI_INTERNAL_API_SECRET = DUMMY_SECRET;
test.after(() => {
  if (realSecret === undefined) delete process.env.VAANI_INTERNAL_API_SECRET;
  else process.env.VAANI_INTERNAL_API_SECRET = realSecret;
});

function loadHandler(coreStub, vaaniStub) {
  const m = serverSrc.match(/async function apiVaaniInternalMachines\(req, res\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'apiVaaniInternalMachines found in server.js');
  const core = coreStub;
  const vaaniSales = vaaniStub;
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}

function stubCore(captured) {
  return { sendJson(res, status, body) { captured.status = status; captured.body = body; } };
}

function req(url, secret = DUMMY_SECRET) {
  return { url, headers: { host: 'localhost', 'x-vaani-internal-secret': secret } };
}

test('missing or incorrect secret is rejected without inventory', async () => {
  for (const secret of [undefined, 'wrong-secret']) {
    const captured = {};
    const vaaniStub = { queryPostgres: async () => { throw new Error('must not reach DB'); } };
    const handler = loadHandler(stubCore(captured), vaaniStub);
    const headers = { host: 'localhost' };
    if (secret !== undefined) headers['x-vaani-internal-secret'] = secret;
    await handler({ url: '/api/vaani/internal/machines?buyer_run_id=1', headers }, {});
    assert.equal(captured.status, 403);
    assert.ok(!JSON.stringify(captured.body).includes(DUMMY_SECRET), 'secret never echoed');
    assert.ok(!('machines' in (captured.body || {})), 'no inventory on auth failure');
  }
});

test('missing or invalid buyer_run_id returns no inventory', async () => {
  for (const url of [
    '/api/vaani/internal/machines',
    '/api/vaani/internal/machines?buyer_run_id=abc',
    '/api/vaani/internal/machines?buyer_run_id=0',
  ]) {
    const captured = {};
    let dbHit = false;
    const vaaniStub = {
      queryPostgres: async () => { dbHit = true; return []; },
      getInternalMachines: async () => { dbHit = true; return []; },
    };
    await loadHandler(stubCore(captured), vaaniStub)(req(url), {});
    assert.equal(captured.status, 400);
    assert.ok(!dbHit || !('machines' in (captured.body || {})), 'no inventory without buyer pointer');
  }
});

test('unknown or non-buyer row fails closed with 404', async () => {
  for (const row of [[], [{ organization_id: 7, customer_type: 'seller', run_id: 9 }]]) {
    const captured = {};
    let machinesCalled = false;
    const vaaniStub = {
      queryPostgres: async () => row,
      getInternalMachines: async () => { machinesCalled = true; return []; },
    };
    await loadHandler(stubCore(captured), vaaniStub)(req('/api/vaani/internal/machines?buyer_run_id=9'), {});
    assert.equal(captured.status, 404);
    assert.equal(machinesCalled, false);
  }
});

test('organization A buyer resolves to organization A stock only', async () => {
  const captured = {};
  let receivedOrg = null;
  const vaaniStub = {
    queryPostgres: async (sql, params) => {
      assert.ok(/FROM vaani_excavator_sales_leads/.test(sql), 'buyer row resolved server-side');
      assert.deepEqual(params, [42]);
      return [{ organization_id: 7, customer_type: 'buyer', run_id: 42 }];
    },
    getInternalMachines: async (org) => { receivedOrg = org; return [{ machine_id: 'm7' }]; },
  };
  await loadHandler(stubCore(captured), vaaniStub)(req('/api/vaani/internal/machines?buyer_run_id=42'), {});
  assert.equal(captured.status, 200);
  assert.equal(receivedOrg, 7);
  assert.deepEqual(captured.body, { machines: [{ machine_id: 'm7' }], count: 1 });
});

test('empty inventory returns an empty result', async () => {
  const captured = {};
  const vaaniStub = {
    queryPostgres: async () => [{ organization_id: 7, customer_type: 'buyer', run_id: 42 }],
    getInternalMachines: async () => [],
  };
  await loadHandler(stubCore(captured), vaaniStub)(req('/api/vaani/internal/machines?buyer_run_id=42'), {});
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { machines: [], count: 0 });
});

test('database errors fail safely without leaking secrets', async () => {
  const captured = {};
  const vaaniStub = {
    queryPostgres: async () => [{ organization_id: 7, customer_type: 'buyer', run_id: 42 }],
    getInternalMachines: async () => { throw new Error('pg boom ' + DUMMY_SECRET + ' conn details'); },
  };
  await loadHandler(stubCore(captured), vaaniStub)(req('/api/vaani/internal/machines?buyer_run_id=42'), {});
  assert.equal(captured.status, 500);
  assert.equal(captured.body.code, 'internal_api_error');
  assert.ok(!JSON.stringify(captured.body).includes(DUMMY_SECRET), 'secret never echoed on 500');
});

test('lib: invalid organization returns [] without database access', async () => {
  for (const bad of [null, undefined, 0, -3, 'abc', {}, NaN]) {
    const out = await vaaniSales.getInternalMachines(bad, { brand: 'JCB' });
    assert.deepEqual(out, []);
  }
});

test('lib: query always scopes organization_id first with bound params', () => {
  for (const org of [7, '9']) {
    const built = vaaniSales.buildInternalMachinesQuery(org, { brand: 'JCB', model: '3DX' });
    assert.ok(built, 'valid org builds');
    assert.equal(built.organizationId, Number(org));
    assert.ok(/WHERE organization_id = \$1 AND/.test(built.sql), 'org predicate first, got: ' + built.sql);
    assert.equal(built.params[0], Number(org));
    assert.ok(built.sql.includes('brand ILIKE $2') && built.sql.includes('model ILIKE $3'));
  }
  assert.equal(vaaniSales.buildInternalMachinesQuery(0), null);
  assert.equal(vaaniSales.buildInternalMachinesQuery('x'), null);
});

test('lib: sold/unavailable excluded by default, explicit status stays org-scoped', () => {
  const def = vaaniSales.buildInternalMachinesQuery(7, {});
  assert.ok(/status IN \('in_sourcing_pipeline', 'certified_ready_in_yard'\)/.test(def.sql), 'default allowlist, got: ' + def.sql);
  const exp = vaaniSales.buildInternalMachinesQuery(7, { status: 'sold' });
  assert.ok(/status = \$2/.test(exp.sql) && exp.params[1] === 'sold', 'explicit override honored');
  assert.ok(/WHERE organization_id = \$1 AND/.test(exp.sql), 'override still org-scoped');
});

test('lib: price columns never selected, result capped', () => {
  const built = vaaniSales.buildInternalMachinesQuery(7, {});
  assert.ok(!/sourcing_cost_inr|target_resale_inr/.test(built.sql), 'no price columns');
  assert.ok(/LIMIT 50/.test(built.sql), 'cap preserved');
});

test('source guards: handler never reads client-supplied organization', () => {
  const fnSrc = serverSrc.match(/async function apiVaaniInternalMachines\(req, res\) \{[\s\S]*?\n\}/)[0];
  assert.ok(!/searchParams\.get\(['"]organization/.test(fnSrc), 'no org from query string');
  assert.ok(!/body\.organization/.test(fnSrc), 'no org from request body');
  assert.ok(/buyer_run_id/.test(fnSrc) && /vaani_excavator_sales_leads/.test(fnSrc), 'org resolved from buyer row');
});
