'use strict';
// Migrated overview GET tests. Loads the actual apiVaaniSalesOverviewBraivex
// handler from server.js source (never boots the server). The handler source
// is eval'd inside loadBoundHandler, so its free references to `core` and
// `vaaniSales` bind to the injected stubs. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadBoundHandler(core, vaaniSales) {
  const m = serverSrc.match(/async function apiVaaniSalesOverviewBraivex\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'migrated overview handler found in server.js');
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}

function mockCtx(org) {
  return { user: { id: 'u-1', email: 'user@example.invalid' }, supabaseUser: { id: 'u-1' }, supabaseUserId: 'u-1', organization_id: org, role: 'member' };
}
function mockReq(url) {
  return { url, headers: { host: 'localhost' } };
}
function mockRes() {
  const res = { status: null, body: null };
  return res;
}
function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}

test('response shape passes through identical to vaaniSales.getOverview', async () => {
  const expected = { is_demo: false, total_leads: 7, funnel: [{ stage: 'NEW', count: 7 }], recent_leads: [] };
  const fn = loadBoundHandler(stubCore(), { getOverview: async () => expected });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/overview'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, expected);
});

test('cross-org query parameters cannot change scope', async () => {
  let seenArgs = null;
  const fn = loadBoundHandler(stubCore(), {
    getOverview: async (isDemo, orgId) => { seenArgs = [isDemo, orgId]; return { ok: true }; },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/overview?organization_id=1&organizationId=1&tenant_id=t_1&tenantId=t_1'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.deepEqual(seenArgs, [false, 2]);
});

test('unmapped context fails closed with 403 and never queries data', async () => {
  let called = false;
  const fn = loadBoundHandler(stubCore(), {
    getOverview: async () => { called = true; throw new Error('must not be called'); },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/overview'), res, mockCtx(null));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'forbidden');
  assert.equal(called, false);
});

test('upstream failure maps to safe 500 with legacy-identical shape', async () => {
  const fn = loadBoundHandler(stubCore(), {
    getOverview: async () => { throw new Error('db down'); },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/overview'), res, mockCtx(2));
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'sales_api_error');
});

test('overview route is wired to bearer middleware, other sales routes untouched', () => {
  const idxNew = serverSrc.indexOf("if (route === '/api/vaani/sales/overview') return braivexAuth.requireBraivexAuth(req, res, apiVaaniSalesOverviewBraivex);");
  const idxOld = serverSrc.indexOf("if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);");
  assert.ok(idxNew !== -1, 'bearer route registered');
  assert.ok(idxOld !== -1, 'legacy sales route intact');
  assert.ok(idxNew < idxOld, 'bearer route wins for overview');
  const m = serverSrc.match(/async function apiVaaniSalesOverviewBraivex\(req, res, ctx\) \{[\s\S]*?\n\}/);
  const codeOnly = m[0].replace(/\/\/[^\n]*/g, '');
  for (const banned of ['getSession', 'createSession', 'rxv_sess', 'core.db(']) {
    assert.ok(!codeOnly.includes(banned), 'handler must not use ' + banned);
  }
  assert.ok(serverSrc.includes('braivexAccessToken: accessToken'), 'login hands token additively');
  assert.ok(serverSrc.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"), 'legacy login intact');
  assert.ok(serverSrc.includes('async function apiVaaniSalesGet(req, res, ctx)'), 'legacy sales handler intact');
});

test('token handoff never uses web storage', () => {
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
  const loginSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'public', 'braivex-login.html'), 'utf8'));
  const dashSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8'));
  assert.ok(!loginSrc.includes('localStorage') && !loginSrc.includes('sessionStorage'), 'login: no web storage');
  assert.ok(!dashSrc.includes('localStorage') && !dashSrc.includes('sessionStorage'), 'dashboard: no web storage');
  assert.ok(dashSrc.includes("Authorization: 'Bearer ' + braivexAccessToken"), 'dashboard sends bearer for overview');
});
