'use strict';
// Goal 24 deterministic lead-qualification tests. Pure-function coverage of
// completeness, resolvers, and normalizers; source-level guards that no
// scores/temperatures/predictions were introduced; regression that legacy
// qualification vocabulary and structures are preserved. No network, no
// database writes, no secrets, no PSTN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const C = vaaniSales.evaluateQualificationCompleteness;
const R = vaaniSales.resolveQualificationFields;

test('buyer example from spec: collected vs missing without invention', () => {
  // Excavator + JCB + 18L budget + Alwar; no model, new/used, timeline, finance.
  const out = C('buyer', {
    machine_type: 'Excavator', brand: 'JCB', model: null,
    budget_max: 1800000, budget_min: null, preferred_city: 'Alwar',
    new_or_used: null, purchase_timeline: null,
  });
  assert.equal(out.status, 'PARTIALLY_QUALIFIED');
  assert.deepEqual(out.collected_fields, ['machine_type', 'budget', 'preferred_city']);
  assert.deepEqual(out.missing_fields, ['purchase_timeline']);
});

test('seller example from spec: full capture qualifies', () => {
  const out = C('seller', {
    machine_type: 'Excavator', brand: 'JCB', model: '3DX', year: 2020,
    hours: 4500, condition: null, availability_status: null,
    asking_price: 1900000, machine_location: 'Alwar',
  });
  assert.equal(out.status, 'PARTIALLY_QUALIFIED');
  assert.ok(!out.collected_fields.includes('condition'), 'condition genuinely missing');
  assert.ok(out.missing_fields.includes('condition'), 'condition reported missing');
  assert.ok(out.missing_fields.includes('availability_status'), 'availability reported missing');
  const full = C('seller', {
    machine_type: 'Excavator', brand: 'JCB', model: '3DX', year: 2020,
    hours: 4500, condition: 'Good', availability_status: 'Ready',
    asking_price: 1900000, machine_location: 'Alwar',
  });
  assert.equal(full.status, 'QUALIFIED');
  assert.deepEqual(full.missing_fields, []);
});

test('empty and unknown inputs never fabricate qualification', () => {
  assert.deepEqual(C('buyer', {}), { status: 'UNQUALIFIED', collected_fields: [], missing_fields: ['machine_type', 'budget', 'preferred_city', 'purchase_timeline'] });
  assert.deepEqual(C('seller', null).status, 'UNQUALIFIED');
  assert.deepEqual(C('buyer', { machine_type: 'unknown', budget_max: 0, preferred_city: '', new_or_used: 'UNKNOWN', purchase_timeline: null }).status, 'UNQUALIFIED');
  assert.deepEqual(C('mystery', { machine_type: 'Excavator' }), { status: 'UNQUALIFIED', collected_fields: [], missing_fields: [] });
  assert.deepEqual(C('buyer', {}, true).status, 'DISQUALIFIED');
});

test('budget range counts without a max, schemas never merge', () => {
  const out = C('buyer', { budget_min: 1500000 });
  assert.ok(out.collected_fields.includes('budget'), 'budget_min alone satisfies budget');
  const seller = C('seller', { machine_type: 'Excavator' });
  assert.ok(!seller.collected_fields.includes('budget'), 'no buyer-only keys in seller schema');
  assert.ok(seller.missing_fields.includes('asking_price'), 'seller keeps its own price key');
  const buyer = C('buyer', { asking_price: 999 });
  assert.ok(!buyer.collected_fields.includes('asking_price'), 'no seller-only keys in buyer schema');
});

test('finance and payment extract only when actually present', () => {
  assert.equal(vaaniSales.normalizeFinanceRequired(true), true);
  assert.equal(vaaniSales.normalizeFinanceRequired(false), false);
  assert.equal(vaaniSales.normalizeFinanceRequired('yes'), true);
  assert.equal(vaaniSales.normalizeFinanceRequired('no'), false);
  assert.equal(vaaniSales.normalizeFinanceRequired('maybe'), null);
  assert.equal(vaaniSales.normalizeFinanceRequired(null), null);
  assert.equal(vaaniSales.normalizePaymentMode('finance'), 'finance');
  assert.equal(vaaniSales.normalizePaymentMode('FULL_PAYMENT'), 'full_payment');
  assert.equal(vaaniSales.normalizePaymentMode('emi'), null);
  assert.equal(vaaniSales.normalizePaymentMode(null), null);
  assert.equal(vaaniSales.normalizeNewOrUsed('Used'), 'used');
  assert.equal(vaaniSales.normalizeNewOrUsed('NEW'), 'new');
  assert.equal(vaaniSales.normalizeNewOrUsed('refurbished'), null);
  const out = C('buyer', {
    machine_type: 'Excavator', budget_max: 1800000, preferred_city: 'Alwar',
    new_or_used: 'used', purchase_timeline: 'immediate',
    finance_required: false, payment_mode: 'full_payment',
  });
  assert.equal(out.status, 'QUALIFIED');
});

