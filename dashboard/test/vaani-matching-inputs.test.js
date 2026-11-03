'use strict';
// Step B4: matching-input expansion tests. Verifies stored machine fields reach
// descriptors without changing scoring philosophy; documents are intentionally
// excluded (no engine consumer).
const test = require('node:test');
const assert = require('node:assert/strict');
const vaaniSales = require('../lib/vaani-sales');

const sellerRow = () => ({
  customer_type: 'seller',
  machine_brand: 'JCB', machine_model: '3DX',
  model_year: 2020, running_hours: 4000,
  application_history: 'soil_earthwork',
  machine_location_city: 'Jaipur',
  expected_selling_price_inr: 1800000,
  raw_extracted_variables: JSON.stringify({
    machine_details: {
      machine_type: 'excavator', tonnage_class: '20_ton_class',
      condition: 'good', machine_condition_summary: 'Bucket attached',
      application_history: 'soil_earthwork',
    },
  }),
});

test('1-3. application/condition/tonnage forwarded from stored data', () => {
  const projected = vaaniSales.projectStructuredSellerFields(sellerRow());
  assert.equal(projected.application_history, 'soil_earthwork');
  assert.equal(projected.tonnage_class, '20_ton_class');
  assert.equal(projected.machine_condition_summary, 'Bucket attached');
});

test('4-6. missing specs stay neutral (null, never invented)', () => {
  const bare = vaaniSales.projectStructuredSellerFields({ customer_type: 'seller', machine_brand: 'JCB' });
  assert.equal(bare.tonnage_class, null);
  assert.equal(bare.machine_condition_summary, null);
  assert.equal(bare.application_history, null);
});

test('7. documents are not a hard matching requirement', () => {
  const stock = [{
    machine_id: 'm1', brand: 'JCB', model: '3DX', manufacturing_year: 2020,
    hour_meter_reading: 4000, application_history: 'soil_earthwork',
    target_resale_inr: 1750000, status: 'in_sourcing_pipeline',
    current_location: 'Jaipur', organization_id: 2,
  }];
  const [m] = vaaniSales.evaluateBuyerMatches(
    { machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000 }, stock);
  assert.ok(m, 'matches without any document input');
  assert.equal(m.match_type, 'EXACT_MATCH');
});

test('8. B1 resale price intact', () => {
  const libSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  const voiceStart = libSrc.indexOf('// 2. vaani_machines record');
  const voiceBlock = libSrc.slice(voiceStart, libSrc.indexOf('// 3.', voiceStart));
  assert.ok(voiceBlock.includes('target_resale_inr'), 'resale column in voice insert');
});

test('9. brand/model matching intact', () => {
  const stock = [{ machine_id: 'm1', brand: 'JCB', model: '3DX', target_resale_inr: 1750000, status: 'in_sourcing_pipeline', current_location: 'Jaipur' }];
  const [ok] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000 }, stock);
  assert.equal(ok.match_type, 'EXACT_MATCH');
  const [nope] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'CAT', buyer_budget_max_inr: 99999999 }, stock);
  assert.equal(nope, undefined);
});

test('10. budget matching intact', () => {
  const stock = [{ machine_id: 'm1', brand: 'JCB', model: '3DX', target_resale_inr: 2000000, status: 'in_sourcing_pipeline', current_location: 'Jaipur' }];
  const [alt] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1900000 }, stock);
  assert.equal(alt.match_type, 'ALTERNATIVE_MATCH');
});

test('11. year/hours behavior intact', () => {
  const stock = [{ machine_id: 'm1', brand: 'JCB', model: '3DX', manufacturing_year: 2020, hour_meter_reading: 4000, target_resale_inr: 1750000, status: 'in_sourcing_pipeline', current_location: 'Jaipur' }];
  const [ok] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'JCB', model_year_min: 2019, model_year_max: 2021, max_hours: 5000, buyer_budget_max_inr: 1800000 }, stock);
  assert.ok(okMatched(ok));
  function okMatched(x) { return x && x.match_type === 'EXACT_MATCH'; }
  const [old] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'JCB', model_year_min: 2010, model_year_max: 2012, buyer_budget_max_inr: 99999999 }, stock);
  assert.equal(old, undefined);
});

test('12. sold/reserved excluded', () => {
  for (const status of ['sold', 'reserved']) {
    const out = vaaniSales.evaluateBuyerMatches(
      { machine_brand: 'JCB', buyer_budget_max_inr: 99999999 },
      [{ machine_id: 'm1', brand: 'JCB', model: '3DX', target_resale_inr: 1, status, current_location: 'Jaipur' }]);
    assert.deepEqual(out, []);
  }
});

test('13. buyer extraction unchanged', () => {
  const ext = require('../lib/vaani-extractor');
  assert.deepEqual(
    [ext.parseSpokenPrice('bees se bais lakh').min_inr, ext.parseSpokenPrice('bees se bais lakh').max_inr],
    [2000000, 2200000]
  );
});

test('14. seller-to-buyer matching unchanged', () => {
  const out = vaaniSales.evaluateMachineBuyers(
    { brand: 'JCB', model: '3DX', manufacturing_year: 2020, hour_meter_reading: 4000, target_resale_inr: 1800000, current_location: 'Jaipur', status: 'in_sourcing_pipeline' },
    [{ buyer_id: 7, machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1900000 }]
  );
  assert.ok(Array.isArray(out) && out.length > 0);
  assert.equal(out[0].match_status, 'MATCH');
});
