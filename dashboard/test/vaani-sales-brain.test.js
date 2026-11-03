'use strict';
// Goal 26 Sales Brain tests. Pure deterministic unit tests over
// buildSalesBrain plus source and contract assertions for wiring, org
// isolation, and no-prediction guarantees. No network, no database writes,
// no secrets, no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const B = vaaniSales.buildSalesBrain;

function buyerInput(over = {}) {
  return {
    customer_type: 'buyer',
    identity: { name: 'Asha Singh', phone: '+919999900001', city: 'Alwar' },
    requirement: {
      machine_type: 'Excavator', budget_max: 1800000, budget_min: null,
      preferred_city: 'Alwar', new_or_used: null, purchase_timeline: null,
    },
    qualification: { status: 'PARTIALLY_QUALIFIED', collected_fields: ['machine_type', 'budget', 'preferred_city'], missing_fields: ['new_or_used', 'purchase_timeline'] },
    inventory_matches: [],
    calls: [],
    ...over,
  };
}
function sellerInput(over = {}) {
  return {
    customer_type: 'seller',
    identity: { name: 'Ravi Kumar', phone: '+919999900002', city: 'Ajmer' },
    requirement: {
      machine_type: 'Excavator', brand: 'JCB', model: '3DX', year: 2020,
      hours: 4500, condition: null, availability_status: null,
      asking_price: 1900000, machine_location: 'Ajmer',
    },
    qualification: { status: 'PARTIALLY_QUALIFIED', collected_fields: ['machine_type', 'brand', 'model', 'year', 'hours', 'asking_price', 'machine_location'], missing_fields: ['condition', 'availability_status'] },
    inventory_matches: [],
    calls: [],
    ...over,
  };
}

test('buyer context builds correctly with purchase intent', () => {
  const out = B(buyerInput());
  assert.equal(out.customer_type, 'buyer');
  assert.equal(out.intent.primary, 'purchase');
  assert.equal(out.intent.confidence, 'known');
  assert.deepEqual(out.customer_identity, { name: 'Asha Singh', phone: '+919999900001', city: 'Alwar' });
  assert.equal(out.requirement.machine_type, 'Excavator');
});

test('seller context builds correctly with sell intent', () => {
  const out = B(sellerInput());
  assert.equal(out.customer_type, 'seller');
  assert.equal(out.intent.primary, 'sell');
  assert.equal(out.requirement.brand, 'JCB');
  assert.equal(out.requirement.asking_price, 1900000);
});

test('unknown customer type remains unknown without invention', () => {
  const out = B({ customer_type: 'dnc' });
  assert.equal(out.customer_type, 'unknown');
  assert.equal(out.intent.primary, 'unknown');
  assert.equal(out.intent.confidence, 'unknown');
  assert.deepEqual(B(null).conversation_context.known_facts, []);
});

test('buyer intent is purchase and seller intent is sell', () => {
  assert.equal(B(buyerInput()).intent.primary, 'purchase');
  assert.equal(B(sellerInput()).intent.primary, 'sell');
});

test('existing requirement fields are reused verbatim', () => {
  const out = B(buyerInput());
  assert.equal(out.requirement.budget_max, 1800000);
  assert.equal(out.requirement.preferred_city, 'Alwar');
  assert.equal(out.requirement.budget_min, null);
});

test('missing requirement fields are identified from qualification', () => {
  const out = B(buyerInput());
  assert.deepEqual(out.sales_focus.next_information_to_collect, ['new_or_used', 'purchase_timeline']);
  assert.deepEqual(out.qualification.missing_fields, ['new_or_used', 'purchase_timeline']);
});

test('qualification status from Goal 24 is preserved', () => {
  assert.equal(B(buyerInput()).qualification.status, 'PARTIALLY_QUALIFIED');
  assert.equal(B(buyerInput({ qualification: null })).qualification.status, 'UNQUALIFIED');
  const q = B(buyerInput({ qualification: { status: 'QUALIFIED', collected_fields: ['a'], missing_fields: [] } }));
  assert.equal(q.sales_focus.current_stage, 'requirement_recorded');
});

test('inventory matches from Goal 25 are included with best-first subset', () => {
  const matches = [
    { machine_id: 'm1', brand: 'JCB', model: '3DX', match_score: 100 },
    { machine_id: 'm2', brand: 'JCB', model: '4DX', match_score: 82 },
    { machine_id: 'm3', brand: 'JCB', model: '5DX', match_score: 70 },
    { machine_id: 'm4', brand: 'JCB', model: '6DX', match_score: 60 },
  ];
  const out = B(buyerInput({ inventory_matches: matches }));
  assert.equal(out.inventory_context.count, 4);
  assert.deepEqual(out.inventory_context.matches, matches);
  assert.deepEqual(out.inventory_context.best_matches.map((m) => m.machine_id), ['m1', 'm2', 'm3']);
  assert.equal(B(buyerInput()).inventory_context.count, 0);
  assert.deepEqual(B(buyerInput()).inventory_context.best_matches, []);
});

test('empty inventory produces honest empty context', () => {
  const out = B(buyerInput({ inventory_matches: 'nope' }));
  assert.equal(out.inventory_context.count, 0);
  assert.deepEqual(out.inventory_context.matches, []);
});

test('previous call count is preserved from linked calls', () => {
  const calls = [
    { conversation_outcome: 'inquiry', transcript: [{ speaker: 'Vaani', message: 'Hi' }] },
    { conversation_outcome: 'callback_requested', transcript: [] },
  ];
  const out = B(buyerInput({ calls }));
  assert.equal(out.conversation_context.call_count, 2);
  assert.ok(out.conversation_context.previous_topics.includes('inquiry'));
  assert.ok(out.conversation_context.previous_topics.includes('callback_requested'));
  assert.ok(out.conversation_context.previous_topics.some((t) => /1 recorded exchanges/.test(t)));
});

