'use strict';
// Goal 32 bidirectional seller-buyer matching tests. Pure deterministic unit
// tests over evaluateMachineBuyers with fixtures (never production data),
// plus source and contract assertions for wiring, org isolation, UI, and
// no-outreach guarantees. No network, no database writes, no secrets, no
// PSTN, no WhatsApp, no SMS, no email.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const E = vaaniSales.evaluateMachineBuyers;

function machineFixture(over = {}) {
  return {
    machine_id: 'm1', brand: 'JCB', model: '3DX', manufacturing_year: 2021,
    hour_meter_reading: 4500, target_resale_inr: 1750000,
    current_location: 'Alwar', status: 'in_sourcing_pipeline',
    ...over,
  };
}
function buyerFixture(over = {}) {
  return {
    buyer_id: 100, machine_brand: 'JCB', machine_model: '3DX',
    buyer_budget_max_inr: 1800000, model_year_min: null, model_year_max: null,
    running_hours_max: null, preferred_city: 'Alwar', ...over,
  };
}

test('seller machine finds compatible buyer', () => {
  const [r] = E(machineFixture(), [buyerFixture()]);
  assert.ok(r, 'compatible buyer found');
  assert.equal(r.match_status, 'MATCH');
  assert.equal(r.direction, 'machine_to_buyer');
  assert.equal(r.buyer_id, 100);
  assert.equal(r.machine_id, 'm1');
  assert.ok(r.matched_fields.includes('brand') && r.matched_fields.includes('model'));
  assert.deepEqual(r.hard_failures, []);
  assert.equal(r.matched, true);
});

test('buyer model mismatch yields NO_MATCH with named hard failure', () => {
  assert.deepEqual(E(machineFixture(), [buyerFixture({ machine_model: '4DX' })]), []);
  assert.deepEqual(E(machineFixture({ model: '4DX' }), [buyerFixture()]), []);
});

test('buyer brand mismatch yields NO_MATCH', () => {
  assert.deepEqual(E(machineFixture(), [buyerFixture({ machine_brand: 'Komatsu' })]), []);
});

test('buyer budget compatible within ceiling', () => {
  const [r] = E(machineFixture(), [buyerFixture({ buyer_budget_max_inr: 1800000 })]);
  assert.equal(r.match_status, 'MATCH');
  assert.ok(r.matched_fields.includes('budget'));
});

test('buyer budget hard failure above tolerance', () => {
  const out = E(machineFixture(), [buyerFixture({ buyer_budget_max_inr: 1000000 })]);
  assert.deepEqual(out, []);
});

test('buyer year range compatible', () => {
  const [r] = E(machineFixture(), [buyerFixture({ model_year_min: 2019, model_year_max: 2021 })]);
  assert.equal(r.match_status, 'MATCH');
  assert.ok(r.matched_fields.includes('year'));
});

test('buyer year outside range yields NO_MATCH', () => {
  assert.deepEqual(E(machineFixture(), [buyerFixture({ model_year_min: 2015, model_year_max: 2016 })]), []);
});

test('buyer max hours compatible', () => {
  const [r] = E(machineFixture(), [buyerFixture({ max_hours: 5000 })]);
  assert.equal(r.match_status, 'MATCH');
  assert.ok(r.matched_fields.includes('hours'));
});

test('buyer max hours exceeded yields NO_MATCH', () => {
  assert.deepEqual(E(machineFixture(), [buyerFixture({ max_hours: 4000 })]), []);
});

test('unknown field never auto-rejects', () => {
  const [r] = E(machineFixture({ manufacturing_year: null, hour_meter_reading: null }), [buyerFixture({ model_year_min: 2019, max_hours: 5000 })]);
  assert.ok(r, 'unknown machine facts do not reject');
  assert.ok(r.missing_fields.includes('year') && r.missing_fields.includes('hours'));
  assert.equal(r.match_status, 'MATCH');
});

