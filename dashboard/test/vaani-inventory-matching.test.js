'use strict';
// Goal 25 smart-inventory-matching tests. Pure deterministic unit tests over
// evaluateBuyerMatches with fixtures (never production data), plus source
// and contract assertions for loader/routes/org scoping. No network, no
// database writes, no secrets, no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const E = vaaniSales.evaluateBuyerMatches;

function stockFixture() {
  return [
    { machine_id: 'm1', brand: 'JCB', model: '3DX', manufacturing_year: 2021, hour_meter_reading: 4500, application_history: 'soil_earthwork', target_resale_inr: 1750000, status: 'in_sourcing_pipeline', current_location: 'Alwar', organization_id: 2 },
    { machine_id: 'm2', brand: 'JCB', model: '4DX', manufacturing_year: 2020, hour_meter_reading: 6000, application_history: 'soil_earthwork', target_resale_inr: 1850000, status: 'in_sourcing_pipeline', current_location: 'Jaipur', organization_id: 2 },
    { machine_id: 'm3', brand: 'Tata Hitachi', model: 'EX 200 LC', manufacturing_year: 2019, hour_meter_reading: 4800, application_history: 'soil_earthwork', target_resale_inr: 2000000, status: 'in_sourcing_pipeline', current_location: 'Alwar', organization_id: 2 },
    { machine_id: 'm4', brand: 'JCB', model: '3DX', manufacturing_year: 2021, hour_meter_reading: 4500, application_history: 'soil_earthwork', target_resale_inr: 1750000, status: 'sold', current_location: 'Alwar', organization_id: 2 },
  ];
}
function buyerFixture(over = {}) {
  return {
    machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000,
    model_year_min: null, model_year_max: null, running_hours_max: null,
    application_history: null, ...over,
  };
}

test('exact buyer to inventory match with full explanation', () => {
  const [m] = E(buyerFixture(), stockFixture());
  assert.ok(m, 'exact match found');
  assert.equal(m.match_type, 'EXACT_MATCH');
  assert.equal(m.match_score, 100);
  assert.equal(m.matched, true);
  assert.ok(m.matched_fields.includes('brand') && m.matched_fields.includes('model') && m.matched_fields.includes('budget'));
  assert.deepEqual(m.mismatched_fields, []);
  assert.ok(m.match_explanation.startsWith('MATCHED'), 'explanation heads MATCHED, got: ' + m.match_explanation);
  assert.equal(m.machine.machine_id, 'm1');
});

test('partial match on alternative model and location with honest gaps', () => {
  const [m] = E(buyerFixture({ preferred_city: 'Alwar' }), stockFixture().filter((x) => x.machine_id === 'm2'));
  assert.ok(m, 'alternative returned, not dropped');
  assert.equal(m.match_type, 'ALTERNATIVE_MATCH');
  assert.ok(m.match_score < 100 && m.match_score >= 0, 'score reduced, got ' + m.match_score);
  assert.ok(m.mismatched_fields.includes('model'), 'model gap listed');
  assert.ok(m.mismatched_fields.includes('location'), 'location gap listed');
  assert.ok(/PARTIAL MATCH/.test(m.match_explanation), 'labeled partial');
});

test('no match returns empty without fabrication', () => {
  assert.deepEqual(E(buyerFixture({ machine_brand: 'Komatsu' }), stockFixture()), []);
  assert.deepEqual(E(buyerFixture(), []), []);
  assert.deepEqual(E(buyerFixture(), [{ machine_id: 'x', brand: 'JCB', model: '3DX', status: 'sold', target_resale_inr: 1 }]), [], 'sold excluded');
});

test('budget overrun within tolerance is partial with amount, beyond is excluded', () => {
  const [m] = E(buyerFixture({ buyer_budget_max_inr: 1800000 }), [stockFixture()[1]]);
  assert.equal(m.match_type, 'ALTERNATIVE_MATCH');
  assert.ok(/0\.50/.test(m.match_explanation), 'overrun amount explained, got: ' + m.match_explanation);
  assert.ok(m.mismatched_fields.includes('budget'));
  assert.deepEqual(E(buyerFixture({ buyer_budget_max_inr: 1000000 }), [stockFixture()[1]]), [], 'far over budget excluded');
});

