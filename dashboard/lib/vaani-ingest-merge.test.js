'use strict';

/**
 * Vaani Phase 1 (plan v2) — pure unit tests for the ingestion persistence
 * helpers. Zero dependencies, zero database access, zero network access.
 *
 * Run: node --test lib/vaani-ingest-merge.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeExtractedVariables,
  resolveArtifactUrl,
  evaluateCallCompletionEvidence,
  applyCallCompletionStatus,
  CALL_COMPLETION_BLOCKING_OUTCOMES,
  CALL_TERMINAL_STATUSES,
} = require('./vaani-sales');

// A stub query function so the call-status writer can be exercised without a
// database. It records every UPDATE so the tests can assert that no write
// happens unless the evidence gate allows it.
function makeStub(options) {
  const opts = options || {};
  const runOrg = opts.runOrg === undefined ? 2 : opts.runOrg;
  const call = opts.call === undefined ? null : opts.call;
  const updates = [];
  const q = async (sql) => {
    const text = String(sql || '');
    if (/FROM workflow_runs r JOIN workflows w/.test(text)) {
      return { init_ctx: { organization_id: runOrg }, wf_org: 1 };
    }
    if (/^\s*UPDATE vaani_calls/i.test(text.trim())) {
      updates.push(text);
      return '';
    }
    if (/FROM vaani_calls/.test(text)) {
      return call;
    }
    return null;
  };
  return { q, updates };
}

describe('mergeExtractedVariables', () => {
  it('fills absent machine, commercial and evidence facts from the Dograh extraction', () => {
    const mach = {};
    const comm = {};
    const ev = {};
    const payload = {};
    mergeExtractedVariables({
      caller_name: 'Ramesh',
      callback_number: '+919000000000',
      customer_type: 'buyer',
      machine_details: { brand: 'JCB', model: 'JS 205', tonnage_class: '20_ton_class' },
      commercial_terms: { budget_max_inr: 2500000, purchase_timeline: '15_to_30_days' },
      evidence_readiness: { photos_agreed: true },
    }, payload, { machDetails: mach, commTerms: comm, evReadiness: ev });

    assert.equal(mach.brand, 'JCB');
    assert.equal(mach.model, 'JS 205');
    assert.equal(mach.tonnage_class, '20_ton_class');
    assert.equal(comm.budget_max_inr, 2500000);
    assert.equal(comm.purchase_timeline, '15_to_30_days');
    assert.equal(ev.photos_agreed, true);
    assert.equal(payload.caller_name, 'Ramesh');
    assert.equal(payload.callback_number, '+919000000000');
    assert.equal(payload.customer_type, 'buyer');
  });

  it('never overwrites a value that is already present locally', () => {
    const mach = { brand: 'Tata' };
    const comm = { budget_max_inr: 9000000 };
    const payload = { customer_name: 'Local Name' };
    mergeExtractedVariables({
      caller_name: 'Dograh Name',
      machine_details: { brand: 'JCB', model: 'JS 205' },
      commercial_terms: { budget_max_inr: 2500000 },
    }, payload, { machDetails: mach, commTerms: comm, evReadiness: {} });

    assert.equal(mach.brand, 'Tata');
    assert.equal(comm.budget_max_inr, 9000000);
    assert.equal(payload.customer_name, 'Local Name');
    assert.equal(mach.model, 'JS 205');
  });

  it('never fabricates: an absent extraction field stays absent', () => {
    const mach = {};
    const comm = {};
    const ev = {};
    const payload = {};
    mergeExtractedVariables({ caller_name: 'Only A Name' }, payload, {
      machDetails: mach, commTerms: comm, evReadiness: ev,
    });

    assert.equal(mach.brand, undefined);
    assert.equal(mach.model, undefined);
    assert.equal(comm.budget_max_inr, undefined);
    assert.equal(ev.photos_agreed, undefined);
    assert.equal(payload.customer_type, undefined);
    assert.equal(payload.next_action, undefined);
  });

  it('keeps explicit false and zero values instead of treating them as absent', () => {
    const comm = {};
    const payload = {};
    mergeExtractedVariables({
      commercial_terms: { price_negotiable: false, budget_max_inr: 0 },
    }, payload, { machDetails: {}, commTerms: comm, evReadiness: {} });

    assert.equal(comm.price_negotiable, false);
    assert.equal(comm.budget_max_inr, 0);
  });

  it('does not map the call disposition onto conversation_outcome', () => {
    const payload = {};
    mergeExtractedVariables({ call_disposition: 'user_hangup' }, payload, {
      machDetails: {}, commTerms: {}, evReadiness: {},
    });
    assert.equal(payload.conversation_outcome, undefined);
  });

  it('tolerates a missing or malformed extraction payload', () => {
    const mach = {};
    const payload = {};
    mergeExtractedVariables(undefined, payload, { machDetails: mach, commTerms: {}, evReadiness: {} });
    mergeExtractedVariables('not-an-object', payload, { machDetails: mach, commTerms: {}, evReadiness: {} });
    assert.equal(mach.brand, undefined);
    assert.equal(payload.caller_name, undefined);
  });
});

describe('resolveArtifactUrl', () => {
  it('builds a browser-usable URL from a stored object key', () => {
    assert.equal(
      resolveArtifactUrl('recordings/126.wav'),
      'http://localhost:9000/voice-audio/recordings/126.wav'
    );
    assert.equal(
      resolveArtifactUrl('transcripts/127.txt'),
      'http://localhost:9000/voice-audio/transcripts/127.txt'
    );
  });

  it('passes an already absolute URL through unchanged', () => {
    assert.equal(resolveArtifactUrl('https://cdn.example.com/a.wav'), 'https://cdn.example.com/a.wav');
  });

  it('returns null for an absent or blank key', () => {
    assert.equal(resolveArtifactUrl(null), null);
    assert.equal(resolveArtifactUrl(undefined), null);
    assert.equal(resolveArtifactUrl('   '), null);
    assert.equal(resolveArtifactUrl(126), null);
  });
});

describe('evaluateCallCompletionEvidence', () => {
  it('refuses to complete a call with no transcript', () => {
    const verdict = evaluateCallCompletionEvidence({ segments: [], disposition: 'end_call' });
    assert.equal(verdict.completed, false);
    assert.equal(verdict.reason, 'no_transcript');
  });

  it('refuses to complete a cancelled call', () => {
    const verdict = evaluateCallCompletionEvidence({
      segments: [{ speaker: 'Customer', message: 'hello' }],
      disposition: 'system_cancelled',
    });
    assert.equal(verdict.completed, false);
    assert.equal(verdict.reason, 'cancelled_disposition');
  });

  it('refuses to complete a call whose conversation outcome is negative', () => {
    for (const outcome of ['No response', 'incomplete', 'opt_out', 'in_progress']) {
      const verdict = evaluateCallCompletionEvidence({
        segments: [{ speaker: 'Customer', message: 'hello' }],
        outcome,
      });
      assert.equal(verdict.completed, false, `outcome ${outcome} must block completion`);
      assert.equal(verdict.reason, 'negative_outcome');
    }
  });

  it('completes a call that has a transcript and no blocking signal', () => {
    const verdict = evaluateCallCompletionEvidence({
      segments: [{ speaker: 'Customer', message: 'namaste' }],
      disposition: 'user_hangup',
      outcome: 'inquiry',
    });
    assert.equal(verdict.completed, true);
    assert.equal(verdict.reason, 'transcript_present');
  });

  it('exposes the documented blocking outcomes and terminal statuses', () => {
    for (const value of ['no response', 'incomplete', 'opt_out', 'in_progress', 'ongoing', 'initiated']) {
      assert.ok(CALL_COMPLETION_BLOCKING_OUTCOMES.has(value), `missing blocking outcome ${value}`);
    }
    for (const value of ['completed', 'failed', 'no_answer', 'cancelled']) {
      assert.ok(CALL_TERMINAL_STATUSES.includes(value), `missing terminal status ${value}`);
    }
  });
});

describe('applyCallCompletionStatus', () => {
  it('writes nothing when there is no completion evidence', async () => {
    const stub = makeStub({ call: { id: 178, status: 'connecting', ended_at: null, duration: null } });
    const result = await applyCallCompletionStatus({
      runId: 126, orgId: 2, segments: [], disposition: 'end_call',
    }, stub.q);

    assert.equal(stub.updates.length, 0);
    assert.equal(result.transitioned, false);
    assert.equal(result.reason, 'no_transcript');
    assert.equal(result.previous_status, 'connecting');
    assert.equal(result.new_status, 'connecting');
  });

  it('never overwrites a terminal status', async () => {
    const stub = makeStub({ call: { id: 178, status: 'failed', ended_at: null, duration: null } });
    const result = await applyCallCompletionStatus({
      runId: 126,
      orgId: 2,
      segments: [{ speaker: 'Customer', message: 'hello' }],
      disposition: 'end_call',
    }, stub.q);

    assert.equal(stub.updates.length, 0);
    assert.equal(result.transitioned, false);
    assert.equal(result.reason, 'terminal_state_preserved');
    assert.equal(result.new_status, 'failed');
  });

  it('refuses to write when the call belongs to another organization', async () => {
    const stub = makeStub({
      runOrg: 1,
      call: { id: 178, status: 'connecting', ended_at: null, duration: null },
    });
    const result = await applyCallCompletionStatus({
      runId: 126,
      orgId: 2,
      segments: [{ speaker: 'Customer', message: 'hello' }],
    }, stub.q);

    assert.equal(stub.updates.length, 0);
    assert.equal(result.transitioned, false);
    assert.equal(result.reason, 'org_mismatch');
  });

  it('marks a connected call completed only when evidence exists', async () => {
    const stub = makeStub({ call: { id: 178, status: 'connecting', ended_at: null, duration: null } });
    const result = await applyCallCompletionStatus({
      runId: 126,
      orgId: 2,
      segments: [{ speaker: 'Customer', message: 'namaste' }],
      disposition: 'user_hangup',
      outcome: 'inquiry',
      durationSeconds: 42,
      startedAt: '2026-10-22T05:10:00.000Z',
    }, stub.q);

    assert.equal(stub.updates.length, 1);
    assert.ok(stub.updates[0].includes("status = 'completed'"));
    assert.ok(stub.updates[0].includes("status NOT IN ('completed','failed','no_answer','cancelled')"));
    assert.equal(result.transitioned, true);
    assert.equal(result.previous_status, 'connecting');
    assert.equal(result.new_status, 'completed');
  });

  it('does nothing when the run has no linked call row', async () => {
    const stub = makeStub({ call: null });
    const result = await applyCallCompletionStatus({
      runId: 126,
      orgId: 2,
      segments: [{ speaker: 'Customer', message: 'hello' }],
    }, stub.q);

    assert.equal(stub.updates.length, 0);
    assert.equal(result.reason, 'unlinked_run');
  });
});
