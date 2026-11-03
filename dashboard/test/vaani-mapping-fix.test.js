'use strict';
// Phase 2 mapping fix: buyer machine_type + preferred_city (pure, no network,
// no database writes, no secrets, no PSTN, no WhatsApp).
const test = require('node:test');
const assert = require('node:assert/strict');
const llmExt = require('../lib/vaani-llm-extractor');
const vaaniSales = require('../lib/vaani-sales');

const map = llmExt.mapLLMResultToVaaniFormat;

function buyerLLM(over = {}) {
  return {
    customer_type: 'buyer',
    buyer_info: {
      required_machine_brand: 'JCB',
      required_machine_model: '3DX',
      required_machine_category: 'Excavator',
      required_year: null,
      required_hours: null,
      required_condition: null,
      machine_quantity: 1,
      budget: 2200000,
      budget_min_inr: 2000000,
      price_or_budget_raw: 'bees se bais lakh',
      budget_qualifier: 'range',
      finance_required: null,
      whatsapp_requested: null,
      purchase_location: 'Alwar',
      purchase_timeline: 'not_applicable',
      ...over,
    },
  };
}

function sellerLLM(over = {}) {
  return {
    customer_type: 'seller',
    seller_info: {
      machine_brand: 'Tata Hitachi',
      machine_model: 'EX 200 LC',
      machine_year: 2019,
      running_hours: 4800,
      machine_condition: null,
      machine_location: 'Jaipur',
      document_status: null,
      expected_selling_price: 2600000,
      sale_urgency: null,
      price_negotiable: null,
      photos_available: null,
      video_available: null,
      ...over,
    },
  };
}

test('1. explicit buyer category maps to machine_type', () => {
  const r = map(buyerLLM());
  assert.equal(r.extracted.machine_details.machine_type, 'excavator');
});

test('2. missing/null/blank category leaves machine_type absent', () => {
  for (const v of [null, undefined, '', '   ']) {
    const r = map(buyerLLM({ required_machine_category: v }));
    assert.ok(r.extracted.machine_details.machine_type === null
      || r.extracted.machine_details.machine_type === undefined,
      `category ${JSON.stringify(v)} must not produce a type`);
  }
});

test('3. explicit buyer purchase city fills preferred_city, keeps location_city', () => {
  const r = map(buyerLLM());
  assert.equal(r.extracted.machine_details.preferred_city, 'Alwar');
  assert.equal(r.extracted.machine_details.location_city, 'Alwar');
});

test('4. blank purchase city leaves preferred_city absent', () => {
  const r = map(buyerLLM({ purchase_location: '  ' }));
  assert.ok(r.extracted.machine_details.preferred_city === null
    || r.extracted.machine_details.preferred_city === undefined);
});

test('5. seller location stays machine location, never buyer preferred city or budget', () => {
  const r = map(sellerLLM());
  assert.equal(r.extracted.machine_details.location_city, 'Jaipur');
  assert.ok(r.extracted.machine_details.preferred_city === null
    || r.extracted.machine_details.preferred_city === undefined);
  assert.equal(r.extracted.commercial_terms.expected_price_inr, 2600000);
  assert.equal(r.extracted.commercial_terms.budget_max_inr, null);
  assert.equal(r.extracted.machine_details.machine_type, undefined);
});

test('6. buyer mapping preserves brand/model/budget alongside new keys', () => {
  const r = map(buyerLLM());
  assert.equal(r.extracted.machine_details.brand, 'JCB');
  assert.equal(r.extracted.machine_details.model, '3DX');
  assert.equal(r.extracted.commercial_terms.budget_max_inr, 2200000);
  assert.equal(r.extracted.commercial_terms.budget_min_inr, 2000000);
  assert.equal(r.extracted.commercial_terms.budget_qualifier, 'range');
});

test('7. retry-safe merge preserves mapped facts against thin null retry', () => {
  const stored = {
    extracted_variables: {
      customer_type: 'buyer',
      machine_details: { brand: 'JCB', machine_type: 'excavator', preferred_city: 'Alwar', location_city: 'Alwar' },
      commercial_terms: { budget_max_inr: 2200000 },
    },
  };
  const thin = {
    extracted_variables: {
      customer_type: 'buyer',
      machine_details: { brand: null, machine_type: null, preferred_city: null, location_city: '' },
      commercial_terms: { budget_max_inr: null },
    },
  };
  const merged = vaaniSales.mergeGatheredContextPreserving(stored, thin);
  const md = merged.extracted_variables.machine_details;
  assert.equal(md.machine_type, 'excavator');
  assert.equal(md.preferred_city, 'Alwar');
  assert.equal(md.location_city, 'Alwar');
});