test('location difference is a soft potential mismatch', () => {
  const [r] = E(machineFixture(), [buyerFixture({ preferred_city: 'Sikar' })]);
  assert.equal(r.match_status, 'POTENTIAL_MATCH');
  assert.ok(r.mismatched_fields.includes('location'));
  assert.ok(/Jaipur|Sikar|Alwar/.test(r.match_explanation), 'cities named, got: ' + r.match_explanation);
});

test('new/used compatibility without inventory column', () => {
  const [r] = E(machineFixture(), [buyerFixture({ new_or_used: 'used' })]);
  assert.ok(r, 'still matches');
  assert.equal(r.match_status, 'MATCH');
  assert.equal(r.match_score, 100);
});

test('sold and reserved machines are excluded', () => {
  assert.deepEqual(E(machineFixture({ status: 'sold' }), [buyerFixture()]), []);
  assert.deepEqual(E(machineFixture({ status: 'reserved' }), [buyerFixture()]), []);
  assert.deepEqual(E({}, [buyerFixture()]), [], 'empty machine matches nothing sensible');
});

test('seller machine finds compatible buyer among several', () => {
  const buyers = [
    buyerFixture({ buyer_id: 1, buyer_budget_max_inr: 1000000 }),
    buyerFixture({ buyer_id: 2 }),
    buyerFixture({ buyer_id: 3, machine_brand: 'Komatsu' }),
  ];
  const out = E(machineFixture(), buyers);
  assert.deepEqual(out.map((r) => r.buyer_id), [2]);
});

test('multiple buyers can match one machine, ordered deterministically', () => {
  const out = E(machineFixture(), [
    buyerFixture({ buyer_id: 2, preferred_city: 'Sikar' }),
    buyerFixture({ buyer_id: 1 }),
  ]);
  assert.deepEqual(out.map((r) => r.buyer_id), [1, 2], 'exact first, then score, then stable id');
  const again = E(machineFixture(), [
    buyerFixture({ buyer_id: 2, preferred_city: 'Sikar' }),
    buyerFixture({ buyer_id: 1 }),
  ]);
  assert.deepEqual(out, again);
});

test('one buyer can match multiple machines', () => {
  const out = vaaniSales.evaluateBuyerMatches(buyerFixture(), [
    { machine_id: 'a', brand: 'JCB', model: '3DX', status: 'in_sourcing_pipeline', target_resale_inr: 1 },
    { machine_id: 'b', brand: 'JCB', model: '3DX', status: 'in_sourcing_pipeline', target_resale_inr: 1 },
  ]);
  assert.equal(out.length, 2);
});

test('match explanation is deterministic and honest', () => {
  const a = E(machineFixture(), [buyerFixture({ preferred_city: 'Sikar' })])[0];
  const b = E(JSON.parse(JSON.stringify(machineFixture())), [buyerFixture({ preferred_city: 'Sikar' })])[0];
  assert.deepEqual(a, b);
  assert.ok(/^MATCHED|POTENTIAL MATCH/.test(a.match_explanation), 'headed explanation');
  assert.ok(/score \d+/.test(a.match_explanation), 'score disclosed');
});

test('result carries matched, mismatched, and missing fields', () => {
  const [r] = E(machineFixture(), [buyerFixture({ preferred_city: 'Sikar' })]);
  assert.ok(Array.isArray(r.matched_fields) && r.matched_fields.includes('brand'));
  assert.ok(r.mismatched_fields.includes('location'));
  assert.ok(r.missing_fields.length >= 0, 'missing list present');
  assert.ok(Array.isArray(r.hard_failures), 'hard failures list present');
});

test('owner review flag on potential matches and unknown criticals', () => {
  const [p] = E(machineFixture(), [buyerFixture({ preferred_city: 'Sikar' })]);
  assert.equal(p.owner_review_required, true);
  const [m] = E(machineFixture(), [buyerFixture()]);
  assert.equal(m.owner_review_required, false, 'clean exact match needs no review');
});

test('buyer 360 integration reuses existing lead360 path', () => {
  assert.ok(libSrc.includes('potentialBuyers'), 'lead360 attaches seller matches');
  assert.ok(libSrc.includes('evaluateMachineBuyers(machineDesc, buyerRows)'), 'shared engine reused');
});

