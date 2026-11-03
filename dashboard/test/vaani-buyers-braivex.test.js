'use strict';
// Migrated Buyers GET tests. Loads the actual apiVaaniSalesBuyersBraivex
// handler from server.js source (never boots the server). The handler source
// is eval'd inside loadBoundHandler, so its free references to `core` and
// `vaaniSales` bind to the injected stubs. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadBoundHandler(core, vaaniSales) {
  const m = serverSrc.match(/async function apiVaaniSalesBuyersBraivex\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'migrated buyers handler found in server.js');
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}

function mockCtx(org) {
  return { user: { id: 'u-1', email: 'user@example.invalid' }, supabaseUser: { id: 'u-1' }, supabaseUserId: 'u-1', organization_id: org, role: 'member' };
}
function mockReq(url) {
  return { url, headers: { host: 'localhost' } };
}
function mockRes() {
  return { status: null, body: null };
}
function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}

test('response shape passes through identical to vaaniSales.getBuyers', async () => {
  const rows = [{ lead_id: 1 }, { lead_id: 2 }];
  const fn = loadBoundHandler(stubCore(), { getBuyers: async () => rows });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { total: 2, buyers: rows });
});

test('org comes from context and hostile params cannot change scope', async () => {
  let seenArgs = null;
  const fn = loadBoundHandler(stubCore(), {
    getBuyers: async (filters, isDemo, orgId) => { seenArgs = [filters, isDemo, orgId]; return []; },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers?organization_id=1&organizationId=1&tenant_id=t_1&tenantId=t_1'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.equal(seenArgs[1], false);
  assert.equal(seenArgs[2], 2);
  assert.ok(!('organization_id' in seenArgs[0]), 'org id stripped from filters');
  assert.ok(!('organizationId' in seenArgs[0]), 'orgId stripped from filters');
  assert.ok(!('tenant_id' in seenArgs[0]), 'tenant stripped from filters');
  assert.ok(!('tenantId' in seenArgs[0]), 'tenantId stripped from filters');
});

test('search and filter parameters flow through untouched', async () => {
  let seenArgs = null;
  const fn = loadBoundHandler(stubCore(), {
    getBuyers: async (filters, isDemo, orgId) => { seenArgs = [filters, isDemo, orgId]; return []; },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers?q=JCB&limit=25'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.equal(seenArgs[0].q, 'JCB');
  assert.equal(seenArgs[0].limit, '25');
  assert.equal(seenArgs[2], 2);
});

test('unmapped context fails closed with 403 and never queries data', async () => {
  let called = false;
  const fn = loadBoundHandler(stubCore(), {
    getBuyers: async () => { called = true; throw new Error('must not be called'); },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(null));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'forbidden');
  assert.equal(called, false);
});

test('buyers route is wired to bearer middleware, siblings untouched', () => {
  const idxNew = serverSrc.indexOf("if (route === '/api/vaani/sales/buyers' && req.method === 'GET') return braivexAuth.requireBraivexAuth(req, res, apiVaaniSalesBuyersBraivex);");
  const idxOld = serverSrc.indexOf("if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);");
  assert.ok(idxNew !== -1, 'bearer buyers route registered');
  assert.ok(idxOld !== -1, 'legacy sales route intact');
  assert.ok(idxNew < idxOld, 'bearer route wins for buyers GET');
  assert.ok(serverSrc.includes("if (route === '/api/vaani/sales/sellers')") ||
    serverSrc.includes("'/api/vaani/sales/sellers'"), 'sellers branch still present');
  assert.ok(serverSrc.includes("if (route === '/api/vaani/sales/buyers' && method === 'POST') return core.requireAuth(req, res, apiVaaniSalesAddBuyer, body);"),
    'buyers POST still legacy');
  const m = serverSrc.match(/async function apiVaaniSalesBuyersBraivex\(req, res, ctx\) \{[\s\S]*?\n\}/);
  const codeOnly = m[0].replace(/\/\/[^\n]*/g, '');
  for (const banned of ['getSession', 'createSession', 'rxv_sess', 'core.db(']) {
    assert.ok(!codeOnly.includes(banned), 'handler must not use ' + banned);
  }
});

test('dashboard sends bearer for buyers without web storage', () => {
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
  const dashSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8'));
  assert.ok(!dashSrc.includes('localStorage') && !dashSrc.includes('sessionStorage'), 'no web storage');
  assert.ok(dashSrc.includes("label === 'Buyers'"), 'buyers section bearer-wired');
});
