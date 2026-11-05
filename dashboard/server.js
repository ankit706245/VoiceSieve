/**
 * Braivex Vaani. Zero-dependency Node server for the Supabase-backed CRM.
 *
 * Auth: Supabase Auth only. Data: Supabase Postgres only. No local JSON store.
 * Static files live in public/. Run with `node server.js`.
 */
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const core = require('./lib/core');
core.loadEnv();
const supadb = require('./lib/supadb');
const vaaniSales = require('./lib/vaani-sales');
const braivex = require('./lib/braivex-auth');

const PORT = parseInt(process.env.PORT || '8787', 10);

/* ==========================================================================
   Public-facing serialization (never leak credentials).
   ========================================================================== */
function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt };
}
function publicTenant(t) {
  const org = parseInt(t.organization_id, 10);
  return {
    id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt,
    branding: t.branding, providers: t.providers, plan: t.plan,
    status: t.status, privacyMode: t.privacyMode,
    organization_id: Number.isFinite(org) && org > 0 ? org : null,
  };
}

/* ==========================================================================
   Auth routes (Supabase Auth is the only account store).
   ========================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function apiSignup(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 80) || 'Owner';
  const company = String(body.company || '').trim().slice(0, 80) || `${name}'s Workspace`;

  if (!EMAIL_RE.test(email)) return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  if (password.length < 12) return core.sendJson(res, 422, { error: 'password must be at least 12 characters', code: 'weak_password' });

  let signup;
  try {
    signup = await braivex.supabaseSignup(email, password);
  } catch (err) {
    const mapped = braivex.mapBraivexAuthError(err, 'signup failed');
    return core.sendJson(res, mapped.status, mapped.body);
  }

  const supabaseUserId = signup.user.id;
  const tenantId = core.genId('t_');

  if (!signup.isNewUser) {
    return core.sendJson(res, 409, { error: 'an account with this email already exists', code: 'email_taken' });
  }

  let orgId;
  try {
    orgId = await braivex.provisionWorkspace(supabaseUserId, tenantId);
  } catch (err) {
    // Roll back only a user this request just created. Supabase returns the
    // existing user when the email is already registered; deleting that id
    // would destroy someone else's account.
    if (signup.isNewUser) {
      const escId = String(supabaseUserId).replace(/'/g, "''");
      supadb.queryTextCallback(`DELETE FROM auth.users WHERE id = '${escId}';`, { timeout: 8000 }, () => {});
    }
    return core.sendJson(res, 500, { error: 'Could not set up your workspace. Please try again.', code: 'org_setup_failed' });
  }

  // shortcut: projects without SMTP cannot deliver the confirmation email.
  // Auto-confirm only outside production, or with an explicit opt-in.
  const autoConfirm = process.env.BRAIVEX_AUTO_CONFIRM_SIGNUP === '1'
    || process.env.NODE_ENV !== 'production';
  if (!signup.accessToken && signup.isNewUser && autoConfirm) {
    try {
      const escId = String(supabaseUserId).replace(/'/g, "''");
      await new Promise((resolve, reject) => {
        supadb.queryTextCallback(
          `UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now() WHERE id = '${escId}';`,
          { timeout: 8000 },
          (err) => (err ? reject(new Error(err.message)) : resolve())
        );
      });
      const session = await braivex.supabaseTokenExchange(email, password);
      signup = { accessToken: session.accessToken, user: session.user };
    } catch (_) {
      // Account still exists; fall back to the email confirmation path.
    }
  }

  const tenant = {
    id: tenantId, name: company, slug: `org-${orgId}`, createdAt: new Date().toISOString(),
    branding: { color: '#6E7BFF' },
    plan: 'studio',
    status: 'active', privacyMode: 'standard', organization_id: orgId,
  };
  const response = {
    user: { id: supabaseUserId, email, name, role: 'owner' },
    tenant: publicTenant(tenant),
    organization_id: orgId,
  };
  if (signup.accessToken) response.accessToken = signup.accessToken;
  const headers = signup.accessToken ? { 'Set-Cookie': core.authCookie(signup.accessToken) } : {};
  core.sendJson(res, 200, response, headers);
}

async function apiLogin(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  let token;
  try {
    token = await braivex.supabaseTokenExchange(email, password);
  } catch (err) {
    const mapped = braivex.mapBraivexAuthError(err, 'login failed');
    return core.sendJson(res, mapped.status, mapped.body);
  }

  let mapping;
  try {
    mapping = await braivex.resolveOrgMapping(token.user.id);
  } catch (err) {
    const mapped = braivex.mapBraivexAuthError(err, 'login failed');
    return core.sendJson(res, mapped.status, mapped.body);
  }
  if (!mapping) {
    return core.sendJson(res, 403, { error: 'account is not linked to an organization', code: 'org_not_linked' });
  }

  const tenant = {
    id: mapping.tenant_id || `org_${mapping.organization_id}`,
    name: token.user.email || 'Workspace',
    slug: `org-${mapping.organization_id}`,
    status: 'active',
    organization_id: mapping.organization_id,
  };
  core.sendJson(res, 200, {
    accessToken: token.accessToken,
    user: { id: token.user.id, email: token.user.email, name: token.user.email, role: mapping.role },
    tenant: publicTenant(tenant),
    organization_id: mapping.organization_id,
  }, { 'Set-Cookie': core.authCookie(token.accessToken) });
}

// Exchange a Supabase access token (for example from an email confirmation
// link) for the HttpOnly session cookie. The token never enters app storage.
async function apiSession(req, res, body) {
  const token = String((body && body.access_token) || '').trim();
  if (!token || token.length < 16) {
    return core.sendJson(res, 422, { error: 'access_token required', code: 'bad_token' });
  }
  let user;
  try {
    user = await braivex.supabaseVerifyToken(token);
  } catch (_) {
    return core.sendJson(res, 401, { error: 'invalid or expired token', code: 'bad_token' });
  }
  let mapping;
  try {
    mapping = await braivex.resolveOrgMapping(user.id);
  } catch (_) {
    mapping = null;
  }
  if (!mapping) {
    return core.sendJson(res, 403, { error: 'account is not linked to an organization', code: 'org_not_linked' });
  }
  core.sendJson(res, 200, { ok: true, organization_id: mapping.organization_id }, {
    'Set-Cookie': core.authCookie(token),
  });
}

async function apiLogout(req, res) {
  const authHeader = String(req.headers.authorization || '');
  const match = authHeader.match(/^\s*Bearer\s+(.+?)\s*$/);
  const token = (match && match[1]) || core.parseCookie(req, core.COOKIE_NAME);
  await braivex.supabaseLogout(token);
  core.send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.clearCookie(),
  });
}

/* ==========================================================================
   Authed routes (ctx = { user, tenant, session, body })
   ========================================================================== */

