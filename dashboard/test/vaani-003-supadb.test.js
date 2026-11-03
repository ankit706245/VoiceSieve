'use strict';
// VAANI-003: Tests for supadb.js queryParams — genuine PostgreSQL parameter binding.
// Covers: strings with quotes, nulls, numbers, booleans, objects, database errors.
// Tests both the genuine-binding path (VAANI_DATABASE_URL set) and the
// legacy Docker/psql fallback path (VAANI_DATABASE_URL unset).
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Save env state
// ---------------------------------------------------------------------------
const savedDbUrl = process.env.VAANI_DATABASE_URL || null;

// ---------------------------------------------------------------------------
// Helper: set up legacy path (VAANI_DATABASE_URL unset) with a stubbed execFile
// ---------------------------------------------------------------------------
function setupLegacyPath(execFileImpl) {
  delete process.env.VAANI_DATABASE_URL;
  const cpPath = require.resolve('child_process');
  let capturedSql = null;
  let execFileCalled = false;
  require.cache[cpPath] = {
    id: cpPath,
    filename: cpPath,
    loaded: true,
    exports: {
      execFile: (_cmd, argsArray, _opts, cb) => {
        execFileCalled = true;
        const cIndex = argsArray.indexOf('-c');
        capturedSql = cIndex >= 0 ? argsArray[cIndex + 1] : null;
        if (execFileImpl) {
          execFileImpl(_cmd, argsArray, _opts, cb);
        } else if (cb) {
          cb(null, 'row1|val1\nrow2|val2\n', '');
        }
      },
    },
  };
  delete require.cache[require.resolve('../lib/supadb')];
  const supadb = require('../lib/supadb');
  return { supadb, cpPath, getSql: () => capturedSql, getCalled: () => execFileCalled };
}

// ---------------------------------------------------------------------------
// Legacy path tests (VAANI_DATABASE_URL unset)
// ---------------------------------------------------------------------------

test('queryParams legacy: string with single quote is escaped (doubled)', (t) => {
  const { supadb, getSql, getCalled } = setupLegacyPath();
  return new Promise((resolve) => {
    supadb.queryParams("SELECT * FROM users WHERE name = $1", ["O'Brien"], (err, stdout) => {
      assert.ifError(err);
      assert.ok(getCalled(), 'execFile should be called');
      assert.ok(
        getSql().includes("'O''Brien'"),
        `Single quote should be doubled. Got: ${getSql()}`
      );
      resolve();
    });
  });
});

test('queryParams legacy: null value becomes NULL', (t) => {
  const { supadb, getSql, getCalled } = setupLegacyPath();
  return new Promise((resolve) => {
    supadb.queryParams("SELECT * FROM t WHERE x = $1", [null], (err, stdout) => {
      assert.ifError(err);
      assert.ok(getCalled(), 'execFile should be called');
      assert.ok(
        getSql().includes(' = NULL'),
        `Null should become NULL. Got: ${getSql()}`
      );
      resolve();
    });
  });
});

test('queryParams legacy: number is passed bare', (t) => {
  const { supadb, getSql, getCalled } = setupLegacyPath();
  return new Promise((resolve) => {
    supadb.queryParams("SELECT * FROM t WHERE id = $1", [42], (err, stdout) => {
      assert.ifError(err);
      assert.ok(getCalled(), 'execFile should be called');
      assert.ok(
        getSql().includes(' = 42'),
        `Number should be bare. Got: ${getSql()}`
      );
      resolve();
    });
  });
});

test('queryParams legacy: boolean becomes true/false', (t) => {
  const { supadb, getSql, getCalled } = setupLegacyPath();
  return new Promise((resolve) => {
    supadb.queryParams("SELECT * FROM t WHERE active = $1", [true], (err, stdout) => {
      assert.ifError(err);
      assert.ok(
        getSql().includes(' = true'),
        `Boolean true should be 'true'. Got: ${getSql()}`
      );
      resolve();
    });
  });
});

test('queryParams legacy: object becomes ::jsonb literal', (t) => {
  const { supadb, getSql, getCalled } = setupLegacyPath();
  return new Promise((resolve) => {
    supadb.queryParams("SELECT * FROM t WHERE data = $1", [{ key: 'value' }], (err, stdout) => {
      assert.ifError(err);
      assert.ok(getCalled(), 'execFile should be called');
      assert.ok(
        getSql().includes('::jsonb'),
        `Object should become ::jsonb. Got: ${getSql()}`
      );
      assert.ok(
        getSql().includes('{"key":"value"}'),
        `Object should be JSON-serialized. Got: ${getSql()}`
      );
      resolve();
    });
  });
});

