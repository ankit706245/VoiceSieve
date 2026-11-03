'use strict';

/**
 * Vaani due-task sweeper — pure unit tests (plan v2, step 1).
 *
 * Zero dependencies, zero database access, zero network access. Every test
 * injects the query and transition seams, so the real transport is never
 * reached and no task row can be read or written.
 *
 * Run: node --test lib/vaani-tasks.sweep.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sweepDueTasks } = require('./vaani-tasks');

// The transport returns one JSON object per line (row_to_json over a single
// column), so the fake query mirrors that shape exactly.
function fakeStdout(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

function makeDeps(rows, opts) {
  const options = opts || {};
  const calls = { queries: [], transitions: [] };
  const queryFn = async (sql) => {
    calls.queries.push(sql);
    if (options.queryError) throw new Error(options.queryError);
    return fakeStdout(rows || []);
  };
  const transitionFn = async (taskId, targetStatus, organizationId, completedBy, notes) => {
    calls.transitions.push({ taskId, targetStatus, organizationId, completedBy, notes });
    if (options.failTaskIds && options.failTaskIds.includes(taskId)) {
      throw new Error('Invalid state transition from PENDING to DUE');
    }
    return { task_id: taskId, status: targetStatus };
  };
  return { deps: { queryFn, transitionFn }, calls };
}

const SAMPLE = [
  { task_id: 'task_2_1000001', organization_id: 2 },
  { task_id: 'task_1_1000002', organization_id: 1 },
  { task_id: 'task_2_1000003', organization_id: 2 },
];

describe('sweepDueTasks', () => {
  it('scans only overdue PENDING tasks and promotes each through the transition path', async () => {
    const { deps, calls } = makeDeps(SAMPLE);
    const out = await sweepDueTasks(deps);

    assert.equal(calls.queries.length, 1);
    assert.ok(calls.queries[0].includes("status = 'PENDING'"));
    assert.ok(calls.queries[0].includes('due_at <= CURRENT_TIMESTAMP'));
    assert.equal(out.checked, 3);
    assert.equal(out.transitioned.length, 3);
    assert.deepEqual(out.transitioned, ['task_2_1000001', 'task_1_1000002', 'task_2_1000003']);
    assert.equal(out.errors.length, 0);

    // Every promotion goes through the validated transition path, with the
    // task's own organization and the sweeper attribution.
    assert.deepEqual(calls.transitions[0], {
      taskId: 'task_2_1000001',
      targetStatus: 'DUE',
      organizationId: 2,
      completedBy: 'System Sweeper',
      notes: 'Due time reached',
    });
  });

  it('applies the organization filter to the SELECT', async () => {
    const { deps, calls } = makeDeps(SAMPLE);
    await sweepDueTasks({ ...deps, organizationId: 2 });

    assert.ok(calls.queries[0].includes('AND organization_id = 2'));
  });

  it('scans every organization when no filter is given', async () => {
    const { deps, calls } = makeDeps(SAMPLE);
    await sweepDueTasks(deps);

    assert.ok(!calls.queries[0].includes('AND organization_id ='));
  });

  it('rejects an invalid organization id before issuing any query', async () => {
    const { deps, calls } = makeDeps(SAMPLE);
    const out = await sweepDueTasks({ ...deps, organizationId: 0 });

    assert.equal(calls.queries.length, 0);
    assert.equal(calls.transitions.length, 0);
    assert.deepEqual(out.errors, ['invalid_organization_id']);
    assert.equal(out.checked, 0);
  });

  it('applies the limit', async () => {
    const { deps, calls } = makeDeps(SAMPLE);
    await sweepDueTasks({ ...deps, limit: 25 });

    assert.ok(calls.queries[0].includes('LIMIT 25'));
  });

  it('a dry run lists the candidates and changes nothing at all', async () => {
    const { deps, calls } = makeDeps(SAMPLE);
    const out = await sweepDueTasks({ ...deps, dryRun: true });

    assert.equal(out.dry_run, true);
    assert.equal(out.checked, 3);
    assert.equal(out.candidates.length, 3);
    assert.deepEqual(out.candidates, ['task_2_1000001', 'task_1_1000002', 'task_2_1000003']);
    // Nothing was promoted and no transition was even attempted.
    assert.equal(out.transitioned.length, 0);
    assert.equal(calls.transitions.length, 0);
  });

  it('reports the per-organization breakdown', async () => {
    const { deps } = makeDeps(SAMPLE);
    const out = await sweepDueTasks(deps);

    assert.deepEqual(out.by_org, { 2: 2, 1: 1 });
  });

  it('collects a failing transition and still promotes the remaining rows', async () => {
    const { deps, calls } = makeDeps(SAMPLE, { failTaskIds: ['task_1_1000002'] });
    const out = await sweepDueTasks(deps);

    assert.equal(calls.transitions.length, 3, 'every row is still attempted');
    assert.equal(out.transitioned.length, 2);
    assert.deepEqual(out.transitioned, ['task_2_1000001', 'task_2_1000003']);
    assert.equal(out.errors.length, 1);
    assert.ok(out.errors[0].includes('task_1_1000002'));
  });

  it('reports a query failure without promoting anything', async () => {
    const { deps, calls } = makeDeps(SAMPLE, { queryError: 'connection refused' });
    const out = await sweepDueTasks(deps);

    assert.equal(calls.transitions.length, 0);
    assert.equal(out.transitioned.length, 0);
    assert.equal(out.errors.length, 1);
    assert.ok(out.errors[0].startsWith('sweep-query:'));
  });

  it('handles an empty result set without touching anything', async () => {
    const { deps, calls } = makeDeps([]);
    const out = await sweepDueTasks(deps);

    assert.equal(out.checked, 0);
    assert.equal(out.transitioned.length, 0);
    assert.equal(out.errors.length, 0);
    assert.equal(calls.transitions.length, 0);
  });
});
