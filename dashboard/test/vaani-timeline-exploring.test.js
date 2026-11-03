'use strict';
// Phase 2 Step 4C-1: exploring_market timeline intelligence tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../lib/vaani-extractor');
const vaaniSales = require('../lib/vaani-sales');

const buyerTimeline = (first, second) => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('mujhe machine chahiye', 0);
  if (first) x.processTurn(first, 1);
  if (second) x.processTurn(second, 2);
  return x.extracted.commercial_terms.purchase_timeline;
};

test('market explore maps to exploring_market', () => {
  assert.equal(buyerTimeline('market explore kar raha hoon'), 'exploring_market');
});

test('options browsing maps to exploring_market', () => {
  assert.equal(buyerTimeline('abhi options dekh raha hoon'), 'exploring_market');
  assert.equal(buyerTimeline('abhi research kar raha hoon'), 'exploring_market');
  assert.equal(buyerTimeline('abhi decide nahi kiya'), 'exploring_market');
});

test('existing immediate timeline still works', () => {
  assert.equal(buyerTimeline('turant chahiye'), 'immediate_within_7_days');
});

test('existing within_month timeline still works', () => {
  assert.equal(buyerTimeline('15 din mein chahiye'), 'within_15_30_days');
});

test('existing planning timeline still works', () => {
  assert.equal(buyerTimeline('baad mein lunga'), 'future_1_3_months');
});

test('seller behavior unchanged (no exploring branch)', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('meri machine bechni hai', 0);
  x.processTurn('photos bhej dunga', 1);
  assert.equal(x.extracted.customer_type, 'seller');
  assert.equal(x.extracted.commercial_terms.purchase_timeline, 'not_applicable');
  const y = new ext.VaaniConversationExtractor();
  y.processTurn('machine sell karni hai', 0);
  y.processTurn('turant bechni hai', 1);
  assert.equal(y.extracted.commercial_terms.purchase_timeline, 'immediate_within_7_days');
});

test('explicit timeline not overwritten by browsing', () => {
  assert.equal(buyerTimeline('turant chahiye', 'abhi dekh raha hoon'), 'immediate_within_7_days');
});

test('exploring counts as collected, no new_or_used required', () => {
  const C = vaaniSales.evaluateQualificationCompleteness;
  const r = C('buyer', { machine_type: 'x', budget_max: 1, preferred_city: 'y', purchase_timeline: 'exploring_market' });
  assert.ok(!r.missing_fields.includes('purchase_timeline'));
  assert.ok(!r.missing_fields.includes('new_or_used'));
});