function apiMe(req, res, ctx) {
  core.sendJson(res, 200, { user: publicUser(ctx.user), tenant: publicTenant(ctx.tenant), impersonation: ctx.impersonator ? { actor: publicUser(ctx.impersonator), reason: ctx.session.impersonationReason, expiresAt: new Date(ctx.session.exp).toISOString() } : null });
}


function resolveOrganizationId(ctx) {
  if (!ctx) return null;
  const raw = ctx.organization_id != null ? ctx.organization_id : (ctx.tenant && ctx.tenant.organization_id);
  if (raw === undefined || raw === null) return null;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? null : parsed;
}

async function apiVaaniSalesGet(req, res, ctx) {
  try {
    const route = (req.url || '').split('?')[0];
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isDemo = urlObj.searchParams.get('demo') === '1' || req.headers['x-vaani-demo'] === 'true';

    // The shared demo fixture is safe without an org. Real rows require a mapping.
    const orgId = resolveOrganizationId(ctx);
    if (!orgId && !isDemo) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }

    // Sanitize query parameters - explicitly delete any tenant injection attempts
    const filters = Object.fromEntries(urlObj.searchParams.entries());
    delete filters.organization_id;
    delete filters.organizationId;
    delete filters.tenant_id;
    delete filters.tenantId;

    if (route === '/api/vaani/sales/overview') {
      const data = await vaaniSales.getOverview(isDemo, orgId);
      return core.sendJson(res, 200, data);
    }
    if (route === '/api/vaani/sales/sellers') {
      const data = await vaaniSales.getSellers(filters, isDemo, orgId);
      return core.sendJson(res, 200, { total: data.length, sellers: data });
    }
    if (route === '/api/vaani/sales/buyers') {
      const data = await vaaniSales.getBuyers(filters, isDemo, orgId);
      return core.sendJson(res, 200, { total: data.length, buyers: data });
    }
    if (route === '/api/vaani/sales/machines') {
      const data = await vaaniSales.getMachines(isDemo, orgId);
      return core.sendJson(res, 200, data);
    }
    if (route === '/api/vaani/sales/demand') {
      const data = await vaaniSales.getDemand(isDemo, orgId);
      return core.sendJson(res, 200, data);
    }
    if (route === '/api/vaani/sales/follow-ups' || route === '/api/vaani/sales/tasks') {
      const data = await vaaniSales.getFollowUps(isDemo, orgId);
      return core.sendJson(res, 200, data);
    }
    if (route === '/api/vaani/sales/calls') {
      const data = await vaaniSales.getCalls(isDemo, orgId);
      return core.sendJson(res, 200, { total: data.length, calls: data });
    }
    if (route.startsWith('/api/vaani/sales/calls/')) {
      const runId = route.slice('/api/vaani/sales/calls/'.length);
      const data = await vaaniSales.getCallDetail(runId, isDemo, orgId);
      if (!data) return core.sendJson(res, 404, { error: 'call not found', code: 'not_found' });
      return core.sendJson(res, 200, data);
    }
    if (route.startsWith('/api/vaani/sales/leads/') && route.endsWith('/timeline')) {
      const raw = route.slice('/api/vaani/sales/leads/'.length);
      const leadId = raw.replace(/\/timeline$/, '');
      const data = await vaaniSales.getLeadTimeline(leadId, isDemo, orgId);
      return core.sendJson(res, 200, data);
    }
    if (route.startsWith('/api/vaani/sales/leads/') && route.endsWith('/evidence')) {
      const raw = route.slice('/api/vaani/sales/leads/'.length);
      const leadId = raw.replace(/\/evidence$/, '');
      const data = await vaaniSales.getLeadEvidence(leadId, isDemo, orgId);
      const items = Array.isArray(data) ? data : (data?.items || []);
      const readiness = data?.readiness || vaaniSales.calculateEvidenceReadiness(items);
      return core.sendJson(res, 200, { total: items.length, evidence: items, readiness });
    }
    if (route.startsWith('/api/vaani/sales/leads/') && route.endsWith('/whatsapp')) {
      const raw = route.slice('/api/vaani/sales/leads/'.length);
      const leadId = raw.replace(/\/whatsapp$/, '');
      const data = await vaaniSales.getLeadWhatsAppHistory(leadId, isDemo, orgId);
      return core.sendJson(res, 200, { total: data.length, messages: data, is_dry_run: true, indicator: 'WHATSAPP: DRY RUN' });
    }
    if (route.startsWith('/api/vaani/sales/leads/')) {
      const leadId = route.slice('/api/vaani/sales/leads/'.length);
      const data = await vaaniSales.getLead360(leadId, isDemo, orgId);
      if (!data) return core.sendJson(res, 404, { error: 'lead not found', code: 'not_found' });
      return core.sendJson(res, 200, data);
    }
    if (route === '/api/vaani/sales/activities') {
      const limit = parseInt(urlObj.searchParams.get('limit') || '15', 10);
      const data = await vaaniSales.getRecentActivities(limit, isDemo, orgId);
      return core.sendJson(res, 200, { total: data.length, activities: data });
    }
    if (route === '/api/vaani/sales/dnc') {
      const data = await vaaniSales.getDncRegistry(isDemo, orgId);
      return core.sendJson(res, 200, { total: data.length, dnc_records: data });
    }
    if (route === '/api/vaani/sales/search') {
      const q = urlObj.searchParams.get('q') || '';
      const data = await vaaniSales.searchLeads(q, isDemo, orgId);
      return core.sendJson(res, 200, { query: q, total: data.length, results: data });
    }

    return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
  } catch (err) {
    console.error('[VAANI SALES] GET failed:', err.message);
    return core.sendJson(res, 500, { error: 'sales request failed', code: 'sales_api_error' });
  }
}