test('queryParams legacy: SQL injection attempt is neutralized', (t) => {
  const { supadb, getSql, getCalled } = setupLegacyPath();
  return new Promise((resolve) => {
    const malicious = "x'; DROP TABLE users; --";
    supadb.queryParams("SELECT * FROM users WHERE name = $1", [malicious], (err, stdout) => {
      assert.ifError(err);
      assert.ok(getCalled(), 'execFile should be called');
      assert.ok(
        getSql().includes("'x''; DROP TABLE users; --'"),
        `Injection should be neutralized by quoting. Got: ${getSql()}`
      );
      const afterFirstQuote = getSql().substring(getSql().indexOf("'x''"));
      assert.ok(
        afterFirstQuote.startsWith("'x''; DROP TABLE users; --'"),
        `Malicious payload must remain inside a quoted literal. Got: ${afterFirstQuote.substring(0, 60)}`
      );
      resolve();
    });
  });
});

test('queryParams legacy: execFile error propagates to callback', (t) => {
  delete process.env.VAANI_DATABASE_URL;
  const cpPath = require.resolve('child_process');
  require.cache[cpPath] = {
    id: cpPath,
    filename: cpPath,
    loaded: true,
    exports: {
      execFile: (_cmd, _args, _opts, cb) => {
        cb(new Error('psql connection failed'), '', '');
      },
    },
  };
  delete require.cache[require.resolve('../lib/supadb')];
  const supadb = require('../lib/supadb');

  return new Promise((resolve) => {
    supadb.queryParams("SELECT 1", [], (err, stdout) => {
      assert.ok(err, 'Error should be propagated to callback');
      assert.equal(err.message, 'psql connection failed');
      resolve();
    });
  });
});

// ---------------------------------------------------------------------------
// Genuine parameter binding path (VAANI_DATABASE_URL set)
// Only runs when VAANI_DATABASE_URL is actually configured.
// ---------------------------------------------------------------------------

