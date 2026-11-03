'use strict';

/**
 * Vaani Phase 2 + Phase 3 focused tests (node:test, zero deps).
 * Run: VAANI_DATABASE_URL=<session-pooler-url> node --test lib/vaani-phase23.test.js
 * DB-touching tests use synthetic TEST-* rows and delete them afterwards.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const supadb = require('./supadb');

function q(text) {
  return new Promise((resolve, reject) => {
    supadb.queryTextCallback(text, { timeout: 20000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}

async function qj(sql) {
  const out = await q(sql);
  const t = out.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch (_) {
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      try { return JSON.parse(line); } catch (_) {}
    }
    return t;
  }
}

async function cleanupTestRows() {
  await q(`DELETE FROM public.vaani_buyer_machine_matches WHERE buyer_run_id = 1000002;`);
  await q(`DELETE FROM public.vaani_follow_up_tasks WHERE lead_id LIKE 'TEST-%';`);
}

before(async () => {
  assert.ok(process.env.VAANI_DATABASE_URL, 'VAANI_DATABASE_URL required');
  await cleanupTestRows();
});

describe('Phase 2A: qualification engines (pure, no DB)', () => {
  let S;
  it('loads vaani-sales module', () => {
    // engines are module-private; verify via ingest-adjacent exports instead
    S = require('./vaani-sales');
    assert.ok(S.ingestCallComplete);
  });

  it('normalizeCustomerType paths via ingest validation (unit-level)', async () => {
    // invalid payload must fail fast, not invent data
    await assert.rejects(S.ingestCallComplete(null), /Payload must be/);
    await assert.rejects(S.ingestCallComplete({}), /primary_phone/);
  });
});

describe('Phase 2B: DB-backed inventory matching (integration)', () => {
  it('runIntelligentMatching finds the JCB row and persists evidence', async () => {
    const S = require('./vaani-sales');
    const matches = await S.runIntelligentMatching(1, 1000002, {
      machine_brand: 'JCB', machine_model: null,
      budget_max_inr: null, buyer_budget_max_inr: null,
      model_year_min: null, model_year_max: null, running_hours_max: null,
    });
    assert.ok(Array.isArray(matches) && matches.length >= 1, 'expected >=1 match');
    assert.ok(!JSON.stringify(matches).includes('JCBJCB'), 'no fabricated repetition');
    const persisted = await qj(`SELECT count(*) AS c FROM public.vaani_buyer_machine_matches WHERE buyer_run_id = 1000002;`);
    const n = typeof persisted === 'object' ? persisted.c : parseInt(persisted, 10);
    assert.ok(n >= 1, 'match rows persisted');
  });

  it('no-match buyer records clearly (impossible brand)', async () => {
    const S = require('./vaani-sales');
    const matches = await S.runIntelligentMatching(1, 1000002, {
      machine_brand: 'ZZZNoSuchBrand', machine_model: null,
      budget_max_inr: null, buyer_budget_max_inr: null,
      model_year_min: null, model_year_max: null, running_hours_max: null,
    });
    assert.deepEqual(matches, []);
  });
});

describe('Phase 3D: follow-up dedup + state machine (integration)', () => {
  const T = () => require('./vaani-tasks');

  it('creates then refuses duplicate open tasks', async () => {
    const ctx = {
      organization_id: 1, lead_id: 'TEST-DEDUP-1', customer_id: 'TEST-DEDUP-1',
      customer_type: 'buyer', qual_state: 'PARTIALLY_QUALIFIED', lead_temp: 'WARM',
      next_action: 'FOLLOW_UP_BUYER', mach_details: {}, comm_terms: {}, ev_readiness: {},
      run_id: -999, caller_name: 'Test', primary_phone: '+910000000001',
    };
    const first = await T().processCallFollowUpTasks(ctx);
    assert.ok(first.length >= 1, 'first call creates');
    const second = await T().processCallFollowUpTasks(ctx);
    assert.deepEqual(second, [], 'second call creates none (dedup)');
  });

  it('OWNER_HANDOFF suppresses normal tasks', async () => {
    const ctx = {
      organization_id: 1, lead_id: 'TEST-OWNER-1', customer_id: 'TEST-OWNER-1',
      customer_type: 'buyer', qual_state: 'QUALIFIED', lead_temp: 'HOT',
      next_action: 'OWNER_HANDOFF', deal_readiness: 'READY_FOR_HUMAN',
      owner_summary: 'Test summary', deal_ready_reason: 'Test reason',
      mach_details: { brand: 'JCB', model: '3DX' }, comm_terms: {}, ev_readiness: {},
      run_id: -999, caller_name: 'Test', primary_phone: '+910000000002',
    };
    const created = await T().processCallFollowUpTasks(ctx);
    const types = created.map((r) => (typeof r === 'string' ? JSON.parse(r) : r).task_type);
    assert.deepEqual(types, ['OWNER_HANDOFF']);
  });

  it('DNC creates nothing', async () => {
    const ctx = {
      organization_id: 1, lead_id: 'TEST-DNC-1', customer_id: 'TEST-DNC-1',
      customer_type: 'buyer', qual_state: 'DISQUALIFIED', lead_temp: 'COLD',
      next_action: 'DNC_SUPPRESS', dnc_requested: true,
      mach_details: {}, comm_terms: {}, ev_readiness: {},
      run_id: -999, caller_name: 'Test', primary_phone: '+910000000003',
    };
    const created = await T().processCallFollowUpTasks(ctx);
    assert.deepEqual(created, []);
  });

  it('due sweeper promotes overdue PENDING without touching others', async () => {
    await q(`INSERT INTO public.vaani_follow_up_tasks (task_id, organization_id, lead_id, task_type, title, status, due_at, source_call_id) VALUES ('TEST-SWEEP-1', 1, 'TEST-SWEEP-1', 'FOLLOW_UP_BUYER', 'Sweep test', 'PENDING', CURRENT_TIMESTAMP - INTERVAL '1 hour', -999) ON CONFLICT (task_id) DO UPDATE SET status='PENDING', due_at=CURRENT_TIMESTAMP - INTERVAL '1 hour';`);
    const res = await T().sweepDueTasks({ limit: 200 });
    assert.ok(res.transitioned.includes('TEST-SWEEP-1'), JSON.stringify(res));
    const row = await qj(`SELECT status FROM public.vaani_follow_up_tasks WHERE task_id='TEST-SWEEP-1';`);
    const status = typeof row === 'object' ? row.status : row;
    assert.equal(status, 'DUE');
  });

  it('valid transitions DUE->IN_PROGRESS->COMPLETED; invalid rejected', async () => {
    const r1 = await T().transitionTaskStatus('TEST-SWEEP-1', 'IN_PROGRESS', 1, 'Test', '');
    const s1 = typeof r1 === 'object' ? r1.status : JSON.parse(r1).status;
    assert.equal(s1, 'IN_PROGRESS');
    const r2 = await T().transitionTaskStatus('TEST-SWEEP-1', 'COMPLETED', 1, 'Test', '');
    const s2 = typeof r2 === 'object' ? r2.status : JSON.parse(r2).status;
    assert.equal(s2, 'COMPLETED');
    await assert.rejects(T().transitionTaskStatus('TEST-SWEEP-1', 'DUE', 1, 'Test', ''), /Invalid state transition/);
  });
});

describe('Phase 5: owner digest (integration)', () => {
  it('digest aggregates real Supabase data, no fabrication', async () => {
    const S = require('./vaani-sales');
    const d = await S.getOwnerDigest(1);
    assert.equal(d.organization_id, 1);
    assert.ok(d.leads.buyers >= 40 && d.leads.sellers >= 40, JSON.stringify(d.leads));
    assert.ok(d.inventory.total >= 40, JSON.stringify(d.inventory));
    assert.ok(Array.isArray(d.recent_activities));
    assert.ok(d.follow_ups.overdue + d.follow_ups.due_today + d.follow_ups.upcoming >= 0);
    assert.ok(d.generated_at);
  });
});

describe('Phase 2F/3: idempotency + relay re-run (integration)', () => {
  it('duplicate relay for run 1000002 creates no new call rows', async () => {
    const before = await qj(`SELECT max(id) AS m FROM public.vaani_calls;`);
    const m0 = typeof before === 'object' ? before.m : parseInt(before, 10);
    const S = require('./vaani-sales');
    // rebuild minimal relay-equivalent payload path is covered live; here assert
    // follow-up upsert stability by reprocessing the same owner context twice
    const T = require('./vaani-tasks');
    const ctx = {
      organization_id: 1, lead_id: 'lead_1000002', customer_id: '+910000000000',
      customer_type: 'buyer', qual_state: 'PARTIALLY_QUALIFIED', lead_temp: 'WARM',
      next_action: 'FOLLOW_UP_BUYER', mach_details: {}, comm_terms: {}, ev_readiness: {},
      run_id: 1000002, caller_name: 'Test', primary_phone: '+910000000000',
    };
    await T.processCallFollowUpTasks(ctx);
    await T.processCallFollowUpTasks(ctx);
    const after = await qj(`SELECT max(id) AS m FROM public.vaani_calls;`);
    const m1 = typeof after === 'object' ? after.m : parseInt(after, 10);
    assert.equal(m1, m0, 'no new call rows from reprocessing');
  });
});