async function apiVaaniCreateEntry(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    const body = ctx.body || {};
    const type = String(body.type || '');
    if (type === 'machine') {
      const id = await vaaniSales.addMachineRecord(orgId, body);
      return core.sendJson(res, 201, { ok: true, id });
    }
    if (type !== 'buyer' && type !== 'seller') {
      return core.sendJson(res, 400, { error: 'type must be buyer, seller, or machine', code: 'bad_type' });
    }
    const id = await vaaniSales.addLead(orgId, type, body);
    return core.sendJson(res, 201, { ok: true, id });
  } catch (err) {
    const mapped = vaaniSales.mapLeadSaveError(err, 'Could not save entry. Please try again.');
    return core.sendJson(res, mapped.status, mapped.body);
  }
}

async function apiVaaniImportEntries(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    const body = ctx.body || {};
    const type = String(body.type || '');
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return core.sendJson(res, 400, { error: 'rows are required', code: 'bad_rows' });
    if (rows.length > 1000) return core.sendJson(res, 400, { error: 'max 1000 rows per import', code: 'too_many_rows' });
    let result;
    if (type === 'buyer') result = await vaaniSales.importBuyers(orgId, rows);
    else if (type === 'seller') result = await vaaniSales.importSellers(orgId, rows);
    else if (type === 'machine') result = await vaaniSales.importMachines(orgId, rows);
    else return core.sendJson(res, 400, { error: 'type must be buyer, seller, or machine', code: 'bad_type' });
    return core.sendJson(res, 200, result);
  } catch (err) {
    return core.sendJson(res, 500, { error: 'Import failed', code: 'import_failed' });
  }
}

