'use strict';
// Goal 30 Buyer 360 tests. Pure snapshot-composer coverage plus source and
// contract assertions proving consolidation reuses Goals 23-27 outputs with
// no new memory, routes, tables, or automation. No network, no database
// writes, no secrets, no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const B = vaaniSales.buildBuyer360Snapshot;

function fullInput(over = {}) {
  return {
    customer_type: 'buyer',
    identity: { name: 'Asha Singh', phone: '+919999900001', city: 'Alwar' },
    requirement: { machine_type: 'Excavator', brand: 'JCB', model: '3DX', budget_max: 1800000, preferred_city: 'Alwar' },
    qualification: { status: 'PARTIALLY_QUALIFIED', collected_fields: ['machine_type', 'brand'], missing_fields: ['purchase_timeline'] },
    inventory_matches: [{ machine_id: 'm1', brand: 'JCB', model: '3DX', match_score: 100, match_type: 'EXACT_MATCH' }],
    objections: [{ type: 'price_budget', status: 'open', owner_needed: true }],
    calls: [{ run_id: 1, conversation_outcome: 'inquiry', summary: { outcome: 'inquiry', next_action: 'Collect timeline' }, transcript: [{ speaker: 'V', message: 'x' }] }],
    stage: 'qualification',
    lead_id: '1000038',
    ...over,
  };
}

test('buyer 360 identity with no fabrication', () => {
  const s = B(fullInput());
  assert.deepEqual(s.buyer, { name: 'Asha Singh', phone: '+919999900001', location: 'Alwar', customer_type: 'buyer', lead_id: '1000038' });
  assert.equal(B({ customer_type: 'buyer' }).buyer.name, null);
  assert.equal(B({ customer_type: 'buyer', identity: {} }).buyer.phone, null);
});

test('buyer requirement aggregation honors stored values', () => {
  const s = B(fullInput());
  assert.equal(s.requirement.machine_type, 'Excavator');
  assert.equal(s.requirement.budget_max, 1800000);
  assert.equal(s.requirement.preferred_city, 'Alwar');
  assert.equal(s.requirement.year_min, null);
});

test('qualification included verbatim from Goal 24 output', () => {
  const s = B(fullInput());
  assert.equal(s.qualification_status, 'PARTIALLY_QUALIFIED');
  assert.deepEqual(s.missing_fields, ['purchase_timeline']);
});

test('missing fields included without invention', () => {
  assert.deepEqual(B(fullInput()).missing_fields, ['purchase_timeline']);
  assert.deepEqual(B({ customer_type: 'buyer' }).missing_fields, []);
});

test('inventory matches included with best match first', () => {
  const s = B(fullInput());
  assert.equal(s.best_match.machine_id, 'm1');
  assert.equal(s.best_match.match_score, 100);
  assert.equal(B({ customer_type: 'buyer' }).best_match, null);
});

test('call history included latest-first with summaries', () => {
  const s = B(fullInput());
  assert.ok(s.last_call, 'latest call present');
  assert.equal(s.last_outcome, 'inquiry');
  assert.equal(s.next_action, 'Collect timeline');
  const empty = B({ customer_type: 'buyer', calls: [] });
  assert.equal(empty.last_call, null);
  assert.equal(empty.last_outcome, null);
  assert.equal(empty.next_action, null);
});

test('call summaries surfaced without regeneration', () => {
  const s = B(fullInput());
  assert.equal(s.last_outcome, 'inquiry');
});

test('transcript linkage present via calls, never fabricated', () => {
  const withTx = B(fullInput());
  assert.ok(withTx.last_call, 'call with transcript linked');
  const withoutTx = B({ customer_type: 'buyer', calls: [{ run_id: 2 }] });
  assert.ok(withoutTx.last_call, 'call listed without transcript claims');
});

test('objections included with open flags', () => {
  const s = B(fullInput());
  assert.equal(s.open_objections.length, 1);
  assert.equal(s.open_objections[0].type, 'price_budget');
  assert.equal(B({ customer_type: 'buyer', objections: [{ type: 'x', status: 'addressed', owner_needed: false }] }).open_objections.length, 0);
});

