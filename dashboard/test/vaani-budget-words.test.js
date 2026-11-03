'use strict';
// Step 1: deterministic Roman-Hindi budget word coverage (pachchis gap).
// Pure unit level: parseSpokenPrice only. No network, no database writes,
// no secrets, no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../lib/vaani-extractor');

const range = (text, lo, hi) => {
  const r = ext.parseSpokenPrice(text);
  assert.ok(r, `expected parse for ${JSON.stringify(text)}`);
  assert.deepEqual([r.min_inr, r.max_inr, r.qualifier], [lo, hi, 'range']);
};

test('1. bees se bais lakh (baseline)', () => {
  range('bees se bais lakh', 2000000, 2200000);
});

test('2. bees se pachchis lakh', () => {
  range('bees se pachchis lakh', 2000000, 2500000);
});

test('3. mera budget bees se pachchis lakh hai', () => {
  range('mera budget bees se pachchis lakh hai', 2000000, 2500000);
});

test('4. Devanagari bees se pachchis lakh (locked)', () => {
  range('बीस से पच्चीस लाख', 2000000, 2500000);
});

test('5. bees se pachchees lakh (locked)', () => {
  range('bees se pachchees lakh', 2000000, 2500000);
});

test('6. explicit digit amounts unchanged (no regression)', () => {
  const r1 = ext.parseSpokenPrice('22-25 lakh');
  assert.deepEqual([r1.min_inr, r1.max_inr, r1.qualifier], [2200000, 2500000, 'range']);
  const r2 = ext.parseSpokenPrice('20 to 22 l');
  assert.deepEqual([r2.min_inr, r2.max_inr, r2.qualifier], [2000000, 2200000, 'range']);
  const r3 = ext.parseSpokenPrice('My budget is 24 lakh');
  assert.deepEqual([r3.min_inr, r3.max_inr, r3.qualifier], [2400000, 2400000, 'exact']);
  const r4 = ext.parseSpokenPrice('bees se pachees lakh');
  assert.deepEqual([r4.min_inr, r4.max_inr, r4.qualifier], [2000000, 2500000, 'range']);
});