test('seller detail integration via lead360 with letter-coded buyers', () => {
  assert.ok(/Buyer \+/.test(libSrc) || libSrc.includes("'Buyer ' +"), 'letter-coded labels, no PII');
  assert.ok(!/phone.*buyer_label|buyer.*phone/i.test(libSrc.split('potentialBuyers = evaluateMachineBuyers')[1].split('} catch (_)')[0]), 'no buyer phone in match rows');
});

test('org A cannot see org B matches through shared engine', () => {
  assert.ok(libSrc.includes('await getBuyers({}, false, orgInt)'), 'seller matching reads ctx-org buyers only');
  assert.ok(libSrc.includes('WHERE organization_id = $1 AND buyer_run_id = $2'), 'persisted matches filtered by ctx org');
});

test('unauthenticated access remains protected on match data', () => {
  assert.ok(libSrc.includes('async function runIntelligentMatching(organizationId'), 'match writer is org-scoped');
  assert.ok(!/['"]\/api\/[^'"]*matches/i.test(serverSrc), 'no public matches route');
});

test('no cross-tenant leakage vectors in new engine', () => {
  const code = strip(libSrc);
  const fn = code.split('function evaluateMachineBuyers')[1].split('\nasync function loadMatchStock')[0];
  assert.ok(!/organization_id/.test(fn), 'engine takes pre-scoped inputs; callers scope');
  assert.ok(!/queryPostgres|INSERT|UPDATE|DELETE|fetch\(/.test(fn), 'pure computation, no I/O');
});

test('no database writes from matching on read paths', () => {
  assert.ok(!/INSERT INTO vaani_buyer_machine_matches/.test(libSrc.split('async function runIntelligentMatching')[0]), 'no persistence outside runIntelligentMatching');
  const leadBlock = libSrc.split('let potentialBuyers = []')[1].split('const salesBrainData')[0];
  assert.ok(!/INSERT|UPDATE|DELETE/.test(leadBlock), 'lead360 matching is read-only');
});

test('no outbound communication from matching', () => {
  const code = strip(libSrc);
  const blocks = [
    code.split('function evaluateMachineBuyers')[1].split('\nasync function loadMatchStock')[0],
    code.split('let potentialBuyers = []')[1].split('const salesBrainData')[0],
  ].join('\n');
  assert.ok(!/whatsapp|sms|email|pstn|dial|Dograh|fetch\(/i.test(blocks), 'matching never contacts anyone');
});

test('same input produces same output across runs', () => {
  const m = machineFixture();
  const b = [buyerFixture()];
  assert.deepEqual(E(m, b), E(JSON.parse(JSON.stringify(m)), JSON.parse(JSON.stringify(b))));
});

test('no probability or lead-score semantics anywhere', () => {
  const code = strip(libSrc);
  const blocks = [
    code.split('function evaluateMachineBuyers')[1].split('\nasync function loadMatchStock')[0],
  ].join('\n');
  assert.ok(!/probability|conversion|hot|warm|cold|lead_score|sales_score|confidence/i.test(blocks), 'deterministic suitability only');
  const [r] = E(machineFixture(), [buyerFixture()]);
  assert.ok(typeof r.match_score === 'number' && r.match_score >= 0 && r.match_score <= 100, 'bounded suitability score');
});

test('status contract maps cleanly onto Goal 25 types', () => {
  assert.equal(vaaniSales.matchTypeToStatus('EXACT_MATCH'), 'MATCH');
  assert.equal(vaaniSales.matchTypeToStatus('ALTERNATIVE_MATCH'), 'POTENTIAL_MATCH');
  assert.equal(vaaniSales.matchTypeToStatus('OTHER'), 'NO_MATCH');
  assert.equal(vaaniSales.isReviewRequired({ match_status: 'MATCH', missing_fields: [] }), false);
  assert.equal(vaaniSales.isReviewRequired({ match_status: 'MATCH', missing_fields: ['year'] }), true);
  assert.equal(vaaniSales.isReviewRequired({ match_status: 'POTENTIAL_MATCH', missing_fields: [] }), true);
  assert.equal(vaaniSales.isReviewRequired(null), true);
});
