'use strict';
// Phase 2 Step 4B: buyer machine-specification mirroring tests.
// Covers: hours/year/application mirrors, LLM hours/condition schema,
// bucket/GST notes, null-safety, no new_or_used requirement.
const test = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../lib/vaani-extractor');
const vaaniSales = require('../lib/vaani-sales');

test('running_hours mirror preserves original value', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('mujhe machine chahiye', 1);
  x.processTurn('5000 ghante se kam chali ho', 2);
  assert.equal(x.extracted.machine_details.running_hours, 5000);
});

test('model_year mirror preserves original value', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('2019 model chahiye', 1);
  assert.equal(x.extracted.machine_details.model_year, 2019);
});

test('application flags mirror for buyer only', () => {
  const b = new ext.VaaniConversationExtractor();
  b.processTurn('mujhe machine chahiye', 1);
  b.processTurn('mitti ka kaam hai', 2);
  assert.equal(b.extracted.machine_details.application_history, 'soil_earthwork');
  assert.equal(b.extracted.buyer_requirements.application, 'soil_earthwork');
  const s = new ext.VaaniConversationExtractor();
  s.processTurn('meri machine bechni hai', 1);
  s.processTurn('mitti ka kaam kiya hai', 2);
  assert.equal(s.extracted.machine_details.application_history, 'soil_earthwork');
  assert.equal(s.extracted.buyer_requirements.application, 'unknown');
});

test('LLM buyer hours/condition schema maps without new_or_used', () => {
  const src = { machine_details: { max_hours: 6000, condition: 'good' } };
  const got = vaaniSales.extractNewStructuredFields({ machine_details: { max_hours: 6000, condition: 'good' } });
  assert.equal(got.mach.max_hours, 6000);
  assert.equal(got.mach.condition, 'good');
  assert.ok(!('new_or_used' in got.mach) || got.mach.new_or_used === undefined);
});

test('bucket/GST notes are lightweight and null-safe', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('mujhe machine chahiye', 1);
  x.processTurn('bucket bhi chahiye aur GST bill chahiye', 2);
  const sum = x.extracted.machine_details.machine_condition_summary || '';
  assert.ok(sum.includes('bucket'), 'bucket noted: ' + sum);
  assert.ok(sum.includes('GST'), 'GST noted: ' + sum);
  const y = new ext.VaaniConversationExtractor();
  y.processTurn('mujhe machine chahiye', 1);
  assert.equal(y.extracted.machine_details.machine_condition_summary, null);
});

test('null/empty never clobbers meaningful specs', () => {
  const x = new ext.VaaniConversationExtractor();
  x.processTurn('2019 model chahiye', 1);
  x.processTurn('koi baat nahi', 2);
  assert.equal(x.extracted.machine_details.model_year, 2019);
});

test('buyer still has no new_or_used required field', () => {
  const C = vaaniSales.evaluateQualificationCompleteness;
  const r = C('buyer', { machine_type: 'x', budget_max: 1, preferred_city: 'y', purchase_timeline: 'z' });
  assert.equal(r.status, 'QUALIFIED');
  assert.ok(!r.missing_fields.includes('new_or_used'));
});

test('backstop fills hours/year/application when absent only', () => {
  const md = {}, ct = {}, pl = {};
  vaaniSales.applyDeterministicBackstop({
    customerType: 'buyer',
    transcript: [{ speaker: 'Customer', message: '5000 ghante se kam, 2019 model, mitti kaam' }],
    conversation: null, machDetails: md, commTerms: ct, payload: pl,
  });
  assert.equal(md.max_hours, 5000);
  assert.equal(md.model_year, 2019);
  assert.equal(md.application_history, 'soil_earthwork');
  const md2 = { max_hours: 6000, model_year: 2020, application_history: 'quarry_rock' };
  vaaniSales.applyDeterministicBackstop({
    customerType: 'buyer',
    transcript: [{ speaker: 'Customer', message: '5000 ghante, 2019 model, mitti kaam' }],
    conversation: null, machDetails: md2, commTerms: {}, payload: {},
  });
  assert.equal(md2.max_hours, 6000);
  assert.equal(md2.model_year, 2020);
  assert.equal(md2.application_history, 'quarry_rock');
});
