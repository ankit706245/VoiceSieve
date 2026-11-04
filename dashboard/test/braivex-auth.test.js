'use strict';
// Phase 1 BRAIVEX bridge tests. Fully mocked: fake fetch for Supabase Auth,
// fake query for the mapping table. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const braivex = require('../lib/braivex-auth');

const mockFetch = (ok, body) => async () => ({ ok, status: ok ? 200 : 400, json: async () => body });

test('bridge reports unconfigured when env is absent', () => {
  const keepUrl = process.env.SUPABASE_URL;
  const keepKey = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  assert.equal(braivex.isBraivexConfigured(), false);
  if (keepUrl !== undefined) process.env.SUPABASE_URL = keepUrl;
  if (keepKey !== undefined) process.env.SUPABASE_ANON_KEY = keepKey;
});

test('valid Supabase identity resolves (mocked exchange + verify)', async () => {
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_ANON_KEY = 'anon';
  try {
    const ex = await braivex.supabaseTokenExchange('t@example.invalid', 'password123456',
      mockFetch(true, { access_token: 'AT', user: { id: 'u-1', email: 't@example.invalid' } }));
    assert.equal(ex.accessToken, 'AT');
    const u = await braivex.supabaseVerifyToken('AT',
      mockFetch(true, { id: 'u-1', email: 't@example.invalid' }));
    assert.equal(u.id, 'u-1');
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  }
});

test('bad credentials and bad tokens become 401 without leaking', async () => {
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_ANON_KEY = 'anon';
  try {
    await assert.rejects(
      braivex.supabaseTokenExchange('t@example.invalid', 'wrong', mockFetch(false, { error: 'x' })), /invalid email or password/);
    await assert.rejects(
      braivex.supabaseVerifyToken('SECRET-AT-123', mockFetch(false, {})), /invalid or expired session/);
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  }
});

test('signup provisioning creates its own org, workflow and profile mapping', async () => {
  let captured = '';
  const orgId = await braivex.provisionWorkspace('u-1', 't_1', (sql, _opts, cb) => {
    captured = sql;
    cb(null, '7\n', '');
  });
  assert.equal(orgId, 7);
  assert.ok(/INSERT INTO public\.organizations/.test(captured), 'must create an organization');
  assert.ok(/INSERT INTO public\.workflows/.test(captured), 'must create the default Vaani workflow');
  assert.ok(/INSERT INTO public\.vaani_user_profiles/.test(captured), 'must map the user to the new org');
  assert.ok(captured.includes("'u-1'") && captured.includes("'t_1'"), 'must bind the caller user and tenant');
  await assert.rejects(
    braivex.provisionWorkspace('u-2', 't_2', (_sql, _opts, cb) => cb(new Error('boom'), '', 'db down')),
    /db down/
  );
  await assert.rejects(
    braivex.provisionWorkspace('u-3', 't_3', (_sql, _opts, cb) => cb(null, '', '')),
    /organization setup failed/
  );
});

test('mapping resolves verbatim, never defaults to org 1', async () => {
  const row = { supabase_user_id: 'u-1', organization_id: 2, tenant_id: null, role: 'owner' };
  const m = await braivex.resolveOrgMapping('u-1', async () => row);
  assert.equal(m.organization_id, 2);
  assert.equal(m.role, 'owner');
  const none = await braivex.resolveOrgMapping('unknown', async () => null);
  assert.equal(none, null);
  assert.equal(await braivex.resolveOrgMapping('', async () => row), null);
  assert.equal(await braivex.resolveOrgMapping('u-9', async () => ({ organization_id: 'nan' })), null);
});

test('different identities keep different organizations (cross-org safe)', async () => {
  const q = async (sql, params) => params[0] === 'u-a'
    ? { supabase_user_id: 'u-a', organization_id: 1, tenant_id: null, role: 'member' }
    : { supabase_user_id: 'u-b', organization_id: 2, tenant_id: null, role: 'member' };
  assert.equal((await braivex.resolveOrgMapping('u-a', q)).organization_id, 1);
  assert.equal((await braivex.resolveOrgMapping('u-b', q)).organization_id, 2);
});

test('error mapping is safe and status-correct', () => {
  const e401 = braivex.mapBraivexAuthError(Object.assign(new Error('x'), { status: 401 }));
  assert.deepEqual(e401, { status: 401, body: { error: 'invalid email or password', code: 'bad_creds' } });
  const e403 = braivex.mapBraivexAuthError(Object.assign(new Error('x'), { status: 403 }));
  assert.equal(e403.status, 403);
  const e429 = braivex.mapBraivexAuthError(Object.assign(new Error('signup rate limit exceeded. Please wait a moment and try again.'), { status: 429, code: 'rate_limited' }));
  assert.equal(e429.status, 429, 'signup rate limit must stay a 429, not a 500');
  assert.equal(e429.body.code, 'rate_limited');
  const e409 = braivex.mapBraivexAuthError(Object.assign(new Error('an account with this email already exists'), { status: 409, code: 'email_taken' }));
  assert.equal(e409.status, 409, 'duplicate email must stay a 409');
  const e503 = braivex.mapBraivexAuthError(Object.assign(new Error('down'), { status: 503, code: 'k' }));
  assert.equal(e503.body.error, 'authentication service unavailable');
  const e500 = braivex.mapBraivexAuthError(new Error('refresh-token SECRET'));
  assert.equal(e500.status, 500);
  assert.ok(!JSON.stringify(e500).includes('SECRET'));
});

