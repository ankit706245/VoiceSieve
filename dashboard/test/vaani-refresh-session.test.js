'use strict';
// Vaani session regression tests: cookie login -> open CRM -> refresh keeps
// the signed-in identity, and no demo identity paints before auth.
// Static checks over the shipped pages. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'braivex-login.html'), 'utf8');

test('CRM boot restores identity from the cookie session', () => {
  assert.ok(dashSrc.includes("fetch('/api/me')"), 'dashboard reads the server session');
  assert.ok(serverSrc.includes('function apiMe(req, res, ctx)'), 'apiMe exists server-side');
  assert.ok(serverSrc.includes('core.getSession(req)'), 'session comes from the cookie');
});

test('no demo identity paints before auth', () => {
  assert.ok(!dashSrc.includes('demo@rapidx.ai'), 'no demo email anywhere');
  assert.ok(dashSrc.includes('function showSessionExpired'), 'expiry path exists');
});

test('unauthenticated boot redirects to the login form', () => {
  assert.ok(dashSrc.includes('showSessionExpired('), 'boot can show the expiry overlay');
  assert.ok(dashSrc.includes('&fresh=1'), 'expiry redirect forces the form');
  assert.ok(loginSrc.includes("get('fresh') === '1'"), 'login page honors fresh=1');
});

test('login page exchanges an email-link token for the cookie and opens the CRM', () => {
  assert.ok(loginSrc.includes("fetch('/api/auth/session'"), 'hash token is traded for the HttpOnly cookie');
  assert.ok(!loginSrc.includes('access_token='), 'token never appended to the redirect URL');
  assert.ok(loginSrc.includes('DASHBOARD_URL'), 'authed visit redirects to CRM');
});

test('logout destroys the server session before leaving', () => {
  assert.ok(dashSrc.includes("await fetch('/api/auth/logout', { method: 'POST' })"),
    'logout hits the server');
  assert.ok(serverSrc.includes('async function apiLogout(req, res)'), 'logout handler exists');
  assert.ok(dashSrc.includes("window.location.href = '/braivex-login.html'"),
    'logout returns to the login page');
});

test('unmapped workspaces can read the shared demo, never real rows', () => {
  const m = serverSrc.match(/function resolveOrganizationId\(ctx\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'resolveOrganizationId found');
  const resolve = eval('(' + m[0] + ')'); // eslint-disable-line no-eval
  assert.equal(resolve({ tenant: { id: 't_1' } }), null, 'missing org fails closed');
  assert.equal(resolve({ tenant: { id: 't_2', organization_id: 2 } }), 2, 'explicit org wins');
  assert.equal(resolve({ organization_id: 3 }), 3, 'Supabase mapping org wins without a local tenant');
  assert.equal(resolve({}), null, 'missing tenant fails closed');
  assert.ok(serverSrc.includes('if (!orgId && !isDemo)'),
    'demo fixture is allowed without an org mapping');
});

test('auth pages never store the password in web storage', () => {
  for (const [name, src] of [['login', loginSrc], ['dashboard', dashSrc]]) {
    assert.ok(!src.includes('localStorage'), `${name}: no localStorage`);
    for (const line of src.split('\n').filter((l) => l.includes('sessionStorage'))) {
      assert.ok(!/password/i.test(line), `${name}: sessionStorage holds only the access token`);
    }
  }
});
