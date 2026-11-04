'use strict';

/**
 * Phase 1 BRAIVEX: Supabase Auth verification + organization-mapping bridge.
 *
 * All Supabase Auth HTTP happens here, server-side only. The anon key and
 * project URL come from process.env (never the frontend, never logs).
 * Organization is resolved ONLY from the server-side mapping table
 * public.vaani_user_profiles keyed by verified Supabase user id. There is
 * no fallback organization: unknown users get 403, bad tokens get 401.
 */

const crypto = require('crypto');
const supadb = require('./supadb');

function braivexConfig() {
  return {
    url: String(process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    anonKey: String(process.env.SUPABASE_ANON_KEY || ''),
  };
}

function isBraivexConfigured() {
  const c = braivexConfig();
  return Boolean(c.url && c.anonKey);
}

function authError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Create a new Supabase Auth user (email + password).
// Returns { accessToken, user }. accessToken is null when the user is
// unconfirmed (mailer_autoconfirm: false) — they must confirm via email first.
// Throws 409 if email already exists, 422 on validation failure.
async function supabaseSignup(email, password, fetchImpl) {
  const { url, anonKey } = braivexConfig();
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(url + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw authError('Supabase Auth is unreachable', 503, 'supabase_unreachable');
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 409) throw authError('an account with this email already exists', 409, 'email_taken');
  if (res.status === 422) throw authError(data.message || 'validation failed', 422, 'validation_error');
  if (res.status === 429) throw authError('signup rate limit exceeded. Please wait a moment and try again.', 429, 'rate_limited');
  if (!res.ok || !data.id || !data.email) {
    throw authError('signup failed', 400, 'signup_failed');
  }
  // Supabase returns the existing user with an empty identities array when the
  // email is already registered. Only a user with an identity was just created.
  const isNewUser = Array.isArray(data.identities)
    ? data.identities.length > 0
    : Boolean(data.access_token || data.confirmation_sent_at);
  return { accessToken: data.access_token || null, isNewUser, user: { id: data.id, email: data.email, ...data.user_metadata } };
}

// Create a separate organization, its default Vaani workflow, and the user
// profile mapping in one atomic statement. Every signup gets its own org, so
// CRM rows never leak between customers.
function provisionWorkspace(supabaseUserId, tenantId, queryImpl) {
  const providerId = `braivex_${Date.now()}_${crypto.randomUUID()}`;
  const esc = (v) => String(v).replace(/'/g, "''");
  const sql = `WITH new_org AS (
    INSERT INTO public.organizations (provider_id) VALUES ('${esc(providerId)}') RETURNING id
  ), new_wf AS (
    INSERT INTO public.workflows (name, workflow_definition, template_context_variables, call_disposition_codes, organization_id, status, workflow_uuid)
    SELECT 'Vaani Sales', '{}'::json, '{}'::json, '{}'::json, id, 'active', 'braivex_' || id
    FROM new_org RETURNING organization_id
  )
  INSERT INTO public.vaani_user_profiles (supabase_user_id, organization_id, tenant_id, role)
  SELECT '${esc(supabaseUserId)}', organization_id, '${esc(tenantId)}', 'owner' FROM new_wf
  RETURNING organization_id;`;
  const run = queryImpl || ((q, opts, cb) => supadb.queryTextCallback(q, opts, cb));
  return new Promise((resolve, reject) => {
    run(sql, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(0, 300)));
      const orgId = parseInt(String(stdout || '').trim(), 10);
      if (!Number.isFinite(orgId) || orgId <= 0) return reject(new Error('organization setup failed'));
      resolve(orgId);
    });
  });
}

// Exchange email+password for a Supabase session (password grant).
// Returns { accessToken, user }. Throws 401 on bad credentials.
async function supabaseTokenExchange(email, password, fetchImpl) {
  const { url, anonKey } = braivexConfig();
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw authError('Supabase Auth is unreachable', 503, 'supabase_unreachable');
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || !data.access_token || !data.user || !data.user.id) {
    throw authError('invalid email or password', 401, 'bad_creds');
  }
  return { accessToken: data.access_token, user: data.user };
}

// Revoke the current Supabase session (refresh token) on logout. Access tokens
// are JWTs and expire on their own; this stops the session being refreshed.
async function supabaseLogout(accessToken, fetchImpl) {
  const { url, anonKey } = braivexConfig();
  const doFetch = fetchImpl || fetch;
  if (!accessToken || !url || !anonKey) return;
  try {
    await doFetch(url + '/auth/v1/logout', {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: 'Bearer ' + accessToken },
    });
  } catch (_) {
    // Best effort: the local cookie is cleared regardless.
  }
}

// Verify an access token against Supabase Auth. Returns the user or throws 401.
async function supabaseVerifyToken(accessToken, fetchImpl) {
  const { url, anonKey } = braivexConfig();
  const doFetch = fetchImpl || fetch;
  let res;
  try {
    res = await doFetch(url + '/auth/v1/user', {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: 'Bearer ' + accessToken },
    });
  } catch (e) {
    throw authError('Supabase Auth is unreachable', 503, 'supabase_unreachable');
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || !data.id) {
    throw authError('invalid or expired session', 401, 'bad_token');
  }
  return data;
}

