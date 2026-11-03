'use strict';
// Vaani refresh-session regression tests: BRAIVEX login -> open Vaani ->
// refresh page -> BRAIVEX identity remains -> demo identity never appears.
// Static checks over the shipped pages plus a live eval of the real apiMe
// handler with stubbed core/serializers. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'braivex-login.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

function loadApiMe(core, publicUser, publicTenant) {
  const m = serverSrc.match(/function apiMe\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'apiMe found in server.js');
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}
const stubCore = () => ({ sendJson(res, status, body) { res.status = status; res.body = body; } });
const stubUser = (u) => ({ ...u });
const stubTenant = (t) => ({ ...t });

test('bearer handoff survives refresh: no boot-time clear', () => {
  const code = strip(dashSrc);
  assert.ok(code.includes('clearBraivexHandoff'), 'central handoff clearer exists');
  // The boot read must not wipe window.name; only logout/401/failed-check clear it.
  const bootBlock = code.split('let braivexAccessToken')[1].split('function clearBraivexHandoff')[0];
  assert.ok(!bootBlock.includes("window.name = ''"), 'boot read must retain the handoff');
  assert.ok(code.includes('handleLogout') && code.includes('clearBraivexHandoff()'), 'logout clears handoff');
});

test('no demo or legacy identity can paint before auth', () => {
  assert.ok(!dashSrc.includes('Demo User'), 'no demo placeholder label');
  assert.ok(!dashSrc.includes('demo@rapidx.ai'), 'no demo email anywhere');
  assert.ok(dashSrc.includes('Signing in'), 'neutral pre-auth label');
});

test('non-BRAIVEX sessions never render: gate redirects to login', () => {
  const code = strip(dashSrc);
  assert.ok(code.includes("data.authSource !== 'braivex'"), 'authSource gate present');
  const gate = code.split("data.authSource !== 'braivex'")[1].split('applyUserTenantContext')[0];
  assert.ok(gate.includes('fresh=1'), 'gate redirects with fresh=1 (form, no bounce loop)');
  assert.ok(gate.includes('return false'), 'gate stops boot before render');
});

test('session-expiry paths force re-authentication form', () => {
  assert.ok(dashSrc.includes('/braivex-login.html?redirect=/vaani-sales.html&fresh=1'), 'expiry redirect carries fresh=1');
});

test('login page honors fresh=1 and still bounces otherwise', () => {
  const code = strip(loginSrc);
  assert.ok(code.includes("get('fresh') === '1'"), 'fresh flag read');
  assert.ok(code.includes("fetch('/api/me'"), 'authed bounce still present for normal visits');
  assert.ok(!strip(loginSrc).includes('localStorage') && !strip(loginSrc).includes('sessionStorage'), 'no web storage');
});

test('apiMe marks bridge sessions braivex and legacy sessions legacy', () => {
  const shadow = { id: 'u_1', supabaseUserId: 'f37e075c-4e79-49f5-b44f-11cc7a5a494a', email: 'u@e', role: 'member' };
  const legacy = { id: 'u_2', email: 'demo@rapidx.ai', role: 'owner' };
  const tenant = { id: 't_1', organization_id: 2 };
  const fn = loadApiMe(stubCore(), stubUser, stubTenant);
  const r1 = {};
  fn({}, r1, { user: shadow, tenant, session: {}, impersonator: null });
  assert.equal(r1.body.authSource, 'braivex');
  assert.equal(r1.body.user.email, 'u@e');
  const r2 = {};
  fn({}, r2, { user: legacy, tenant, session: {}, impersonator: null });
  assert.equal(r2.body.authSource, 'legacy');
  assert.ok('tenant' in r2.body && 'impersonation' in r2.body, 'response shape otherwise intact');
});
