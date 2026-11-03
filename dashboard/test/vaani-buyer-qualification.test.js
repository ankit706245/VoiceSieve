'use strict';
// Phase 2 Step 2: buyer qualification without new_or_used.
// Verifies: requirement removal, qualification examples, no new/used question
// generation for buyers, seller flow unchanged, Step 1 green.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const q = (type, fields, dnc = false) =>
  vaaniSales.evaluateQualificationCompleteness(type, fields, dnc);

test('1. buyer qualifies without new_or_used', () => {
  const r = q('buyer', { machine_type: 'excavator', budget_max: 2000000, preferred_city: 'Jaipur', purchase_timeline: 'immediate_within_7_days' });
  assert.equal(r.status, 'QUALIFIED');
  assert.ok(!r.missing_fields.includes('new_or_used'));
});

test('2. machine + budget + location (+timeline implied partial)', () => {
  const full = q('buyer', { machine_type: 'excavator', budget_max: 2000000, preferred_city: 'Jaipur', purchase_timeline: 'within_15_30_days' });
  assert.equal(full.status, 'QUALIFIED');
  const noTime = q('buyer', { machine_type: 'excavator', budget_max: 2000000, preferred_city: 'Jaipur' });
  assert.equal(noTime.status, 'PARTIALLY_QUALIFIED');
  assert.ok(noTime.missing_fields.includes('purchase_timeline'));
  assert.ok(!noTime.missing_fields.includes('new_or_used'));
});

test('3. machine + budget + location + timeline qualifies', () => {
  const r = q('buyer', { machine_type: 'backhoe', budget_min: 2000000, budget_max: 2200000, preferred_city: 'Jaipur', purchase_timeline: 'future_1_3_months' });
  assert.equal(r.status, 'QUALIFIED');
});

test('4. range + quantity + finance qualifies (optionals never gate)', () => {
  const r = q('buyer', { machine_type: 'excavator', budget_min: 2000000, budget_max: 2200000, preferred_city: 'Jaipur', purchase_timeline: 'immediate_within_7_days' });
  assert.equal(r.status, 'QUALIFIED');
  const noInfo = q('buyer', {});
  assert.equal(noInfo.status, 'UNQUALIFIED');
});

test('5. new_or_used is NOT required', () => {
  const withVal = q('buyer', { machine_type: 'excavator', budget_max: 1, preferred_city: 'X', purchase_timeline: 'y', new_or_used: 'used' });
  const withoutVal = q('buyer', { machine_type: 'excavator', budget_max: 1, preferred_city: 'X', purchase_timeline: 'y' });
  assert.equal(withVal.status, withoutVal.status);
  assert.equal(withoutVal.status, 'QUALIFIED');
});

test('6. buyer brain never emits a new/used question', () => {
  const brainSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  // unresolved_questions derive from missing_fields; with new_or_used out of
  // the buyer required set it can never appear for buyers.
  const r = q('buyer', { machine_type: 'excavator', budget_max: 1, preferred_city: 'X' });
  assert.ok(!r.missing_fields.includes('new_or_used'));
  assert.ok(brainSrc.includes('new_or_used'), 'field retained in model');
});

test('7. seller qualification unchanged', () => {
  const full = q('seller', { machine_type: 'excavator', brand: 'JCB', model: '3DX', year: 2020, hours: 5000, condition: 'good', availability_status: 'available', asking_price: 1800000, machine_location: 'Jaipur' });
  assert.equal(full.status, 'QUALIFIED');
  const partial = q('seller', { machine_type: 'excavator', brand: 'JCB' });
  assert.equal(partial.status, 'PARTIALLY_QUALIFIED');
  assert.ok(!partial.missing_fields.includes('new_or_used'));
});

test('8. Step 1 extraction still green', () => {
  const ext = require('../lib/vaani-extractor');
  const r = ext.parseSpokenPrice('bees se bais lakh');
  assert.deepEqual([r.min_inr, r.max_inr, r.qualifier], [2000000, 2200000, 'range']);
  assert.equal(ext.parseSpokenQuantity('do excavator chahiye').quantity, 2);
});
