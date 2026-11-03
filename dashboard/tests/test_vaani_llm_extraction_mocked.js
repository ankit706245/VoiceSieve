'use strict';
// Phase 2 Sales Intelligence: repeatable mocked-LLM extraction contract tests.
// No network, no Supabase, no VAANI_DATABASE_URL, no Workflow 3 access.
// Run: GROQ_API_KEY=dummy node --test dashboard/tests/test_vaani_llm_extraction_mocked.js
// NOTE: lib/vaani-llm-extractor.js reads GROQ_API_KEY at module load time,
// so the dummy value must be supplied in the test process env (see Run line).
// It is never written to disk and never printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');

const { extractFromConversationLLM } = require('../lib/vaani-llm-extractor');

const realRequest = https.request;
let queue = [];
let lastOptions = null;

// Mock transport: serve queued inner LLM JSON strings inside a fake Groq
// outer envelope. No sockets are ever opened.
https.request = (options, callback) => {
  lastOptions = options;
  const inner = queue.length ? queue.shift() : '{}';
  const outer = JSON.stringify({ choices: [{ message: { content: inner } }] });
  const res = {
    statusCode: 200,
    on: (event, handler) => {
      if (event === 'data') handler(outer);
      if (event === 'end') handler();
    },
  };
  if (callback) callback(res);
  return { on: () => {}, write: () => {}, end: () => {} };
};

test.after(() => { https.request = realRequest; });
test.beforeEach(() => { queue = []; lastOptions = null; });

test('buyer intent returns MATCH_BUYER with mapped machine and budget', async () => {
  queue.push(JSON.stringify({
    customer_type: 'buyer',
    lead_temperature: 'HOT',
    sales_priority: 'HIGH',
    priority_reason: 'Urgent purchase with budget stated.',
    deal_readiness: 'QUALIFYING',
    next_action: 'MATCH_BUYER',
    follow_up_required: true,
    buyer_info: {
      required_machine_brand: 'JCB',
      required_machine_model: '3DX',
      budget: 1800000,
      price_or_budget_raw: '18 lakh',
      budget_qualifier: 'exact',
    },
  }));
  const res = await extractFromConversationLLM([
    { role: 'user', text: 'JCB 3DX chahiye, 2020 ke aas paas, budget 18 lakh, Alwar me chahiye, jaldi lena hai.' },
  ]);
  assert.equal(res.extracted.customer_type, 'buyer');
  assert.equal(res.extracted.next_action, 'MATCH_BUYER');
  assert.equal(res.extracted.follow_up_required, true);
  assert.equal(res.extracted.machine_details.brand, 'JCB');
  assert.equal(res.extracted.machine_details.model, '3DX');
  assert.equal(res.extracted.commercial_terms.budget_max_inr, 1800000);
  assert.equal(lastOptions.hostname, 'api.groq.com');
});

test('seller intent returns REQUEST_MACHINE_PHOTOS with mapped machine', async () => {
  queue.push(JSON.stringify({
    customer_type: 'seller',
    lead_temperature: 'WARM',
    sales_priority: 'MEDIUM',
    deal_readiness: 'QUALIFYING',
    next_action: 'REQUEST_MACHINE_PHOTOS',
    follow_up_required: true,
    seller_info: {
      machine_brand: 'Tata Hitachi',
      machine_model: 'EX 200LC',
      machine_year: 2018,
      running_hours: 6400,
    },
  }));
  const res = await extractFromConversationLLM(
    'Machine bechni hai, Tata Hitachi EX 200LC 2018 model, 6400 hours chali hai.'
  );
  assert.equal(res.extracted.customer_type, 'seller');
  assert.equal(res.extracted.next_action, 'REQUEST_MACHINE_PHOTOS');
  assert.equal(res.extracted.follow_up_required, true);
  assert.equal(res.extracted.machine_details.brand, 'Tata Hitachi');
  assert.equal(res.extracted.machine_details.model, 'EX 200LC');
  assert.equal(res.extracted.machine_details.model_year, 2018);
  assert.equal(lastOptions.hostname, 'api.groq.com');
});

test('DO_NOT_CALL returns NO_FOLLOW_UP with follow_up_required=false', async () => {
  queue.push(JSON.stringify({
    customer_type: 'unknown',
    lead_temperature: 'DO_NOT_CALL',
    sales_priority: 'LOW',
    deal_readiness: 'DO_NOT_CALL',
    next_action: 'NO_FOLLOW_UP',
    follow_up_required: false,
  }));
  const res = await extractFromConversationLLM('Mujhe dobara call mat karna. Stop calling me!');
  assert.equal(res.extracted.lead_temperature, 'DO_NOT_CALL');
  assert.equal(res.extracted.next_action, 'NO_FOLLOW_UP');
  assert.equal(res.extracted.follow_up_required, false);
  assert.equal(res.extracted.dnc_requested, true);
});

test('malformed LLM JSON fails closed with parse error, invents nothing', async () => {
  queue.push('THIS IS NOT JSON {{{');
  await assert.rejects(
    extractFromConversationLLM('hello'),
    /Failed to parse JSON/
  );
});
