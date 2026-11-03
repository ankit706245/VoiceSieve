'use strict';
// Requirement Extraction Correction: deterministic budget wins over
// conflicting LLM numbers (buyer only), when explicit and unambiguous.
const test = require('node:test');
const assert = require('node:assert/strict');
const vaaniSales = require('../lib/vaani-sales');

const run = (lines, pre = {}) => {
  const machDetails = {};
  const commTerms = { ...pre };
  const payload = {};
  vaaniSales.applyDeterministicBackstop({
    customerType: 'buyer',
    transcript: lines.map((m) => ({ speaker: 'Customer', message: m })),
    conversation: null, machDetails, commTerms, payload,
  });
  return commTerms;
};

test('1. Hindi range wins', () => {
  const c = run(['mera budget bees se bais lakh hai']);
  assert.deepEqual([c.budget_min_inr, c.budget_max_inr], [2000000, 2200000]);
});

test('2. Hindi single wins', () => {
  const c = run(['mera budget bees lakh hai']);
  assert.equal(c.budget_max_inr, 2000000);
});

test('3. Hindi max-only wins without invented min', () => {
  const c = run(['bees lakh tak']);
  assert.equal(c.budget_max_inr, 2000000);
  assert.equal(c.budget_min_inr, null);
});

test('4. Hindi approx wins with qualifier', () => {
  const c = run(['lagbhag bees lakh']);
  assert.equal(c.budget_max_inr, 2000000);
  assert.equal(c.budget_qualifier, 'approximate');
});

test('5. English digits range wins', () => {
  const c = run(['budget 20-22 lakh']);
  assert.deepEqual([c.budget_min_inr, c.budget_max_inr], [2000000, 2200000]);
});

test('6. conflict: LLM 30-35L overridden by deterministic 20-22L', () => {
  const c = run(
    ['mera budget bees se bais lakh hai'],
    { budget_min_inr: 3000000, budget_max_inr: 3500000, price_or_budget_raw: 'something', budget_qualifier: 'range' }
  );
  assert.deepEqual([c.budget_min_inr, c.budget_max_inr], [2000000, 2200000]);
  assert.ok(String(c.price_or_budget_raw).includes('bees se bais lakh'));
});

test('7. agreement unchanged', () => {
  const c = run(
    ['budget 20 lakh'],
    { budget_min_inr: 2000000, budget_max_inr: 2000000, price_or_budget_raw: '20 lakh', budget_qualifier: 'exact' }
  );
  assert.deepEqual([c.budget_min_inr, c.budget_max_inr, c.price_or_budget_raw], [2000000, 2000000, '20 lakh']);
});

test('8. ambiguous phrase keeps LLM result', () => {
  const c = run(
    ['budget ke baare mein baad mein bataunga'],
    { budget_min_inr: 3000000, budget_max_inr: 3500000, price_or_budget_raw: 'x', budget_qualifier: 'range' }
  );
  assert.deepEqual([c.budget_min_inr, c.budget_max_inr], [3000000, 3500000]);
});

test('9. seller extraction untouched by buyer guard', () => {
  const machDetails = {}, commTerms = {}, payload = {};
  vaaniSales.applyDeterministicBackstop({
    customerType: 'seller',
    transcript: [{ speaker: 'Customer', message: 'bees se bais lakh mein deni hai' }],
    conversation: null, machDetails, commTerms, payload,
  });
  assert.equal(commTerms.budget_max_inr, undefined);
  assert.equal(commTerms.budget_min_inr, undefined);
});

test('10. raw phrase preserved verbatim', () => {
  const c = run(['mera budget bees se bais lakh hai']);
  assert.equal(c.price_or_budget_raw, 'bees se bais lakh');
});
