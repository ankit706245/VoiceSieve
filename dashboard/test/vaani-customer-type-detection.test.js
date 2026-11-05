'use strict';
// Buyer/seller classification from the caller's own words. This is the
// fallback that keeps cut calls and provider outages from defaulting to buyer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCustomerTypeFromTranscript } = require('../lib/vaani-sales');

const convo = (...userLines) => [
  { role: 'assistant', text: 'Namaste, koi machine sale karni hai ya purchase karni hai?' },
  ...userLines.map((text) => ({ role: 'user', text })),
];

test('seller: "machine sale karni hai"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Machine sale karni hai.')), 'seller');
});

test('seller: Hinglish "sale करना चाहता हूं"', () => {
  assert.equal(
    detectCustomerTypeFromTranscript(convo('Machine sale करना चाहता हूं.')),
    'seller'
  );
});

test('seller: "sale karna chahte hain"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Sale karna chahte hain.')), 'seller');
});

test('seller: "bechni hai"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Mujhe apni JCB bechni hai.')), 'seller');
});

test('seller: Devanagari "बेचनी है"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('मुझे मशीन बेचनी है.')), 'seller');
});

test('buyer: "kharidna hai"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Mujhe excavator kharidna hai.')), 'buyer');
});

test('buyer: "purchase karna chahta hoon"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Main machine purchase karna chahta hoon.')), 'buyer');
});

test('buyer: Devanagari "खरीदनी है"', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('मुझे मशीन खरीदनी है.')), 'buyer');
});

test('assistant question alone is ignored', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo()), null);
});

test('cut call with no buy/sell statement stays unclassified', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Haan ji.')), null);
});

test('latest explicit statement wins', () => {
  assert.equal(
    detectCustomerTypeFromTranscript(convo('Pehle sale karni thi.', 'Ab purchase karni hai.')),
    'buyer'
  );
});

test('correction from buyer to seller wins', () => {
  assert.equal(
    detectCustomerTypeFromTranscript(convo('Mujhe kharidni hai.', 'Nahi, bechni hai.')),
    'seller'
  );
});

test('asking about sale commission is a seller (commission on selling)', () => {
  assert.equal(detectCustomerTypeFromTranscript(convo('Sale par commission kitna hai?')), 'seller');
});