test('transcript facts reused only when actually present', () => {
  const withTx = B(buyerInput({ calls: [{ transcript: [{ speaker: 'V', message: 'x' }, { speaker: 'C', message: 'y' }] }] }));
  assert.ok(withTx.conversation_context.previous_topics.some((t) => /2 recorded exchanges/.test(t)));
  const withoutTx = B(buyerInput({ calls: [{ conversation_outcome: 'inquiry' }] }));
  assert.ok(!withoutTx.conversation_context.previous_topics.some((t) => /exchanges/.test(t)));
  assert.deepEqual(B(buyerInput({ calls: 'nope' })).conversation_context.previous_topics, []);
});

test('known facts come only from collected fields, never fabricated', () => {
  const out = B(buyerInput());
  assert.ok(out.conversation_context.known_facts.some((f) => /Excavator/.test(f)));
  assert.ok(out.conversation_context.known_facts.some((f) => /18/.test(f) && /L/.test(f)));
  assert.ok(!out.conversation_context.known_facts.some((f) => /timeline|Timeline/.test(f) && /null/i.test(f)), 'no null facts listed');
  const empty = B({ customer_type: 'buyer', requirement: {}, qualification: null });
  assert.deepEqual(empty.conversation_context.known_facts, []);
});

test('already-known fields appear in avoid-reasking', () => {
  const out = B(buyerInput());
  assert.deepEqual(out.sales_focus.avoid_reasking, ['machine_type', 'budget', 'preferred_city']);
  assert.ok(!out.sales_focus.avoid_reasking.includes('purchase_timeline'), 'missing fields never listed as known');
});

test('missing fields appear in next-information-to-collect', () => {
  const out = B(sellerInput());
  assert.deepEqual(out.sales_focus.next_information_to_collect, ['condition', 'availability_status']);
});

test('buyer and seller contexts do not mix schemas', () => {
  const b = B(buyerInput());
  assert.ok(!('asking_price' in b.requirement) || b.requirement.asking_price === undefined, 'no seller price key on buyer');
  assert.ok(!b.sales_focus.next_information_to_collect.includes('asking_price'));
  const s = B(sellerInput());
  assert.ok(!s.sales_focus.next_information_to_collect.includes('purchase_timeline'));
  assert.ok(!s.sales_focus.next_information_to_collect.includes('budget'));
});

test('org isolation enforced through existing lead360 path', () => {
  assert.ok(libSrc.includes('WHERE w.organization_id = $1'), 'lead360 stays org-filtered');
  assert.ok(!/['"]\/api\/[^'"]*brain/i.test(serverSrc), 'no new brain routes; existing org gates rule');
});

test('unresolved ownership fails closed via existing gates', () => {
  assert.ok(serverSrc.includes('call does not belong to this organization'), 'call ownership gate intact');
  assert.ok(serverSrc.includes('organization not linked'), 'org gate intact');
});

test('no cross-org transcript or inventory leakage vectors added', () => {
  const code = strip(libSrc);
  const brainFn = code.split('function buildSalesBrain')[1].split('\nfunction resolveQualificationFields(')[0];
  assert.ok(!brainFn.includes('queryPostgres'), 'composer is pure: zero database reads');
  assert.ok(!brainFn.includes('organization_id'), 'composer takes no org input; callers scope');
});

test('no predictive score is generated anywhere in the brain', () => {
  const brainFn = strip(libSrc).split('function buildSalesBrain')[1].split('\nfunction resolveQualificationFields(')[0];
  for (const bad of ['HOT', 'WARM', 'COLD', 'probability', 'predict', 'conversion', 'lead_score', 'sales_score', 'temperature']) {
    assert.ok(!brainFn.includes(bad), 'brain must not contain ' + bad);
  }
  assert.ok(!/hot|warm|cold/i.test(JSON.stringify(B(buyerInput()))), 'output carries no temperature words');
});

test('no hot/warm/cold classification or conversion probability in output', () => {
  const dumped = JSON.stringify([B(buyerInput()), B(sellerInput())]);
  assert.ok(!/hot|warm|cold|probability|conversion|score/i.test(dumped), 'clean output');
});

test('no conversion probability or scoring fields in shape', () => {
  const keys = Object.keys(B(buyerInput()));
  assert.deepEqual(keys, ['customer_type', 'customer_identity', 'intent', 'requirement', 'qualification', 'inventory_context', 'conversation_context', 'sales_focus']);
});

test('no database mutation in read-only brain generation', () => {
  const brainFn = strip(libSrc).split('function buildSalesBrain')[1].split('\nfunction resolveQualificationFields(')[0];
  assert.ok(!/INSERT|UPDATE|DELETE|queryPostgres|fetch\(/.test(brainFn), 'pure computation only');
});

test('deterministic output for identical input', () => {
  const a = B(buyerInput({ calls: [{ conversation_outcome: 'inquiry' }] }));
  const b = B(JSON.parse(JSON.stringify(buyerInput({ calls: [{ conversation_outcome: 'inquiry' }] }))));
  assert.deepEqual(a, b);
});

test('drawer renders brain without banned branding', () => {
  const code = strip(dashSrc);
  assert.ok(dashSrc.includes('id="drawerBrainStage"'), 'stage container present');
  assert.ok(dashSrc.includes('l360.sales_brain'), 'rendered from lead360 brain');
  assert.ok(!/AI Sales Agent|RapidX/.test(dashSrc), 'no banned branding');
});
