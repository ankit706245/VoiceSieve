'use strict';
// VAANI-001: buyer/seller classification precedence. Pure function, no DB,
// no network, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const vaaniSales = require('../lib/vaani-sales');

const resolve = vaaniSales.resolveCustomerType;

test('VAANI-001: customer_type takes precedence over buyer_seller_classification', () => {
  assert.equal(resolve({
    customer_type: 'buyer',
    extracted_variables: { buyer_seller_classification: 'seller' },
  }), 'buyer');
});

test('VAANI-001: buyer_seller_classification takes precedence over intent', () => {
  assert.equal(resolve({
    extracted_variables: { buyer_seller_classification: 'seller', intent: 'purchase' },
  }), 'seller');
});

test('VAANI-001: intent maps to buyer when only intent is present', () => {
  assert.equal(resolve({ extracted_variables: { intent: 'purchase' } }), 'buyer');
});

test('VAANI-001: intent maps to seller when only intent is present', () => {
  assert.equal(resolve({ extracted_variables: { intent: 'sell' } }), 'seller');
});

test('VAANI-001: ambiguous values resolve to unknown, not buyer or seller', () => {
  assert.equal(resolve({ customer_type: 'maybe' }), 'unknown');
  assert.equal(resolve({ extracted_variables: { intent: 'browsing' } }), 'unknown');
});

test('VAANI-001: missing all classification fields resolves to unknown', () => {
  assert.equal(resolve({}), 'unknown');
});

test('VAANI-001: null customer_type falls through to buyer_seller_classification', () => {
  assert.equal(resolve({
    customer_type: null,
    extracted_variables: { buyer_seller_classification: 'buyer' },
  }), 'buyer');
});

test('VAANI-001: empty string customer_type falls through to next source', () => {
  assert.equal(resolve({
    customer_type: '',
    extracted_variables: { intent: 'sell' },
  }), 'seller');
});

test('VAANI-001: buyer_seller_classification with "not_interested" maps to other', () => {
  assert.equal(resolve({
    extracted_variables: { buyer_seller_classification: 'not_interested' },
  }), 'other');
});
