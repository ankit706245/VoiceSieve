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
  assert.ok(src.includes("if (route === '/api/auth/braivex/login') return apiBraivexLogin(req, res, body);"), 'bridge route present');
  assert.ok(src.includes('async function apiBraivexLogin(req, res, body)'), 'bridge handler present');
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
