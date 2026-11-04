'use strict';

/**
 * Central PostgreSQL transport for the Vaani dashboard.
 *
 * Supabase is the only database. VAANI_DATABASE_URL (Supabase session pooler)
 * is required; without it every query fails closed instead of falling back to
 * a local Docker database.
 *
 * Returned text emulates `psql -t -A -c` output (one row per line,
 * `|`-separated columns, empty string for NULL, JSON columns as compact JSON
 * text) so existing stdout parsing keeps working byte-for-byte.
 */

const fs = require('fs');
const path = require('path');

const DB_URL = process.env.VAANI_DATABASE_URL || '';
const SUPABASE_CA_PATH = process.env.VAANI_DB_SSLROOTCERT
  || path.join(__dirname, '..', 'certs', 'supabase-pooler-ca.pem');

function supabaseSslConfig() {
  if (!DB_URL) return undefined;
  let host = '';
  try {
    host = new URL(DB_URL).hostname;
  } catch (_) {
    return undefined;
  }
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return undefined;
  if (host.endsWith('.pooler.supabase.com')) {
    try {
      return {
        ca: fs.readFileSync(SUPABASE_CA_PATH, 'utf8'),
        rejectUnauthorized: true,
      };
    } catch (e) {
      // Refuse to silently send database credentials over a plaintext link.
      console.error('Supabase CA certificate not readable; refusing connection:', e.message);
      throw e;
    }
  }
  // shortcut: direct Supabase hosts use a self-signed cert, so encrypt without
  // CA verification. Prefer the session pooler URL, which is verified above.
  return { rejectUnauthorized: false };
}

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    const ssl = supabaseSslConfig();
    pool = new Pool({
      connectionString: DB_URL,
      max: 3,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10000,
      ...(ssl ? { ssl } : {}),
    });
    pool.on('error', () => {});
  }
  return pool;
}

function formatCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return v.toString('utf8');
    return JSON.stringify(v);
  }
  return String(v);
}

function notConfiguredError() {
  return new Error('VAANI_DATABASE_URL is not configured. Supabase is the only database.');
}

async function queryTextAsync(sql, { timeout = 8000 } = {}) {
  if (!DB_URL) throw notConfiguredError();
  const raw = await getPool().query({ text: sql, rowMode: 'array', query_timeout: timeout });
  // node-postgres returns an ARRAY of results for multi-statement simple-protocol
  // queries (e.g. BEGIN; INSERT; ...; COMMIT;). psql prints each result's rows in
  // order, so concatenate lines from every result to stay byte-compatible.
  const results = Array.isArray(raw) ? raw : [raw];
  const lines = [];
  for (const result of results) {
    for (const row of result.rows || []) {
      lines.push(row.map(formatCell).join('|'));
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Drop-in replacement for the old docker/psql callback transport.
 * Callback: (err, stdout, stderr).
 */
function queryTextCallback(sql, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  const timeout = (opts && opts.timeout) || 8000;
  if (!DB_URL) {
    cb(notConfiguredError(), '', notConfiguredError().message);
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      const err = new Error('supadb query timed out');
      cb(err, '', err.message);
    }
  }, timeout + 1000);
  timer.unref();
  queryTextAsync(sql, { timeout })
    .then((stdout) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cb(null, stdout, '');
      }
    })
    .catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cb(err, '', err.message);
      }
    });
}

/**
 * Executes a SQL query with genuine PostgreSQL parameter binding.
 * Callback signature: (err, stdout, stderr) — stdout matches the
 * psql -t -A -c text format.
 */
function queryParams(sql, params, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  const timeout = (opts && opts.timeout) || 8000;
  const safeParams = params || [];

  if (!DB_URL) {
    cb(notConfiguredError(), '', notConfiguredError().message);
    return;
  }

  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      const err = new Error('supadb query timed out');
      cb(err, '', err.message);
    }
  }, timeout + 1000);
  timer.unref();
  getPool()
    .query({ text: sql, values: safeParams, rowMode: 'array', query_timeout: timeout })
    .then((result) => {
      if (settled) return;
      let lines;
      try {
        lines = [];
        for (const row of result.rows || []) {
          lines.push(row.map(formatCell).join('|'));
        }
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        cb(err, '', err.message);
        return;
      }
      settled = true;
      clearTimeout(timer);
      cb(null, lines.length ? lines.join('\n') + '\n' : '', '');
    })
    .catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cb(err, '', err.message);
      }
    });
}

module.exports = {
  queryTextCallback,
  queryParams,
  isSupabase: () => Boolean(DB_URL),
};
