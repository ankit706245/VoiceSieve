'use strict';
// Phase 2 Step 1: requirement-extraction foundation tests.
// Covers: Hindi/English/Hinglish budgets (exact/range/tak/se-kam/approximate/
// ambiguous), quantity, financing, WhatsApp readiness, regression guards.
// Pure unit level: deterministic extractor + LLM mapping (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../lib/vaani-extractor');

test('A. Hindi exact budget', () => {
  const r = ext.parseSpokenPrice('y 20 lakh');
  assert.equal(r && r.max_inr, 2000000);
});

test('A2. Hindi range via words', () => {
  const r = ext.parseSpokenPrice('bees se bais lakh');
  assert.equal(r.min_inr, 2000000);
  assert.equal(r.max_inr, 2200000);
  assert.equal(r.qualifier, 'range');
});

test('B. Hindi range Devanagari', () => {
  const r = ext.parseSpokenPrice('बीस से बाइस लाख');
  assert.deepEqual([r.min_inr, r.max_inr, r.qualifier], [2000000, 2200000, 'range']);
  assert.ok(r.raw.includes('बीस'));
});

test('C. English exact budget', () => {
  const r = ext.parseSpokenPrice('My budget is 18 lakh');
  assert.deepEqual([r.min_inr, r.max_inr, r.qualifier], [1800000, 1800000, 'exact']);
});

test('D. Hinglish range', () => {
  const r = ext.parseSpokenPrice('18 se 20 lakh ke beech');
  assert.deepEqual([r.min_inr, r.max_inr, r.qualifier], [1800000, 2000000, 'range']);
});

test('E. tak is max-only', () => {
  const r = ext.parseSpokenPrice('22 lakh tak');
  assert.equal(r.min_inr, null);
  assert.equal(r.max_inr, 2200000);
  assert.equal(r.qualifier, 'max');
});

test('F. se kam is max-only', () => {
  const r = ext.parseSpokenPrice('15 lakh se kam');
  assert.equal(r.min_inr, null);
  assert.equal(r.max_inr, 1500000);
  assert.equal(r.qualifier, 'max');
});

test('G. approximate never invents a range', () => {
  for (const s of ['around 20 lakh', 'lagbhag 20 lakh']) {
    const r = ext.parseSpokenPrice(s);
    assert.equal(r.qualifier, 'approximate');
    assert.equal(r.max_inr, 2000000);
  }
});

test('H. ambiguous budget guesses nothing', () => {
  assert.equal(ext.parseSpokenPrice('koi budget nahi'), null);
  assert.equal(ext.parseSpokenPrice('budget bataunga'), null);
  assert.equal(ext.parseSpokenPrice(''), null);
});

test('I. Hindi quantity', () => {
  assert.equal(ext.parseSpokenQuantity('ek machine chahiye').quantity, 1);
  assert.equal(ext.parseSpokenQuantity('do excavator chahiye').quantity, 2);
  assert.equal(ext.parseSpokenQuantity('mujhe teen JCB chahiye').quantity, 3);
  assert.equal(ext.parseSpokenQuantity('ek minute ruko'), null);
  assert.equal(ext.parseSpokenQuantity('do baar bola'), null);
});

test('J. English quantity', () => {
  assert.equal(ext.parseSpokenQuantity('2 machines chahiye').quantity, 2);
  assert.equal(ext.parseSpokenQuantity('I want three excavators').quantity, 3);
});

test('K. Hindi/Hinglish financing', () => {
  assert.equal(ext.parseFinanceRequirement('finance karwana hai'), true);
  assert.equal(ext.parseFinanceRequirement('machine finance par leni hai'), true);
  assert.equal(ext.parseFinanceRequirement('cash mein lunga'), false);
  assert.equal(ext.parseFinanceRequirement('koi baat nahi'), null);
});

test('L. English financing', () => {
  assert.equal(ext.parseFinanceRequirement('loan chahiye'), true);
  assert.equal(ext.parseFinanceRequirement('full payment karunga'), false);
  assert.equal(ext.parseFinanceRequirement('loan chal raha hai'), null);
});

test('M. WhatsApp request state, never a sent claim', () => {
  assert.equal(ext.parseWhatsappRequest('Machine ki details WhatsApp par bhej do'), true);
  assert.equal(ext.parseWhatsappRequest('photos bhej dunga'), false);
  assert.equal(ext.parseWhatsappRequest('koi baat nahi'), false);
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('machine purchase karni hai', 1);
  x.processTurn('Machine ki details WhatsApp par bhej do', 2);
  assert.equal(x.extracted.whatsapp_requested, true);
  assert.equal(x.extracted.whatsapp_action, 'PENDING');
});

test('N1. full buyer statement end to end', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('Mujhe JCB 3DX chahiye', 1);
  x.processTurn('mera budget bees se bais lakh hai', 2);
  x.processTurn('Jaipur mein chahiye, do machine chahiye aur finance karwana hai', 3);
  const e = x.extracted;
  assert.equal(e.customer_type, 'buyer');
  assert.equal(e.commercial_terms.budget_min_inr, 2000000);
  assert.equal(e.commercial_terms.budget_max_inr, 2200000);
  assert.equal(e.commercial_terms.budget_qualifier, 'range');
  assert.ok(String(e.commercial_terms.price_or_budget_raw).includes('bees se bais lakh'));
  assert.equal(e.machine_details.quantity, 2);
  assert.equal(e.commercial_terms.finance_required, true);
});

test('N2. seller path untouched (expected_price, no budget split)', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('mere paas JCB hai, bechni hai', 1);
  x.processTurn('25 lakh mein deni hai', 2);
  const e = x.extracted;
  assert.equal(e.customer_type, 'seller');
  assert.equal(e.commercial_terms.expected_price_inr, 2500000);
});