async function apiVaaniFollowUpStatus(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const { id, status } = ctx.body || {};
    if (!id || !status) return core.sendJson(res, 422, { error: 'id and status required', code: 'bad_request' });
    try {
      const updated = await vaaniSales.updateFollowUpStatus(id, status, orgId);
      return core.sendJson(res, 200, updated);
    } catch (err) {
      const statusCode = err.code === 'not_found' ? 404 : 422;
      return core.sendJson(res, statusCode, { error: err.message, code: err.code || 'invalid_status' });
    }
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

async function apiVaaniTaskTransition(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const { task_id, status, notes, completed_by } = ctx.body || {};
    if (!task_id || !status) {
      return core.sendJson(res, 422, { error: 'task_id and status required', code: 'bad_request' });
    }
    try {
      const result = await vaaniSales.transitionTaskStatus(task_id, status, orgId, completed_by || 'Sales Operator', notes || '');
      return core.sendJson(res, 200, { success: true, task: result });
    } catch (err) {
      const statusCode = err.statusCode || (err.code === 'not_found' ? 404 : 422);
      return core.sendJson(res, statusCode, { error: err.message, code: err.code || 'transition_error' });
    }
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

async function apiVaaniEvidenceReceived(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const b = ctx.body || {};
    if (!b.run_id || !b.media_type) {
      return core.sendJson(res, 422, { error: 'run_id and media_type required', code: 'bad_request' });
    }
    try {
      const result = await vaaniSales.markEvidenceReceived(b, orgId);
      return core.sendJson(res, 200, { success: true, ...result });
    } catch (err) {
      const statusCode = err.statusCode || (err.code === 'bad_request' ? 422 : 500);
      return core.sendJson(res, statusCode, { error: err.message, code: err.code || 'evidence_error' });
    }
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

async function apiVaaniEvidenceRequest(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const b = ctx.body || {};
    const route = (req.url || '/').split('?')[0];
    let leadId = b.lead_id;
    if (!leadId && route.startsWith('/api/vaani/sales/leads/')) {
      const match = route.match(/^\/api\/vaani\/sales\/leads\/([^/]+)\/evidence\/request$/);
      if (match) leadId = match[1];
    }
    if (!leadId) {
      return core.sendJson(res, 422, { error: 'lead_id is required', code: 'bad_request' });
    }
    if (!b.evidence_type) {
      return core.sendJson(res, 422, { error: 'evidence_type is required', code: 'bad_request' });
    }
    const validTypes = new Set(Object.values(vaaniSales.EVIDENCE_TYPES));
    if (!validTypes.has(b.evidence_type)) {
      return core.sendJson(res, 422, { error: `invalid evidence_type: ${b.evidence_type}`, code: 'invalid_evidence_type' });
    }
    try {
      const result = await vaaniSales.requestLeadEvidence(leadId, b.evidence_type, orgId, {
        provider_options: b.provider_options || {}
      });
      return core.sendJson(res, 200, result);
    } catch (err) {
      const statusCode = err.statusCode || (err.code === 'dnc_quarantined' || err.code === 'dnc_blocked' ? 403 : err.code === 'invalid_evidence_type' ? 422 : err.code === 'lead_not_found' ? 404 : 400);
      return core.sendJson(res, statusCode, { error: err.message, code: err.code || 'request_error' });
    }
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

/* ==========================================================================
   Request origin + rate-limit identity.
   ========================================================================== */
function requestOriginAllowed(req) {
  const rawOrigin = String(req.headers.origin || '').trim();
  if (!rawOrigin) return true;
  let origin;
  try { origin = new URL(rawOrigin); } catch (_) { return false; }
  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  const trustProxy = process.env.TRUST_PROXY === '1';
  const forwardedHost = trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const requestHost = forwardedHost || String(req.headers.host || '').trim();
  const configuredOrigin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configuredOrigin) return rawOrigin === configuredOrigin;
  const forwardedProto = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const requestProto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return !!requestHost && origin.origin === `${requestProto}://${requestHost}`;
}

function requestRateKey(req) {
  const peer = String(req.socket.remoteAddress || 'local').replace(/^::ffff:/, '');
  if (process.env.TRUST_PROXY !== '1') return peer;
  const privatePeer = peer === '127.0.0.1' || peer === '::1' || peer.startsWith('10.') || peer.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(peer);
  if (!privatePeer) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return net.isIP(forwarded) ? forwarded : peer;
}

/* ==========================================================================
   Service authentication for the Vaani ingestion + WhatsApp webhooks.
   ========================================================================== */
function verifyIngestionAuth(req) {
  const configuredSecret = process.env.VAANI_INGESTION_SECRET;
  if (!configuredSecret || typeof configuredSecret !== 'string' || !configuredSecret.trim()) {
    return false;
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    return false;
  }
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
    return false;
  }
  const token = parts[1].trim();
  const expectedHash = crypto.createHash('sha256').update(configuredSecret.trim()).digest();
  const actualHash = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

/* ==========================================================================
   Service Authentication: Vaani WhatsApp Webhook
   Validates x-vaani-whatsapp-secret or Authorization: Bearer <secret>
   against VAANI_WHATSAPP_WEBHOOK_SECRET or VAANI_INGESTION_SECRET in constant time.
   Fails closed if neither secret is configured.
   ========================================================================== */
function verifyWhatsAppWebhookAuth(req) {
  const configuredSecret = process.env.VAANI_WHATSAPP_WEBHOOK_SECRET || process.env.VAANI_INGESTION_SECRET;
  if (!configuredSecret || typeof configuredSecret !== 'string' || !configuredSecret.trim()) {
    return false;
  }
  let token = null;
  const customHeader = req.headers['x-vaani-whatsapp-secret'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    token = customHeader.trim();
  } else {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string') {
      const parts = authHeader.trim().split(/\s+/);
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer' && parts[1]) {
        token = parts[1].trim();
      }
    }
  }
  if (!token) return false;
  const expectedHash = crypto.createHash('sha256').update(configuredSecret.trim()).digest();
  const actualHash = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

/* ==========================================================================
   Router
   ========================================================================== */

const server = http.createServer(async (req, res) => {
  const ip = requestRateKey(req);
  const route = (req.url || '/').split('?')[0];

  try {
    if (route.startsWith('/api/')) {
      if (process.env.NODE_ENV !== 'test' && !core.rateOk(ip)) {
        return core.sendJson(res, 429, { error: 'rate limited', code: 'rate' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !requestOriginAllowed(req)) {
        return core.sendJson(res, 403, { error: 'cross-origin request blocked', code: 'bad_origin' });
      }
      const requestContentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && requestContentType && requestContentType !== 'application/json') {
        return core.sendJson(res, 415, { error: 'application/json required', code: 'bad_content_type' });
      }

      if (route === '/api/health' && req.method === 'GET') {
        return core.sendJson(res, 200, { ok: true, service: 'braivex-vaani' });
      }

      if (req.method === 'GET') {
        if (route === '/api/me') return core.requireAuth(req, res, apiMe);
        if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      if (req.method !== 'POST') {
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      if (route === '/api/v1/vaani/calls/complete' || route === '/api/vaani/calls/complete') {
        if (!verifyIngestionAuth(req)) {
          return core.sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized', error_code: 'UNAUTHORIZED' });
        }
        try {
          const rawBody = await core.readBody(req);
          console.log('[VAANI WEBHOOK] /api/v1/vaani/calls/complete payload received:', JSON.stringify({ has_transcript: !!(rawBody ? (rawBody.transcript || rawBody.conversation) : false), has_phone: !!(rawBody ? (rawBody.primary_phone || rawBody.callback_number) : false), has_run_id: !!(rawBody ? (rawBody.call_metadata ? (rawBody.call_metadata.run_id || rawBody.run_id) : (rawBody.run_id || false)) : false), has_workflow_id: !!(rawBody ? (rawBody.call_metadata ? (rawBody.call_metadata.workflow_id || rawBody.workflow_id) : (rawBody.workflow_id || false)) : false) }));
          const result = await vaaniSales.ingestCallComplete(rawBody);
          return core.sendJson(res, 201, result);
        } catch (err) {
          const status = err.statusCode || 400;
          return core.sendJson(res, status, { error: err.message, code: err.code || 'validation_error', error_code: err.errorCode || err.code || 'VALIDATION_ERROR' });
        }
      }

      if (route === '/api/v1/vaani/extract') {
        if (!verifyIngestionAuth(req)) {
          return core.sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized', error_code: 'UNAUTHORIZED' });
        }
        try {
          const rawBody = await core.readBody(req);
          const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody || {});
          const conversation = parsed.transcript || parsed.conversation || parsed.text || [];
          return core.sendJson(res, 200, vaaniSales.extractFromConversation(conversation));
        } catch (err) {
          return core.sendJson(res, 400, { error: err.message, code: 'extraction_error', error_code: 'EXTRACTION_ERROR' });
        }
      }

      if (route === '/api/v1/vaani/whatsapp/webhook' || route === '/api/vaani/whatsapp/webhook') {
        if (!verifyWhatsAppWebhookAuth(req)) {
          return core.sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized', error_code: 'UNAUTHORIZED' });
        }
        try {
          const rawBody = await core.readBody(req);
          const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody || {});
          const orgVal = parsed.organization_id || req.headers['x-organization-id'];
          const orgInt = parseInt(orgVal, 10);
          if (isNaN(orgInt) || orgInt <= 0) {
            return core.sendJson(res, 400, { error: 'explicit organization_id required', code: 'bad_tenant' });
          }
          const result = await vaaniSales.processInboundWebhook(parsed, orgInt);
          return core.sendJson(res, 200, { success: true, ...result });
        } catch (err) {
          return core.sendJson(res, err.statusCode || 400, { error: err.message, code: err.code || 'webhook_error' });
        }
      }

      let body;
      try {
        const bodyLimit = route === '/api/vaani/sales/import' ? 2 * 1024 * 1024 : 64 * 1024;
        body = await core.readBody(req, bodyLimit);
      } catch (e) {
        const tooBig = /too large/.test(String(e.message));
        return core.sendJson(res, tooBig ? 413 : 400, { error: e.message, code: tooBig ? 'too_large' : 'bad_body' });
      }

      if (route === '/api/auth/signup') return apiSignup(req, res, body);
      if (route === '/api/auth/login') return apiLogin(req, res, body);
      if (route === '/api/auth/session') return apiSession(req, res, body);
      if (route === '/api/auth/logout') return apiLogout(req, res);

      if (route.startsWith('/api/vaani/sales/leads/') && route.endsWith('/evidence/request')) {
        return core.requireAuth(req, res, apiVaaniEvidenceRequest, body);
      }
      if (route === '/api/vaani/sales/entries') return core.requireAuth(req, res, apiVaaniCreateEntry, body);
      if (route === '/api/vaani/sales/import') return core.requireAuth(req, res, apiVaaniImportEntries, body);
      if (route === '/api/vaani/sales/evidence/request') return core.requireAuth(req, res, apiVaaniEvidenceRequest, body);
      if (route === '/api/vaani/sales/follow-up/status') return core.requireAuth(req, res, apiVaaniFollowUpStatus, body);
      if (route === '/api/vaani/sales/tasks/transition') return core.requireAuth(req, res, apiVaaniTaskTransition, body);
      if (route === '/api/vaani/sales/evidence/received') return core.requireAuth(req, res, apiVaaniEvidenceReceived, body);

      return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
    }

    const isCrm = /^\/(app|vaani-sales|sales)(\.html|\/)?$/i.test(route);
    if (['GET', 'HEAD'].includes(req.method || '') && isCrm) {
      const sess = await core.getSession(req);
      if (!sess) {
        const accept = String(req.headers['accept'] || '').toLowerCase();
        if (accept.includes('application/json') && !accept.includes('text/html')) {
          return core.sendJson(res, 401, { error: 'authentication required', code: 'no_session' });
        }
        const target = route.startsWith('/app') ? '/app.html' : '/vaani-sales.html';
        res.writeHead(302, {
          Location: `/braivex-login.html?redirect=${target}`,
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0'
        });
        return res.end();
      }
      req.url = '/vaani-sales.html';
      return core.serveStatic(req, res);
    }

    core.serveStatic(req, res);
  } catch (e) {
    core.sendJson(res, 500, { error: String((e && e.message) || e), code: 'server' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  PORT ${PORT} is already in use. Stop the other process or set PORT to a free port, for example: PORT=8788 node server.js\n`);
    process.exit(1);
  }
  console.error('  server error:', e.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n  Braivex Vaani ready');
  console.log(`  Marketing : http://localhost:${PORT}/`);
  console.log(`  CRM       : http://localhost:${PORT}/app.html`);
  console.log(`  Database  : Supabase only\n`);
});
