'use strict';
// Step 1A: stubbed-DB integration verification of the real ingestCallComplete
// path: transcript -> extractFromConversationLLM(stubbed) ->
// applyDeterministicBackstop -> evaluateFollowUp -> mergedExtracted /
// callSession -> persisted workflow_runs SQL. Supabase is never touched:
// the supadb transport, LLM extractor, and task runner are stubbed in the
// require cache before vaani-sales loads. No network, no secrets, no PSTN.
const test = require('node:test');
const assert = require('node:assert/strict');

// ---- stubs (must be installed before requiring vaani-sales) ----
const llmPath = require.resolve('../lib/vaani-llm-extractor');
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: {
    extractFromConversationLLM: async () => ({
      extracted: {
        customer_type: null, lead_temperature: null, next_action: null,
        caller_name: null, follow_up_required: null, dnc_requested: false,
        sales_priority: null, priority_reason: null, deal_readiness: null,
        deal_ready_reason: null, owner_summary: null, lead_status: null,
        whatsapp_requested: false, whatsapp_action: null,
        availability_status: null, machine_details: {},
        commercial_terms: {}, evidence_readiness: {},
      },
    }),
  },
};
const tasksPath = require.resolve('../lib/vaani-tasks');
require.cache[tasksPath] = {
  id: tasksPath, filename: tasksPath, loaded: true,
  exports: { processCallFollowUpTasks: async () => [] },
};
const sentSql = [];
const supadbPath = require.resolve('../lib/supadb');
require.cache[supadbPath] = {
  id: supadbPath, filename: supadbPath, loaded: true,
  exports: {
    // Bare '1' resolves the owner org; everything else reads back empty.
    queryTextCallback: (sql, _opts, cb) => {
      sentSql.push(sql);
      if (/FROM workflows WHERE id/.test(sql)) return cb(null, '{"organization_id":1}', '');
      if (/FROM workflow_runs r JOIN workflows/.test(sql)) return cb(null, '1', '');
      return cb(null, '[]', '');
    },
  },
};

const vaaniSales = require('../lib/vaani-sales');

const basePayload = (transcript, extra = {}) => ({
  primary_phone: '+919999900001',
  run_id: 900001,
  workflow_id: 3,
  customer_type: 'buyer',
  conversation_outcome: 'callback_requested',
  follow_up_required: true,
  transcript,
  ...extra,
});

// Expected datetimes use the app's own server-local wall-clock convention
// (same frame as the next-morning-11:00 default).
const tomorrowAt = (h) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  return d;
};

test('1A-1. explicit "kal ek baje" survives to persisted CRM field', async () => {
  sentSql.length = 0;
  const out = await vaaniSales.ingestCallComplete(
    basePayload('caller: mujhe JCB chahiye\ncaller: kal ek baje call karna'));
  const expected = tomorrowAt(13).toISOString();
  assert.equal(out.follow_up.datetime, expected);
  assert.equal(out.follow_up.required, true);
  const persisted = sentSql.join('\n');
  assert.ok(persisted.includes('INSERT INTO workflow_runs'), 'workflow_runs upsert issued');
  assert.ok(persisted.includes(`follow_up_datetime\\":\\"${expected}`)
    || persisted.includes(`follow_up_datetime":"${expected}`),
  'merged extracted_variables carry the explicit datetime');
});

test('1A-2. transcript without callback keeps existing default behavior', async () => {
  sentSql.length = 0;
  const out = await vaaniSales.ingestCallComplete(
    basePayload('caller: machine ke baare mein jankari chahiye'));
  const expected = tomorrowAt(11).toISOString();
  assert.equal(out.follow_up.datetime, expected);
  assert.equal(out.follow_up.required, true);
});

test('1A-3. pre-set payload datetime is never overwritten by transcript parse', async () => {
  const preset = '2026-10-20T05:30:00.000Z';
  sentSql.length = 0;
  const out = await vaaniSales.ingestCallComplete(
    basePayload('caller: kal ek baje call karna', { follow_up_datetime: preset }));
  assert.equal(out.follow_up.datetime, preset);
  assert.ok(sentSql.join('\n').includes(preset), 'preset datetime persisted');
});