test('resolver aligns aliases without inventing values', () => {
  const b = R('buyer', { buyer_budget_max_inr: 1800000, machine_location_city: 'Alwar', used_or_refurbished: 'used' });
  assert.equal(b.budget_max, 1800000);
  assert.equal(b.preferred_city, 'Alwar');
  assert.equal(b.new_or_used, 'used');
  assert.equal(b.machine_type, null);
  const s = R('seller', { machine_brand: 'JCB', model_year: 2020, running_hours: 4800, component_condition: 'Good' });
  assert.equal(s.brand, 'JCB');
  assert.equal(s.year, 2020);
  assert.equal(s.hours, 4800);
  assert.equal(s.condition, 'Good');
  assert.deepEqual(R('other', { machine_type: 'X' }), {});
  assert.deepEqual(R('buyer', null).machine_type, null);
});

test('legacy qualification gate behavior is preserved', () => {
  const q = vaaniSales.evaluateQualification;
  assert.equal(q('buyer', { brand: 'JCB' }, { budget_max_inr: 1800000 }, 'Alwar', false), 'QUALIFIED');
  assert.equal(q('buyer', { brand: 'JCB' }, {}, null, false), 'PARTIALLY_QUALIFIED');
  assert.equal(q('buyer', {}, {}, null, false), 'UNQUALIFIED');
  assert.equal(q('buyer', { brand: 'JCB' }, { budget_max_inr: 1 }, 'X', true), 'DISQUALIFIED');
  assert.equal(q('seller', { brand: 'B', model: 'M' }, { expected_price_inr: 5 }, 'C', false), 'QUALIFIED');
  assert.equal(q('unknown', {}, {}, null, false), 'UNQUALIFIED');
});

test('no scores, temperatures, or predictions in the new layer', () => {
  const libSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8'));
  const blocks = libSrc.split('function evaluateQualificationCompleteness')[1].split('function evaluateQualification(')[0]
    + libSrc.split('function resolveQualificationFields')[1].split(/^function evaluateLeadTemperature/m)[0];
  for (const bad of ['HOT', 'WARM', 'COLD', 'score', 'probability', 'predict', 'rank']) {
    assert.ok(!blocks.includes(bad), 'completeness layer must not contain ' + bad);
  }
});

test('extracted_variables and gathered_context structures preserved', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  for (const key of ['machine_details', 'commercial_terms', 'evidence_readiness', 'lead_temperature', 'qualification_state', 'conversation_outcome', 'next_action', 'follow_up_required', 'call_notes']) {
    assert.ok(libSrc.includes(key), 'legacy key still present: ' + key);
  }
  assert.ok(libSrc.includes('qualification: {'), 'qualification object persisted');
  assert.ok(libSrc.includes('missing_info'), 'audit missing_info filled, not duplicated');
});

test('cross-org posture unchanged: no new unscoped endpoints', () => {
  const routes = [...serverSrc.matchAll(/route === '([^']+)'/g)].map((m) => m[1]);
  assert.ok(!routes.some((r) => /qualif/i.test(r)), 'no new qualification routes');
  assert.ok(serverSrc.includes('core.requireAuth'), 'sales routes are auth gated');
});

test('failed and no-answer calls cannot fabricate qualification', () => {
  assert.equal(C('buyer', {}).status, 'UNQUALIFIED');
  const libSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8'));
  assert.ok(!/failed|no_answer/.test(libSrc.split('function evaluateQualificationCompleteness')[1].split('function evaluateQualification(')[0]), 'no lifecycle coupling in pure layer');
});

test('drawer shows qualification status from lead-360', () => {
  const code = strip(dashSrc);
  assert.ok(dashSrc.includes('id="drawerStage"'), 'status container present');
  assert.ok(code.includes('l360.qualification_state'), 'rendered from lead-360 qualification');
  assert.ok(!/AI Sales Agent|RapidX/.test(dashSrc), 'no banned branding in dashboard');
});
