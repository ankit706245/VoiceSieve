/**
 * Vaani. Core runtime primitives. ZERO npm dependencies.
 *
 * One file, pure Node. It gives the rest of the server everything that is not
 * provider specific:
 *   - a tiny .env loader (no dotenv)
 *   - http helpers (send, sendJson, readBody, httpsPost, httpsGet)
 *   - auth: Supabase bearer-token verification, getSession + requireAuth
 *     (organization scoped)
 *   - a per-IP token-bucket rate limiter
 *   - a static file server with MIME mapping and a path-traversal guard
 *   - htmlEscape for safe DOM injection
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');   // referenced for typing clarity, server.js owns createServer
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Project root is one level up from lib/.
const ROOT = path.join(__dirname, '..');

/* ==========================================================================
   1. .env loader (no dotenv dependency)
   Reads ROOT/.env once. Existing process.env wins, so real shell vars override.
   ========================================================================== */
function loadEnv() {
  const candidates = [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')];
  for (const envPath of candidates) {
    try {
      const txt = fs.readFileSync(envPath, 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch (_) {
      // .env is optional when the vars are already in the environment.
    }
  }
}

/* ==========================================================================
   2. http helpers
   ========================================================================== */

// Security headers applied to every response.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self), payment=()',
  'Content-Security-Policy-Report-Only': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self' https://secure.payu.in https://test.payu.in",
};

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });
}

/**
 * Read and JSON-parse a request body with a hard size cap. Resolves {} for an
 * empty body. Rejects on oversize payloads or invalid JSON so callers can map
 * to a clean 4xx instead of crashing.
 */
function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > cap) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// Generic HTTPS POST. Resolves { status, headers, buffer }. Times out at 60s.
function httpsPost(host, pathname, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'POST', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('upstream timeout')));
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

// Generic HTTPS GET. Resolves { status, headers, buffer }. Times out at 20s.
function httpsGet(host, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path: pathname, method: 'GET', headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        buffer: Buffer.concat(parts),
      }));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('upstream timeout')));
    r.end();
  });
}

/* ==========================================================================
   3. htmlEscape (XSS guard for any user string injected into the DOM)
   ========================================================================== */
function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ==========================================================================
   4. Auth: Supabase bearer tokens, requireAuth
   ========================================================================== */

const COOKIE_NAME = 'braivex_token';

// HttpOnly cookie carrying the Supabase access token so page navigation and
// refreshes survive without exposing the token to JavaScript.
function authCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=3600; SameSite=Lax${secure}`;
}

// Build the Set-Cookie header value that clears the session.
function clearCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function parseCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/**
 * Resolve the request's auth context via Supabase bearer token.
 *
 * Extracts `Authorization: Bearer <token>`, verifies it against Supabase Auth,
 * and resolves the organization mapping from public.vaani_user_profiles.
 * Returns null when there is no valid session.
 *
 * The returned ctx shape is { user, tenant, session, supabaseUserId,
 * organization_id, role }. `session` is a compatibility shim (Supabase tokens
 * are self-expiring; we set a far-future exp so handlers that read ctx.session
 * keep working).
 */
async function getSession(req) {
  const authHeader = req.headers && req.headers['authorization'] || '';
  const m = authHeader.match(/^\s*Bearer\s+(.+?)\s*$/);
  let token = m && m[1];
  if (!token) token = parseCookie(req, COOKIE_NAME);
  if (!token || token.length < 16) return null;

  let braivex;
  try { braivex = require('./braivex-auth'); } catch (_) { return null; }

  let user;
  try {
    user = await braivex.supabaseVerifyToken(token);
  } catch (_) {
    return null;
  }
  let mapping;
  try {
    mapping = await braivex.resolveOrgMapping(user.id);
  } catch (_) {
    return null;
  }
  if (!mapping) return null;

  // Tenant identity comes only from the Supabase mapping. No local store.
  const tenant = {
    id: mapping.tenant_id || `org_${mapping.organization_id}`,
    name: user.email || 'Workspace',
    slug: `org-${mapping.organization_id}`,
    status: 'active',
    organization_id: mapping.organization_id,
  };

  const ctxUser = {
    id: user.id,
    email: user.email || '',
    name: user.email || '',
    role: mapping.role,
    status: 'active',
  };
  return {
    user: ctxUser,
    tenant,
    session: { exp: Date.now() + 7 * 24 * 60 * 60 * 1000, impersonatorUserId: null },
    supabaseUserId: user.id,
    organization_id: mapping.organization_id,
    role: mapping.role,
  };
}

/**
 * Gate a handler behind auth. Resolves the session; on success calls
 * handler(req, res, ctx) where ctx = { user, tenant, session, body }. On a
 * missing or invalid session, replies 401 and clears any stale cookie.
 * Every authed route is therefore tenant scoped via ctx.tenant.id.
 */
async function requireAuth(req, res, handler, body) {
  const ctx = await getSession(req);
  if (!ctx) {
    return send(res, 401, JSON.stringify({ error: 'authentication required', code: 'no_session' }), {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookie(),
    });
  }
  return handler(req, res, { ...ctx, body });
}

/* ==========================================================================
   6. Per-IP token-bucket rate limiter (90 req / 60s, refilling)
   ========================================================================== */
const _buckets = new Map();
let _rateSweep = 0;
function resetRateLimits() { _buckets.clear(); }
function rateOk(ip, capacity = 90, perMinute = 90) {
  if (process.env.NODE_ENV === 'test') return true;
  const now = Date.now();
  // Evict idle buckets so a long-running server does not grow without bound.
  if (++_rateSweep % 1000 === 0) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [key, bucket] of _buckets) {
      if (bucket.ts < cutoff) _buckets.delete(key);
    }
  }
  let b = _buckets.get(ip);
  if (!b) { b = { tokens: capacity, ts: now }; _buckets.set(ip, b); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 60000) * perMinute);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/* ==========================================================================
   7. Static file server with MIME map + path-traversal guard
   ========================================================================== */
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  // Resolve against PUBLIC_DIR and verify the result stays inside it. This
  // catches .., encoded traversal, and absolute escapes in one check.
  const resolved = path.normalize(path.join(PUBLIC_DIR, p));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 400, 'bad path');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // Single-page app and marketing both live as real files, so a 404 here is
      // a genuine missing asset. Keep it plain.
      return send(res, 404, 'not found');
    }
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

/* ==========================================================================
   8. id helper
   ========================================================================== */
function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex');
}

module.exports = {
  ROOT, PUBLIC_DIR,
  loadEnv,
  send, sendJson, readBody, httpsPost, httpsGet,
  htmlEscape,
  getSession, requireAuth,
  authCookie, clearCookie, COOKIE_NAME, parseCookie,
  rateOk, resetRateLimits,
  serveStatic, MIME,
  genId,
};