test('existing rxv_sess login flow is untouched', () => {
  const src = fs.readFileSync(__dirname + '/../server.js', 'utf8');
  assert.ok(src.includes('async function apiLogin(req, res, body)'), 'apiLogin intact');
  assert.ok(src.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"), 'login route intact');
});

test('real psql pipe-delimited row resolves (no 403 regression)', async () => {
  // Exactly what supadb returns for the Phase 1 mapping row.
  const pipe = 'f37e075c-4e79-49f5-b44f-11cc7a5a494a|2||member';
  const m = await braivex.resolveOrgMapping(
    'f37e075c-4e79-49f5-b44f-11cc7a5a494a',
    async () => pipe + '\n');
  assert.equal(m.organization_id, 2);
  assert.equal(m.role, 'member');
  assert.equal(m.supabase_user_id, 'f37e075c-4e79-49f5-b44f-11cc7a5a494a');
  assert.equal(m.tenant_id, null);
});

test('pipe-delimited edge cases stay safe', async () => {
  const withTenant = await braivex.resolveOrgMapping('u-1',
    async () => 'u-1|3|t_abc|owner\n');
  assert.equal(withTenant.organization_id, 3);
  assert.equal(withTenant.tenant_id, 't_abc');
  assert.equal(withTenant.role, 'owner');
  // Empty result means unmapped, not org 0.
  assert.equal(await braivex.resolveOrgMapping('unknown', async () => ''), null);
  assert.equal(await braivex.resolveOrgMapping('unknown', async () => null), null);
  // Malformed pipe text never resolves.
  assert.equal(await braivex.resolveOrgMapping('u-1', async () => 'garbage'), null);
  assert.equal(await braivex.resolveOrgMapping('u-1', async () => 'a|b'), null);
  // Non-numeric org in pipe text never resolves.
  assert.equal(await braivex.resolveOrgMapping('u-1', async () => 'u-1|nan||member'), null);
});

// The signup handler lives in server.js. Eval it with stubs so a missing
// top-level constant or a broken response shape fails here, not in production.
const serverSrc = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
function loadSignupHandler(core, braivex, supadb) {
  const emailRe = serverSrc.match(/const EMAIL_RE = [^\n]+/)[0];
  const publicTenant = serverSrc.match(/function publicTenant\(t\) \{[\s\S]*?\n\}/)[0];
  const handler = serverSrc.match(/async function apiSignup\(req, res, body\) \{[\s\S]*?\n\}/)[0];
  return new Function('core', 'braivex', 'supadb',
    emailRe + '\n' + publicTenant + '\n' + handler + '\nreturn apiSignup;')(core, braivex, supadb);
}

test('signup handler returns the new org and sets the HttpOnly cookie', async () => {
  const core = {
    genId: () => 't_test',
    authCookie: () => 'braivex_token=AT; HttpOnly; Path=/',
    sendJson(res, status, body, headers) { res.status = status; res.body = body; res.headers = headers || {}; },
  };
  const braivexStub = {
    supabaseSignup: async () => ({ accessToken: 'AT', isNewUser: true, user: { id: 'u-1', email: 'new@example.invalid' } }),
    provisionWorkspace: async () => 7,
  };
  const supadbStub = { queryTextCallback: () => { throw new Error('no query expected'); } };
  const fn = loadSignupHandler(core, braivexStub, supadbStub);
  const res = {};
  await fn({}, res, { email: 'new@example.invalid', password: 'longpassword12', name: 'New', company: 'New Co' });
  assert.equal(res.status, 200);
  assert.equal(res.body.organization_id, 7);
  assert.equal(res.body.tenant.name, 'New Co');
  assert.equal(res.body.accessToken, 'AT');
  assert.ok(res.headers['Set-Cookie'].includes('HttpOnly'), 'session cookie is HttpOnly');
});

test('signup handler rejects an existing email without provisioning or deleting', async () => {
  let provisioned = false;
  const core = {
    genId: () => 't_test',
    authCookie: () => '',
    sendJson(res, status, body) { res.status = status; res.body = body; },
  };
  const braivexStub = {
    supabaseSignup: async () => ({ accessToken: null, isNewUser: false, user: { id: 'u-existing', email: 'old@example.invalid' } }),
    provisionWorkspace: async () => { provisioned = true; return 9; },
  };
  const fn = loadSignupHandler(core, braivexStub, { queryTextCallback: () => {} });
  const res = {};
  await fn({}, res, { email: 'old@example.invalid', password: 'longpassword12' });
  assert.equal(res.status, 409);
  assert.equal(provisioned, false, 'an existing account is never re-provisioned');
});
