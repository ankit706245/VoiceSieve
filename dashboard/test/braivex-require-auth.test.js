'use strict';
// requireBraivexAuth middleware tests. Fully mocked: fake fetch for token
// verification, fake query for the mapping table, mock req/res objects.
// No network, no database, no secrets, no sessions created.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const braivex = require('../lib/braivex-auth');
const core = require('../lib/core');

const UUID = 'f37e075c-4e79-49f5-b44f-11cc7a5a494a';
const mockFetch = (ok, body) => async () => ({ ok, status: ok ? 200 : 401, json: async () => body });

function mockRes() {
  return {
    headersSent: false,
    status: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}
function mockReq(auth) {
  return { headers: auth === undefined ? {} : { authorization: auth } };
}
function parsed(res) {
  return { status: res.status, body: JSON.parse(res.body) };
}

test('missing Authorization header ends 401 without running handler', async () => {
  let ran = false;
  const res = mockRes();
  await braivex.requireBraivexAuth(mockReq(), res, async () => { ran = true; });
  assert.equal(ran, false);
  assert.deepEqual(parsed(res), {
    status: 401, body: { error: 'invalid or expired session', code: 'bad_token' },
  });
});

test('malformed Bearer header ends 401 without running handler', async () => {
  for (const bad of ['Bearer', 'Basic abc123', 'bearer abc123', '', 'Bearer   ']) {
    let ran = false;
    const res = mockRes();
    await braivex.requireBraivexAuth(mockReq(bad), res, async () => { ran = true; });
    assert.equal(ran, false, JSON.stringify(bad) + ' must not run handler');
    assert.equal(parsed(res).status, 401, JSON.stringify(bad) + ' must be 401');
  }
});

test('invalid Supabase token ends 401 without running handler', async () => {
  let ran = false;
  const res = mockRes();
  await braivex.requireBraivexAuth(
    mockReq('Bearer dead-token'),
    res,
    async () => { ran = true; },
    { fetchImpl: mockFetch(false, {}) });
  assert.equal(ran, false);
  assert.deepEqual(parsed(res), {
    status: 401, body: { error: 'invalid or expired session', code: 'bad_token' },
  });
});

test('valid user with Org 2 mapping yields org-2 context', async () => {
  let ctx = null;
  const res = mockRes();
  const out = await braivex.requireBraivexAuth(
    mockReq('Bearer good-token'),
    res,
    async (req, res2, c) => { ctx = c; return 'ok'; },
    {
      fetchImpl: mockFetch(true, { id: UUID, email: 'user@example.invalid' }),
      queryImpl: async () => UUID + '|2||member\n',
    });
  assert.equal(out, 'ok');
  assert.ok(ctx, 'handler ran');
  assert.equal(ctx.supabaseUserId, UUID);
  assert.equal(ctx.organization_id, 2);
  assert.equal(ctx.role, 'member');
  assert.equal(ctx.user.id, UUID);
  assert.equal(ctx.supabaseUser.id, UUID);
});

test('valid user without mapping ends 403 org_not_linked', async () => {
  let ran = false;
  const res = mockRes();
  await braivex.requireBraivexAuth(
    mockReq('Bearer good-token'),
    res,
    async () => { ran = true; },
    {
      fetchImpl: mockFetch(true, { id: 'unknown-id' }),
      queryImpl: async () => null,
    });
  assert.equal(ran, false);
  assert.deepEqual(parsed(res), {
    status: 403,
    body: { error: 'account is not linked to an organization', code: 'org_not_linked' },
  });
});

test('mapped role is preserved verbatim', async () => {
  for (const role of ['member', 'owner', 'admin', 'super_admin']) {
    let ctx = null;
    const res = mockRes();
    await braivex.requireBraivexAuth(
      mockReq('Bearer good-token'),
      res,
      async (req, res2, c) => { ctx = c; },
      {
        fetchImpl: mockFetch(true, { id: 'u-1' }),
        queryImpl: async () => ({ supabase_user_id: 'u-1', organization_id: 3, tenant_id: null, role }),
      });
    assert.equal(ctx.role, role, 'role ' + role + ' preserved');
    assert.equal(ctx.organization_id, 3);
  }
});

test('new helper never touches legacy sessions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'braivex-auth.js'), 'utf8');
  const fn = src.split('async function requireBraivexAuth')[1].split(/^module\.exports/m)[0];
  assert.ok(!fn.includes('createSession'), 'no createSession in helper');
  assert.ok(!fn.includes('rxv_sess'), 'no rxv_sess in helper');
  assert.ok(!fn.includes('db.json') && !fn.includes('core.db('), 'no db.json access in helper');
  assert.ok(!fn.includes('organization_id || 1'), 'no silent org fallback in helper');
});

test('existing requireAuth behavior is unchanged', () => {
  assert.equal(typeof core.requireAuth, 'function', 'requireAuth still exported');
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core.js'), 'utf8');
  assert.ok(coreSrc.includes('code: \'no_session\''), 'no_session path intact');
  assert.ok(coreSrc.includes('async function requireAuth(req, res, handler, body)'), 'signature intact');
});