function defaultQuery(sql, params) {
  return new Promise((resolve, reject) => {
    supadb.queryTextCallback(sql.replace(/\$(\d+)/g, (m, i) => {
      const v = params[parseInt(i, 10) - 1];
      if (v === null || v === undefined) return 'NULL';
      return `'${String(v).replace(/'/g, "''")}'`;
    }), { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const trimmed = String(stdout).trim();
        if (!trimmed) return resolve(null);
        try { return resolve(JSON.parse(trimmed)); } catch (_) { return resolve(trimmed); }
      } catch (e) { reject(e); }
    });
  });
}

// supadb emulates `psql -t -A`: rows arrive as pipe-delimited text in
// SELECT column order (empty string for NULL, one row per line), e.g.
// "<uuid>|2||member". Parse the first line into the mapping shape so the
// real defaultQuery result works. Object/array results (mocks, JSON) pass
// through untouched.
function parsePipeRow(text) {
  const line = String(text).trim().split('\n')[0].trim();
  if (!line || line.indexOf('|') === -1) return null;
  const parts = line.split('|');
  if (parts.length < 4) return null;
  return {
    supabase_user_id: parts[0] || undefined,
    organization_id: parts[1],
    tenant_id: parts[2] || null,
    role: parts[3] || undefined,
  };
}

// Resolve the organization mapping for a verified Supabase user id.
// Returns the mapping row verbatim, or null when unmapped. queryImpl is
// injectable so tests never touch the database.
async function resolveOrgMapping(supabaseUserId, queryImpl) {
  if (!supabaseUserId || typeof supabaseUserId !== 'string') return null;
  const q = queryImpl || defaultQuery;
  const sql = `SELECT supabase_user_id, organization_id, tenant_id, role FROM public.vaani_user_profiles WHERE supabase_user_id = $1 LIMIT 1;`;
  const out = await q(sql, [supabaseUserId]);
  let row = Array.isArray(out) ? out[0] : out;
  if (typeof row === 'string') row = parsePipeRow(row);
  if (!row || typeof row !== 'object' || row.organization_id === undefined) return null;
  const orgInt = parseInt(row.organization_id, 10);
  if (isNaN(orgInt) || orgInt <= 0) return null;
  return {
    supabase_user_id: row.supabase_user_id || supabaseUserId,
    organization_id: orgInt,
    tenant_id: row.tenant_id || null,
    role: row.role || 'member',
  };
}

// Map bridge failures to safe HTTP responses. Messages are static: tokens,
// passwords and upstream details never reach the client.
function mapBraivexAuthError(err, fallbackMessage) {
  const status = (err && err.status) || 500;
  const code = (err && err.code) || 'braivex_error';
  if (status === 401) return { status: 401, body: { error: 'invalid email or password', code: 'bad_creds' } };
  if (status === 403) return { status: 403, body: { error: 'account is not linked to an organization', code: 'org_not_linked' } };
  if (status === 400 || status === 409 || status === 422 || status === 429) {
    return { status, body: { error: err.message || fallbackMessage, code } };
  }
  if (status === 503) return { status: 503, body: { error: fallbackMessage || 'authentication service unavailable', code } };
  return { status: 500, body: { error: fallbackMessage || 'authentication failed', code } };
}

// Extract a Supabase access token from `Authorization: Bearer <token>`.
// Returns the token string, or null when the header is missing/malformed.
function parseBearerToken(req) {
  const raw = req && req.headers ? req.headers['authorization'] : '';
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^\s*Bearer\s+(.+?)\s*$/);
  if (!m || !m[1]) return null;
  return m[1];
}

// Additive BRAIVEX bearer-token middleware (foundation only, no routes use
// it yet). Verifies the Supabase access token per request with the existing
// supabaseVerifyToken(), resolves organization_id exclusively from the
// vaani_user_profiles mapping (never a default), and invokes
// handler(req, res, ctx) with a db.json-free context:
//
//   { user, supabaseUser, supabaseUserId, organization_id, role }
//
// Fail-closed: missing/malformed/invalid tokens end with 401 bad_token,
// unknown mappings end with 403 org_not_linked, and the handler never runs
// in either case. No shadow session is created, rxv_sess is untouched.
// impls is an optional { fetchImpl, queryImpl, body } override for tests.
async function requireBraivexAuth(req, res, handler, impls) {
  const core = require('./core');
  const opts = impls || {};
  const token = parseBearerToken(req);
  if (!token) {
    core.sendJson(res, 401, { error: 'invalid or expired session', code: 'bad_token' });
    return;
  }
  let user;
  try {
    user = await supabaseVerifyToken(token, opts.fetchImpl);
  } catch (_) {
    core.sendJson(res, 401, { error: 'invalid or expired session', code: 'bad_token' });
    return;
  }
  let mapping;
  try {
    mapping = await resolveOrgMapping(user.id, opts.queryImpl);
  } catch (err) {
    const mapped = mapBraivexAuthError(err, 'authentication failed');
    core.sendJson(res, mapped.status, mapped.body);
    return;
  }
  if (!mapping) {
    core.sendJson(res, 403, { error: 'account is not linked to an organization', code: 'org_not_linked' });
    return;
  }
  const ctx = {
    user,
    supabaseUser: user,
    supabaseUserId: user.id,
    organization_id: mapping.organization_id,
    role: mapping.role,
  };
  if (opts.body !== undefined) ctx.body = opts.body;
  return handler(req, res, ctx);
}

module.exports = {
  braivexConfig,
  isBraivexConfigured,
  supabaseSignup,
  provisionWorkspace,
  supabaseTokenExchange,
  supabaseLogout,
  supabaseVerifyToken,
  resolveOrgMapping,
  mapBraivexAuthError,
  requireBraivexAuth,
  parseBearerToken,
};
