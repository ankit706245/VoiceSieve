'use strict';
// Step B2: seller price-negotiability tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ext = require('../lib/vaani-extractor');
const vaaniSales = require('../lib/vaani-sales');

test('1. flexible phrasing is true', () => {
  assert.equal(ext.parsePriceNegotiability('18 lakh hai, thoda kam ho jayega'), true);
});

test('2. explicit final is false', () => {
  assert.equal(ext.parsePriceNegotiability('18 lakh final hai'), false);
});

test('3. isse kam nahi is false', () => {
  assert.equal(ext.parsePriceNegotiability('18 lakh, isse kam nahi hoga'), false);
});

test('4. explicit negotiable is true', () => {
  assert.equal(ext.parsePriceNegotiability('18 lakh negotiable hai'), true);
});

test('5. bare price guesses nothing', () => {
  assert.equal(ext.parsePriceNegotiability('18 lakh ka hai'), null);
  assert.equal(ext.parsePriceNegotiability('final decision kal lunga'), null);
});

test('6. Hindi/Hinglish variations', () => {
  assert.equal(ext.parsePriceNegotiability('kuch kam ho jayega'), true);
  assert.equal(ext.parsePriceNegotiability('bilkul final rate hai'), false);
  assert.equal(ext.parsePriceNegotiability('baat ho jayegi'), true);
  assert.equal(ext.parsePriceNegotiability('price flexible hai'), true);
  assert.equal(ext.parsePriceNegotiability('fixed price hai'), false);
  assert.equal(ext.parsePriceNegotiability('final nahi hai'), true);
});

test('7. buyer statements do not use seller negotiability path', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('mujhe machine chahiye', 1);
  x.processTurn('18 lakh hai, thoda kam ho jayega', 2);
  assert.equal(x.extracted.customer_type, 'buyer');
  assert.equal(x.extracted.commercial_terms.price_negotiable ?? null, null);
  const y = new ext.VaaniConversationExtractor();
  y.processTurn('meri machine bechni hai', 1);
  y.processTurn('18 lakh hai, thoda kam ho jayega', 2);
  assert.equal(y.extracted.customer_type, 'seller');
  assert.equal(y.extracted.commercial_terms.price_negotiable, true);
});

test('8. existing price extraction still works', () => {
  const p = ext.parseSpokenPrice('18 lakh');
  assert.deepEqual([p.min_inr, p.max_inr, p.qualifier], [1800000, 1800000, 'exact']);
  const r = ext.parseSpokenPrice('20 se 22 lakh');
  assert.deepEqual([r.min_inr, r.max_inr], [2000000, 2200000]);
});

test('9. null never overwrites meaningful stored value', () => {
  const out = vaaniSales.mergeGatheredContextPreserving(
    { extracted_variables: { commercial_terms: { price_negotiable: true } } },
    { extracted_variables: { commercial_terms: {} } }
  );
  assert.equal(out.extracted_variables.commercial_terms.price_negotiable, true);
  const out2 = vaaniSales.mergeGatheredContextPreserving(
    { extracted_variables: { commercial_terms: { price_negotiable: true } } },
    { extracted_variables: { commercial_terms: { price_negotiable: false } } }
  );
  assert.equal(out2.extracted_variables.commercial_terms.price_negotiable, false);
});

test('10. seller UI renders Yes/No/Not specified honestly', () => {
  const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
  const idx = dashSrc.indexOf('Negotiable: Yes');
  assert.ok(idx !== -1, 'Yes branch present');
  assert.ok(dashSrc.includes('Negotiable: No'), 'No branch present');
  assert.ok(dashSrc.includes('Negotiable: Not specified'), 'unknown branch present');
  const win = dashSrc.slice(Math.max(0, idx - 600), idx + 200);
  assert.ok(!/sent|dispatch/i.test(win), 'no send/dispatch language near label');
});
