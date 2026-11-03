'use strict';
// VAANI-001: Buyer/seller classification mapping regression tests.
// VAANI-003: SQL parameterization regression tests for customer/call endpoints.
// No network, no secrets, no live database, no PSTN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ============================================================================
// VAANI-001: Classification mapping tests
// Tests ingestCallComplete with stubbed DB + LLM extractor to verify explicit,
// validated precedence: customer_type > buyer_seller_classification > intent.
// Ambiguous/unrecognized values never silently become buyer or seller.
// ============================================================================

// Stub the LLM extractor before requiring vaani-sales
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
    queryTextCallback: (sql, _opts, cb) => {
      sentSql.push(sql);
      if (/FROM workflows WHERE id/.test(sql)) return cb(null, '{"organization_id":1}', '');
      if (/FROM workflow_runs r JOIN workflows/.test(sql)) return cb(null, '1', '');
      return cb(null, '[]', '');
    },
  },
};

const vaaniSales = require('../lib/vaani-sales');

function basePayload(extra = {}) {
  return {
    primary_phone: '+919999900001',
    run_id: 900001,
    workflow_id: 3,
    customer_type: 'buyer',
    conversation_outcome: 'callback_requested',
    follow_up_required: true,
    transcript: 'caller: hello',
    ...extra,
  };
}

// Extract the customer_type value from the persisted extracted_variables JSON
function persistedCustomerType() {
  const sql = sentSql.join('\n');
  const m = sql.match(/"customer_type":"([^"]+)"/);
  return m ? m[1] : null;
}

test('VAANI-001: customer_type takes precedence over buyer_seller_classification', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: 'buyer',
      extracted_variables: { buyer_seller_classification: 'seller' },
    })
  );
  assert.equal(persistedCustomerType(), 'buyer');
});

test('VAANI-001: buyer_seller_classification takes precedence over intent', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: null,
      extracted_variables: {
        buyer_seller_classification: 'seller',
        intent: 'purchase',
      },
    })
  );
  assert.equal(persistedCustomerType(), 'seller');
});

test('VAANI-001: intent maps to buyer when only intent is present', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: null,
      extracted_variables: { buyer_seller_classification: null, intent: 'purchase' },
    })
  );
  assert.equal(persistedCustomerType(), 'buyer');
});

test('VAANI-001: intent maps to seller when only intent is present', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: null,
      extracted_variables: { buyer_seller_classification: null, intent: 'sell' },
    })
  );
  assert.equal(persistedCustomerType(), 'seller');
});

test('VAANI-001: ambiguous values resolve to unknown, not buyer or seller', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: 'maybe',
      extracted_variables: { buyer_seller_classification: 'unknown', intent: 'ambiguous_xyz' },
    })
  );
  assert.equal(persistedCustomerType(), 'unknown');
});

test('VAANI-001: missing all classification fields resolves to unknown', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: null,
      extracted_variables: {},
    })
  );
  assert.equal(persistedCustomerType(), 'unknown');
});

test('VAANI-001: LLM extraction override only applies valid buyer/seller/other values (source inspection)', () => {
  const vsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  // The override must call normalizeCustomerType on the LLM result
  assert.ok(vsSrc.includes('normalizeCustomerType(extractionResult.extracted.customer_type)'),
    'LLM extraction must normalize customer_type via normalizeCustomerType');
  // The override must guard with 'if (transType)' so ambiguous values don't override
  assert.ok(/if\s*\(\s*transType\s*\)/.test(vsSrc),
    'LLM override must guard with if(transType) so ambiguous/null values are skipped');
  // The override assigns customerType = transType
  assert.ok(vsSrc.includes('customerType = transType'),
    'LLM override must assign customerType = transType when valid');
});

test('VAANI-001: LLM extraction override with null/ambiguous value is skipped (source inspection)', () => {
  const vsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  // normalizeCustomerType returns null for ambiguous/unrecognized values
  // The 'if (transType)' guard ensures null/ambiguous LLM output never overrides
  assert.ok(/if\s*\(\s*transType\s*\)\s*\{/.test(vsSrc),
    'LLM override must be guarded by if(transType) to skip ambiguous values');
});

test('VAANI-001: null customer_type falls through to buyer_seller_classification', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: null,
      extracted_variables: { buyer_seller_classification: 'seller', intent: 'purchase' },
    })
  );
  assert.equal(persistedCustomerType(), 'seller');
});

