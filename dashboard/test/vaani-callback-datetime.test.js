'use strict';
// Step 1: Hindi / Roman-Hindi callback datetime extraction ("kal ek baje").
// Pure deterministic unit tests: parser, deterministic backstop wiring, and
// default-schedule non-overwrite. No network, no database writes, no secrets,
// no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../lib/vaani-extractor');
const vaaniSales = require('../lib/vaani-sales');

// Fixed reference: Monday 2026-10-12 10:00 server-local. All assertions use
// local getters so they hold in any timezone.
const NOW = new Date(2026, 9, 12, 10, 0, 0, 0).getTime();
const parts = (iso) => {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
};

test('1. reported case: kal ek baje -> tomorrow 13:00', () => {
  const r = ext.parseCallbackDatetime(
    'main note kar leti hoon ki aap kal ek baje tak call karenge', NOW);
  assert.ok(r, 'expected a parse');
  assert.deepEqual(parts(r.datetime), [2026, 9, 13, 13, 0]);
  assert.equal(r.qualifier, 'explicit');
});

test('2. digit form: kal 1 baje -> tomorrow 13:00', () => {
  const r = ext.parseCallbackDatetime('kal 1 baje phone karna', NOW);
  assert.ok(r);
  assert.deepEqual(parts(r.datetime), [2026, 9, 13, 13, 0]);
});

test('3. Devanagari: kal ek baje -> tomorrow 13:00', () => {
  const r = ext.parseCallbackDatetime('कल एक बजे कॉल करना', NOW);
  assert.ok(r);
  assert.deepEqual(parts(r.datetime), [2026, 9, 13, 13, 0]);
});

test('4. period words disambiguate', () => {
  assert.deepEqual(parts(ext.parseCallbackDatetime('kal shaam 5 baje call karna', NOW).datetime), [2026, 9, 13, 17, 0]);
  assert.deepEqual(parts(ext.parseCallbackDatetime('kal subah 10 baje sampark karenge', NOW).datetime), [2026, 9, 13, 10, 0]);
  assert.deepEqual(parts(ext.parseCallbackDatetime('kal dopahar 2 baje baat karenge', NOW).datetime), [2026, 9, 13, 14, 0]);
});

test('5. aaj and parson offsets', () => {
  assert.deepEqual(parts(ext.parseCallbackDatetime('aaj 11 baje baat karenge', NOW).datetime), [2026, 9, 12, 11, 0]);
  assert.deepEqual(parts(ext.parseCallbackDatetime('parson do baje call karna', NOW).datetime), [2026, 9, 14, 14, 0]);
});

test('6. ambiguous input resolves to nothing (never a guess)', () => {
  for (const t of [
    '3 baje',                        // no day
    'kal baat karenge',              // no hour
    'Mujhe JCB 3DX chahiye',         // model name
    '2 ghante lagenge',              // duration, not clock time
    'budget bees se bais lakh hai',  // budget words
    '8290453674 par call karna',     // phone number, no clock time
    'kal ek baje baat hui thi',      // past-tense narrative
    '',
  ]) {
    assert.equal(ext.parseCallbackDatetime(t, NOW), null, JSON.stringify(t));
  }
});

test('7. backstop fills absent follow_up_datetime from transcript (buyer)', () => {
  const payload = {};
  vaaniSales.applyDeterministicBackstop({
    customerType: 'buyer',
    transcript: 'caller: mujhe JCB chahiye\ncaller: kal ek baje call karna',
    conversation: null, machDetails: {}, commTerms: {}, payload,
  });
  assert.ok(payload.follow_up_datetime, 'expected datetime to be set');
  const d = new Date(payload.follow_up_datetime);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(d.getHours(), 13);
  assert.equal(d.getDate(), tomorrow.getDate());
});

test('8. backstop fills absent follow_up_datetime from transcript (seller)', () => {
  const payload = {};
  vaaniSales.applyDeterministicBackstop({
    customerType: 'seller',
    transcript: 'kal subah gyarah baje phone karna',
    conversation: null, machDetails: {}, commTerms: {}, payload,
  });
  assert.ok(payload.follow_up_datetime, 'expected datetime to be set');
  assert.equal(new Date(payload.follow_up_datetime).getHours(), 11);
});

test('9. backstop never overwrites an LLM/payload-provided datetime', () => {
  const payload = { follow_up_datetime: '2026-10-20T05:30:00.000Z' };
  vaaniSales.applyDeterministicBackstop({
    customerType: 'buyer',
    transcript: 'kal ek baje call karna',
    conversation: null, machDetails: {}, commTerms: {}, payload,
  });
  assert.equal(payload.follow_up_datetime, '2026-10-20T05:30:00.000Z');
});

test('10. evaluateFollowUp keeps explicit time, defaults only when absent', () => {
  const explicit = '2026-10-13T07:30:00.000Z';
  const kept = vaaniSales.evaluateFollowUp(
    { conversation_outcome: 'callback_requested', follow_up_datetime: explicit }, {});
  assert.equal(kept.follow_up_datetime, explicit);

  const def = vaaniSales.evaluateFollowUp({ conversation_outcome: 'callback_requested' }, {});
  const d = new Date(def.follow_up_datetime);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(d.getHours(), 11);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), tomorrow.getDate());
  assert.equal(def.follow_up_required, true);
});
