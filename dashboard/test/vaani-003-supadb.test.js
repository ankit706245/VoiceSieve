'use strict';
// Supabase-only transport tests. No live database: the pg pool is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const core = require('../lib/core');
core.loadEnv();

function setupMock(rows = [['val1', 'val2']]) {
  const pgPath = require.resolve('pg');
  let captured = null;
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: {
      Pool: class MockPool {
        on() {}
        query(options) { captured = options; return Promise.resolve({ rows }); }
      },
    },
  };
  delete require.cache[require.resolve('../lib/supadb')];
  const supadb = require('../lib/supadb');
  return { supadb, getQuery: () => captured };
}

test('queryParams sends values separately from SQL text', async () => {
  const { supadb, getQuery } = setupMock();
  await new Promise((resolve, reject) => {
    supadb.queryParams('SELECT * FROM users WHERE id = $1 AND name = $2', [42, "O'Brien"], (err, stdout) => {
      if (err) return reject(err);
      const q = getQuery();
      assert.equal(q.text, 'SELECT * FROM users WHERE id = $1 AND name = $2');
      assert.deepEqual(q.values, [42, "O'Brien"]);
      assert.ok(!q.text.includes("O'Brien"), 'raw value never appears in SQL text');
      assert.equal(stdout, 'val1|val2\n');
      resolve();
    });
  });
});

test('queryParams preserves null, number, and object values', async () => {
  const { supadb, getQuery } = setupMock([]);
  await new Promise((resolve, reject) => {
    supadb.queryParams('SELECT $1, $2, $3', [null, 42, { key: 'value' }], (err) => {
      if (err) return reject(err);
      assert.deepEqual(getQuery().values, [null, 42, { key: 'value' }]);
      resolve();
    });
  });
});

test('SQL injection input stays in the values array', async () => {
  const { supadb, getQuery } = setupMock([]);
  const malicious = "x'; DROP TABLE users; --";
  await new Promise((resolve, reject) => {
    supadb.queryParams('SELECT * FROM users WHERE name = $1', [malicious], (err) => {
      if (err) return reject(err);
      const q = getQuery();
      assert.equal(q.text, 'SELECT * FROM users WHERE name = $1');
      assert.deepEqual(q.values, [malicious]);
      assert.ok(!q.text.includes(malicious), 'malicious input is not interpolated');
      resolve();
    });
  });
});

test('without VAANI_DATABASE_URL every query fails closed', () => {
  const script = `
    const supadb = require('./lib/supadb');
    supadb.queryTextCallback('SELECT 1', {}, (err) => {
      process.stdout.write(err ? err.message : 'NO_ERROR');
    });
  `;
  const out = spawnSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, VAANI_DATABASE_URL: '' },
    encoding: 'utf8',
  });
  assert.match(out.stdout, /VAANI_DATABASE_URL is not configured/);
});

test('core.loadEnv loads VAANI_DATABASE_URL before supadb is required', () => {
  assert.ok(process.env.VAANI_DATABASE_URL, 'VAANI_DATABASE_URL is set');
  assert.ok(process.env.VAANI_DATABASE_URL.startsWith('postgresql://'), 'it is a postgres URL');
  assert.equal(require('../lib/supadb').isSupabase(), true);
});