if (process.env.VAANI_DATABASE_URL) {
  function setupPgPath() {
    const pgPath = require.resolve('pg');
    let capturedQuery = null;
    require.cache[pgPath] = {
      id: pgPath,
      filename: pgPath,
      loaded: true,
      exports: {
        Pool: class MockPool {
          on() {}
          query(options) {
            capturedQuery = options;
            return Promise.resolve({
              rows: [{ col1: 'val1', col2: 'val2' }],
            });
          }
        },
      },
    };
    delete require.cache[require.resolve('../lib/supadb')];
    const supadb = require('../lib/supadb');
    return { supadb, pgPath, getQuery: () => capturedQuery };
  }

  test('queryParams pg path: params travel separately from SQL text', (t) => {
    const { supadb, getQuery } = setupPgPath();
    return new Promise((resolve) => {
      supadb.queryParams("SELECT * FROM users WHERE id = $1 AND name = $2", [42, "O'Brien"], (err, stdout) => {
        assert.ifError(err);
        const q = getQuery();
        assert.ok(q, 'pool.query should be called');
        assert.equal(q.text, "SELECT * FROM users WHERE id = $1 AND name = $2");
        assert.deepStrictEqual(q.values, [42, "O'Brien"]);
        assert.ok(
          !q.text.includes("O'Brien"),
          'SQL text must NOT contain the raw parameter value'
        );
        resolve();
      });
    });
  });

  test('queryParams pg path: null value travels as null in values array', (t) => {
    const { supadb, getQuery } = setupPgPath();
    return new Promise((resolve) => {
      supadb.queryParams("SELECT * FROM t WHERE x = $1", [null], (err, stdout) => {
        assert.ifError(err);
        const q = getQuery();
        assert.deepStrictEqual(q.values, [null]);
        assert.equal(q.text, "SELECT * FROM t WHERE x = $1");
        resolve();
      });
    });
  });

  test('queryParams pg path: number value travels as number in values array', (t) => {
    const { supadb, getQuery } = setupPgPath();
    return new Promise((resolve) => {
      supadb.queryParams("SELECT * FROM t WHERE id = $1", [42], (err, stdout) => {
        assert.ifError(err);
        const q = getQuery();
        assert.deepStrictEqual(q.values, [42]);
        resolve();
      });
    });
  });

  test('queryParams pg path: pool query error propagates to callback', (t) => {
    const { supadb, pgPath } = setupPgPath();
    const pgMod = require.cache[pgPath];
    const MockPool = pgMod.exports.Pool;
    pgMod.exports.Pool = class ErrorPool {
      query() {
        return Promise.reject(new Error('connection refused'));
      }
    };

    return new Promise((resolve) => {
      supadb.queryParams("SELECT 1", [], (err, stdout) => {
        assert.ok(err, 'Error should be propagated');
        assert.equal(err.message, 'connection refused');
        pgMod.exports.Pool = MockPool;
        resolve();
      });
    });
  });

  test('queryParams pg path: output matches psql text format', (t) => {
    const { supadb, getQuery } = setupPgPath();
    return new Promise((resolve) => {
      supadb.queryParams("SELECT col1, col2 FROM t WHERE id = $1", [7], (err, stdout) => {
        assert.ifError(err);
        assert.equal(stdout, 'val1|val2\n');
        resolve();
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Config loading test: dashboard/.env contains VAANI_DATABASE_URL and
// core.loadEnv() reads it before supadb is required.
// ---------------------------------------------------------------------------

test('queryParams config: dashboard/.env sets VAANI_DATABASE_URL', (t) => {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  const env = fs.readFileSync(envPath, 'utf8');
  const lines = env.split('\n').filter((l) => l.match(/^\s*[A-Z0-9_]+\s*=/));
  const hasDbUrl = lines.some((l) => l.startsWith('VAANI_DATABASE_URL='));
  assert.ok(hasDbUrl, 'VAANI_DATABASE_URL must be present in dashboard/.env');
});

test('queryParams config: core.loadEnv() loads VAANI_DATABASE_URL before supadb requires it', (t) => {
  const savedDbUrl = process.env.VAANI_DATABASE_URL || null;
  delete process.env.VAANI_DATABASE_URL;
  delete require.cache[require.resolve('../lib/core')];
  delete require.cache[require.resolve('../lib/supadb')];

  const core = require('../lib/core');
  core.loadEnv();

  assert.ok(process.env.VAANI_DATABASE_URL, 'VAANI_DATABASE_URL must be set by loadEnv()');
  assert.ok(process.env.VAANI_DATABASE_URL.startsWith('postgresql://'), 'VAANI_DATABASE_URL must be a postgresql:// URL');

  const supadb = require('../lib/supadb');
  assert.ok(supadb.isSupabase(), 'supabase.isSupabase() must be true when VAANI_DATABASE_URL is present');

  // Restore
  process.env.VAANI_DATABASE_URL = savedDbUrl || '';
  delete require.cache[require.resolve('../lib/core')];
  delete require.cache[require.resolve('../lib/supadb')];
});

// ---------------------------------------------------------------------------
// pg path: SQL injection safety — malicious input travels as separate values
// ---------------------------------------------------------------------------

test('queryParams pg path: SQL injection input does not appear in SQL text', (t) => {
  process.env.VAANI_DATABASE_URL = 'postgresql://postgres:pass@localhost:5432/test';
  const pgPath = require.resolve('pg');
  let capturedQuery = null;
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: {
      Pool: class MockPool {
        on() {}
        query(options) {
          capturedQuery = options;
          return Promise.resolve({ rows: [] });
        }
      },
    },
  };
  delete require.cache[require.resolve('../lib/supadb')];
  const supadb = require('../lib/supadb');

  return new Promise((resolve) => {
    const malicious = "x'; DROP TABLE users; --";
    supadb.queryParams("SELECT * FROM users WHERE name = $1", [malicious], (err, stdout) => {
      assert.ifError(err);
      const q = capturedQuery;
      assert.ok(q, 'pool.query should be called');
      assert.equal(q.text, "SELECT * FROM users WHERE name = $1");
      assert.deepStrictEqual(q.values, [malicious]);
      assert.ok(
        !q.text.includes(malicious),
        'Malicious input must NOT appear in SQL text'
      );
      assert.ok(
        q.values.includes(malicious),
        'Malicious input MUST appear in values array'
      );
      resolve();
    });
  });
});

// ---------------------------------------------------------------------------
// Restore env and module cache
// ---------------------------------------------------------------------------

process.env.VAANI_DATABASE_URL = savedDbUrl || '';
delete require.cache[require.resolve('../lib/supadb')];
delete require.cache[require.resolve('child_process')];
delete require.cache[require.resolve('pg')];