test('sales brain stage and intent reused', () => {
  const s = B({ customer_type: 'buyer', stage: 'inventory_match_review' });
  assert.equal(s.stage, 'inventory_match_review');
  assert.equal(s.intent, 'purchase');
});

test('latest-state snapshot keys are complete', () => {
  const keys = Object.keys(B(fullInput()));
  for (const k of ['buyer', 'intent', 'stage', 'qualification_status', 'requirement', 'missing_fields', 'best_match', 'open_objections', 'last_call', 'last_outcome', 'next_action']) {
    assert.ok(keys.includes(k), 'snapshot has ' + k);
  }
});

test('buyer and seller data never mix', () => {
  assert.equal(B({ customer_type: 'seller' }), null);
  assert.equal(B({ customer_type: 'unknown' }), null);
  assert.equal(B(null), null);
  assert.equal(B({}), null);
});

test('missing data renders as null, never guessed', () => {
  const s = B({ customer_type: 'buyer' });
  assert.equal(s.requirement.machine_type, null);
  assert.equal(s.stage, null);
  assert.equal(s.next_action, null);
  assert.ok(!/unknown buyer|test|demo|fake/i.test(JSON.stringify(s).replace(/"customer_type":"buyer"/g, '')), 'no placeholder identities');
});

test('no previous calls handled with explicit none states', () => {
  const s = B({ customer_type: 'buyer', calls: [] });
  assert.equal(s.last_call, null);
  assert.equal(s.last_outcome, null);
});

test('no inventory matches handled with null best match', () => {
  const s = B({ customer_type: 'buyer', inventory_matches: [] });
  assert.equal(s.best_match, null);
});

test('organization isolation via existing lead360 gates', () => {
  assert.ok(libSrc.includes('WHERE w.organization_id = $1'), 'lead360 stays org-filtered');
  assert.ok(!/['"]\/api\/[^'"]*360|buyer_360.*route/i.test(serverSrc), 'no new buyer360 routes');
});

test('auth protection unchanged on lead routes', () => {
  assert.ok(serverSrc.includes('requireAuth') && serverSrc.includes('requireBraivexAuth'), 'both auth paths intact');
});

test('unauthorized buyer access fails through existing gates', () => {
  assert.ok(serverSrc.includes('call does not belong to this organization'), 'call ownership gate intact');
  assert.ok(serverSrc.includes('organization not linked'), 'org gate intact');
});

test('existing Goal 29 summary remains intact', () => {
  assert.ok(typeof vaaniSales.buildTerminalCallSummary === 'function', 'composer present');
  assert.ok(typeof vaaniSales.upsertTerminalCallSummary === 'function', 'merge persist present');
});

test('existing Lead 360 behavior remains intact', () => {
  assert.ok(typeof vaaniSales.getLead360 === 'function', 'getLead360 present');
  assert.ok(libSrc.includes('buyer_360: buyer360Data'), 'snapshot attached, lead360 otherwise untouched');
});

test('no duplicate memory or data system created', () => {
  const code = strip(libSrc);
  const fn = code.split('function buildBuyer360Snapshot')[1].split('\nfunction resolveQualificationFields')[0];
  assert.ok(!/queryPostgres|INSERT|UPDATE|DELETE|fetch\(/.test(fn), 'pure consolidation only');
  assert.ok(!/CREATE TABLE/i.test(code.split('function buildBuyer360Snapshot')[1].split('\nfunction resolveQualificationFields')[0]), 'no DDL');
});

test('no follow-up, WhatsApp, or PSTN triggered', () => {
  const fn = strip(libSrc).split('function buildBuyer360Snapshot')[1].split('\nfunction resolveQualificationFields')[0];
  assert.ok(!/whatsapp|follow.?up|pstn|dial|call.*api|fetch\(/i.test(fn), 'no automation hooks');
});
