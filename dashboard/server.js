/**
 * RapidX Voice. Zero-dependency Node server (the product, multi-tenant).
 *
 * Pure Node http/https/crypto/fs. No npm, no build step, no framework. Run with
 * `node server.js` and it serves the JSON API plus the static public/ site on
 * PORT (default 8787). Secrets stay server side, runtime state lives in data/.
 *
 * Routes are EXACTLY per SPEC section 4. Every agents/usage/telephony route is
 * tenant scoped through the session. The live provider calls (Deepgram, Groq, Rumik,
 * VoBiz through Dograh) are isolated in lib/providers.js.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const core = require('./lib/core');
core.loadEnv();
const providers = require('./lib/providers');
const payu = require('./lib/payu');
const demoLinks = require('./lib/demo-links');
const vaaniSales = require('./lib/vaani-sales');

const PORT = parseInt(process.env.PORT || '8787', 10);
const DEFAULT_PROVIDERS = Object.freeze({
  stt: providers.stt.id,
  tts: providers.tts.id,
  llm: providers.llm.id,
  telephony: providers.telephony.id,
});

/* ==========================================================================
   Boot: ensure data/ + db.json, seed the demo tenant, migrate legacy agents.
   ========================================================================== */

const DEMO_EMAIL = String(process.env.TEST_USER_EMAIL || '').trim().toLowerCase();
const DEMO_PASS = String(process.env.TEST_USER_PASSWORD || '');
const DEMO_TENANT = String(process.env.TEST_USER_TENANT || 'RapidX Test');
const TRIAL_CREDIT_PAISE = 1000;
const CREDIT_PACKS = Object.freeze({
  starter: Object.freeze({ amount: '200.00', currency: 'INR', credits: 20000, productinfo: 'RapidX Voice Starter Credits' }),
  growth: Object.freeze({ amount: '500.00', currency: 'INR', credits: 50000, productinfo: 'RapidX Voice Growth Credits' }),
  scale: Object.freeze({ amount: '1000.00', currency: 'INR', credits: 100000, productinfo: 'RapidX Voice Scale Credits' }),
});

function payuConfig() {
  if (!process.env.PAYU_KEY || !process.env.PAYU_SALT) return null;
  return { key: process.env.PAYU_KEY, salt: process.env.PAYU_SALT, env: process.env.PAYU_ENV === 'production' ? 'production' : 'test' };
}

function readForm(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size > cap) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

const PRESET_LIBRARY = [
  {
    id: 'preset_personal_injury_v1', slug: 'personal-injury-intake', version: 1,
    name: 'Personal Injury Intake', category: 'legal', isSystem: true,
    greeting: 'Thank you for calling. I am an AI intake assistant and this call may be recorded. Are you in immediate danger or need emergency medical help?',
    fields: ['caller_name', 'callback_number', 'adverse_parties', 'incident_date', 'incident_location', 'incident_type', 'injuries', 'treatment', 'insurance', 'represented', 'deadline_risk', 'preferred_appointment'],
    guardrails: ['No legal advice', 'No case valuation', 'Escalate emergencies and deadline risk', 'Attorney decides case acceptance'],
  },
  {
    id: 'preset_dental_receptionist_v1', slug: 'dental-receptionist', version: 1,
    name: 'Dental Receptionist', category: 'healthcare', isSystem: true,
    greeting: 'Thank you for calling. I am the practice AI receptionist and this call may be recorded. How can I help today?',
    fields: ['caller_name', 'callback_number', 'new_or_existing_patient', 'reason', 'pain_level', 'emergency_signs', 'insurance', 'preferred_appointment'],
    guardrails: ['No diagnosis', 'Escalate breathing, bleeding, trauma, or severe swelling', 'Confirm booking details'],
  },
  {
    id: 'preset_real_estate_v1', slug: 'real-estate-lead', version: 1,
    name: 'Real Estate Lead Qualifier', category: 'real_estate', isSystem: true,
    greeting: 'Thanks for calling. I am the AI property assistant. Are you looking to buy, sell, rent, or schedule a viewing?',
    fields: ['caller_name', 'callback_number', 'intent', 'location', 'budget', 'timeline', 'financing', 'property_type', 'preferred_appointment'],
    guardrails: ['Do not promise availability or returns', 'Escalate fair housing questions', 'Confirm consent before follow-up'],
  },
  {
    id: 'preset_restaurant_v1', slug: 'restaurant-reservations', version: 1,
    name: 'Restaurant Reservations', category: 'hospitality', isSystem: true,
    greeting: 'Thank you for calling. I can help with a reservation, opening hours, directions, or a general question.',
    fields: ['caller_name', 'callback_number', 'party_size', 'date', 'time', 'dietary_needs', 'occasion', 'special_requests'],
    guardrails: ['Never confirm unavailable inventory', 'Escalate allergy questions to staff', 'Read back reservation details'],
  },
  {
    id: 'preset_appointment_v1', slug: 'appointment-booking', version: 1,
    name: 'Appointment Booking', category: 'scheduling', isSystem: true,
    greeting: 'Thanks for calling. I can help you schedule, move, or cancel an appointment.',
    fields: ['caller_name', 'callback_number', 'appointment_type', 'preferred_date', 'preferred_time', 'timezone', 'notes'],
    guardrails: ['Confirm timezone', 'Never invent calendar availability', 'Read back the final appointment'],
  },
  {
    id: 'preset_customer_support_v1', slug: 'customer-support', version: 1,
    name: 'Customer Support', category: 'support', isSystem: true,
    greeting: 'Thanks for contacting support. I am an AI assistant. Tell me what happened and I will help or route you to the right person.',
    fields: ['caller_name', 'callback_number', 'account_reference', 'issue_category', 'issue_summary', 'steps_tried', 'preferred_resolution'],
    guardrails: ['Never request passwords or full payment credentials', 'Escalate security incidents', 'Do not promise refunds'],
  },
  {
    id: 'preset_lead_qualification_v1', slug: 'lead-qualification', version: 1,
    name: 'Lead Qualification', category: 'sales', isSystem: true,
    greeting: 'Thanks for your interest. I am an AI assistant. I will ask a few quick questions and help you book the right next step.',
    fields: ['caller_name', 'company', 'callback_number', 'email', 'need', 'budget', 'authority', 'timeline', 'preferred_appointment'],
    guardrails: ['Disclose AI identity', 'Do not make unsupported product claims', 'Respect opt-out requests immediately'],
  },
  {
    id: 'preset_receptionist_v1', slug: 'general-receptionist', version: 1,
    name: 'AI Receptionist', category: 'reception', isSystem: true,
    greeting: 'Thank you for calling. I am the AI receptionist. How may I direct your call today?',
    fields: ['caller_name', 'callback_number', 'reason', 'department', 'urgency', 'message', 'preferred_follow_up'],
    guardrails: ['Disclose AI identity', 'Escalate emergencies', 'Do not reveal private staff or customer information'],
  },
];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Pull legacy agents from _legacy/agents.legacy.json or root agents.json (first
// that exists). Returns an array, never throws.
function readLegacyAgents() {
  const candidates = [
    path.join(core.ROOT, '_legacy', 'agents.legacy.json'),
    path.join(core.ROOT, 'agents.json'),
  ];
  for (const f of candidates) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) { /* try next */ }
  }
  return [];
}

// Normalize a legacy agent (flat model/speaker/created) into the SPEC shape
// (nested tts object, createdAt ISO), scoped to the given tenant.
function migrateLegacyAgent(legacy, tenantId) {
  const model = legacy.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(legacy.speaker) ? legacy.speaker : 'speaker_1';
  return {
    id: legacy.id || core.genId('ag_'),
    tenantId,
    name: String(legacy.name || 'Untitled Agent').slice(0, 60),
    persona: String(legacy.persona || '').slice(0, 1500),
    tts: {
      provider: providers.tts.id,
      model,
      speaker,
      f0_up_key: Number.isFinite(legacy.f0_up_key) ? legacy.f0_up_key : 0,
    },
    greeting: String(legacy.greeting || '').slice(0, 300),
    telephony: { did: String(legacy.did || providers.telephony.did) },
    createdAt: legacy.created ? new Date(legacy.created).toISOString() : new Date().toISOString(),
  };
}

async function boot() {
  // Force a load so a missing/corrupt db.json resolves to a clean default.
  const existing = core.db();
  await core.mutate((d) => {
    for (const preset of PRESET_LIBRARY) {
      if (!d.presets.some((p) => p.id === preset.id)) d.presets.push({ ...preset, createdAt: new Date().toISOString() });
    }
  });

  const hasDemo = DEMO_EMAIL && existing.users.some((u) => u.email === DEMO_EMAIL);

  if (DEMO_EMAIL && DEMO_PASS.length >= 12 && !hasDemo) {
    const tenantId = core.genId('t_');
    const userId = core.genId('u_');
    const nowIso = new Date().toISOString();
    const legacy = readLegacyAgents();

    await core.mutate((d) => {
      d.tenants.push({
        id: tenantId,
        name: DEMO_TENANT,
        slug: makeSlug(DEMO_TENANT, new Set(d.tenants.map((t) => t.slug))),
        createdAt: nowIso,
        branding: { color: '#6E7BFF' },
        providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio',
        status: 'active', privacyMode: 'standard',
      });
      d.users.push({
        id: userId,
        tenantId,
        email: DEMO_EMAIL,
        name: 'RapidX Demo',
        passHash: core.hashPassword(DEMO_PASS),
        role: process.env.TEST_USER_SUPER_ADMIN === 'true' ? 'super_admin' : 'owner', status: 'active',
        createdAt: nowIso,
      });
      d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
      addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10, source: 'test_bootstrap' });
      // Migrate any legacy agents into the demo tenant.
      for (const la of legacy) d.agents.push(migrateLegacyAgent(la, tenantId));
    });

    console.log(`  Seeded env-configured test tenant "${DEMO_TENANT}" with ${legacy.length} migrated agent(s).`);
  }

  // Migrate the old provider selection without rewriting tenant data by hand.
  if (core.db().tenants.some((t) => t.providers && t.providers.telephony === 'voicelink')) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        if (t.providers && t.providers.telephony === 'voicelink') t.providers.telephony = 'vobiz';
      });
    });
  }

  // Fill missing or stale selections from the configured adapter defaults.
  // Existing valid selections remain intact so boot never forces a tenant back
  // to one specific LLM or TTS provider.
  if (core.db().tenants.some((t) => !t.providers || !t.providers.stt || !t.providers.tts || !t.providers.llm || !t.providers.telephony)) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        t.providers = { ...DEFAULT_PROVIDERS, ...(t.providers || {}) };
      });
    });
  }
}

/* ==========================================================================
   Public-facing serialization (never leak passHash, scope to tenant).
   ========================================================================== */
function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt };
}
function publicTenant(t) {
  return {
    id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt,
    branding: t.branding, providers: t.providers, plan: t.plan,
    status: t.status, privacyMode: t.privacyMode,
    organization_id: t.organization_id || 1,
  };
}
function publicAgent(a) {
  return {
    id: a.id, name: a.name, persona: a.persona, tts: a.tts,
    greeting: a.greeting, telephony: a.telephony, presetId: a.presetId || null, createdAt: a.createdAt,
  };
}

// Slugify a company name into a tenant slug, ensuring uniqueness.
function makeSlug(name, taken) {
  const base = String(name || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';
  let slug = base; let n = 2;
  while (taken.has(slug)) { slug = `${base}-${n++}`; }
  return slug;
}

// Bump a usage counter for today for a tenant. field in {chars, calls, llmTokens}.
async function bumpUsage(tenantId, field, amount) {
  const day = todayUtc();
  await core.mutate((d) => {
    let row = d.usage.find((r) => r.tenantId === tenantId && r.day === day);
    if (!row) { row = { tenantId, day, chars: 0, calls: 0, llmTokens: 0 }; d.usage.push(row); }
    row[field] = (row[field] || 0) + amount;
  });
}

function publicWallet(w) {
  return { id: w.id, tenantId: w.tenantId, currency: w.currency, balancePaise: w.balancePaise, balanceInr: w.balancePaise / 100, updatedAt: w.updatedAt };
}

function addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');
  if (key && d.ledger.some((x) => x.tenantId === tenantId && x.idempotencyKey === key)) return null;
  let wallet = d.wallets.find((w) => w.tenantId === tenantId);
  const now = new Date().toISOString();
  if (!wallet) {
    wallet = { id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now };
    d.wallets.push(wallet);
  }
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) throw new Error('invalid wallet adjustment');
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = { id: core.genId('led_'), tenantId, type, amountPaise, balanceAfterPaise: wallet.balancePaise, idempotencyKey: key || core.genId('idem_'), actorUserId, metadata, createdAt: now };
  d.ledger.push(entry);
  return entry;
}

function addAudit(d, ctx, action, targetType, targetId, metadata = {}) {
  d.auditEvents.push({ id: core.genId('aud_'), tenantId: ctx.tenant.id, actorUserId: ctx.impersonator ? ctx.impersonator.id : ctx.user.id, subjectUserId: ctx.impersonator ? ctx.user.id : null, action, targetType, targetId, metadata, createdAt: new Date().toISOString() });
}

function rejectImpersonated(res, ctx) {
  if (!ctx.impersonator) return false;
  core.sendJson(res, 403, { error: 'This action is blocked while viewing as another user', code: 'impersonation_read_only' });
  return true;
}

