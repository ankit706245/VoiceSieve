'use strict';
// Step B3: seller sale-urgency tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ext = require('../lib/vaani-extractor');
const vaaniSales = require('../lib/vaani-sales');

const cases = [
  ['jaldi bechna hai', 'URGENT'],
  ['turant bechna hai', 'URGENT'],
  ['abhi bechna hai', 'URGENT'],
  ['fatafat bechna hai', 'URGENT'],
  ['jaldi se sale karni hai', 'URGENT'],
  ['kuch din mein bechna hai', 'SOON'],
  ['is hafte bechna hai', 'SOON'],
  ['next week tak bechna hai', 'SOON'],
  ['jaldi hi bech dunga', 'SOON'],
  ['abhi rate pata kar raha hu', 'EXPLORING'],
  ['bas market dekh raha hu', 'EXPLORING'],
  ['abhi options dekh raha hu', 'EXPLORING'],
  ['pehle rate check kar raha hu', 'EXPLORING'],
  ['abhi decide nahi kiya', 'EXPLORING'],
  ['abhi soch raha hu', 'EXPLORING'],
  ['18 lakh ka hai', null],
  ['jaldi', null],
  ['abhi', null],
  ['rate batao', null],
];

test('1-2. URGENT phrases', () => {
  for (const [s, exp] of cases.filter(([, e]) => e === 'URGENT')) {
    assert.equal(ext.parseSaleUrgency(s), 'URGENT', s);
  }
});

test('3-4. SOON phrases', () => {
  for (const [s, exp] of cases.filter(([, e]) => e === 'SOON')) {
    assert.equal(ext.parseSaleUrgency(s), 'SOON', s);
  }
});

test('5-7. EXPLORING phrases', () => {
  for (const [s, exp] of cases.filter(([, e]) => e === 'EXPLORING')) {
    assert.equal(ext.parseSaleUrgency(s), 'EXPLORING', s);
  }
});

test('8-9. no signal stays null', () => {
  for (const [s, exp] of cases.filter(([, e]) => e === null)) {
    assert.equal(ext.parseSaleUrgency(s), null, s);
  }
});

test('10. buyer statements never set seller urgency', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('mujhe machine chahiye', 1);
  x.processTurn('mera budget bees se bais lakh hai', 2);
  assert.equal(x.extracted.customer_type, 'buyer');
  assert.equal(x.extracted.commercial_terms.sale_urgency ?? null, null);
});

test('11. null never overwrites stored value', () => {
  const out = vaaniSales.mergeGatheredContextPreserving(
    { extracted_variables: { commercial_terms: { sale_urgency: 'URGENT' } } },
    { extracted_variables: { commercial_terms: {} } }
  );
  assert.equal(out.extracted_variables.commercial_terms.sale_urgency, 'URGENT');
});

test('12. latest explicit seller position wins', () => {
  const md = {}, ct = {}, pl = {};
  vaaniSales.applyDeterministicBackstop({
    customerType: 'seller',
    transcript: [
      { speaker: 'Customer', message: 'abhi rate pata kar raha hu' },
      { speaker: 'Customer', message: 'nahi nahi, turant bechna hai' },
    ],
    conversation: null, machDetails: md, commTerms: ct, payload: pl,
  });
  assert.equal(ct.sale_urgency, 'URGENT');
});

test('13. B1 and B2 behavior intact', () => {
  assert.equal(ext.parseSpokenPrice('18 lakh').max_inr, 1800000);
  assert.equal(ext.parsePriceNegotiability('18 lakh final hai'), false);
  const C = vaaniSales.evaluateQualificationCompleteness;
  assert.equal(C('seller', { machine_type: 'x', brand: 'JCB', model: '3DX', year: 2020, hours: 100, condition: 'good', availability_status: 'available', asking_price: 1, machine_location: 'Jaipur' }).status, 'QUALIFIED');
});

test('14. seller UI renders all urgency states honestly', () => {
  const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
  for (const s of ['Sale Urgency: Urgent', 'Sale Urgency: Soon', 'Sale Intent: Exploring', 'Sale Urgency: Normal', 'Sale Urgency: Not specified']) {
    assert.ok(dashSrc.includes(s), s);
  }
  assert.ok(!dashSrc.includes('Sale Urgency: URGENT'), 'no raw enum shown');
});
