'use strict';
// Phase 2 Step 4C-2: buyer read-projection tests.
// Structured JSON values must surface through resolveQualificationFields;
// old leads without JSON must resolve blank without crashing; flat values win.
const test = require('node:test');
const assert = require('node:assert/strict');
const vaaniSales = require('../lib/vaani-sales');

const R = vaaniSales.resolveQualificationFields;
const jsonLead = (md, ct, top) => ({
  raw_extracted_variables: JSON.stringify({
    machine_details: md || {},
    commercial_terms: ct || {},
    ...(top || {}),
  }),
});

test('1. quantity appears from JSON', () => {
  const r = R('buyer', jsonLead({ quantity: 2 }, {}));
  assert.equal(r.quantity, 2);
});

test('2. budget_qualifier appears', () => {
  const r = R('buyer', jsonLead({}, { budget_qualifier: 'range' }));
  assert.equal(r.budget_qualifier, 'range');
});

test('3. whatsapp_requested appears', () => {
  const r = R('buyer', jsonLead({}, {}, { whatsapp_requested: true }));
  assert.equal(r.whatsapp_requested, true);
});

test('4. whatsapp_action PENDING appears', () => {
  const r = R('buyer', jsonLead({}, {}, { whatsapp_requested: true, whatsapp_action: 'PENDING' }));
  assert.equal(r.whatsapp_action, 'PENDING');
});

test('5. condition appears', () => {
  const r = R('buyer', jsonLead({ condition: 'good' }, {}));
  assert.equal(r.condition, 'good');
});

test('6. model_year appears', () => {
  const r = R('buyer', jsonLead({ model_year: 2019 }, {}));
  assert.equal(r.model_year, 2019);
});

test('7. max_hours appears', () => {
  const r = R('buyer', jsonLead({ max_hours: 5000 }, {}));
  assert.equal(r.max_hours, 5000);
});

test('8. application appears', () => {
  const r = R('buyer', jsonLead({ application_history: 'soil_earthwork' }, {}));
  assert.equal(r.application_history, 'soil_earthwork');
});

test('9. tonnage appears', () => {
  const r = R('buyer', jsonLead({ tonnage_class: '20_ton_class' }, {}));
  assert.equal(r.tonnage_class, '20_ton_class');
});

test('10. bucket/GST summary appears if present', () => {
  const r = R('buyer', jsonLead({ machine_condition_summary: 'Attachment: bucket/balti required; GST billing required' }, {}));
  assert.ok(String(r.machine_condition_summary).includes('bucket'));
});

test('11. old lead without JSON does not crash', () => {
  const r = R('buyer', { machine_type: 'excavator' });
  assert.equal(r.quantity, null);
  assert.equal(r.budget_qualifier, null);
  assert.equal(r.whatsapp_requested, null);
  assert.equal(r.whatsapp_action, null);
  assert.equal(r.machine_type, 'excavator');
  const r2 = R('buyer', null);
  assert.deepEqual(Object.keys(r2).sort(), Object.keys(R('buyer', {})).sort());
});

test('12. flat value not clobbered by null JSON', () => {
  const r = R('buyer', {
    preferred_city: 'Jaipur',
    raw_extracted_variables: JSON.stringify({ machine_details: {}, commercial_terms: {} }),
  });
  assert.equal(r.preferred_city, 'Jaipur');
  assert.equal(r.quantity, null);
});

test('seller projection unchanged', () => {
  const r = R('seller', { machine_brand: 'JCB', machine_location_city: 'Jaipur' });
  assert.equal(r.brand, 'JCB');
  assert.ok(!('quantity' in r) && !('whatsapp_requested' in r));
});
