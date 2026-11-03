'use strict';
// Phase 2 Step 4A: retry-safe gathered_context merge tests.
// A thin/null retry must not clobber stored sales facts; genuine new values
// must still replace old ones. Pure-function level (no DB).
const test = require('node:test');
const assert = require('node:assert/strict');
const vaaniSales = require('../lib/vaani-sales');

const merge = vaaniSales.mergeGatheredContextPreserving;

const FULL = {
  extracted_variables: {
    customer_type: 'buyer',
    caller_name: 'ankit',
    machine_details: { brand: 'JCB', model: '3DX', machine_type: 'excavator', location_city: 'Jaipur' },
    commercial_terms: { budget_min_inr: 2000000, budget_max_inr: 2200000, price_or_budget_raw: 'bees se bais lakh', budget_qualifier: 'range', finance_required: true },
    lead_temperature: 'WARM',
    qualification_state: 'PARTIALLY_QUALIFIED',
    qualification: { status: 'PARTIALLY_QUALIFIED', collected_fields: ['machine_type', 'budget'], missing_fields: ['preferred_city'] },
    next_action: 'SEND_MACHINE_OPTIONS',
  },
  call_session: { status: 'COMPLETED', qualification_state: 'PARTIALLY_QUALIFIED' },
};

const THIN = {
  extracted_variables: {
    customer_type: 'buyer',
    machine_details: { brand: null, model: null, machine_type: null, location_city: '' },
    commercial_terms: { budget_min_inr: null, budget_max_inr: null, price_or_budget_raw: null, budget_qualifier: 'unknown', finance_required: false },
    lead_temperature: 'COLD',
    qualification_state: 'UNQUALIFIED',
    qualification: { status: 'UNQUALIFIED', collected_fields: [], missing_fields: [] },
    next_action: null,
  },
  call_session: { status: 'COMPLETED', qualification_state: 'UNQUALIFIED' },
};

test('Test 1: thin retry preserves stored facts', () => {
  const out = merge({ extracted_variables: FULL.extracted_variables, call_session: FULL.call_session }, THIN);
  const ev = out.extracted_variables;
  assert.equal(ev.machine_details.brand, 'JCB');
  assert.equal(ev.machine_details.model, '3DX');
  assert.equal(ev.machine_details.location_city, 'Jaipur');
  assert.equal(ev.commercial_terms.budget_min_inr, 2000000);
  assert.equal(ev.commercial_terms.budget_max_inr, 2200000);
  assert.equal(ev.commercial_terms.price_or_budget_raw, 'bees se bais lakh');
  assert.equal(ev.commercial_terms.budget_qualifier, 'range');
  assert.equal(ev.commercial_terms.finance_required, true);
  assert.equal(ev.qualification.status, 'PARTIALLY_QUALIFIED');
  assert.equal(out.call_session.qualification_state, 'PARTIALLY_QUALIFIED');
  assert.equal(ev.lead_temperature, 'WARM');
});

test('Test 2: genuine new value replaces old', () => {
  const out = merge({ extracted_variables: FULL.extracted_variables }, {
    extracted_variables: {
      machine_details: { brand: 'JCB', model: '3DX' },
      commercial_terms: { budget_min_inr: null, budget_max_inr: 2500000, price_or_budget_raw: '25 lakh', budget_qualifier: 'exact' },
      qualification: { status: 'QUALIFIED', collected_fields: ['machine_type', 'budget', 'preferred_city'], missing_fields: [] },
    },
  });
  const ev = out.extracted_variables;
  assert.equal(ev.commercial_terms.budget_max_inr, 2500000);
  assert.equal(ev.commercial_terms.price_or_budget_raw, '25 lakh');
  assert.equal(ev.commercial_terms.budget_min_inr, 2000000);
  assert.equal(ev.qualification.status, 'QUALIFIED');
});

test('Test 3: placeholders never clobber', () => {
  const out = merge(
    { extracted_variables: { machine_details: { location_city: 'Jaipur' }, commercial_terms: { purchase_timeline: 'within_15_30_days' } } },
    { extracted_variables: { machine_details: { location_city: 'unknown' }, commercial_terms: { purchase_timeline: 'not_applicable', budget_max_inr: 0 } } }
  );
  assert.equal(out.extracted_variables.machine_details.location_city, 'Jaipur');
  assert.equal(out.extracted_variables.commercial_terms.purchase_timeline, 'within_15_30_days');
  assert.ok(!('budget_max_inr' in out.extracted_variables.commercial_terms) || out.extracted_variables.commercial_terms.budget_max_inr === null || out.extracted_variables.commercial_terms.budget_max_inr === undefined);
});

test('Test 3b: DNC disqualification always applies', () => {
  const out = merge({ extracted_variables: FULL.extracted_variables }, {
    extracted_variables: { dnc_requested: true, qualification: { status: 'DISQUALIFIED', collected_fields: [], missing_fields: [] } },
  });
  assert.equal(out.extracted_variables.qualification.status, 'DISQUALIFIED');
  assert.equal(out.extracted_variables.dnc_requested, true);
});

test('Test 4: qualification behavior unchanged (empty stays empty)', () => {
  const C = vaaniSales.evaluateQualificationCompleteness;
  assert.equal(C('buyer', {}).status, 'UNQUALIFIED');
  assert.equal(C('buyer', { machine_type: 'x', budget_max: 1, preferred_city: 'y', purchase_timeline: 'z' }).status, 'QUALIFIED');
});