test('VAANI-001: empty string customer_type falls through to next source', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: '',
      extracted_variables: { buyer_seller_classification: 'seller', intent: 'purchase' },
    })
  );
  assert.equal(persistedCustomerType(), 'seller');
});

test('VAANI-001: buyer_seller_classification with "not_interested" maps to other', async () => {
  sentSql.length = 0;
  await vaaniSales.ingestCallComplete(
    basePayload({
      customer_type: null,
      extracted_variables: { buyer_seller_classification: 'not_interested', intent: null },
    })
  );
  assert.equal(persistedCustomerType(), 'other');
});

// ============================================================================
// VAANI-003: SQL parameterization tests
// Tests that customer/call endpoints in server.js use parameterized queries
// instead of interpolated SQL strings. No live database required.
// ============================================================================

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function findFunction(name) {
  const re = new RegExp('async function ' + name + '\\(req, res, ctx\\) \\{[\\s\\S]*?\\n\\}');
  const m = serverSrc.match(re);
  assert.ok(m, name + ' found in server.js');
  return m[0];
}

const manualEscapePattern = "replace(/'/g, \"''\")";

test('VAANI-003: apiVaaniCustomerCreate uses parameterized query (no interpolated values)', () => {
  const fn = findFunction('apiVaaniCustomerCreate');
  assert.ok(fn.includes('queryPostgres'), 'apiVaaniCustomerCreate must use queryPostgres');
  assert.ok(fn.includes('$1') && fn.includes('$2') && fn.includes('$3'),
    'apiVaaniCustomerCreate must use parameterized $1, $2, $3 placeholders');
  assert.ok(!fn.includes("VALUES ('${"), 'apiVaaniCustomerCreate must NOT interpolate VALUES with template literals');
  assert.ok(!fn.includes(manualEscapePattern), 'apiVaaniCustomerCreate must NOT use manual SQL string escaping');
});

test('VAANI-003: apiVaaniCustomerDetail uses parameterized query', () => {
  const fn = findFunction('apiVaaniCustomerDetail');
  assert.ok(fn.includes('queryPostgres'), 'apiVaaniCustomerDetail must use queryPostgres');
  assert.ok(fn.includes('$1'), 'apiVaaniCustomerDetail must use parameterized $1 placeholder');
  assert.ok(!fn.includes('${parseInt(id)}'), 'apiVaaniCustomerDetail must NOT interpolate id with template literal');
});

test('VAANI-003: apiVaaniCallDetail uses parameterized queries', () => {
  const fn = findFunction('apiVaaniCallDetail');
  assert.ok(fn.includes('queryPostgres'), 'apiVaaniCallDetail must use queryPostgres');
  assert.ok(fn.includes('$1'), 'apiVaaniCallDetail must use parameterized $1 placeholder');
  assert.ok(!fn.includes('${parseInt(id)}'), 'apiVaaniCallDetail must NOT interpolate id with template literal');
});

test('VAANI-003: apiVaaniDemoCallComplete uses parameterized queries for inserts', () => {
  const fn = findFunction('apiVaaniDemoCallComplete');
  assert.ok(fn.includes('queryPostgres'), 'apiVaaniDemoCallComplete must use queryPostgres');
  assert.ok(fn.includes('$1'), 'apiVaaniDemoCallComplete must use parameterized placeholders');
  assert.ok(!fn.includes("'${esc("), 'apiVaaniDemoCallComplete must NOT interpolate with esc()');
  assert.ok(!fn.includes('VALUES (${parseInt(customerId)}'), 'apiVaaniDemoCallComplete must NOT interpolate customerId');
});

test('VAANI-003: No remaining interpolated SQL in customer/call endpoints', () => {
  const customerCreate = findFunction('apiVaaniCustomerCreate');
  const customerDetail = findFunction('apiVaaniCustomerDetail');
  const callDetail = findFunction('apiVaaniCallDetail');
  const demoCall = findFunction('apiVaaniDemoCallComplete');

  const allFns = [customerCreate, customerDetail, callDetail, demoCall];
  for (const fn of allFns) {
    assert.ok(!fn.includes('queryTextCallback'),
      'Function must not use vulnerable queryTextCallback');
    assert.ok(!fn.match(/VALUES\s*\([^)]*\$\{/),
      'Function must not interpolate values into SQL VALUES');
  }
});