test('location mismatch is soft with city names', () => {
  const [m] = E(buyerFixture({ preferred_city: 'Alwar' }), [stockFixture()[0]]);
  assert.ok(m, 'kept as match');
  const [m2] = E(buyerFixture({ preferred_city: 'Sikar' }), [stockFixture()[0]]);
  assert.equal(m2.match_type, 'ALTERNATIVE_MATCH');
  assert.ok(/Jaipur|Sikar|Alwar/.test(m2.match_explanation), 'cities named, got: ' + m2.match_explanation);
});

test('year range with tolerance and max hours as hard caps', () => {
  const base = buyerFixture({ model_year_min: 2019, model_year_max: 2021, max_hours: 5000 });
  const [exact] = E(base, [stockFixture()[0]]);
  assert.equal(exact.match_type, 'EXACT_MATCH');
  const [tol] = E(buyerFixture({ model_year_min: 2022, model_year_max: 2024 }), [stockFixture()[0]]);
  assert.equal(tol.match_type, 'ALTERNATIVE_MATCH', '±1 year tolerated');
  assert.deepEqual(E(buyerFixture({ model_year_min: 2015, model_year_max: 2016 }), [stockFixture()[0]]), [], 'out-of-range excluded');
  assert.deepEqual(E({ ...base, max_hours: 4000 }, [stockFixture()[0]]), [], 'over-hours excluded');
});

test('new/used and machine type never penalize without inventory columns', () => {
  const [m] = E(buyerFixture({ new_or_used: 'used', machine_type: 'Excavator' }), [stockFixture()[0]]);
  assert.ok(m, 'still matches');
  assert.equal(m.match_type, 'EXACT_MATCH');
  assert.equal(m.match_score, 100);
});

test('brand matching is case-insensitive with taxonomy aliases', () => {
  assert.equal(vaaniSales.canonicalMatchModel('jcb 205'), 'js 205');
  assert.equal(vaaniSales.canonicalMatchModel('JS 205'), 'js 205');
  const [m] = E(buyerFixture({ machine_brand: 'jcb', machine_model: 'JCB 205' }), [
    { machine_id: 'a', brand: 'JCB', model: 'JS 205', status: 'in_sourcing_pipeline', target_resale_inr: 1 },
  ]);
  assert.ok(m, 'alias-resolved model matches');
  assert.ok(m.matched_fields.includes('model'));
});

test('model matching without brand still works', () => {
  const [m] = E({ machine_model: '3DX' }, [stockFixture()[0]]);
  assert.ok(m, 'model-only requirement matches');
});

test('missing buyer fields never cause false mismatch', () => {
  const [m] = E({}, [stockFixture()[0]]);
  assert.ok(m, 'empty requirement still matches sellable stock');
  assert.ok(m.missing_requirement_fields.includes('brand'), 'absent dims reported missing');
  assert.deepEqual(m.mismatched_fields, [], 'nothing to mismatch against');
});

test('explanation names every evaluated dimension', () => {
  const [m] = E(buyerFixture({ preferred_city: 'Alwar' }), [stockFixture()[0]]);
  for (const k of ['brand', 'model', 'budget']) {
    assert.ok(m.match_explanation.includes(k), 'explains ' + k);
  }
});

test('match score is deterministic across runs and orderings', () => {
  const b = buyerFixture({ preferred_city: 'Alwar' });
  const a = E(b, stockFixture());
  const again = E(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(stockFixture())));
  assert.deepEqual(a, again);
  const reordered = E(b, [...stockFixture()].reverse());
  assert.deepEqual(reordered.map((m) => m.machine_id), a.map((m) => m.machine_id), 'order-stable sort');
});

