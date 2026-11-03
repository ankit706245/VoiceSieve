'use strict';
// Step A1: Seller 360 read-projection tests. Pure unit level (no DB writes):
// stored seller facts must surface through resolveQualificationFields and the
// Lead360 SQL projection; buyer behavior and matching must be unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const R = vaaniSales.resolveQualificationFields;
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');

const sellerRow = () => ({
  customer_type: 'seller',
  machine_brand: 'JCB',
  machine_model: '3DX',
  model_year: 2019,
  running_hours: 4500,
  application_history: 'soil_earthwork',
  machine_location_city: 'Jaipur',
  expected_selling_price_inr: 1800000,
  tonnage_class: '20_ton_class',
  document_status: 'all_clear_noc_ready',
  machine_condition_summary: 'Bucket attached, sealed engine',
  whatsapp_number: '+919812345678',
});

test('1. seller machine data projects correctly', () => {
  const r = R('seller', sellerRow());
  assert.equal(r.brand, 'JCB');
  assert.equal(r.model, '3DX');
});

test('2. seller brand/model/year/hours project correctly', () => {
  const r = R('seller', sellerRow());
  assert.equal(r.year, 2019);
  assert.equal(r.hours, 4500);
});

test('3. seller application/condition/notes project when present', () => {
  const r = R('seller', { ...sellerRow(), condition: 'good' });
  assert.equal(r.condition, 'good');
  assert.equal(r.machine_condition_summary, 'Bucket attached, sealed engine');
});

test('4. seller price projects correctly', () => {
  const r = R('seller', sellerRow());
  assert.equal(r.asking_price, 1800000);
});

test('5. tonnage/document/whatsapp project when stored', () => {
  const r = R('seller', sellerRow());
  assert.equal(r.tonnage_class, '20_ton_class');
  assert.equal(r.document_status, 'all_clear_noc_ready');
  assert.equal(r.whatsapp_number, '+919812345678');
});

test('6/7. follow-up and potential-buyers builders still exist', () => {
  assert.equal(typeof vaaniSales.buildFollowUpRecommendation, 'function');
  assert.equal(typeof vaaniSales.evaluateMachineBuyers, 'function');
});

test('8. missing fields stay null, nothing invented', () => {
  const r = R('seller', { customer_type: 'seller' });
  assert.equal(r.brand, null);
  assert.equal(r.year, null);
  assert.equal(r.tonnage_class, null);
  assert.equal(r.whatsapp_number, null);
});

test('9. buyer Lead360 behavior unchanged', () => {
  const C = vaaniSales.evaluateQualificationCompleteness;
  const r = C('buyer', { machine_type: 'x', budget_max: 1, preferred_city: 'y', purchase_timeline: 'z' });
  assert.equal(r.status, 'QUALIFIED');
  assert.ok(!r.missing_fields.includes('new_or_used'));
  const rb = R('buyer', { machine_type: 'excavator' });
  assert.equal(rb.machine_type, 'excavator');
  assert.equal(rb.quantity, null);
  assert.ok(!('availability_status' in rb) && !('asking_price' in rb), 'no seller-only keys leak into buyer');
});

test('10/11. matching engines unchanged', () => {
  assert.equal(typeof vaaniSales.evaluateBuyerMatches, 'function');
  const m = vaaniSales.evaluateBuyerMatches(
    { machine_brand: 'JCB', budget_max_inr: 2000000 }, []
  );
  assert.ok(Array.isArray(m));
});

test('SQL projection carries the four seller keys', () => {
  for (const k of ["'whatsapp_number'", "'document_status'", "'tonnage_class'", "'machine_condition_summary'"]) {
    assert.ok(libSrc.includes(k), 'projection has ' + k);
  }
});
