'use strict';
// Buyers GET tests for the consolidated sales handler. The handler source is
// eval'd with injected stubs, so no server boot, network, or database is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadHandler(core, vaaniSales) {
  const resolveSrc = serverSrc.match(/function resolveOrganizationId\(ctx\) \{[\s\S]*?\n\}/);
  const handlerSrc = serverSrc.match(/async function apiVaaniSalesGet\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(resolveSrc, 'organization resolver found in server.js');
  assert.ok(handlerSrc, 'sales GET handler found in server.js');
  return new Function('core', 'vaaniSales', resolveSrc[0] + '\n' + handlerSrc[0] + '\nreturn apiVaaniSalesGet;')(core, vaaniSales);
}

function mockCtx(org) {
  return { user: { id: 'u-1' }, organization_id: org, role: 'member' };
}
function mockReq(url) {
  return { url, method: 'GET', headers: { host: 'localhost' } };
}
function mockRes() {
  return { status: null, body: null };
}
function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}

test('response shape passes through identical to vaaniSales.getBuyers', async () => {
  const rows = [{ lead_id: 1 }, { lead_id: 2 }];
  const fn = loadHandler(stubCore(), { getBuyers: async () => rows });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { total: 2, buyers: rows });
});

test('org comes from context and hostile params cannot change scope', async () => {
  let seenArgs = null;
  const fn = loadHandler(stubCore(), {
    getBuyers: async (filters, isDemo, orgId) => { seenArgs = [filters, isDemo, orgId]; return []; },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers?organization_id=1&organizationId=1&tenant_id=t_1&tenantId=t_1'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.equal(seenArgs[1], false);
  assert.equal(seenArgs[2], 2);
  for (const key of ['organization_id', 'organizationId', 'tenant_id', 'tenantId']) {
    assert.ok(!(key in seenArgs[0]), key + ' stripped from filters');
  }
});

test('search and filter parameters flow through untouched', async () => {
  let seenArgs = null;
  const fn = loadHandler(stubCore(), {
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
  const fn = loadHandler(stubCore(), {
    getBuyers: async () => { called = true; throw new Error('must not be called'); },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(null));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'forbidden');
  assert.equal(called, false);
});

test('sales routes are auth gated and the browser cannot choose the org', () => {
  assert.ok(serverSrc.includes("if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);"),
    'sales GET route is auth gated');
  assert.ok(serverSrc.includes("if (route === '/api/vaani/sales/entries') return core.requireAuth(req, res, apiVaaniCreateEntry, body);"),
    'buyer/seller/machine POST route is auth gated');
  assert.ok(!serverSrc.includes('apiVaaniSalesBuyersBraivex'), 'no legacy buyer-only handler remains');
  assert.ok(!serverSrc.includes('req.query.organization'), 'organization never comes from the query string');
});

test('dashboard authenticates with the HttpOnly cookie, not web storage or the URL', () => {
  const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
  assert.ok(!dashSrc.includes('sessionStorage') && !dashSrc.includes('localStorage'), 'no token in web storage');
  assert.ok(!dashSrc.includes('access_token='), 'no token in the URL');
  assert.ok(dashSrc.includes("credentials: 'same-origin'"), 'cookie is sent with API calls');
});