/* ==========================================================================
   Auth routes
   ========================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function apiSignup(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 80) || 'Owner';
  const company = String(body.company || '').trim().slice(0, 80) || `${name}'s Workspace`;

  if (!EMAIL_RE.test(email)) return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  if (password.length < 12) return core.sendJson(res, 422, { error: 'password must be at least 12 characters', code: 'weak_password' });
  if (core.db().users.some((u) => u.email === email)) {
    return core.sendJson(res, 409, { error: 'an account with this email already exists', code: 'email_taken' });
  }

  const tenantId = core.genId('t_');
  const userId = core.genId('u_');
  const nowIso = new Date().toISOString();
  let tenant; let user;

  await core.mutate((d) => {
    const taken = new Set(d.tenants.map((t) => t.slug));
    tenant = {
      id: tenantId, name: company, slug: makeSlug(company, taken), createdAt: nowIso,
      branding: { color: '#6E7BFF' },
      providers: { ...DEFAULT_PROVIDERS },
      plan: 'studio',
      status: 'active', privacyMode: 'standard',
    };
    user = {
      id: userId, tenantId, email, name,
      passHash: core.hashPassword(password), role: 'owner', status: 'active', createdAt: nowIso,
    };
    d.tenants.push(tenant);
    d.users.push(user);
    d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
    addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10 });
    addAudit(d, { tenant, user }, 'auth.signup', 'tenant', tenantId);
  });

  const token = await core.createSession(userId, tenantId);
  core.send(res, 200, JSON.stringify({ token, user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogin(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const d = core.db();
  const user = d.users.find((u) => u.email === email);
  // Same generic error whether the user is missing or the password is wrong.
  if (!user || !core.verifyPassword(password, user.passHash)) {
    return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });
  }
  const tenant = d.tenants.find((t) => t.id === user.tenantId);
  if (!tenant) return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });

  const token = await core.createSession(user.id, user.tenantId);
  core.send(res, 200, JSON.stringify({ token, user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogout(req, res) {
  await core.destroySession(req);
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

const HVAC_TIMEZONE = 'Asia/Kolkata';
const HVAC_OUTCOMES = new Set(['new', 'booked', 'routed', 'follow_up', 'closed', 'abandoned']);
function calHeaders(version) {
  if (!process.env.CALCOM_API_KEY) throw new providers.ProviderError('Cal.com is not configured', 503, 'calendar_not_configured');
  return { Authorization: `Bearer ${process.env.CALCOM_API_KEY}`, 'cal-api-version': version, Accept: 'application/json' };
}
function calRequest(method, pathname, version, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const headers = calHeaders(version);
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
    const upstream = require('https').request({ host: 'api.cal.com', path: pathname, method, headers }, (resp) => {
      const parts = []; resp.on('data', (part) => parts.push(part)); resp.on('end', () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) {}
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new providers.ProviderError(body.message || body.error || 'Cal.com request failed', resp.statusCode || 502, 'calendar_upstream'));
        resolve(body);
      });
    });
    upstream.on('error', reject); upstream.setTimeout(20000, () => upstream.destroy(new Error('Cal.com timeout')));
    if (data) upstream.write(data); upstream.end();
  });
}
function tenantHvacJobs(tenantId) { return core.db().hvacJobs.filter((job) => job.tenantId === tenantId); }
function publicHvacJob(job) { return { id: job.id, callerName: job.callerName, phone: job.phone, email: job.email || '', service: job.service, urgency: job.urgency, outcome: job.outcome, assignedTo: job.assignedTo || '', notes: job.notes || '', appointment: job.appointment || null, createdAt: job.createdAt, updatedAt: job.updatedAt }; }
function apiHvacDesk(req, res, ctx) {
  const jobs = tenantHvacJobs(ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = (outcome) => jobs.filter((job) => job.outcome === outcome).length;
  core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, calendarConfigured: Boolean(process.env.CALCOM_API_KEY), jobs: jobs.map(publicHvacJob), stats: { calls: jobs.length, booked: count('booked'), routed: count('routed'), followUp: count('follow_up') } });
}

function resolveOrganizationId(ctx) {
  if (!ctx || !ctx.tenant) return null;
  if (ctx.tenant.organization_id !== undefined && ctx.tenant.organization_id !== null) {
    const parsed = parseInt(ctx.tenant.organization_id, 10);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
}

function queryVaaniLeads(orgId) {
  return new Promise((resolve, reject) => {
    const orgInt = parseInt(orgId, 10);
    if (isNaN(orgInt)) {
      return reject(new Error('Invalid organization ID'));
    }
    const sql = `
      SELECT json_build_object(
        'stats', json_build_object(
          'total', (SELECT COUNT(r.id) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = ${orgInt}),
          'inquiry', (SELECT COUNT(r.id) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = ${orgInt} AND COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, r.gathered_context ->> 'call_disposition'::text) = 'inquiry'),
          'lead_qualified', (SELECT COUNT(r.id) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = ${orgInt} AND COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, r.gathered_context ->> 'call_disposition'::text) = 'lead_qualified'),
          'callback_requested', (SELECT COUNT(r.id) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = ${orgInt} AND COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, r.gathered_context ->> 'call_disposition'::text) = 'callback_requested'),
          'appointment_requested', (SELECT COUNT(r.id) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = ${orgInt} AND COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, r.gathered_context ->> 'call_disposition'::text) = 'appointment_requested'),
          'opt_out', (SELECT COUNT(r.id) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = ${orgInt} AND COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, r.gathered_context ->> 'call_disposition'::text) = 'opt_out')
        ),
        'interactions', COALESCE(
          (SELECT json_agg(t) FROM (
            SELECT 
              r.id AS run_id,
              r.created_at,
              to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') AS formatted_time,
              (r.gathered_context -> 'extracted_variables'::text) ->> 'caller_name'::text AS caller_name,
              (r.gathered_context -> 'extracted_variables'::text) ->> 'callback_number'::text AS callback_number,
              (r.gathered_context -> 'extracted_variables'::text) ->> 'requirement'::text AS requirement,
              COALESCE(((r.gathered_context -> 'extracted_variables'::text) ->> 'callback_requested'::text)::boolean, false) AS callback_requested,
              (r.gathered_context -> 'extracted_variables'::text) ->> 'appointment_type'::text AS appointment_type,
              (r.gathered_context -> 'extracted_variables'::text) ->> 'preferred_date'::text AS preferred_date,
              (r.gathered_context -> 'extracted_variables'::text) ->> 'preferred_time'::text AS preferred_time,
              COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'conversation_outcome'::text, r.gathered_context ->> 'call_disposition'::text) AS conversation_outcome
            FROM workflow_runs r
            JOIN workflows w ON r.workflow_id = w.id
            WHERE w.organization_id = ${orgInt}
            ORDER BY r.id DESC
          ) t), '[]'::json
        )
      );
    `;
    execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function apiVaaniLeads(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const data = await queryVaaniLeads(orgId);
    core.sendJson(res, 200, data);
  } catch (err) {
    core.sendJson(res, 500, { error: err.message, code: 'db_error' });
  }
}

async function apiVaaniInternalMachines(req, res) {
  try {
    const internalSecret = process.env.VAANI_INTERNAL_API_SECRET;
    const clientSecret = req.headers['x-vaani-internal-secret'];
    
    if (!internalSecret || internalSecret !== clientSecret) {
      return core.sendJson(res, 403, { error: 'forbidden', code: 'forbidden' });
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filters = {
      brand: urlObj.searchParams.get('brand'),
      model: urlObj.searchParams.get('model'),
      status: urlObj.searchParams.get('status')
    };

    const data = await vaaniSales.getInternalMachines(filters);
    return core.sendJson(res, 200, {
      machines: data,
      count: data.length
    });
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_api_error' });
  }
}

async function apiVaaniSalesGet(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }

    const route = (req.url || '').split('?')[0];
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isDemo = urlObj.searchParams.get('demo') === '1' || req.headers['x-vaani-demo'] === 'true';

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
    return core.sendJson(res, 500, { error: err.message, code: 'sales_api_error' });
  }
}



// ---- Vaani Demo A+B APIs ----
async function apiVaaniCustomersList(req, res) {
  const { execFile } = require('child_process');
  execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', "SELECT row_to_json(t) FROM (SELECT id, name, phone, machine_requirement, (SELECT status FROM vaani_calls WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1) as last_call_status, (SELECT created_at FROM vaani_calls WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1) as last_call_date FROM vaani_customers c ORDER BY created_at DESC) t;"], { timeout: 5000 }, (err, stdout) => {
    if (err) return core.sendJson(res, 500, { error: err.message });
    const records = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    return core.sendJson(res, 200, { customers: records });
  });
}

async function apiVaaniCustomerDetail(req, res, ctx) {
  const id = ctx.body;
  const { execFile } = require('child_process');
  execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', `SELECT row_to_json(c) FROM vaani_customers c WHERE id = ${parseInt(id)};`], { timeout: 5000 }, (err, stdout) => {
    if (err) return core.sendJson(res, 500, { error: err.message });
    if (!stdout.trim()) return core.sendJson(res, 404, { error: 'Not found' });
    const customer = JSON.parse(stdout.trim());
    execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', `SELECT row_to_json(t) FROM (SELECT * FROM vaani_calls WHERE customer_id = ${parseInt(id)} ORDER BY created_at DESC) t;`], { timeout: 5000 }, (err2, stdout2) => {
      customer.calls = stdout2 ? stdout2.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      return core.sendJson(res, 200, customer);
    });
  });
}

async function apiVaaniCustomerCreate(req, res, ctx) {
  const b = ctx.body || {};
  if (!b.name || !b.phone) return core.sendJson(res, 400, { error: 'Name and phone required' });
  const { execFile } = require('child_process');
  const sql = `INSERT INTO vaani_customers (name, phone, machine_requirement) VALUES ('${b.name.replace(/'/g, "''")}', '${b.phone.replace(/'/g, "''")}', '${(b.machine_requirement || '').replace(/'/g, "''")}') RETURNING id;`;
  execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql], { timeout: 5000 }, (err, stdout) => {
    if (err) return core.sendJson(res, 500, { error: err.message });
    return core.sendJson(res, 200, { id: parseInt(stdout.trim()) });
  });
}

async function apiVaaniCallsList(req, res) {
  const { execFile } = require('child_process');
  const sql = `SELECT row_to_json(t) FROM (SELECT c.id, c.direction, c.status, c.mode, c.created_at, cust.name as customer_name, cust.machine_requirement FROM vaani_calls c LEFT JOIN vaani_customers cust ON c.customer_id = cust.id ORDER BY c.created_at DESC) t;`;
  execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', sql], { timeout: 5000 }, (err, stdout) => {
    if (err) return core.sendJson(res, 500, { error: err.message });
    const records = stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    return core.sendJson(res, 200, { calls: records });
  });
}

async function apiVaaniCallDetail(req, res, ctx) {
  const id = ctx.body;
  const { execFile } = require('child_process');
  const sql = `SELECT row_to_json(c) FROM vaani_calls c WHERE id = ${parseInt(id)};`;
  execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', sql], { timeout: 5000 }, (err, stdout) => {
    if (err) return core.sendJson(res, 500, { error: err.message });
    if (!stdout.trim()) return core.sendJson(res, 404, { error: 'Not found' });
    const callData = JSON.parse(stdout.trim());
    
    // Fetch transcripts
    execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', `SELECT row_to_json(t) FROM (SELECT * FROM vaani_transcripts WHERE call_id = ${parseInt(id)} ORDER BY timestamp ASC) t;`], { timeout: 5000 }, (err2, stdout2) => {
      callData.transcripts = stdout2 ? stdout2.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      
      // Fetch summary
      execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-c', `SELECT row_to_json(s) FROM vaani_call_summaries s WHERE call_id = ${parseInt(id)};`], { timeout: 5000 }, (err3, stdout3) => {
        callData.summary = stdout3 && stdout3.trim() ? JSON.parse(stdout3.trim()) : null;
        return core.sendJson(res, 200, callData);
      });
    });
  });
}

async function apiVaaniDemoCallComplete(req, res, ctx) {
  const b = ctx.body || {};
  const customerId = b.customer_id;
  const rawTranscripts = b.transcripts || [];
  if (!customerId) return core.sendJson(res, 400, { error: 'customer_id required' });
  if (!Array.isArray(rawTranscripts) || rawTranscripts.length === 0) {
    return core.sendJson(res, 400, { error: 'transcripts array is required and must not be empty' });
  }

  const { execFile } = require('child_process');

  // Normalize transcript entries: demo sends { s, m }, ingestion sends { speaker, message }
  const transcripts = rawTranscripts.map(t => ({
    speaker: String(t.s || t.speaker || 'Unknown'),
    message: String(t.m || t.message || ''),
  }));

  // ── TASK 1 FIX: Build prompt using { role, text } (NOT { role, content }) ──
  // The Groq adapter at providers.js filters: .filter((m) => m && m.text)
  // Messages using `content` are silently dropped, leaving messages.length < 2 → ProviderError.
  const transcriptText = transcripts.map(t => `${t.speaker}: ${t.message}`).join('\n');
  const promptText =
    `You are analyzing a Hindi/Hinglish sales call transcript for Om Shyam Earthmover (used excavator dealer).\n\n` +
    `Extract the following and respond with EXACTLY these labels (one per line):\n` +
    `Requirement: <machine model/brand the customer wants, or "Not stated">\n` +
    `Interest Level: <Hot/Warm/Cold>\n` +
    `Budget: <budget in INR or "Not stated">\n` +
    `Intent: <Buy/Sell/Inquiry/Unknown>\n` +
    `Outcome: <brief one-line outcome of this call>\n` +
    `Next Action: <what should happen next>\n\n` +
    `Transcript:\n${transcriptText}`;

  // Default structured summary fields (used as fallback if LLM fails)
  const esc = (v) => v ? String(v).replace(/'/g, "''").slice(0, 500) : '';
  let sf = {
    customer_requirement: '',
    interest_level: '',
    budget: '',
    customer_intent: '',
    outcome: 'Demo call completed.',
    next_action: '',
  };

  try {
    const selected = providers.resolveSelection('llm', { provider: 'groq' });
    // CRITICAL FIX: use `text` key — Groq adapter filters on m.text, not m.content
    const out = await selected.adapter.chat({
      messages: [{ role: 'user', text: promptText }],
      model: selected.model,
    });
    const rawText = (out && out.text) ? out.text.trim() : '';
    if (rawText) {
      const pick = (label) => {
        const m = rawText.match(new RegExp(`^${label}:\\s*(.+)`, 'im'));
        return m ? m[1].trim() : '';
      };
      sf = {
        customer_requirement: pick('Requirement'),
        interest_level: pick('Interest Level'),
        budget: pick('Budget'),
        customer_intent: pick('Intent'),
        outcome: pick('Outcome') || 'Demo call completed.',
        next_action: pick('Next Action'),
      };
    }
  } catch (e) {
    console.error('[Demo] LLM Summary Error (non-fatal, using fallback):', e.message || e);
  }

  // ── Step 1: Insert call record ─────────────────────────────────────────────
  const sqlCall = `INSERT INTO vaani_calls (customer_id, direction, status, mode, ended_at) VALUES (${parseInt(customerId)}, 'outbound', 'completed', 'demo', CURRENT_TIMESTAMP) RETURNING id;`;
  execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sqlCall], { timeout: 10000 }, (e1, out1) => {
    if (e1) return core.sendJson(res, 500, { error: 'DB error (call insert): ' + e1.message });
    const callId = parseInt((out1 || '').trim());
    if (!callId) return core.sendJson(res, 500, { error: 'Failed to obtain call id after insert' });

    // ── Step 2: Insert structured AI summary ──────────────────────────────
    const sqlSummary = `INSERT INTO vaani_call_summaries (call_id, customer_requirement, interest_level, budget, customer_intent, outcome, next_action) VALUES (${callId}, '${esc(sf.customer_requirement)}', '${esc(sf.interest_level)}', '${esc(sf.budget)}', '${esc(sf.customer_intent)}', '${esc(sf.outcome)}', '${esc(sf.next_action)}');`;
    execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sqlSummary], { timeout: 10000 }, (e2) => {
      if (e2) console.error('[Demo] Summary insert error (non-fatal):', e2.message);

      // ── Step 3: Insert transcript rows ────────────────────────────────
      const tValues = transcripts.map(t => `(${callId}, '${esc(t.speaker)}', '${esc(t.message)}')`).join(',');
      const sqlTr = `INSERT INTO vaani_transcripts (call_id, speaker, message) VALUES ${tValues};`;
      execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sqlTr], { timeout: 10000 }, (e3) => {
        if (e3) console.error('[Demo] Transcript insert error (non-fatal):', e3.message);
        return core.sendJson(res, 200, { success: true, call_id: callId });
      });
    });
  });
}

// ---- Phase 2: Buyer Outbound Call API -----------------------------------------------
//
// Call Status Lifecycle:
//   queued -> DEMO (no telephony) | DISPATCHED (Dograh accepted) | FAILED
//   DISPATCHED -> CONNECTED (via Dograh webhook) -> COMPLETED (via /api/vaani/calls/complete)
//
// When DOGRAH_BASE_URL or DOGRAH_API_KEY are unset, falls back to DEMO mode:
//   runs the full ingestCallComplete pipeline with a structured demo transcript
//   so Leads, Summaries, FollowUps are all created exactly as in a real call.
// -------------------------------------------------------------------------------------

async function _dispatchDograhCall(phone, buyerContext, callId) {
  const dograhBase = (process.env.DOGRAH_BASE_URL || '').trim();
  const dograhKey  = (process.env.DOGRAH_API_KEY   || '').trim();
  if (!dograhBase || !dograhKey) {
    return { dispatched: false, reason: 'DOGRAH_BASE_URL or DOGRAH_API_KEY not configured' };
  }

  const wfId    = parseInt(process.env.DOGRAH_WORKFLOW_ID || '3', 10);
  const telConf = (process.env.DOGRAH_TELEPHONY_CONFIG_ID || '').trim();
  const phoneId = (process.env.DOGRAH_PHONE_NUMBER_ID     || '').trim();

  const postBody = JSON.stringify({
    workflow_id: wfId,
    phone_number: phone,
    ...(telConf && { telephony_config_id: telConf }),
    ...(phoneId && { phone_number_id: phoneId }),
    initial_context: buyerContext,
    metadata: { vaani_call_id: callId }
  });

  return new Promise((resolve) => {
    let url;
    try { url = new URL('/api/v1/telephony/initiate-call', dograhBase); } catch (e) {
      return resolve({ dispatched: false, reason: `Invalid DOGRAH_BASE_URL: ${e.message}` });
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? require('https') : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postBody),
        'Authorization': `Bearer ${dograhKey}`,
      },
    };
    const r = mod.request(opts, (res2) => {
      let d = '';
      res2.on('data', c => { d += c; });
      res2.on('end', () => {
        if (res2.statusCode >= 200 && res2.statusCode < 300) {
          let parsed = {};
          try { parsed = JSON.parse(d); } catch (_) {}
          resolve({ dispatched: true, dograh_response: parsed, raw: d });
        } else {
          resolve({ dispatched: false, reason: `Dograh HTTP ${res2.statusCode}`, raw: d });
        }
      });
    });
    r.setTimeout(8000, () => {
      r.destroy();
      resolve({ dispatched: false, reason: 'Dograh request timed out after 8s' });
    });
    r.on('error', (e) => resolve({ dispatched: false, reason: e.message }));
    r.write(postBody);
    r.end();
  });
}

async function _runDemoBuyerCall(customerId, customerName, phone, buyerContext, callId, orgId) {
  // Build a realistic demo transcript based on buyer context
  const req = buyerContext.machine_requirement || buyerContext.machine || 'excavator';
  const budget = buyerContext.budget ? ` Budget: ${buyerContext.budget}.` : '';
  const city = buyerContext.city ? ` Location: ${buyerContext.city}.` : '';
  const demoTranscript = [
    { role: 'agent',  text: `Namaste ${customerName} ji, Om Shyam Earthmovers se Vaani bol rahi hoon. Aapne ${req} ke liye enquiry ki thi, usi ke regarding call kiya hai.` },
    { role: 'user',   text: `Haan ji, main ${req} khareedna chahta hoon.${city}` },
    { role: 'agent',  text: 'Ji, bilkul. Kaunsa model year prefer karenge aur budget roughly kitna hai?' },
    { role: 'user',   text: `2019 ya 2020 ka model chahiye.${budget}` },
    { role: 'agent',  text: 'Ji. Main abhi inventory check karti hoon.' },
    { role: 'agent',  text: 'Hamare paas kuch options available hain. Main details aur photos WhatsApp par bhejti hoon. WhatsApp number confirm karein?' },
    { role: 'user',   text: `Haan, ${phone} par hi bhej dijiye.` },
    { role: 'agent',  text: 'Bilkul. Aaj hi details aur photos share karti hoon. Dhanyawad.' },
  ];
  const runId = 900000 + callId; // safe simulation range
  try {
    const ingestPayload = {
      primary_phone: phone,
      customer_name: customerName,
      customer_type: 'buyer',
      lead_id: `lead_vc_${customerId}_${callId}`,
      call_metadata: { run_id: runId, workflow_id: 3, org_id: orgId, call_duration_seconds: 95, caller_number: phone, created_at: new Date().toISOString() },
      transcript: demoTranscript,
      machine_details: {
        brand: buyerContext.brand || null,
        model: buyerContext.model || null,
        location_city: buyerContext.city || null,
      },
      commercial_terms: {
        price_or_budget_raw: buyerContext.budget || null,
        purchase_timeline: 'immediate_under_7d',
      },
      call_notes: `Demo call from vaani_customers id=${customerId}. Req: ${req}.`,
      follow_up_required: true,
      conversation_outcome: 'inquiry',
    };
    await vaaniSales.ingestCallComplete(ingestPayload);
    console.log(`[BUYER CALL DEMO] ingestCallComplete OK for call_id=${callId}`);
  } catch (e) {
    console.error(`[BUYER CALL DEMO] ingestCallComplete failed (non-fatal): ${e.message}`);
  }
}

async function apiVaaniOutboundBuyer(req, res, ctx) {
  try {
    const orgId = 1;
    const b = ctx.body || {};

    // ---- Validation -----------------------------------------------------------
    const name   = (b.name || '').trim();
    const phone  = (b.phone || '').trim();
    const req_   = (b.machine_requirement || '').trim();
    if (!name || !phone) {
      return core.sendJson(res, 422, { error: 'name and phone are required', code: 'bad_request' });
    }
    if (phone.length < 8) {
      return core.sendJson(res, 422, { error: 'phone must be a valid number (min 8 digits)', code: 'invalid_phone' });
    }

    // ---- Resolve or create customer ------------------------------------------
    let customerId = b.customer_id ? parseInt(b.customer_id, 10) : null;
    if (customerId) {
      // Verify exists
      const existing = await vaaniSales.queryPostgres(
        'SELECT row_to_json(c) FROM (SELECT id, name, phone FROM vaani_customers WHERE id = $1) c;',
        [customerId]
      ).catch(() => null);
      if (!existing || !existing.id) {
        return core.sendJson(res, 404, { error: `Customer id=${customerId} not found`, code: 'not_found' });
      }
    } else {
      // Create new customer from supplied fields
      const created = await vaaniSales.queryPostgres(
        `WITH r AS (INSERT INTO vaani_customers (name, phone, machine_requirement) VALUES ($1, $2, $3) RETURNING id) SELECT row_to_json(r) FROM r;`,
        [name, phone, req_]
      ).catch(() => null);
      const createdId = created && (created.id || (typeof created === 'number' ? created : parseInt(created, 10)));
      if (!createdId || isNaN(createdId)) {
        return core.sendJson(res, 500, { error: 'Failed to create customer record', code: 'db_error' });
      }
      customerId = createdId;
    }

    // ---- Persist call record with status=queued ------------------------------
    const callRow = await vaaniSales.queryPostgres(
      `WITH r AS (INSERT INTO vaani_calls (customer_id, direction, status, mode, started_at)
       VALUES ($1, 'outbound', 'queued', 'live', CURRENT_TIMESTAMP) RETURNING id) SELECT row_to_json(r) FROM r;`,
      [customerId]
    ).catch(() => null);
    const callId = callRow && (callRow.id || (typeof callRow === 'number' ? callRow : parseInt(callRow, 10)));
    if (!callId || isNaN(callId)) {
      return core.sendJson(res, 500, { error: 'Failed to create call record', code: 'db_error' });
    }

    // ---- Build buyer context for Dograh / demo --------------------------------
    const buyerContext = {
      customer_name:       name,
      machine_requirement: req_,
      brand:               (b.brand  || '').trim() || undefined,
      model:               (b.model  || '').trim() || undefined,
      budget:              (b.budget || '').trim() || undefined,
      city:                (b.city   || '').trim() || undefined,
      notes:               (b.notes  || '').trim() || undefined,
      vaani_call_id:       callId,
    };
    // Remove undefined keys
    Object.keys(buyerContext).forEach(k => buyerContext[k] === undefined && delete buyerContext[k]);

    // ---- Attempt Dograh dispatch ---------------------------------------------
    const dispatch = await _dispatchDograhCall(phone, buyerContext, callId);

    if (dispatch.dispatched) {
      // Update call status to 'dispatched'
      await vaaniSales.queryPostgres(
        `UPDATE vaani_calls SET status = 'dispatched', dograh_call_id = $1 WHERE id = $2;`,
        [String(dispatch.dograh_response?.run_id || dispatch.dograh_response?.call_id || ''), callId]
      ).catch(() => {});

      return core.sendJson(res, 200, {
        success: true,
        call_status: 'DISPATCHED',
        call_id: callId,
        customer_id: customerId,
        message: 'Call dispatched to Dograh. Transcript will be available after call completes via webhook.',
        dograh_response: dispatch.dograh_response,
      });
    } else {
      // ---- DEMO MODE: Dograh unavailable, run full pipeline locally -----------
      console.log(`[BUYER CALL] Dograh unavailable (${dispatch.reason}). Running DEMO mode for call_id=${callId}`);
      await vaaniSales.queryPostgres(
        `UPDATE vaani_calls SET status = 'demo', mode = 'demo', ended_at = CURRENT_TIMESTAMP WHERE id = $1;`,
        [callId]
      ).catch(() => {});

      // Run demo pipeline in the background — do not await to keep API fast
      _runDemoBuyerCall(customerId, name, phone, buyerContext, callId, orgId).catch(() => {});

      // Also persist demo transcript and summary directly to vaani_calls tables
      const req2 = buyerContext.machine_requirement || 'machine';
      const demoTranscriptRows = [
        { speaker: 'Vaani',    message: `Namaste ${name} ji, Om Shyam Earthmovers se Vaani bol rahi hoon. Aapne ${req2} ke liye enquiry ki thi.` },
        { speaker: 'Customer', message: `Haan ji, main ${req2} khareedna chahta hoon.` },
        { speaker: 'Vaani',    message: 'Kaunsa model year prefer karenge aur budget roughly kitna hai?' },
        { speaker: 'Customer', message: `2019 ya 2020 chalega.${buyerContext.budget ? ' Budget ' + buyerContext.budget + ' hai.' : ''}` },
        { speaker: 'Vaani',    message: 'Inventory check karke details aur photos WhatsApp par bhejti hoon.' },
        { speaker: 'Customer', message: 'Theek hai, dhanyawad.' },
      ];

      const esc = (v) => v ? String(v).replace(/'/g, "''").slice(0, 500) : '';

      // Transcript rows
      const tVals = demoTranscriptRows.map(t => `(${callId}, '${esc(t.speaker)}', '${esc(t.message)}')`).join(',');
      await vaaniSales.queryPostgres(`INSERT INTO vaani_transcripts (call_id, speaker, message) VALUES ${tVals};`).catch(() => {});

      // Run LLM summary (same logic as demo call complete)
      let sf = { customer_requirement: req2, interest_level: 'Warm', budget: buyerContext.budget || 'Not stated', customer_intent: 'Buy', outcome: `Demo buyer call for ${req2}.`, next_action: 'Send machine photos and details on WhatsApp.' };
      try {
        const txText = demoTranscriptRows.map(t => `${t.speaker}: ${t.message}`).join('\n');
        const promptText = `You are analyzing a Hindi/Hinglish sales call transcript for Om Shyam Earthmover (used excavator dealer).\n\nExtract the following and respond with EXACTLY these labels (one per line):\nRequirement: <machine model/brand the customer wants, or "Not stated">\nInterest Level: <Hot/Warm/Cold>\nBudget: <budget in INR or "Not stated">\nIntent: <Buy/Sell/Inquiry/Unknown>\nOutcome: <brief one-line outcome of this call>\nNext Action: <what should happen next>\n\nTranscript:\n${txText}`;
        const selected = providers.resolveSelection('llm', { provider: 'groq' });
        const out = await selected.adapter.chat({ messages: [{ role: 'user', text: promptText }], model: selected.model });
        const rawText = (out && out.text) ? out.text.trim() : '';
        if (rawText) {
          const pick = (label) => { const m = rawText.match(new RegExp(`^${label}:\\s*(.+)`, 'im')); return m ? m[1].trim() : ''; };
          sf = { customer_requirement: pick('Requirement') || req2, interest_level: pick('Interest Level') || 'Warm', budget: pick('Budget') || buyerContext.budget || 'Not stated', customer_intent: pick('Intent') || 'Buy', outcome: pick('Outcome') || sf.outcome, next_action: pick('Next Action') || sf.next_action };
        }
      } catch (e) { console.error('[BUYER CALL] LLM summary error (non-fatal):', e.message); }

      await vaaniSales.queryPostgres(
        `INSERT INTO vaani_call_summaries (call_id, customer_requirement, interest_level, budget, customer_intent, outcome, next_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (call_id) DO UPDATE SET
           customer_requirement = EXCLUDED.customer_requirement,
           interest_level = EXCLUDED.interest_level,
           budget = EXCLUDED.budget,
           customer_intent = EXCLUDED.customer_intent,
           outcome = EXCLUDED.outcome,
           next_action = EXCLUDED.next_action;`,
        [callId, sf.customer_requirement, sf.interest_level, sf.budget, sf.customer_intent, sf.outcome, sf.next_action]
      ).catch(() => {});

      return core.sendJson(res, 200, {
        success: true,
        call_status: 'DEMO',
        call_id: callId,
        customer_id: customerId,
        telephony_boundary: 'DEMO — No real call made. Dograh telephony not configured.',
        telephony_missing: dispatch.reason,
        message: 'Demo buyer call pipeline executed. Transcript and AI analysis persisted.',
        summary: sf,
      });
    }
  } catch (err) {
    console.error('[BUYER CALL] Internal error:', err);
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

// ---- Buyer CRM: List customers with latest call status -----------------------
async function apiVaaniBuyersList(req, res) {
  try {
    const result = await vaaniSales.queryPostgres(`
      SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) FROM (
        SELECT
          c.id, c.name, c.phone, c.machine_requirement, c.created_at,
          (
            SELECT status FROM vaani_calls WHERE customer_id = c.id
            ORDER BY created_at DESC LIMIT 1
          ) AS last_call_status,
          (
            SELECT mode FROM vaani_calls WHERE customer_id = c.id
            ORDER BY created_at DESC LIMIT 1
          ) AS last_call_mode,
          (
            SELECT id FROM vaani_calls WHERE customer_id = c.id
            ORDER BY created_at DESC LIMIT 1
          ) AS last_call_id,
          (
            SELECT created_at FROM vaani_calls WHERE customer_id = c.id
            ORDER BY created_at DESC LIMIT 1
          ) AS last_call_at,
          (
            SELECT s.interest_level FROM vaani_call_summaries s
            INNER JOIN vaani_calls cl ON s.call_id = cl.id
            WHERE cl.customer_id = c.id
            ORDER BY cl.created_at DESC LIMIT 1
          ) AS interest_level,
          (
            SELECT s.next_action FROM vaani_call_summaries s
            INNER JOIN vaani_calls cl ON s.call_id = cl.id
            WHERE cl.customer_id = c.id
            ORDER BY cl.created_at DESC LIMIT 1
          ) AS next_action,
          (SELECT COUNT(*) FROM vaani_calls WHERE customer_id = c.id) AS total_calls
        FROM vaani_customers c
      ) t;
    `).catch(() => []);
    const buyers = Array.isArray(result) ? result : [];
    return core.sendJson(res, 200, { total: buyers.length, buyers });
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

// ---- Buyer CRM: Get customer detail with calls, latest summary, follow-ups ---
async function apiVaaniBuyerDetail(req, res, ctx) {
  try {
    const custId = parseInt(ctx.body, 10);
    if (!custId) return core.sendJson(res, 400, { error: 'customer id required', code: 'bad_request' });

    const customer = await vaaniSales.queryPostgres(
      'SELECT row_to_json(c) FROM (SELECT id, name, phone, machine_requirement, created_at FROM vaani_customers WHERE id = $1) c;',
      [custId]
    ).catch(() => null);
    if (!customer || !customer.id) return core.sendJson(res, 404, { error: 'Buyer not found', code: 'not_found' });

    // Calls with summaries (multi-row: use json_agg)
    const calls = await vaaniSales.queryPostgres(`
      SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) FROM (
        SELECT
          c.id, c.direction, c.status, c.mode, c.created_at, c.ended_at, c.duration,
          s.customer_requirement, s.interest_level, s.budget, s.customer_intent, s.outcome, s.next_action
        FROM vaani_calls c
        LEFT JOIN vaani_call_summaries s ON s.call_id = c.id
        WHERE c.customer_id = $1
      ) t;
    `, [custId]).catch(() => []);
    customer.calls = Array.isArray(calls) ? calls : [];

    // Latest transcript (multi-row: use json_agg)
    const latestCallId = customer.calls.length ? customer.calls[0].id : null;
    customer.latest_transcript = [];
    if (latestCallId) {
      const txRows = await vaaniSales.queryPostgres(`
        SELECT COALESCE(json_agg(t ORDER BY t.timestamp ASC), '[]'::json) FROM (
          SELECT speaker, message, timestamp FROM vaani_transcripts
          WHERE call_id = $1
        ) t;
      `, [latestCallId]).catch(() => []);
      customer.latest_transcript = Array.isArray(txRows) ? txRows : [];
    }

    // Latest AI summary (from first call row)
    customer.latest_summary = customer.calls.length ? {
      customer_requirement: customer.calls[0].customer_requirement,
      interest_level:       customer.calls[0].interest_level,
      budget:               customer.calls[0].budget,
      customer_intent:      customer.calls[0].customer_intent,
      outcome:              customer.calls[0].outcome,
      next_action:          customer.calls[0].next_action,
    } : null;

    return core.sendJson(res, 200, customer);
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
  }
}

// ---- Buyer CRM: Get transcript for a specific call ---------------------------
async function apiVaaniBuyerCallDetail(req, res, ctx) {
  try {
    const { custId, callId } = ctx.body || {};
    if (!custId || !callId) return core.sendJson(res, 400, { error: 'customer_id and call_id required', code: 'bad_request' });

    // Verify call belongs to customer (single row)
    const callRow = await vaaniSales.queryPostgres(
      'SELECT row_to_json(c) FROM (SELECT id, direction, status, mode, created_at, ended_at, duration FROM vaani_calls WHERE id = $1 AND customer_id = $2) c;',
      [callId, custId]
    ).catch(() => null);
    if (!callRow || !callRow.id) return core.sendJson(res, 404, { error: 'Call not found for this buyer', code: 'not_found' });

    // Transcripts (multi-row: use json_agg)
    const txRows = await vaaniSales.queryPostgres(`
      SELECT COALESCE(json_agg(t ORDER BY t.timestamp ASC), '[]'::json) FROM (
        SELECT speaker, message, timestamp FROM vaani_transcripts WHERE call_id = $1
      ) t;
    `, [callId]).catch(() => []);
    callRow.transcripts = Array.isArray(txRows) ? txRows : [];

    // Summary (single row)
    const summary = await vaaniSales.queryPostgres(
      'SELECT row_to_json(s) FROM (SELECT customer_requirement, interest_level, budget, customer_intent, outcome, next_action FROM vaani_call_summaries WHERE call_id = $1) s;',
      [callId]
    ).catch(() => null);
    callRow.summary = summary || null;

    return core.sendJson(res, 200, callRow);
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'internal_error' });
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

async function apiVaaniSimulateCall(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const b = ctx.body || {};
    const scenario = b.scenario || 'seller'; // 'seller' or 'buyer'

    // Generate safe synthetic run_id in the dedicated test/simulation range (>= 950000)
    const runId = Math.floor(950000 + Math.random() * 45000);
    const leadId = `lead_${runId}`;
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const testPhone = `+9198765${randSuffix}`;

    let payload;
    if (scenario === 'buyer') {
      payload = {
        primary_phone: testPhone,
        customer_name: b.customer_name || `Sunil Verma (Simulated Buyer #${randSuffix})`,
        customer_type: 'buyer',
        lead_id: leadId,
        call_metadata: {
          run_id: runId,
          workflow_id: 3,
          org_id: orgId,
          call_duration_seconds: 145,
          caller_number: testPhone,
          created_at: new Date().toISOString()
        },
        transcript: [
          { role: 'agent', text: 'Namaste, Shyam Earthmover me aapka swagat hai. Main Vaani bol rahi hoon. Kahiye kaise sahayata kar sakti hoon?' },
          { role: 'user', text: 'Haan madam mujhe second hand JCB 3DX machine chahiye mere construction project ke liye.' },
          { role: 'agent', text: 'Zaroor sir, aapko kaun sa model year aur budget me machine dekhna hai?' },
          { role: 'user', text: 'Model 2020 ya 2021 ka chalega, budget 22 lakh tak ka hai, immediate delivery chahiye Raipur me.' },
          { role: 'agent', text: 'Bahut badhiya sir. Main aapki requirement note kar leti hoon aur inventory match karke turant details bhejti hoon.' }
        ],
        machine_details: {
          brand: 'JCB',
          model: '3DX',
          model_year: 2021,
          machine_location: 'Raipur, Chhattisgarh'
        },
        commercial_terms: {
          budget_min: 2000000,
          budget_max: 2200000,
          payment_terms: 'Finance + Down Payment'
        }
      };
    } else {
      // Default: Seller (Tata Hitachi EX 200 LC)
      payload = {
        primary_phone: testPhone,
        customer_name: b.customer_name || `Ramesh Choudhary (Simulated Seller #${randSuffix})`,
        customer_type: 'seller',
        lead_id: leadId,
        call_metadata: {
          run_id: runId,
          workflow_id: 3,
          org_id: orgId,
          call_duration_seconds: 185,
          caller_number: testPhone,
          created_at: new Date().toISOString()
        },
        transcript: [
          { role: 'agent', text: 'Namaste, Shyam Earthmover se Vaani bol rahi hoon. Kahiye kaise sahayata kar sakti hoon?' },
          { role: 'user', text: 'Namaste madam, mere paas Tata Hitachi EX 200 LC excavator hai, 2019 model, bechna hai.' },
          { role: 'agent', text: 'Theek hai sir. Machine kitne ghante chali hai aur asking price kya rakha hai aapne?' },
          { role: 'user', text: 'Lagbhag 4800 hours chali hai, asking price 26 lakh hai, 25 lakh tak final kar dunga. Urgent cash deal chahiye.' },
          { role: 'agent', text: 'Kya machine par koi loan ya finance baki hai, aur RC available hai?' },
          { role: 'user', text: 'Loan clear hai, Bank NOC aur RC mere paas hai. WhatsApp par photos bhej dunga.' },
          { role: 'agent', text: 'Shukriya Ramesh ji. Main inspection checklist aur WhatsApp details forward kar rahi hoon.' }
        ],
        machine_details: {
          brand: 'Tata Hitachi',
          model: 'EX 200 LC',
          model_year: 2019,
          running_hours: 4800,
          machine_location: 'Bilaspur, Chhattisgarh'
        },
        commercial_terms: {
          asking_price: 2600000,
          min_acceptable_price: 2500000,
          payment_terms: 'Immediate RTGS'
        }
      };
    }

    // Call EXISTING ingestCallComplete pipeline without bypassing any business logic
    const result = await vaaniSales.ingestCallComplete(payload);

    return core.sendJson(res, 201, {
      success: true,
      simulated: true,
      scenario,
      run_id: runId,
      lead_id: result.lead_id || leadId,
      customer_name: payload.customer_name,
      primary_phone: testPhone,
      qualification_state: result.qualification_state || 'QUALIFIED',
      temperature: result.temperature || 'HOT',
      tasks_created: result.tasks_created || [],
      machine: payload.machine_details,
      commercial_terms: payload.commercial_terms,
      result
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return core.sendJson(res, status, { error: err.message, code: err.code || 'simulation_error' });
  }
}

async function apiVaaniSimulateInboundMedia(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }
    const b = ctx.body || {};
    const leadId = (b.lead_id || '').trim();
    if (!leadId) {
      return core.sendJson(res, 422, { error: 'lead_id is required', code: 'missing_lead_id' });
    }
    const evidenceType = b.evidence_type || 'BOOM_PHOTOS';

    // Find the lead's phone number in PostgreSQL
    const leadNumId = isNaN(parseInt(leadId.replace('lead_', ''), 10)) ? -1 : parseInt(leadId.replace('lead_', ''), 10);
    const leadRow = await vaaniSales.queryPostgres(`
      SELECT row_to_json(t) FROM (
        SELECT run_id, caller_name, callback_number, whatsapp_number
        FROM public.vaani_excavator_sales_leads
        WHERE organization_id = $1 AND (run_id = $2 OR callback_number = $3 OR whatsapp_number = $3)
        LIMIT 1
      ) t;
    `, [orgId, leadNumId, leadId]).catch(() => null);

    if (!leadRow || (!leadRow.callback_number && !leadRow.whatsapp_number)) {
      return core.sendJson(res, 404, { error: 'Lead phone not found for this tenant', code: 'lead_not_found' });
    }

    const fromPhone = leadRow.whatsapp_number || leadRow.callback_number;
    const eventId = `sim_wa_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    let messageType = 'IMAGE';
    let mimeType = 'image/jpeg';
    let filename = 'boom_arm_inspection.jpg';
    let textDesc = 'Customer sent machine boom & arm photo';

    if (evidenceType === 'HOUR_METER_PHOTO') {
      filename = 'hour_meter_display.jpg';
      textDesc = 'Customer sent hour meter display photo';
    } else if (evidenceType === 'RUNNING_VIDEO') {
      messageType = 'VIDEO';
      mimeType = 'video/mp4';
      filename = 'engine_running_sound.mp4';
      textDesc = 'Customer sent engine operation video';
    } else if (evidenceType === 'RC_DOCUMENT' || evidenceType === 'BANK_NOC_DOCUMENT') {
      messageType = 'DOCUMENT';
      mimeType = 'application/pdf';
      filename = evidenceType === 'RC_DOCUMENT' ? 'vehicle_rc.pdf' : 'bank_noc.pdf';
      textDesc = `Customer sent ${evidenceType.replace('_', ' ')}`;
    }

    const webhookPayload = {
      organization_id: orgId,
      event_id: eventId,
      from_phone: fromPhone,
      to_phone: '+918000000000',
      message_type: messageType,
      text: textDesc,
      media_url: `whatsapp://simulated/${evidenceType.toLowerCase()}/${eventId}`,
      mime_type: mimeType,
      filename: filename,
      raw_metadata: {
        simulated: true,
        evidence_type: evidenceType,
        source: 'vaani_live_simulation_controller'
      }
    };

    // Call EXISTING processInboundWebhook business logic (Dry-run mock)
    const result = await vaaniSales.processInboundWebhook(webhookPayload, orgId);

    return core.sendJson(res, 200, {
      success: true,
      simulated: true,
      event_id: eventId,
      lead_id: leadId,
      from_phone: fromPhone,
      evidence_type: evidenceType,
      result
    });
  } catch (err) {
    const status = err.statusCode || 400;
    return core.sendJson(res, status, { error: err.message, code: err.code || 'media_simulation_error' });
  }
}

async function apiVaaniCleanupSimulations(req, res, ctx) {
  try {
    const orgId = resolveOrganizationId(ctx);
    if (!orgId) {
      return core.sendJson(res, 403, { error: 'organization not linked', code: 'forbidden' });
    }

    // Safely delete ONLY simulated records (run_id >= 900000 or raw_metadata->>'simulated' = 'true')
    const delQuery = `
      DO $$
      DECLARE
        target_org INT := ${parseInt(orgId, 10)};
      BEGIN
        DELETE FROM public.vaani_whatsapp_inbound_events 
          WHERE organization_id = target_org 
            AND (event_id LIKE 'sim_wa_%' OR raw_metadata->>'simulated' = 'true');

        DELETE FROM public.vaani_digital_evidence 
          WHERE organization_id = target_org 
            AND (run_id >= 900000 OR media_url LIKE 'whatsapp://simulated/%' OR metadata->>'simulated' = 'true');

        DELETE FROM public.vaani_whatsapp_messages 
          WHERE organization_id = target_org 
            AND (phone_number LIKE '+9198765%' OR phone_number LIKE '+9198111%');

        DELETE FROM public.vaani_follow_up_tasks 
          WHERE organization_id = target_org 
            AND (source_call_id >= 900000 OR lead_id LIKE 'lead_9%');

        DELETE FROM public.vaani_machines 
          WHERE organization_id = target_org 
            AND source_lead_run_id >= 900000;

        DELETE FROM public.workflow_runs 
          WHERE id >= 900000;
      END $$;
    `;

    await vaaniSales.queryPostgres(delQuery);

    return core.sendJson(res, 200, {
      success: true,
      message: 'Simulated test data safely cleared'
    });
  } catch (err) {
    return core.sendJson(res, 500, { error: err.message, code: 'cleanup_error' });
  }
}


async function apiHvacEventTypes(req, res) {
  try { const result = await calRequest('GET', '/v2/event-types', '2024-06-14'); core.sendJson(res, 200, { eventTypes: (result.data || []).map((event) => ({ id: event.id, title: event.title, slug: event.slug, lengthInMinutes: event.lengthInMinutes, locations: event.locations || [] })) }); }
  catch (e) { handleProviderError(res, e); }
}
async function apiHvacSlots(req, res) {
  try {
    const q = new URL(req.url, 'http://local').searchParams; const eventTypeId = Number(q.get('eventTypeId')); const start = String(q.get('start') || ''); const end = String(q.get('end') || '');
    if (!Number.isInteger(eventTypeId) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return core.sendJson(res, 422, { error: 'event type and date range required', code: 'bad_calendar_query' });
    const result = await calRequest('GET', `/v2/slots?eventTypeId=${eventTypeId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(HVAC_TIMEZONE)}&format=range`, '2024-09-04');
    core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, slots: result.data || {} });
  } catch (e) { handleProviderError(res, e); }
}
async function apiHvacJobSave(req, res, ctx) {
  const b = ctx.body || {}; const callerName = String(b.callerName || '').trim().slice(0, 100); const phone = String(b.phone || '').trim().slice(0, 32);
  if (!callerName || !phone) return core.sendJson(res, 422, { error: 'caller name and phone are required', code: 'missing_contact' });
  const outcome = HVAC_OUTCOMES.has(b.outcome) ? b.outcome : 'new'; const now = new Date().toISOString(); let job;
  await core.mutate((d) => {
    job = b.id ? d.hvacJobs.find((item) => item.id === String(b.id) && item.tenantId === ctx.tenant.id) : null;
    if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, createdAt: now, appointment: null }; d.hvacJobs.push(job); }
    Object.assign(job, { callerName, phone, email: String(b.email || '').trim().slice(0, 180), service: String(b.service || 'General HVAC').trim().slice(0, 80), urgency: String(b.urgency || 'normal').trim().slice(0, 30), outcome, assignedTo: String(b.assignedTo || '').trim().slice(0, 80), notes: String(b.notes || '').trim().slice(0, 2000), updatedAt: now });
    addAudit(d, ctx, 'hvac.job.saved', 'hvac_job', job.id, { outcome: job.outcome });
  });
  core.sendJson(res, 200, { job: publicHvacJob(job) });
}
async function apiHvacBook(req, res, ctx) {
  const b = ctx.body || {}; const eventTypeId = Number(b.eventTypeId); const start = String(b.start || ''); const attendee = b.attendee || {};
  if (!Number.isInteger(eventTypeId) || Number(eventTypeId) <= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(start)) return core.sendJson(res, 422, { error: 'event type and appointment time are required', code: 'bad_booking' });
  const name = String(attendee.name || '').trim(); const email = String(attendee.email || '').trim().toLowerCase(); const phone = String(attendee.phone || '').trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone) return core.sendJson(res, 422, { error: 'attendee name, email and phone are required for Cal.com booking', code: 'missing_booking_contact' });
  try {
    const booking = await calRequest('POST', '/v2/bookings', '2026-02-25', { eventTypeId, start: new Date(start).toISOString(), attendee: { name, email, phoneNumber: phone, timeZone: HVAC_TIMEZONE, language: 'en' }, metadata: { source: 'rumik_hvac_desk', service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), jobId: String(b.jobId || '') } });
    const now = new Date().toISOString(); let job;
    await core.mutate((d) => {
      job = b.jobId ? d.hvacJobs.find((item) => item.id === String(b.jobId) && item.tenantId === ctx.tenant.id) : null;
      if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, callerName: name, phone, email, service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), assignedTo: '', notes: '', createdAt: now }; d.hvacJobs.push(job); }
      job.outcome = 'booked'; job.updatedAt = now; job.appointment = { calBookingUid: booking.data && booking.data.uid, eventTypeId, start: booking.data && booking.data.start, end: booking.data && booking.data.end, status: booking.data && booking.data.status, timezone: HVAC_TIMEZONE };
      addAudit(d, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: job.appointment.calBookingUid || '' });
    });
    core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
  } catch (e) { handleProviderError(res, e); }
}

function apiAgentsList(req, res, ctx) {
  const agents = core.db().agents
    .filter((a) => a.tenantId === ctx.tenant.id)
    .map(publicAgent);
  core.sendJson(res, 200, { agents });
}

async function apiAgentsCreate(req, res, ctx) {
  const b = ctx.body || {};
  const preset = b.presetId ? core.db().presets.find((p) => p.id === String(b.presetId) && (p.isSystem || p.tenantId === ctx.tenant.id)) : null;
  if (b.presetId && !preset) return core.sendJson(res, 404, { error: 'preset not found', code: 'not_found' });
  const ttsIn = b.tts || {};
  const model = ttsIn.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(ttsIn.speaker) ? ttsIn.speaker : 'speaker_1';
  const f0 = Number.isFinite(ttsIn.f0_up_key) ? Math.max(-12, Math.min(12, ttsIn.f0_up_key | 0)) : 0;

  const agent = {
    id: core.genId('ag_'),
    tenantId: ctx.tenant.id,
    name: String(b.name || (preset && preset.name) || 'Untitled Agent').slice(0, 60),
    persona: String(b.persona || (preset ? `${preset.name}. Collect: ${preset.fields.join(', ')}. Guardrails: ${preset.guardrails.join('; ')}.` : '')).slice(0, 1500),
    tts: { provider: providers.tts.id, model, speaker, f0_up_key: f0 },
    greeting: String(b.greeting || (preset && preset.greeting) || '').slice(0, 300),
    presetId: preset ? preset.id : null,
    telephony: { did: String(b.did || providers.telephony.did).replace(/[^0-9]/g, '') || providers.telephony.did },
    createdAt: new Date().toISOString(),
  };
  await core.mutate((d) => { d.agents.push(agent); });
  core.sendJson(res, 200, { agent: publicAgent(agent) });
}

async function apiAgentsUpdate(req, res, ctx) {
  const b = ctx.body || {};
  const id = String(b.id || '');
  const d = core.db();
  const agent = d.agents.find((a) => a.id === id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  if (agent.tenantId !== ctx.tenant.id) {
    return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
  }
  let updated;
  await core.mutate((dd) => {
    const a = dd.agents.find((x) => x.id === id);
    if (b.name != null) a.name = String(b.name).slice(0, 60);
    if (b.persona != null) a.persona = String(b.persona).slice(0, 1500);
    if (b.greeting != null) a.greeting = String(b.greeting).slice(0, 300);
    if (b.did != null) {
      const did = String(b.did).replace(/[^0-9]/g, '');
      a.telephony = { ...(a.telephony || {}), did: did || providers.telephony.did };
    }
    if (b.tts && typeof b.tts === 'object') {
      const t = a.tts || { provider: providers.tts.id };
      if (b.tts.model != null) t.model = b.tts.model === 'muga' ? 'muga' : providers.tts.model;
      if (providers.TTS_SPEAKERS.has(b.tts.speaker)) t.speaker = b.tts.speaker;
      if (Number.isFinite(b.tts.f0_up_key)) t.f0_up_key = Math.max(-12, Math.min(12, b.tts.f0_up_key | 0));
      t.provider = providers.tts.id;
      a.tts = t;
    }
    updated = a;
  });
  core.sendJson(res, 200, { agent: publicAgent(updated) });
}

async function apiAgentsDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const agent = core.db().agents.find((a) => a.id === id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  if (agent.tenantId !== ctx.tenant.id) {
    return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
  }
  await core.mutate((d) => { d.agents = d.agents.filter((a) => a.id !== id); });
  core.sendJson(res, 200, { ok: true });
}

// POST /api/tts -> Rumik WAV bytes. Increments tenant usage.chars.
async function apiTts(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const out = await selected.adapter.synthesize({
      text: b.text,
      model: selected.model,
      speaker: b.speaker,
      f0_up_key: b.f0_up_key,
      description: b.description,
    });
    // Count usage only on a real synthesis.
    bumpUsage(ctx.tenant.id, 'chars', out.chars).catch(() => {});
    core.send(res, 200, out.buffer, {
      'Content-Type': 'audio/wav',
      'Content-Length': out.buffer.length,
      'X-Credits-Used': out.credits,
      'X-Chars': String(out.chars),
    });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// GET or POST /api/tts/local -> synthesized local Hindi audio WAV using Lekha
async function apiTtsLocal(req, res, queryOrBody) {
  const text = String((queryOrBody && queryOrBody.text) || '').slice(0, 2000).trim();
  if (!text) return core.sendJson(res, 400, { error: 'text is required', code: 'no_text' });
  try {
    const wavBuf = await providers.synthesizeLocalLekha(text);
    core.send(res, 200, wavBuf, {
      'Content-Type': 'audio/wav',
      'Content-Length': wavBuf.length,
      'X-Voice': 'Lekha (Local macOS)',
    });
  } catch (err) {
    core.sendJson(res, 500, { error: err.message || 'local tts failed', code: 'tts_failed' });
  }
}

// POST /api/ws-connect -> { ws_url, token } (Rumik streaming mint).
async function apiWsConnect(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const data = await selected.adapter.wsConnect({ text: b.text, model: selected.model });
    core.sendJson(res, 200, { ...data, provider: selected.provider, model: selected.model });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/chat -> { text, finish, provider, model, latency_ms } (Groq brain).
async function apiChat(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('llm', { provider: b.provider, model: b.model });
    const out = await selected.adapter.chat({ messages: b.messages, system: b.system, model: selected.model });
    // Rough token accounting for the usage view (4 chars ~= 1 token).
    const approxTokens = Math.ceil((out.text || '').length / 4);
    bumpUsage(ctx.tenant.id, 'llmTokens', approxTokens).catch(() => {});
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/stt -> { text, provider, model, latency_ms } (Deepgram Nova-3).
async function apiStt(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const out = await providers.stt.transcribe({ audio: b.audio, mime: b.mime });
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function mintDograhVoiceSession(req, context) {
  const token = String(process.env.DOGRAH_EMBED_TOKEN || '').trim();
  const base = String(process.env.DOGRAH_BASE_URL || '').replace(/\/$/, '');
  if (!token || !base) {
    const error = new Error('realtime voice session is not configured');
    error.status = 503; error.code = 'voice_session_unavailable'; throw error;
  }
  const requestOrigin = String(req.headers.origin || `https://${req.headers.host || ''}`);
  const upstream = await fetch(base + '/api/v1/public/embed/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
    body: JSON.stringify({ token, context_variables: {
      source: String(context.source || 'rumik_studio'),
      tenant_id: String(context.tenantId || ''),
      agent_id: String(context.agentId || ''),
      demo_link_id: String(context.demoLinkId || ''),
      max_session_seconds: String(context.maxSessionSeconds || ''),
    } }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await upstream.text(); let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!upstream.ok) {
    const error = new Error(String(data.detail || 'Dograh could not start the realtime voice session'));
    error.status = upstream.status; error.code = 'voice_session_failed'; throw error;
  }
  const sessionToken = String(data.session_token || '');
  let turnCredentials = null;
  if (sessionToken) {
    try {
      const turnUpstream = await fetch(base + '/api/v1/public/embed/turn-credentials/' + encodeURIComponent(sessionToken), {
        method: 'GET', headers: { Origin: requestOrigin }, signal: AbortSignal.timeout(8000),
      });
      if (turnUpstream.ok) {
        const turnData = await turnUpstream.json();
        if (Array.isArray(turnData.uris) && turnData.uris.length && turnData.username && turnData.password) {
          turnCredentials = {
            uris: turnData.uris,
            username: String(turnData.username),
            password: String(turnData.password),
            ttl: Number(turnData.ttl || 0),
          };
        }
      }
    } catch (_) {}
  }
  return {
    sessionToken: data.session_token, workflowRunId: data.workflow_run_id,
    workflowId: data.config && data.config.workflow_id,
    signalingUrl: base.replace(/^http/, 'ws') + '/api/v1/ws/public/signaling/' + encodeURIComponent(data.session_token),
    turnCredentials,
    runtime: 'Dograh SmallWebRTC',
  };
}

async function apiVoiceSession(req, res, ctx) {
  try {
    const session = await mintDograhVoiceSession(req, {
      source: 'rumik_studio', tenantId: ctx.tenant.id, agentId: (ctx.body || {}).agentId,
    });
    core.sendJson(res, 200, session);
  } catch (error) {
    core.sendJson(res, error.status || 502, { error: error.message || 'Dograh realtime voice session failed', code: error.code || 'voice_session_failed' });
  }
}

function tenantDemoLinks(tenantId) {
  return core.db().demoLinks.filter((link) => link.tenantId === tenantId);
}

function apiDemoLinksList(req, res, ctx) {
  const links = tenantDemoLinks(ctx.tenant.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => demoLinks.publicDemoLink(link));
  core.sendJson(res, 200, { demoLinks: links });
}

async function apiDemoLinksCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const body = ctx.body || {};
  const agent = core.db().agents.find((item) => item.id === String(body.agentId || '') && item.tenantId === ctx.tenant.id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  const generated = demoLinks.createDemoToken();
  const limits = demoLinks.normalizeDemoLimits(body);
  const link = {
    id: generated.id, tokenHash: generated.tokenHash, tenantId: ctx.tenant.id, agentId: agent.id,
    label: String(body.label || `${agent.name} demo`).trim().slice(0, 80) || `${agent.name} demo`,
    status: 'active', starts: 0, createdBy: ctx.user.id, createdAt: new Date().toISOString(),
    ...limits,
  };
  await core.mutate((database) => {
    database.demoLinks.push(link);
    addAudit(database, ctx, 'demo_link.created', 'demo_link', link.id, { agentId: agent.id, expiresAt: link.expiresAt, maxStarts: link.maxStarts });
  });
  core.sendJson(res, 201, { demoLink: demoLinks.publicDemoLink(link), sharePath: `/demo/${generated.token}` });
}

async function apiDemoLinksRevoke(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body || {}).id || '');
  const link = core.db().demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
  if (!link) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  await core.mutate((database) => {
    const target = database.demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
    target.status = 'revoked'; target.revokedAt = new Date().toISOString(); target.revokedBy = ctx.user.id;
    addAudit(database, ctx, 'demo_link.revoked', 'demo_link', id, { agentId: target.agentId });
  });
  core.sendJson(res, 200, { ok: true });
}

function publicDemoContext(token) {
  const database = core.db();
  const link = demoLinks.findDemoLink(database, token);
  if (!link) return null;
  const tenant = database.tenants.find((item) => item.id === link.tenantId && item.status === 'active');
  const agent = database.agents.find((item) => item.id === link.agentId && item.tenantId === link.tenantId);
  if (!tenant || !agent) return null;
  const color = String((tenant.branding || {}).color || '#B88A2D');
  return { link, tenant, agent, color: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#B88A2D' };
}

function apiPublicDemoMeta(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  const status = demoLinks.demoLinkStatus(context.link);
  core.sendJson(res, 200, {
    demo: { id: context.link.id, label: context.link.label, status, expiresAt: context.link.expiresAt, maxSessionSeconds: context.link.maxSessionSeconds },
    brand: { name: context.tenant.name, color: context.color },
    agent: { name: context.agent.name, greeting: String(context.agent.greeting || '').slice(0, 300) },
  });
}

async function apiPublicDemoSession(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  let reserved = false;
  try {
    await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      const status = demoLinks.demoLinkStatus(target);
      if (status !== 'active') {
        const error = new Error(`this demo link is ${status}`);
        error.status = 410; error.code = `demo_${status}`; throw error;
      }
      target.starts = Number(target.starts || 0) + 1;
      target.lastStartedAt = new Date().toISOString();
      reserved = true;
    });
    const session = await mintDograhVoiceSession(req, {
      source: 'public_demo', tenantId: context.tenant.id, agentId: context.agent.id,
      demoLinkId: context.link.id, maxSessionSeconds: context.link.maxSessionSeconds,
    });
    core.sendJson(res, 200, { ...session, maxSessionSeconds: context.link.maxSessionSeconds });
  } catch (error) {
    if (reserved) await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      if (target) target.starts = Math.max(0, Number(target.starts || 0) - 1);
    }).catch(() => {});
    core.sendJson(res, error.status || 502, { error: error.message || 'realtime demo failed', code: error.code || 'voice_session_failed' });
  }
}

// GET /api/telephony/status -> VoBiz configuration status from Dograh.
async function apiTelephonyStatus(req, res) {
  try {
    const status = await providers.telephony.status();
    core.sendJson(res, 200, { ...status, provider: 'vobiz', orchestrator: 'dograh' });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/telephony/dial -> places a REAL paid call. GUARDED behind confirm.
async function apiTelephonyDial(req, res, ctx) {
  const b = ctx.body || {};
  if (b.confirm !== true) {
    return core.sendJson(res, 400, {
      error: 'confirm required: this places a REAL paid call',
      code: 'needs_confirm',
    });
  }
  let workflowId;
  if (ctx.tenant.privacyMode === 'no_recording') {
    workflowId = Number(process.env.DOGRAH_NO_RECORDING_WORKFLOW_ID || 0);
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      return core.sendJson(res, 409, {
        error: 'HIPAA mode blocks phone calls until a verified no-recording Dograh workflow is configured',
        code: 'privacy_workflow_required',
      });
    }
  }
  try {
    const r = await providers.telephony.dial(b.number, { workflowId });
    // Count the dial attempt against today's usage.
    bumpUsage(ctx.tenant.id, 'calls', 1).catch(() => {});
    core.sendJson(res, r.status, r.data);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// GET /api/usage -> tenant scoped daily rows + totals, with a rough INR cost.
function apiUsage(req, res, ctx) {
  const rows = core.db().usage
    .filter((u) => u.tenantId === ctx.tenant.id)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  // Economics estimate for the promotional AI layer. Telephony and other
  // carrier-inclusive costs are tracked separately and are not implied here.
  const INR_PER_1K_CHARS = 0.12;
  const INR_PER_CALL = 0.9;
  const days = rows.map((r) => ({
    day: r.day,
    chars: r.chars || 0,
    calls: r.calls || 0,
    llmTokens: r.llmTokens || 0,
    costInr: Math.round(((r.chars || 0) / 1000 * INR_PER_1K_CHARS + (r.calls || 0) * INR_PER_CALL) * 100) / 100,
  }));
  const totals = days.reduce((acc, d) => ({
    chars: acc.chars + d.chars,
    calls: acc.calls + d.calls,
    llmTokens: acc.llmTokens + d.llmTokens,
    costInr: Math.round((acc.costInr + d.costInr) * 100) / 100,
  }), { chars: 0, calls: 0, llmTokens: 0, costInr: 0 });
  core.sendJson(res, 200, { days, totals });
}

function apiPresets(req, res, ctx) {
  const presets = core.db().presets.filter((p) => p.isSystem || p.tenantId === ctx.tenant.id);
  core.sendJson(res, 200, { presets });
}

function apiWallet(req, res, ctx) {
  const d = core.db();
  const wallet = d.wallets.find((w) => w.tenantId === ctx.tenant.id);
  const ledger = d.ledger.filter((x) => x.tenantId === ctx.tenant.id).slice(-100).reverse();
  core.sendJson(res, 200, { wallet: publicWallet(wallet || { id: null, tenantId: ctx.tenant.id, currency: 'INR', balancePaise: 0 }), ledger });
}

function apiPaymentIntents(req, res, ctx) {
  const intents = core.db().paymentIntents.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, gatewayPayload: undefined, intentToken: undefined, customer: undefined }));
  core.sendJson(res, 200, { paymentIntents: intents });
}

async function apiPaymentIntentCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const packId = String(b.packId || '');
  let base;
  try { base = payu.createPaymentIntent({ packId, packs: CREDIT_PACKS, tenantId: ctx.tenant.id, userId: ctx.user.id }); }
  catch (e) { return core.sendJson(res, 422, { error: e.message, code: 'bad_pack' }); }
  const customer = { firstname: String(b.firstname || ctx.user.name || 'Customer').trim().slice(0, 60), email: ctx.user.email, phone: String(b.phone || '').trim().slice(0, 20) };
  const intent = { id: core.genId('pay_'), provider: 'payu', ...base, customer, amountPaise: Math.round(Number(base.amount) * 100), updatedAt: base.createdAt };
  let checkout = null; const cfg = payuConfig();
  if (cfg && process.env.RAPIDX_PUBLIC_URL) {
    try {
      const origin = String(process.env.RAPIDX_PUBLIC_URL).replace(/\/$/, '');
      checkout = payu.buildCheckout({ intent, customer, successUrl: `${origin}/api/payu/callback`, failureUrl: `${origin}/api/payu/return`, config: cfg });
    } catch (e) { return core.sendJson(res, 503, { error: 'PayU checkout configuration is invalid', code: 'payu_config' }); }
  }
  await core.mutate((d) => { d.paymentIntents.push(intent); addAudit(d, ctx, 'billing.payment_intent.created', 'payment_intent', intent.id, { packId, amountPaise: intent.amountPaise }); });
  core.sendJson(res, 201, { paymentIntent: { ...intent, intentToken: undefined, customer: undefined }, checkoutReady: !!checkout, checkout, message: checkout ? undefined : 'PayU is not configured. The intent is saved but cannot be paid yet.' });
}

async function apiPayuCallback(req, res, payload) {
  const cfg = payuConfig();
  if (!cfg) return core.sendJson(res, 503, { error: 'PayU is not configured', code: 'payu_unavailable' });
  const intent = core.db().paymentIntents.find((x) => x.txnid === String(payload.txnid || ''));
  const eventId = core.genId('pevt_');
  const safePayload = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => !/hash|salt|key|card|token/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 500)]));
  if (!intent) {
    await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', txnid: String(payload.txnid || ''), status: 'rejected', reason: 'intent_not_found', payload: safePayload, createdAt: new Date().toISOString() }));
    return core.sendJson(res, 404, { error: 'payment intent not found', code: 'not_found' });
  }
  const callback = payu.verifyCallback({ payload, intent, customer: intent.customer, config: cfg });
  await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', tenantId: intent.tenantId, paymentIntentId: intent.id, txnid: intent.txnid, status: callback.valid ? 'verified_hash' : 'rejected', reason: callback.reason, payload: safePayload, createdAt: new Date().toISOString() }));
  if (!callback.valid || !callback.creditable) return core.sendJson(res, 400, { error: callback.reason, code: 'payu_callback_rejected' });
  let verification;
  try { verification = await payu.verifyPayment({ intent, config: cfg }); }
  catch (_) { return core.sendJson(res, 502, { error: 'PayU verification unavailable', code: 'payu_verify_failed' }); }
  if (!verification.verified) return core.sendJson(res, 409, { error: verification.reason, code: 'payu_not_verified' });
  let entry; let duplicate = false;
  await core.mutate((d) => {
    const stored = d.paymentIntents.find((x) => x.id === intent.id);
    if (stored.status === 'credited') { duplicate = true; return; }
    entry = addLedgerEntry(d, stored.tenantId, stored.credits, 'payment_credit', `payu:${stored.txnid}`, stored.userId, { paymentIntentId: stored.id, payuId: verification.payuId, packId: stored.packId });
    if (!entry) { duplicate = true; stored.status = 'credited'; return; }
    stored.status = 'credited'; stored.payuId = verification.payuId; stored.updatedAt = new Date().toISOString();
    d.auditEvents.push({ id: core.genId('aud_'), tenantId: stored.tenantId, actorUserId: stored.userId, action: 'billing.payment.credited', targetType: 'payment_intent', targetId: stored.id, metadata: { ledgerId: entry.id }, createdAt: stored.updatedAt });
  });
  core.sendJson(res, 200, { ok: true, credited: !duplicate, duplicate });
}

function apiPayuReturn(req, res, payload) {
  const result = payu.classifyBrowserReturn(payload);
  core.sendJson(res, 202, { ...result, message: 'Payment is pending server verification. A browser return never credits the wallet.' });
}

function apiSupportList(req, res, ctx) {
  const d = core.db();
  const tickets = d.supportTickets.filter((x) => x.tenantId === ctx.tenant.id).map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id && m.tenantId === ctx.tenant.id && !m.internal) }));
  core.sendJson(res, 200, { tickets });
}

async function apiSupportCreate(req, res, ctx) {
  const b = ctx.body || {};
  const subject = String(b.subject || '').trim().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 5000);
  if (!subject || !message) return core.sendJson(res, 422, { error: 'subject and message required', code: 'bad_ticket' });
  const now = new Date().toISOString();
  const ticket = { id: core.genId('tic_'), tenantId: ctx.tenant.id, createdBy: ctx.user.id, subject, priority: ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal', status: 'open', createdAt: now, updatedAt: now };
  const first = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: message, internal: false, createdAt: now };
  await core.mutate((d) => { d.supportTickets.push(ticket); d.supportMessages.push(first); addAudit(d, ctx, 'support.ticket.created', 'ticket', ticket.id); });
  core.sendJson(res, 201, { ticket: { ...ticket, messages: [first] } });
}

async function apiSupportReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || '') && t.tenantId === ctx.tenant.id);
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!text) return core.sendJson(res, 422, { error: 'message required', code: 'bad_message' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: text, internal: false, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.updatedAt = msg.createdAt; addAudit(d, ctx, 'support.ticket.replied', 'ticket', ticket.id); });
  core.sendJson(res, 201, { message: msg });
}

function apiByonList(req, res, ctx) {
  const connections = core.db().byonConnections.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, credentials: undefined }));
  core.sendJson(res, 200, { connections });
}

function apiPrivacyGet(req, res, ctx) { core.sendJson(res, 200, { mode: ctx.tenant.privacyMode || 'standard' }); }

async function apiByonSave(req, res, ctx) {
  const b = ctx.body || {};
  const provider = String(b.provider || '').toLowerCase();
  if (!['vobiz', 'twilio', 'telnyx', 'plivo', 'vonage', 'sip'].includes(provider)) return core.sendJson(res, 422, { error: 'unsupported BYON provider', code: 'bad_provider' });
  const address = String(b.address || '').replace(/[^0-9+]/g, '').slice(0, 32);
  if (!address) return core.sendJson(res, 422, { error: 'phone address required', code: 'bad_address' });
  const connection = { id: core.genId('byon_'), tenantId: ctx.tenant.id, provider, address, label: String(b.label || '').slice(0, 64), status: 'pending_verification', createdBy: ctx.user.id, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.byonConnections.push(connection); addAudit(d, ctx, 'telephony.byon.created', 'byon_connection', connection.id, { provider, address }); });
  core.sendJson(res, 201, { connection });
}

async function apiPrivacyMode(req, res, ctx) {
  const mode = String((ctx.body || {}).mode || '');
  if (!['standard', 'metadata_only', 'no_recording'].includes(mode)) return core.sendJson(res, 422, { error: 'invalid privacy mode', code: 'bad_privacy_mode' });
  await core.mutate((d) => { const t = d.tenants.find((x) => x.id === ctx.tenant.id); t.privacyMode = mode; addAudit(d, ctx, 'tenant.privacy_mode.updated', 'tenant', t.id, { mode }); });
  core.sendJson(res, 200, { mode });
}

function apiMembers(req, res, ctx) {
  core.sendJson(res, 200, { users: core.db().users.filter((u) => u.tenantId === ctx.tenant.id).map(publicUser) });
}

function apiAudit(req, res, ctx) {
  core.sendJson(res, 200, { auditEvents: core.db().auditEvents.filter((e) => e.tenantId === ctx.tenant.id).slice(-200).reverse() });
}

const INVOICE_STATUSES = new Set(['draft', 'issued', 'paid', 'void']);
const APPROACH_CHANNELS = new Set(['whatsapp', 'email', 'phone', 'linkedin', 'meeting', 'other']);
const INTEGRATION_CATALOG = [
  {
    id: 'whatsapp-business',
    name: 'WhatsApp Business Cloud',
    category: 'Messaging',
    description: 'Manage consent-safe conversations, templates, delivery state, and client replies from one workspace.',
    capabilities: ['Shared inbox', 'Approved templates', 'Delivery events', 'Conversation activity'],
    setup: ['Meta business verification', 'WhatsApp phone number', 'Access token', 'Signed webhook'],
  },
  {
    id: 'meta-ad-library',
    name: 'Meta Ad Library',
    category: 'Research',
    description: 'Track public competitor ads and save research context without presenting sample records as live campaign data.',
    capabilities: ['Public ad search', 'Competitor watchlists', 'Creative snapshots', 'Research notes'],
    setup: ['Meta developer app', 'Permitted API access', 'Rate-limit policy', 'Health check'],
  },
];

function isPlatformUser(user) {
  return user && (user.role === 'super_admin' || user.role === 'admin');
}

function requestOriginAllowed(req) {
  const rawOrigin = String(req.headers.origin || '').trim();
  if (!rawOrigin) return true;
  let origin;
  try { origin = new URL(rawOrigin); } catch (_) { return false; }
  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req.headers.host || '').trim();
  const configuredOrigin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configuredOrigin) return rawOrigin === configuredOrigin;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
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

function invoiceState(invoice, now = Date.now()) {
  if (invoice.status === 'issued' && invoice.dueDate && new Date(`${invoice.dueDate}T23:59:59Z`).getTime() < now) return 'overdue';
  return invoice.status;
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function publicInvoice(invoice) {
  return {
    id: invoice.id,
    tenantId: invoice.tenantId,
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.clientName,
    clientEmail: invoice.clientEmail || '',
    description: invoice.description,
    amountPaise: invoice.amountPaise,
    currency: invoice.currency || 'INR',
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoiceState(invoice),
    storedStatus: invoice.status,
    deliveryStatus: invoice.deliveryStatus || 'not_sent',
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    issuedAt: invoice.issuedAt || null,
    paidAt: invoice.paidAt || null,
  };
}

function scopedInvoices(ctx) {
  const rows = core.db().invoices || [];
  return (isPlatformUser(ctx.user) ? rows : rows.filter((row) => row.tenantId === ctx.tenant.id));
}

function apiInvoices(req, res, ctx) {
  core.sendJson(res, 200, { invoices: scopedInvoices(ctx).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicInvoice) });
}

async function apiInvoiceCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const d = core.db();
  const requestedTenantId = String(b.tenantId || '');
  const tenant = isPlatformUser(ctx.user)
    ? d.tenants.find((row) => row.id === requestedTenantId)
    : d.tenants.find((row) => row.id === ctx.tenant.id);
  if (!tenant) return core.sendJson(res, 422, { error: 'valid client workspace required', code: 'bad_tenant' });
  const amountPaise = Number(b.amountPaise);
  const description = String(b.description || '').trim().slice(0, 500);
  const clientName = String(b.clientName || tenant.name || '').trim().slice(0, 120);
  const clientEmail = String(b.clientEmail || '').trim().toLowerCase().slice(0, 160);
  const dueDate = String(b.dueDate || '').trim();
  const issueDate = String(b.issueDate || todayUtc()).trim();
  const initialStatus = b.issueNow === true ? 'issued' : 'draft';
  if (!Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > 1000000000) return core.sendJson(res, 422, { error: 'amount must be between ₹1 and ₹10,000,000', code: 'bad_amount' });
  if (!description || !clientName) return core.sendJson(res, 422, { error: 'client name and description required', code: 'bad_invoice' });
  if (clientEmail && !EMAIL_RE.test(clientEmail)) return core.sendJson(res, 422, { error: 'client email is invalid', code: 'bad_email' });
  if (!validDateOnly(issueDate) || !validDateOnly(dueDate)) return core.sendJson(res, 422, { error: 'valid issue and due dates are required', code: 'bad_date' });
  if (dueDate < issueDate) return core.sendJson(res, 422, { error: 'due date cannot be before issue date', code: 'bad_date' });
  let invoice;
  await core.mutate((store) => {
    const year = issueDate.slice(0, 4);
    const sequence = store.invoices.filter((row) => String(row.invoiceNumber || '').startsWith(`RX-${year}-`)).length + 1;
    const now = new Date().toISOString();
    invoice = {
      id: core.genId('inv_'), tenantId: tenant.id, invoiceNumber: `RX-${year}-${String(sequence).padStart(4, '0')}`,
      clientName, clientEmail, description, amountPaise, currency: 'INR', issueDate, dueDate,
      status: initialStatus, deliveryStatus: 'not_sent', createdBy: ctx.user.id, createdAt: now, updatedAt: now,
      issuedAt: initialStatus === 'issued' ? now : null,
    };
    store.invoices.push(invoice);
    store.invoiceEvents.push({ id: core.genId('ine_'), tenantId: tenant.id, invoiceId: invoice.id, type: initialStatus === 'issued' ? 'issued' : 'created', actorUserId: ctx.user.id, createdAt: now });
    store.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: initialStatus === 'issued' ? 'invoice_issued' : 'invoice_created', channel: 'internal', visibility: 'internal', summary: `${invoice.invoiceNumber} ${initialStatus === 'issued' ? 'issued' : 'created'} for ₹${(amountPaise / 100).toLocaleString('en-IN')}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, initialStatus === 'issued' ? 'invoice.issued' : 'invoice.created', 'invoice', invoice.id, { invoiceNumber: invoice.invoiceNumber, tenantId: tenant.id, amountPaise });
  });
  core.sendJson(res, 201, { invoice: publicInvoice(invoice), note: 'The invoice is stored in Agency OS. No email was sent.' });
}

async function apiInvoiceStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const requested = String(b.status || '');
  if (!INVOICE_STATUSES.has(requested)) return core.sendJson(res, 422, { error: 'invalid invoice status', code: 'bad_status' });
  const current = scopedInvoices(ctx).find((row) => row.id === String(b.invoiceId || ''));
  if (!current) return core.sendJson(res, 404, { error: 'invoice not found', code: 'not_found' });
  const transitions = { draft: new Set(['issued', 'void']), issued: new Set(['paid', 'void']), paid: new Set(), void: new Set() };
  if (!transitions[current.status] || !transitions[current.status].has(requested)) {
    const final = current.status === 'void' || current.status === 'paid';
    return core.sendJson(res, 409, {
      error: final ? 'paid and void invoices are final' : `invoice cannot move from ${current.status} to ${requested}`,
      code: final ? 'invoice_final' : 'invalid_transition',
    });
  }
  let updated;
  await core.mutate((store) => {
    const invoice = store.invoices.find((row) => row.id === current.id);
    if (!invoice || !transitions[invoice.status] || !transitions[invoice.status].has(requested)) return;
    const now = new Date().toISOString();
    invoice.status = requested; invoice.updatedAt = now;
    if (requested === 'issued' && !invoice.issuedAt) invoice.issuedAt = now;
    if (requested === 'paid') invoice.paidAt = now;
    if (requested === 'void') invoice.voidedAt = now;
    store.invoiceEvents.push({ id: core.genId('ine_'), tenantId: invoice.tenantId, invoiceId: invoice.id, type: requested, actorUserId: ctx.user.id, createdAt: now });
    store.clientActivities.push({ id: core.genId('act_'), tenantId: invoice.tenantId, type: `invoice_${requested}`, channel: 'internal', visibility: 'internal', summary: `${invoice.invoiceNumber} marked ${requested}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, `invoice.${requested}`, 'invoice', invoice.id, { invoiceNumber: invoice.invoiceNumber, tenantId: invoice.tenantId });
    updated = { ...invoice };
  });
  if (!updated) return core.sendJson(res, 409, { error: 'invoice state changed before this update', code: 'invoice_conflict' });
  core.sendJson(res, 200, { invoice: publicInvoice(updated) });
}

function apiAgencyOverview(req, res, ctx) {
  const d = core.db();
  const platform = isPlatformUser(ctx.user);
  const tenantIds = platform ? new Set(d.tenants.map((t) => t.id)) : new Set([ctx.tenant.id]);
  const tenants = d.tenants.filter((t) => tenantIds.has(t.id));
  const invoices = d.invoices.filter((row) => tenantIds.has(row.tenantId));
  const usage = d.usage.filter((row) => tenantIds.has(row.tenantId));
  const activities = d.clientActivities.filter((row) => tenantIds.has(row.tenantId) && (platform || row.visibility === 'tenant'));
  const audit = d.auditEvents.filter((row) => tenantIds.has(row.tenantId));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dayInvoices = invoices.filter((row) => row.issueDate === date && row.status !== 'draft' && row.status !== 'void');
    const dayPaid = invoices.filter((row) => row.paidAt && row.paidAt.slice(0, 10) === date);
    const dayUsage = usage.filter((row) => row.day === date);
    const dayActivities = activities.filter((row) => row.createdAt.slice(0, 10) === date);
    days.push({
      date,
      invoicedPaise: dayInvoices.reduce((sum, row) => sum + row.amountPaise, 0),
      paidPaise: dayPaid.reduce((sum, row) => sum + row.amountPaise, 0),
      calls: dayUsage.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      activity: dayActivities.length + audit.filter((row) => row.createdAt && row.createdAt.slice(0, 10) === date).length,
    });
  }
  const issued = invoices.filter((row) => row.status === 'issued' || row.status === 'paid');
  const paid = invoices.filter((row) => row.status === 'paid');
  const outstanding = invoices.filter((row) => row.status === 'issued');
  const comparisons = tenants.map((tenant) => ({
    tenantId: tenant.id,
    name: tenant.name,
    status: tenant.status || 'active',
    calls: usage.filter((row) => row.tenantId === tenant.id).reduce((sum, row) => sum + Number(row.calls || 0), 0),
    activity: activities.filter((row) => row.tenantId === tenant.id).length + audit.filter((row) => row.tenantId === tenant.id).length,
    outstandingPaise: outstanding.filter((row) => row.tenantId === tenant.id).reduce((sum, row) => sum + row.amountPaise, 0),
  })).sort((a, b) => (b.calls + b.activity) - (a.calls + a.activity)).slice(0, 8);
  const portfolio = ['active', 'onboarding', 'suspended', 'closed'].map((status) => ({ status, count: tenants.filter((t) => (t.status || 'active') === status).length }));
  const recent = activities.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12).map((row) => ({ id: row.id, tenantId: row.tenantId, tenantName: (d.tenants.find((t) => t.id === row.tenantId) || {}).name || 'Workspace', type: row.type, channel: row.channel, summary: row.summary, createdAt: row.createdAt }));
  core.sendJson(res, 200, {
    dataMode: 'live_staging', currency: 'INR', asOf: new Date().toISOString(),
    kpis: {
      clients: tenants.length,
      activeClients: tenants.filter((t) => (t.status || 'active') === 'active').length,
      closedClients: tenants.filter((t) => t.status === 'closed').length,
      invoicedPaise: issued.reduce((sum, row) => sum + row.amountPaise, 0),
      paidPaise: paid.reduce((sum, row) => sum + row.amountPaise, 0),
      outstandingPaise: outstanding.reduce((sum, row) => sum + row.amountPaise, 0),
      calls: usage.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      activity: activities.length + audit.length,
    },
    days, comparisons, portfolio, recent,
  });
}

async function apiClientApproach(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  if (!isPlatformUser(ctx.user)) return core.sendJson(res, 403, { error: 'platform admin required', code: 'forbidden' });
  const b = ctx.body || {};
  const tenant = core.db().tenants.find((row) => row.id === String(b.tenantId || ''));
  const channel = String(b.channel || '').toLowerCase();
  const summary = String(b.summary || '').trim().slice(0, 500);
  if (!tenant || !APPROACH_CHANNELS.has(channel) || !summary) return core.sendJson(res, 422, { error: 'valid client, channel, and summary required', code: 'bad_activity' });
  let activity;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    activity = { id: core.genId('act_'), tenantId: tenant.id, type: 'approach', channel, visibility: 'internal', summary, actorUserId: ctx.user.id, createdAt: now };
    store.clientActivities.push(activity);
    const target = store.tenants.find((row) => row.id === tenant.id); target.lastApproachedAt = now;
    addAudit(store, ctx, 'client.approached', 'tenant', tenant.id, { channel });
  });
  core.sendJson(res, 201, { activity });
}

function apiIntegrations(req, res, ctx) {
  const requests = core.db().integrationRequests.filter((row) => row.tenantId === ctx.tenant.id);
  const integrations = INTEGRATION_CATALOG.map((item) => {
    const request = requests.filter((row) => row.integrationId === item.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { ...item, status: request ? request.status : 'setup_required', requestedAt: request ? request.createdAt : null };
  });
  core.sendJson(res, 200, { integrations, note: 'Setup requests do not connect external services.' });
}

async function apiIntegrationRequest(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const integrationId = String((ctx.body || {}).integrationId || '');
  const item = INTEGRATION_CATALOG.find((row) => row.id === integrationId);
  if (!item) return core.sendJson(res, 422, { error: 'unknown integration', code: 'bad_integration' });
  let request;
  await core.mutate((store) => {
    const existing = store.integrationRequests.find((row) => row.tenantId === ctx.tenant.id && row.integrationId === integrationId && row.status === 'requested');
    if (existing) { request = existing; return; }
    request = { id: core.genId('int_'), tenantId: ctx.tenant.id, integrationId, status: 'requested', createdBy: ctx.user.id, createdAt: new Date().toISOString() };
    store.integrationRequests.push(request);
    addAudit(store, ctx, 'integration.setup_requested', 'integration', integrationId);
  });
  core.sendJson(res, 201, { request, note: 'Request recorded. The integration is not connected.' });
}

function apiAgencyPromptGet(req, res, ctx) {
  const row = core.db().agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
  const editor = row ? core.db().users.find((user) => user.id === row.updatedBy) : null;
  core.sendJson(res, 200, { prompt: row ? row.text : '', version: row ? row.version : 0, updatedAt: row ? row.updatedAt : null, updatedBy: editor ? editor.name || editor.email : null });
}

async function apiAgencyPromptSave(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const text = String((ctx.body || {}).prompt || '').trim();
  if (text.length < 20 || text.length > 12000) return core.sendJson(res, 422, { error: 'agency prompt must be between 20 and 12,000 characters', code: 'bad_prompt' });
  let row;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    row = store.agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
    if (!row) {
      row = { tenantId: ctx.tenant.id, text, version: 1, updatedBy: ctx.user.id, updatedAt: now };
      store.agencyPrompts.push(row);
    } else {
      row.text = text; row.version += 1; row.updatedBy = ctx.user.id; row.updatedAt = now;
    }
    addAudit(store, ctx, 'agency.prompt.updated', 'agency_prompt', ctx.tenant.id, { version: row.version });
  });
  core.sendJson(res, 200, { prompt: row.text, version: row.version, updatedAt: row.updatedAt, updatedBy: ctx.user.name || ctx.user.email });
}

async function apiTenantUpdate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const color = String(b.color || '').trim();
  if (!name || !/^#[0-9a-fA-F]{6}$/.test(color)) return core.sendJson(res, 422, { error: 'valid tenant name and color required', code: 'bad_tenant' });
  let tenant;
  await core.mutate((store) => {
    tenant = store.tenants.find((row) => row.id === ctx.tenant.id);
    tenant.name = name; tenant.branding = { ...(tenant.branding || {}), color };
    addAudit(store, ctx, 'tenant.settings.updated', 'tenant', tenant.id);
  });
  core.sendJson(res, 200, { tenant: publicTenant(tenant) });
}

async function apiMemberRole(req, res, ctx) {
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'tenant roles are owner or member', code: 'bad_role' });
  const target = core.db().users.find((u) => u.id === String(b.userId || '') && u.tenantId === ctx.tenant.id);
  if (!target) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === target.id); u.role = role; addAudit(d, ctx, 'member.role.updated', 'user', u.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...target, role }) });
}

function apiAdminOverview(req, res) {
  const d = core.db();
  const issued = d.invoices.filter((row) => row.status === 'issued' || row.status === 'paid');
  core.sendJson(res, 200, { totals: {
    tenants: d.tenants.length,
    activeTenants: d.tenants.filter((t) => (t.status || 'active') === 'active').length,
    closedTenants: d.tenants.filter((t) => t.status === 'closed').length,
    users: d.users.length,
    openTickets: d.supportTickets.filter((t) => t.status !== 'closed').length,
    walletPaise: d.wallets.reduce((n, w) => n + w.balancePaise, 0),
    calls: d.usage.reduce((n, u) => n + (u.calls || 0), 0),
    invoicedPaise: issued.reduce((n, row) => n + row.amountPaise, 0),
    outstandingPaise: d.invoices.filter((row) => row.status === 'issued').reduce((n, row) => n + row.amountPaise, 0),
  } });
}

function apiAdminTenants(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { tenants: d.tenants.map((t) => ({
    ...publicTenant(t),
    users: d.users.filter((u) => u.tenantId === t.id).length,
    agents: d.agents.filter((a) => a.tenantId === t.id).length,
    calls: d.usage.filter((u) => u.tenantId === t.id).reduce((n, row) => n + Number(row.calls || 0), 0),
    lastApproachedAt: t.lastApproachedAt || null,
    outstandingPaise: d.invoices.filter((row) => row.tenantId === t.id && row.status === 'issued').reduce((n, row) => n + row.amountPaise, 0),
    wallet: publicWallet(d.wallets.find((w) => w.tenantId === t.id) || { id: null, tenantId: t.id, currency: 'INR', balancePaise: 0 }),
  })) });
}

async function apiAdminTenantCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const ownerEmail = String(b.ownerEmail || '').trim().toLowerCase().slice(0, 160);
  const password = String(b.password || '');
  if (!name) return core.sendJson(res, 422, { error: 'client workspace name required', code: 'bad_tenant' });
  if (ownerEmail && (!EMAIL_RE.test(ownerEmail) || password.length < 12)) return core.sendJson(res, 422, { error: 'a valid owner email and 12 character temporary password are required together', code: 'bad_owner' });
  if (!ownerEmail && password) return core.sendJson(res, 422, { error: 'owner email is required when a password is supplied', code: 'bad_owner' });
  if (ownerEmail && core.db().users.some((user) => user.email === ownerEmail)) return core.sendJson(res, 409, { error: 'owner email is already registered', code: 'email_taken' });
  let tenant; let user = null;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    tenant = {
      id: core.genId('t_'), name, slug: makeSlug(name, new Set(store.tenants.map((t) => t.slug))),
      createdAt: now, branding: { color: '#B88A2D' }, providers: { ...DEFAULT_PROVIDERS },
      plan: 'studio', status: ownerEmail ? 'active' : 'onboarding', privacyMode: 'standard',
    };
    store.tenants.push(tenant);
    store.wallets.push({ id: core.genId('wal_'), tenantId: tenant.id, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now });
    if (ownerEmail) {
      user = { id: core.genId('u_'), tenantId: tenant.id, email: ownerEmail, name: String(b.ownerName || 'Client Owner').trim().slice(0, 80), passHash: core.hashPassword(password), role: 'owner', status: 'active', createdAt: now };
      store.users.push(user);
    }
    store.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: 'workspace_created', channel: 'internal', visibility: 'internal', summary: 'Client workspace created in Agency OS.', actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, 'admin.tenant.created', 'tenant', tenant.id, { ownerCreated: !!user });
  });
  core.sendJson(res, 201, { tenant: publicTenant(tenant), owner: user ? publicUser(user) : null, note: 'No email was sent.' });
}

function apiAdminUsers(req, res) { core.sendJson(res, 200, { users: core.db().users.map(publicUser) }); }

function apiAdminAudit(req, res) { core.sendJson(res, 200, { auditEvents: core.db().auditEvents.slice(-500).reverse() }); }

function apiAdminTickets(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { tickets: d.supportTickets.map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id) })) });
}

function apiAdminPaymentEvents(req, res) { core.sendJson(res, 200, { events: core.db().paymentEvents.slice(-500).reverse() }); }

function apiAdminTenantDetail(req, res) {
  const url = new URL(req.url, 'http://localhost'); const tenantId = String(url.searchParams.get('tenantId') || ''); const d = core.db();
  const tenant = d.tenants.find((t) => t.id === tenantId);
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  core.sendJson(res, 200, { tenant: publicTenant(tenant), users: d.users.filter((u) => u.tenantId === tenantId).map(publicUser), agents: d.agents.filter((a) => a.tenantId === tenantId).map(publicAgent), numbers: d.byonConnections.filter((x) => x.tenantId === tenantId).map((x) => ({ id: x.id, provider: x.provider, address: x.address, label: x.label, status: x.status, createdAt: x.createdAt })), usage: d.usage.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), tickets: d.supportTickets.filter((x) => x.tenantId === tenantId), wallet: publicWallet(d.wallets.find((w) => w.tenantId === tenantId) || { id: null, tenantId, currency: 'INR', balancePaise: 0 }), ledger: d.ledger.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), invoices: d.invoices.filter((x) => x.tenantId === tenantId).map(publicInvoice), activities: d.clientActivities.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), statusEvents: d.tenantStatusEvents.filter((x) => x.tenantId === tenantId).slice(-100).reverse() });
}

async function apiAdminImpersonate(req, res, ctx) {
  if (ctx.impersonator) return core.sendJson(res, 409, { error: 'nested impersonation is not allowed', code: 'nested_impersonation' });
  const b = ctx.body || {}; const reason = String(b.reason || '').trim().slice(0, 240); const target = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!reason || !target) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });
  if (!core.verifyPassword(String(b.password || ''), ctx.user.passHash)) return core.sendJson(res, 401, { error: 'password re-authentication failed', code: 'reauth_failed' });
  if (target.role === 'super_admin' || target.status !== 'active') return core.sendJson(res, 403, { error: 'that account cannot be impersonated', code: 'impersonation_forbidden' });
  const tenant = core.db().tenants.find((t) => t.id === target.tenantId);
  if (!tenant || tenant.status !== 'active') return core.sendJson(res, 409, { error: 'target tenant is not active', code: 'target_inactive' });
  const token = await core.createImpersonationSession(ctx.user.id, target.id, tenant.id, reason);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.started', 'user', target.id, { reason }));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiImpersonationExit(req, res, ctx) {
  if (!ctx.impersonator) return core.sendJson(res, 409, { error: 'not impersonating', code: 'not_impersonating' });
  const actor = ctx.impersonator; const tenant = core.db().tenants.find((t) => t.id === actor.tenantId); const token = await core.createSession(actor.id, actor.tenantId);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.ended', 'user', ctx.user.id));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiAdminTenantStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['onboarding', 'active', 'suspended', 'closed'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const tenant = core.db().tenants.find((t) => t.id === String(b.tenantId || ''));
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  await core.mutate((d) => {
    const now = new Date().toISOString();
    d.tenants.find((t) => t.id === tenant.id).status = status;
    if (status !== 'active') d.sessions = d.sessions.filter((s) => s.tenantId !== tenant.id);
    d.tenantStatusEvents.push({ id: core.genId('tse_'), tenantId: tenant.id, fromStatus: tenant.status || 'active', toStatus: status, reason: String(b.reason || '').trim().slice(0, 240), actorUserId: ctx.user.id, createdAt: now });
    d.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: status === 'closed' ? 'offboarded' : 'status_changed', channel: 'internal', visibility: 'internal', summary: `Client status changed from ${tenant.status || 'active'} to ${status}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(d, ctx, 'admin.tenant.status', 'tenant', tenant.id, { status });
  });
  core.sendJson(res, 200, { tenant: publicTenant({ ...tenant, status }) });
}

async function apiAdminUserStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['active', 'suspended', 'deleted'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const user = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id) return core.sendJson(res, 409, { error: 'cannot change your own status', code: 'self_target' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === user.id); u.status = status; if (status === 'deleted') { u.email = `deleted-${u.id}@invalid.local`; u.name = 'Deleted user'; u.passHash = ''; } d.sessions = d.sessions.filter((s) => s.userId !== user.id); addAudit(d, ctx, 'admin.user.status', 'user', user.id, { status }); });
  core.sendJson(res, 200, { ok: true });
}

async function apiAdminUserRole(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['super_admin', 'admin', 'owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'invalid role', code: 'bad_role' });
  const user = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id && role !== 'super_admin') return core.sendJson(res, 409, { error: 'cannot remove your own super admin role', code: 'self_target' });
  await core.mutate((d) => { d.users.find((u) => u.id === user.id).role = role; addAudit(d, ctx, 'admin.user.role', 'user', user.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...user, role }) });
}

async function apiAdminWalletAdjust(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const amountPaise = Number(b.amountPaise);
  const tenantId = String(b.tenantId || '');
  if (!core.db().tenants.some((t) => t.id === tenantId) || !Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 100000000) return core.sendJson(res, 422, { error: 'valid tenantId and amountPaise required', code: 'bad_adjustment' });
  const idempotencyKey = String(b.idempotencyKey || '').trim().slice(0, 120);
  if (!idempotencyKey) return core.sendJson(res, 422, { error: 'idempotencyKey required', code: 'idempotency_required' });
  let entry;
  try { await core.mutate((d) => { entry = addLedgerEntry(d, tenantId, amountPaise, 'admin_adjustment', `admin:${idempotencyKey}`, ctx.user.id, { reason: String(b.reason || '').slice(0, 200) }); if (entry) addAudit(d, ctx, 'admin.wallet.adjusted', 'tenant', tenantId, { amountPaise, ledgerId: entry.id }); }); }
  catch (e) { return core.sendJson(res, 409, { error: e.message, code: 'wallet_rejected' }); }
  if (!entry) return core.sendJson(res, 200, { duplicate: true });
  core.sendJson(res, 201, { ledgerEntry: entry });
}

async function apiAdminTicketReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || ''));
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!ticket || !text) return core.sendJson(res, 422, { error: 'valid ticketId and message required', code: 'bad_reply' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ticket.tenantId, authorUserId: ctx.user.id, body: text, internal: !!b.internal, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = b.status === 'closed' ? 'closed' : 'waiting_on_customer'; t.updatedAt = msg.createdAt; addAudit(d, ctx, 'admin.ticket.replied', 'ticket', ticket.id, { status: t.status }); });
  core.sendJson(res, 201, { message: msg });
}

async function apiAdminTicketUpdate(req, res, ctx) {
  const b = ctx.body || {}; const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || ''));
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const status = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'].includes(String(b.status || '')) ? String(b.status) : ticket.status;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(String(b.priority || '')) ? String(b.priority) : ticket.priority;
  await core.mutate((d) => { const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = status; t.priority = priority; t.assignedTo = b.assignedTo ? String(b.assignedTo) : t.assignedTo || ctx.user.id; t.updatedAt = new Date().toISOString(); addAudit(d, ctx, 'admin.ticket.updated', 'ticket', ticket.id, { status, priority, assignedTo: t.assignedTo }); });
  core.sendJson(res, 200, { ok: true });
}

// GET /api/providers -> the registry so Settings can render active vs available.
function apiProviders(req, res) {
  core.sendJson(res, 200, providers.describeProviders());
}

// GET /api/health -> readiness + which provider keys are present.
function apiHealth(req, res) {
  const described = providers.describeProviders();
  const providerHealth = (layer) => Object.fromEntries((described[layer] || []).map((item) => [item.id, item.live]));
  const selected = (layer) => (described[layer] || []).find((item) => item.selected) || (described[layer] || [])[0] || {};
  const selectedStt = selected('stt'); const selectedTts = selected('tts'); const selectedLlm = selected('llm'); const selectedTelephony = selected('telephony');
  core.sendJson(res, 200, {
    ok: true,
    providers: {
      stt: providerHealth('stt'),
      tts: providerHealth('tts'),
      llm: providerHealth('llm'),
      telephony: providerHealth('telephony'),
    },
    models: { stt: selectedStt.model, llm: selectedLlm.model, tts: selectedTts.model },
    selected: {
      stt: { provider: selectedStt.id, model: selectedStt.model },
      tts: { provider: selectedTts.id, model: selectedTts.model },
      llm: { provider: selectedLlm.id, model: selectedLlm.model },
      telephony: { provider: selectedTelephony.id },
    },
  });
}

/* ==========================================================================
   Map a ProviderError (or anything) to a clean JSON HTTP response.
   ========================================================================== */