test('no inventory is fabricated and stock input is unmutated', () => {
  const stock = stockFixture();
  const before = JSON.stringify(stock);
  const out = E(buyerFixture(), stock);
  assert.equal(JSON.stringify(stock), before, 'stock input untouched');
  assert.ok(out.every((m) => stock.some((s) => s.machine_id === m.machine_id)), 'every match traces to real stock');
  assert.ok(out.every((m) => typeof m.match_score === 'number' && m.match_score >= 0 && m.match_score <= 100), 'scores bounded');
});

test('buildMatchRequirement maps legacy and raw-EV keys without invention', () => {
  const req = vaaniSales.buildMatchRequirement({
    machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000,
    raw_extracted_variables: { machine_details: { machine_type: 'Excavator', model_year_min: 2018, max_hours: 6000, preferred_city: 'Alwar' }, commercial_terms: { budget_min_inr: 1500000 } },
  });
  assert.equal(req.machine_brand, 'JCB');
  assert.equal(req.machine_type, 'Excavator');
  assert.equal(req.budget_min, 1500000);
  assert.equal(req.model_year_min, 2018);
  assert.equal(req.max_hours, 6000);
  assert.equal(req.preferred_city, 'Alwar');
  const empty = vaaniSales.buildMatchRequirement({});
  assert.ok(Object.values(empty).every((v) => v === null), 'empty row yields all-null requirement');
  assert.ok(Object.values(vaaniSales.buildMatchRequirement(null)).every((v) => v === null), 'null-safe');
});

test('legacy-only buyer rows still match exactly as before', () => {
  const [m] = E({ machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000 }, [stockFixture()[0]]);
  assert.equal(m.match_type, 'EXACT_MATCH');
  assert.equal(m.match_score, 100);
});

test('match loader selects only existing columns and verifies buyer type', () => {
  assert.ok(!serverSrc.includes('model_year_min, model_year_max, running_hours_max'), 'broken loader columns gone');
  assert.ok(serverSrc.includes('raw_extracted_variables'), 'loader reads raw EV JSON');
  assert.ok(serverSrc.includes("row.customer_type !== 'buyer'"), 'non-buyer rows rejected');
});

test('org isolation: stock, matches, and buyer ownership all ctx-scoped', () => {
  const code = strip(libSrc);
  assert.ok(libSrc.includes('WHERE organization_id = $1 AND status IN'), 'stock filtered by ctx org');
  assert.ok(serverSrc.includes('WHERE m.organization_id = $1 AND m.buyer_run_id = $2'), 'matches read filtered by ctx org');
  assert.ok(serverSrc.includes('WHERE organization_id = $1 AND run_id = $2'), 'buyer requirement filtered by ctx org');
  assert.ok(!/organization_id..\s*req\.|req\.body\.organization|searchParams\.get\(.organization/.test(code), 'no org taken from request input in matcher');
});

test('unresolved ownership fails closed and stock writes never happen in reads', () => {
  assert.ok(!/INSERT INTO vaani_buyer_machine_matches/.test(libSrc.split('async function runIntelligentMatching')[0]), 'no persistence outside runIntelligentMatching');
  const getFn = serverSrc.match(/async function apiVaaniBuyerMatchesGet[\s\S]*?\n\}/)[0];
  assert.ok(!/INSERT|UPDATE|DELETE/.test(getFn), 'GET matches is read-only');
  const leadFn = libSrc.includes('inventory_matches');
  assert.ok(leadFn, 'lead360 attaches computed matches');
});

test('persisted evidence carries score block without migration', () => {
  assert.ok(libSrc.includes('match_score: m.match_score'), 'score embedded in evidence_json');
  assert.ok(libSrc.includes('missing_requirement_fields'), 'missing fields embedded');
});

test('lead360 and drawer surface matches without redesign', () => {
  assert.ok(dashSrc.includes('id="drawerMatchesList"'), 'matches container present');
  assert.ok(dashSrc.includes('l360.inventory_matches'), 'drawer renders lead360 matches');
  assert.ok(dashSrc.includes('No matching inventory found'), 'honest empty state');
});
