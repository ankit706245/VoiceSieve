'use strict';

/**
 * Central PostgreSQL transport for the Vaani dashboard.
 *
 * When VAANI_DATABASE_URL is set (Supabase session pooler), queries run
 * through node-postgres and the returned text emulates `psql -t -A -c`
 * output (one row per line, `|`-separated columns, empty string for NULL,
 * JSON columns as compact JSON text) so all existing stdout parsing keeps
 * working byte-for-byte.
 *
 * When VAANI_DATABASE_URL is unset, the legacy local path is used
 * (docker exec into dograh-local-postgres-1), preserving old behavior.
 */

const { execFile } = require('child_process');
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
  if (!host.endsWith('.pooler.supabase.com')) return undefined;
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

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    // Shares one Supabase session-mode pooler (capped clients) with the Dograh
    // API engine. Keep small so call setup can never be starved: the local
    // dashboard is single-user and issues short queries.
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

async function queryTextAsync(sql, { timeout = 8000 } = {}) {
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

function legacyExec(sql, { timeout = 8000 }, cb) {
  execFile(
    'docker',
    ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql],
    { timeout },
    cb
  );
}

/**
 * Client-side SQL value substitution for the legacy Docker/psql path.
 * Mirrors the escaping rules used by vaani-sales.formatSql so that the
 * legacy path produces byte-compatible SQL when parameter binding is not
 * available. Single quotes are doubled, nulls become NULL, numbers are
 * passed bare, booleans become true/false, objects become ::jsonb literals.
 */
function formatSqlFallback(sql, params) {
  if (!params || !params.length) return sql;
  return sql.replace(/\$(\d+)/g, (match, idx) => {
    const i = parseInt(idx, 10) - 1;
    if (i < 0 || i >= params.length) return match;
    const val = params[i];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

/**
 * Drop-in replacement for:
 *   execFile('docker', ['exec', 'dograh-local-postgres-1', 'psql', ..., '-c', sql], { timeout }, cb)
 * Callback: (err, stdout, stderr).
 */
function queryTextCallback(sql, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  const timeout = (opts && opts.timeout) || 8000;
  if (!DB_URL) {
    legacyExec(sql, { timeout }, cb);
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
 * Executes a SQL query with genuine PostgreSQL parameter binding where the
 * driver supports it (VAANI_DATABASE_URL set), falling back to client-side
 * substitution + docker/psql when it does not.
 *
 * When DB_URL is set: params travel separately from the SQL text via
 * pg.Pool.query({ text, values }), so values can never be interpreted as
 * SQL — even strings containing quotes, semicolons, or SQL keywords.
 *
 * When DB_URL is unset: falls back to formatSqlFallback + legacyExec
 * (docker exec psql), preserving the pre-existing behavior exactly.
 *
 * Callback signature: (err, stdout, stderr) — stdout matches the
 * psql -t -A -c text format (pipe-separated columns, one row per line)
 * so callers can parse results identically to queryTextCallback.
 */
function queryParams(sql, params, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  const timeout = (opts && opts.timeout) || 8000;
  const safeParams = params || [];

  if (DB_URL) {
    // Genuine PostgreSQL parameter binding: values travel separately from SQL text.
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
        // Format output to match psql -t -A -c text format for compatibility.
        // Formatting happens before `settled` is raised and is guarded, so a
        // formatting failure is reported to the caller instead of leaving the
        // request pending forever.
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
  } else {
    // Legacy Docker/psql path: client-side substitution is the only option.
    const finalSql = formatSqlFallback(sql, safeParams);
    legacyExec(finalSql, { timeout }, cb);
  }
}

module.exports = {
  queryTextCallback,
  queryParams,
  isSupabase: () => Boolean(DB_URL),
};