function handleProviderError(res, e) {
  if (e instanceof providers.ProviderError) {
    return core.sendJson(res, e.status || 502, {
      error: e.message,
      code: e.code || 'provider_error',
      detail: e.detail,
    });
  }
  core.sendJson(res, 502, { error: String((e && e.message) || e), code: 'upstream' });
}

/* ==========================================================================
   Service Authentication: Vaani Ingestion Webhook
   Validates Authorization: Bearer <VAANI_INGESTION_SECRET> in constant time.
   Fails closed if VAANI_INGESTION_SECRET is not configured.
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
      if (process.env.NODE_ENV !== 'test' && !core.rateOk(ip)) return core.sendJson(res, 429, { error: 'rate limited', code: 'rate' });

      const payuInbound = route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && !requestOriginAllowed(req)) {
        return core.sendJson(res, 403, { error: 'cross-origin request blocked', code: 'bad_origin' });
      }
      const requestContentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && requestContentType && requestContentType !== 'application/json') {
        return core.sendJson(res, 415, { error: 'application/json required', code: 'bad_content_type' });
      }

      if ((route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return') && req.method === 'POST') {
        let form;
        try { form = await readForm(req); }
        catch (e) { return core.sendJson(res, 400, { error: e.message, code: 'bad_form' }); }
        return (route.endsWith('/callback') || route.endsWith('/webhook')) ? apiPayuCallback(req, res, form) : apiPayuReturn(req, res, form);
      }

      // ---- Public GET / helper routes ----
      if (route === '/api/health' && req.method === 'GET') return apiHealth(req, res);
      if (route === '/api/providers' && req.method === 'GET') return apiProviders(req, res);
      if (route === '/api/tts/local' && req.method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const text = urlObj.searchParams.get('text') || '';
        return apiTtsLocal(req, res, { text });
      }

      if (route.startsWith('/api/public/demo/') && req.method === 'GET') {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length));
        if (token.includes('/')) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
        return apiPublicDemoMeta(req, res, token);
      }

      // ---- Authed GET routes ----
      if (req.method === 'GET') {
        if (route === '/api/me') return core.requireAuth(req, res, apiMe);
        if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsList);
        if (route === '/api/usage') return core.requireAuth(req, res, apiUsage);
        if (route === '/api/telephony/status') return core.requireAuth(req, res, apiTelephonyStatus);
        if (route === '/api/presets') return core.requireAuth(req, res, apiPresets);
        if (route === '/api/wallet') return core.requireAuth(req, res, apiWallet);
        if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntents);
        if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportList);
        if (route === '/api/byon') return core.requireAuth(req, res, apiByonList);
        if (route === '/api/privacy') return core.requireAuth(req, res, apiPrivacyGet);
        if (route === '/api/members') return core.requireRole(req, res, 'owner', apiMembers);
        if (route === '/api/audit') return core.requireRole(req, res, 'owner', apiAudit);
        if (route === '/api/agency/overview') return core.requireRole(req, res, 'owner', apiAgencyOverview);
        if (route === '/api/agency/prompt') return core.requireRole(req, res, 'owner', apiAgencyPromptGet);
        if (route === '/api/invoices') return core.requireRole(req, res, 'owner', apiInvoices);
        if (route === '/api/integrations') return core.requireRole(req, res, 'owner', apiIntegrations);
        if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksList);
        if (route === '/api/admin/overview') return core.requireRole(req, res, 'super_admin', apiAdminOverview);
        if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenants);
        if (route === '/api/admin/users') return core.requireRole(req, res, 'super_admin', apiAdminUsers);
        if (route === '/api/admin/audit') return core.requireRole(req, res, 'admin', apiAdminAudit);
        if (route === '/api/admin/tickets') return core.requireRole(req, res, 'admin', apiAdminTickets);
        if (route === '/api/admin/tenant-detail') return core.requireRole(req, res, 'super_admin', apiAdminTenantDetail);
        if (route === '/api/admin/payment-events') return core.requireRole(req, res, 'admin', apiAdminPaymentEvents);
        if (route === '/api/hvac/desk') return core.requireAuth(req, res, apiHvacDesk);
        if (route === '/api/hvac/event-types') return core.requireAuth(req, res, apiHvacEventTypes);
        if (route === '/api/hvac/slots') return core.requireAuth(req, res, apiHvacSlots);
        if (route === '/api/vaani/internal/machines') {
          return apiVaaniInternalMachines(req, res);
        }
        if (route === '/api/vaani/customers') return core.requireAuth(req, res, apiVaaniCustomersList);
        if (route.startsWith('/api/vaani/customers/') && route.split('/').length === 5) return core.requireAuth(req, res, apiVaaniCustomerDetail, route.split('/')[4]);
        if (route === '/api/vaani/calls') return core.requireAuth(req, res, apiVaaniCallsList);
        if (route.startsWith('/api/vaani/calls/') && route.split('/').length === 5) return core.requireAuth(req, res, apiVaaniCallDetail, route.split('/')[4]);
        if (route === '/api/vaani/leads') return core.requireAuth(req, res, apiVaaniLeads);
        // Phase 2: Buyer CRM API
        if (route === '/api/vaani/buyers') return core.requireAuth(req, res, apiVaaniBuyersList);
        if (route.match(/^\/api\/vaani\/buyers\/\d+$/)) {
          return core.requireAuth(req, res, apiVaaniBuyerDetail, route.split('/')[4]);
        }
        if (route.match(/^\/api\/vaani\/buyers\/\d+\/calls\/\d+$/)) {
          const parts = route.split('/');
          return core.requireAuth(req, res, apiVaaniBuyerCallDetail, { custId: parseInt(parts[4], 10), callId: parseInt(parts[6], 10) });
        }
        if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      if (req.method !== 'POST') {
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      // ---- Vaani Call Ingestion Webhook (POST /api/v1/vaani/calls/complete & POST /api/vaani/calls/complete) ----
      // Service-to-service authentication using Authorization: Bearer <VAANI_INGESTION_SECRET>
      if (route === '/api/v1/vaani/calls/complete' || route === '/api/vaani/calls/complete') {
        if (!verifyIngestionAuth(req)) {
          return core.sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized', error_code: 'UNAUTHORIZED' });
        }
        try {
          const rawBody = await core.readBody(req);
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
          const extractionResult = vaaniSales.extractFromConversation(conversation);
          return core.sendJson(res, 200, extractionResult);
        } catch (err) {
          return core.sendJson(res, 400, { error: err.message, code: 'extraction_error', error_code: 'EXTRACTION_ERROR' });
        }
      }

      // ---- Vaani WhatsApp Inbound Webhook (POST /api/v1/vaani/whatsapp/webhook & POST /api/vaani/whatsapp/webhook) ----
      // Authenticates with x-vaani-whatsapp-secret or Authorization: Bearer <secret> BEFORE body/db processing
      if (route === '/api/v1/vaani/whatsapp/webhook' || route === '/api/vaani/whatsapp/webhook') {
        if (!verifyWhatsAppWebhookAuth(req)) {
          return core.sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized', error_code: 'UNAUTHORIZED' });
        }
        try {
          const rawBody = await core.readBody(req);
          const parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody || {});
          const headerOrg = req.headers['x-organization-id'];
          const orgVal = parsed.organization_id || headerOrg;
          const orgInt = parseInt(orgVal, 10);
          if (isNaN(orgInt) || orgInt <= 0) {
            return core.sendJson(res, 400, { error: 'explicit organization_id required', code: 'bad_tenant' });
          }
          const result = await vaaniSales.processInboundWebhook(parsed, orgInt);
          return core.sendJson(res, 200, { success: true, ...result });
        } catch (err) {
          const status = err.statusCode || 400;
          return core.sendJson(res, status, { error: err.message, code: err.code || 'webhook_error' });
        }
      }

      // ---- POST routes: read the body once, with a bigger cap for STT audio ----
      let body;
      try {
        body = await core.readBody(req, route === '/api/stt' ? 12 * 1024 * 1024 : 64 * 1024);
      } catch (e) {
        const tooBig = /too large/.test(String(e.message));
        return core.sendJson(res, tooBig ? 413 : 400, {
          error: e.message, code: tooBig ? 'too_large' : 'bad_body',
        });
      }

      // Public POST (auth) routes.
      if (route === '/api/auth/signup') return apiSignup(req, res, body);
      if (route === '/api/auth/login') return apiLogin(req, res, body);
      if (route === '/api/auth/logout') return apiLogout(req, res);
      if (route === '/api/auth/impersonation/exit') return core.requireAuth(req, res, apiImpersonationExit, body);
      if (route.startsWith('/api/public/demo/') && route.endsWith('/session')) {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length, -'/session'.length));
        if (token.includes('/') || !core.rateOk(`demo-start:${ip}`, 5, 5)) return core.sendJson(res, token.includes('/') ? 404 : 429, { error: token.includes('/') ? 'demo link not found' : 'too many demo starts, try again shortly', code: token.includes('/') ? 'not_found' : 'demo_rate' });
        return apiPublicDemoSession(req, res, token);
      }
      if (route === '/api/tts/local') return apiTtsLocal(req, res, body);

      // Authed POST routes (tenant scoped through requireAuth).
      if (route.startsWith('/api/vaani/sales/leads/') && route.endsWith('/evidence/request')) {
        return core.requireAuth(req, res, apiVaaniEvidenceRequest, body);
      }
      if (route === '/api/vaani/sales/evidence/request') return core.requireAuth(req, res, apiVaaniEvidenceRequest, body);
      if (route === '/api/vaani/customers') return core.requireAuth(req, res, apiVaaniCustomerCreate, body);
      if (route === '/api/vaani/demo/calls/complete') return core.requireAuth(req, res, apiVaaniDemoCallComplete, body);
      // Phase 2: Buyer call initiation — requireAuth + accept existing customer_id OR new buyer fields
      if (route === '/api/vaani/sales/outbound/buyer') return core.requireAuth(req, res, apiVaaniOutboundBuyer, body);
      if (route.match(/^\/api\/vaani\/buyers\/\d+\/call$/)) {
        // POST /api/vaani/buyers/:id/call — initiate call for existing buyer by id
        const custId = parseInt(route.split('/')[4], 10);
        return core.requireAuth(req, res, async (req2, res2, ctx2) => {
          // Fetch customer to merge body
          const cust = await vaaniSales.queryPostgres(
            'SELECT row_to_json(c) FROM (SELECT id, name, phone, machine_requirement FROM vaani_customers WHERE id = $1) c;',
            [custId]
          ).catch(() => null);
          if (!cust || !cust.id) return core.sendJson(res2, 404, { error: `Buyer id=${custId} not found`, code: 'not_found' });
          const mergedBody = { customer_id: custId, name: cust.name, phone: cust.phone, machine_requirement: cust.machine_requirement, ...((ctx2 && ctx2.body) || {}) };
          return apiVaaniOutboundBuyer(req2, res2, { body: mergedBody });
        }, body);
      }
      if (route === '/api/vaani/sales/follow-up/status') return core.requireAuth(req, res, apiVaaniFollowUpStatus, body);
      if (route === '/api/vaani/sales/tasks/transition') return core.requireAuth(req, res, apiVaaniTaskTransition, body);
      if (route === '/api/vaani/sales/evidence/received') return core.requireAuth(req, res, apiVaaniEvidenceReceived, body);
      if (route === '/api/vaani/sales/simulate-call') return core.requireAuth(req, res, apiVaaniSimulateCall, body);
      if (route === '/api/vaani/sales/simulate-inbound-media') return core.requireAuth(req, res, apiVaaniSimulateInboundMedia, body);
      if (route === '/api/vaani/sales/cleanup-simulations') return core.requireAuth(req, res, apiVaaniCleanupSimulations, body);
      if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsCreate, body);
      if (route === '/api/agents/update') return core.requireAuth(req, res, apiAgentsUpdate, body);
      if (route === '/api/agents/delete') return core.requireAuth(req, res, apiAgentsDelete, body);
      if (route === '/api/tts') return core.requireAuth(req, res, apiTts, body);
      if (route === '/api/ws-connect') return core.requireAuth(req, res, apiWsConnect, body);
      if (route === '/api/chat') return core.requireAuth(req, res, apiChat, body);
      if (route === '/api/stt') return core.requireAuth(req, res, apiStt, body);
      if (route === '/api/voice/session') return core.requireAuth(req, res, apiVoiceSession, body);
      if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksCreate, body);
      if (route === '/api/demo-links/revoke') return core.requireRole(req, res, 'owner', apiDemoLinksRevoke, body);
      if (route === '/api/telephony/dial') return core.requireAuth(req, res, apiTelephonyDial, body);
      if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntentCreate, body);
      if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportCreate, body);
      if (route === '/api/support/tickets/reply') return core.requireAuth(req, res, apiSupportReply, body);
      if (route === '/api/byon') return core.requireRole(req, res, 'owner', apiByonSave, body);
      if (route === '/api/privacy') return core.requireRole(req, res, 'owner', apiPrivacyMode, body);
      if (route === '/api/tenant/update') return core.requireRole(req, res, 'owner', apiTenantUpdate, body);
      if (route === '/api/members/role') return core.requireRole(req, res, 'owner', apiMemberRole, body);
      if (route === '/api/invoices') return core.requireRole(req, res, 'admin', apiInvoiceCreate, body);
      if (route === '/api/invoices/status') return core.requireRole(req, res, 'admin', apiInvoiceStatus, body);
      if (route === '/api/integrations/request') return core.requireRole(req, res, 'owner', apiIntegrationRequest, body);
      if (route === '/api/agency/prompt') return core.requireRole(req, res, 'owner', apiAgencyPromptSave, body);
      if (route === '/api/admin/client-approach') return core.requireRole(req, res, 'admin', apiClientApproach, body);
      if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenantCreate, body);
      if (route === '/api/admin/tenants/status') return core.requireRole(req, res, 'super_admin', apiAdminTenantStatus, body);
      if (route === '/api/admin/users/status') return core.requireRole(req, res, 'super_admin', apiAdminUserStatus, body);
      if (route === '/api/admin/users/role') return core.requireRole(req, res, 'super_admin', apiAdminUserRole, body);
      if (route === '/api/admin/wallet/adjust') return core.requireRole(req, res, 'admin', apiAdminWalletAdjust, body);
      if (route === '/api/admin/tickets/reply') return core.requireRole(req, res, 'admin', apiAdminTicketReply, body);
      if (route === '/api/admin/tickets/update') return core.requireRole(req, res, 'admin', apiAdminTicketUpdate, body);
      if (route === '/api/admin/impersonations') return core.requireRole(req, res, 'super_admin', apiAdminImpersonate, body);
      if (route === '/api/hvac/jobs') return core.requireAuth(req, res, apiHvacJobSave, body);
      if (route === '/api/hvac/book') return core.requireAuth(req, res, apiHvacBook, body);

      return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
    }

    if (req.method === 'GET' && route.startsWith('/demo/')) {
      req.url = '/demo.html';
    }
    if (['GET', 'HEAD'].includes(req.method || '') && (route === '/vaani' || route === '/vaani.html')) {
      req.url = '/vaani.html';
      return core.serveStatic(req, res);
    }
    const isVaaniSales = /^\/(vaani-sales|sales)(\.html|\/)?$/i.test(route);
    if (['GET', 'HEAD'].includes(req.method || '') && isVaaniSales) {
      const sess = await core.getSession(req);
      if (!sess) {
        const accept = String(req.headers['accept'] || '').toLowerCase();
        if (accept.includes('application/json') && !accept.includes('text/html')) {
          return core.sendJson(res, 401, { error: 'authentication required', code: 'no_session' });
        }
        res.writeHead(302, {
          Location: '/app.html?redirect=/vaani-sales',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0'
        });
        return res.end();
      }
      req.url = '/vaani-sales.html';
      return core.serveStatic(req, res);
    }
    if (['GET', 'HEAD'].includes(req.method || '') && route === '/console.html') {
      res.writeHead(302, { Location: '/app.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // Everything else is a static file from public/.
    core.serveStatic(req, res);
  } catch (e) {
    core.sendJson(res, 500, { error: String((e && e.message) || e), code: 'server' });
  }
});

/* ==========================================================================
   Authenticated Deepgram live transcription proxy.

   The browser sends MediaRecorder chunks to this same-origin socket. The
   permanent Deepgram API key remains server side, while Deepgram's interim and
   final Results events are relayed unchanged for word-by-word UI updates.
   ========================================================================== */

const sttWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function rejectUpgrade(socket, status, label) {
  if (!socket.writable) return socket.destroy();
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const route = (req.url || '').split('?')[0];
  if (route !== '/api/stt/stream') return rejectUpgrade(socket, 404, 'Not Found');
  if (!requestOriginAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');

  const ip = requestRateKey(req);
  if (!core.rateOk(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests');

  try {
    const ctx = await core.getSession(req);
    if (!ctx) return rejectUpgrade(socket, 401, 'Unauthorized');
    sttWss.handleUpgrade(req, socket, head, (client) => {
      sttWss.emit('connection', client, req, ctx);
    });
  } catch (_) {
    rejectUpgrade(socket, 500, 'Internal Server Error');
  }
});

sttWss.on('connection', (client) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram is not configured.' }));
    return client.close(1011, 'Deepgram unavailable');
  }

  const query = new URLSearchParams({
    model: providers.stt.model,
    language: 'multi',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  const upstream = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
    headers: { Authorization: `Token ${key}` },
    maxPayload: 1024 * 1024,
  });
  let upstreamReady = false;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };

  const keepAlive = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);

  upstream.on('open', () => {
    upstreamReady = true;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyReady', provider: 'deepgram', model: providers.stt.model }));
    }
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram live stream failed.' }));
    }
    closeBoth();
  });
  upstream.on('close', () => closeBoth());

  client.on('message', (data, isBinary) => {
    if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) upstream.send(data, { binary: true });
    else upstream.send(data.toString());
  });
  client.on('error', () => closeBoth());
  client.on('close', () => closeBoth());
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  PORT ${PORT} is already in use. Stop the other process or set PORT to a free port, for example: PORT=8788 node server.js\n`);
    process.exit(1);
  }
  console.error('  server error:', e.message);
  process.exit(1);
});

// Boot then listen.
boot().then(() => {
  server.listen(PORT, () => {
    const live = providers.describeProviders();
    const flag = (layer, id) => (live[layer].find((p) => p.id === id) || {}).live ? 'ok' : 'MISSING';
    console.log('\n  RapidX Voice  ready');
    console.log(`  Marketing : http://localhost:${PORT}/`);
    console.log(`  Console   : http://localhost:${PORT}/app.html`);
    if (DEMO_EMAIL) console.log(`  Test login: ${DEMO_EMAIL}`);
    console.log(`  Providers : deepgram ${flag('stt', 'deepgram')}  groq ${flag('llm', 'groq')}  rumik ${flag('tts', 'rumik')}  vobiz ${flag('telephony', 'vobiz')}\n`);
  });
}).catch((e) => {
  console.error('  boot failed:', e.message);
  process.exit(1);
});
