'use strict';
// Goal 27 objection-handling tests. Deterministic unit tests over
// detectObjections / updateObjectionStatus / detectLeadObjections plus
// source and contract assertions for Lead 360 wiring, org isolation, and
// no-negotiation guarantees. No network, no database writes, no secrets,
// no PSTN, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const D = vaaniSales.detectObjections;
const tx = (speaker, message) => ({ speaker, message });

test('buyer price objection with grounded facts and owner escalation', () => {
  const [o] = D('buyer', [tx('Customer', 'Price bahut zyada hai, budget 18 lakh tak hai')], {
    budget: 1800000, inventory_price: 1750000,
  });
  assert.equal(o.type, 'price_budget');
  assert.equal(o.status, 'open');
  assert.equal(o.owner_needed, true);
  assert.deepEqual(o.facts_to_verify, [], 'all price facts known, nothing to verify');
  assert.ok(/discount|negotiation/i.test(o.safe_response_guidance), 'guidance forbids discount promises');
  assert.ok(/Do NOT promise/.test(o.safe_response_guidance), 'prohibition is explicit, never an affirmative promise');
});

test('buyer condition objection without evidence stays verifiable', () => {
  const [o] = D('buyer', [tx('user', 'Machine ki condition kaisi hai? Purana to nahi hai?')], {});
  assert.equal(o.type, 'condition');
  assert.equal(o.owner_needed, false);
  assert.ok(o.facts_to_verify.includes('condition'), 'unknown condition flagged');
  assert.ok(o.facts_to_verify.includes('evidence'), 'evidence flagged');
});

test('buyer location objection names the mismatch honestly', () => {
  const [o] = D('buyer', [tx('Customer', 'Alwar se bahut door hai, delivery kaise hogi')], {
    location: 'Alwar', inventory_location: 'Jaipur',
  });
  assert.equal(o.type, 'location');
  assert.deepEqual(o.facts_to_verify, [], 'both locations known');
  assert.ok(/deliver|transport/i.test(o.safe_response_guidance), 'no delivery promise in guidance');
});

test('buyer availability objection stays open without stock claims', () => {
  const [o] = D('buyer', [tx('user', 'Machine kab milega, stock mein hai kya')], {});
  assert.equal(o.type, 'availability');
  assert.ok(o.facts_to_verify.includes('availability'));
});

test('buyer financing objection without commitment language', () => {
  const [o] = D('buyer', [tx('Customer', 'Finance ho jayega kya, EMI par lena hai')], { budget: 1800000 });
  assert.equal(o.type, 'financing_payment');
  assert.equal(o.owner_needed, false);
  assert.ok(o.facts_to_verify.includes('finance'), 'finance facts flagged');
  assert.ok(/Do NOT approve/.test(o.safe_response_guidance), 'approval prohibition explicit, never an approval');
});

test('buyer timing objection is informational only', () => {
  const [o] = D('buyer', [tx('user', 'Abhi nahi, ek mahine baad sochenge')], {});
  assert.equal(o.type, 'timing');
  assert.equal(o.owner_needed, false);
});

test('buyer unknown context yields unknown marker, never a guess', () => {
  const [o] = D('buyer', [tx('Customer', 'Namaste ji, aur batao')], {});
  assert.equal(o.type, 'unknown');
  assert.equal(o.owner_needed, false);
  assert.deepEqual(D('buyer', []), [], 'empty transcript yields nothing, not even unknown');
  assert.deepEqual(D('buyer', [{ speaker: 'Vaani', message: 'Price bahut zyada hai' }]), [], 'agent words never trigger detection');
});

test('seller price objection escalates with valuation facts', () => {
  const [o] = D('seller', [tx('Customer', 'Meri demand 19 lakh hai, isse kam nahi bechunga')], {
    asking_price: 1900000,
  });
  assert.equal(o.type, 'asking_price');
  assert.equal(o.owner_needed, true);
  assert.ok(o.facts_to_verify.includes('valuation'), 'valuation basis flagged');
});

test('seller condition objection stays factual', () => {
  const [o] = D('seller', [tx('user', 'Machine bilkul theek condition mein hai')], { condition: 'Good' });
  assert.equal(o.type, 'condition');
  assert.ok(!o.facts_to_verify.includes('condition'), 'known condition needs no re-verification');
  assert.ok(o.facts_to_verify.includes('evidence'), 'photo evidence remains the honest verification path');
});

test('seller payment objection without invented terms', () => {
  const [o] = D('seller', [tx('Customer', 'Advance mein kitna doge, baaki kab milega')], {});
  assert.equal(o.type, 'payment');
  assert.ok(o.facts_to_verify.includes('payment'));
  assert.ok(!/will pay|guaranteed|pakka payment/i.test(o.safe_response_guidance), 'no payment promises');
});

test('seller availability objection is informational', () => {
  const [o] = D('seller', [tx('user', 'Machine ready hai, kab bhejoge लेने')], {});
  assert.equal(o.type, 'availability');
  assert.equal(o.owner_needed, false);
});

test('buyer and seller logic never mix', () => {
  const b = D('buyer', [tx('Customer', 'Price bahut zyada hai')]);
  assert.ok(b.length && b[0].context.customer_type === 'buyer');
  assert.ok(!b.some((o) => o.type === 'commission' || o.type === 'asking_price'), 'no seller categories on buyer');
  const s = D('seller', [tx('Customer', 'Commission kitna loge')]);
  assert.ok(s.some((o) => o.type === 'commission'), 'seller commercial concern detected');
  assert.ok(!s.some((o) => o.type === 'price_budget'), 'no buyer categories on seller');
});

test('missing facts are listed, never fabricated', () => {
  const [o] = D('buyer', [tx('Customer', 'Price zyada hai')], {});
  assert.ok(o.facts_to_verify.includes('budget'), 'missing budget flagged');
  assert.ok(o.facts_to_verify.includes('inventory_price'), 'missing inventory price flagged');
  assert.ok(!JSON.stringify(o).includes('1800000'), 'no invented numbers');
});

test('discount talk forces owner escalation on any side', () => {
  const [b] = D('buyer', [tx('Customer', 'Kuch discount de do ji')]);
  assert.equal(b.owner_needed, true);
  const [s] = D('seller', [tx('Customer', 'Rate mein thoda discount kar dunga')]);
  assert.equal(s.owner_needed, true);
});

test('unsupported claims require verification, never assertion', () => {
  const [o] = D('buyer', [tx('Customer', 'RC aur NOC clear hai na')], {});
  assert.equal(o.type, 'documentation');
  assert.equal(o.owner_needed, true);
  assert.ok(o.facts_to_verify.includes('documents'));
});

test('sales brain context shapes detection input without a second memory', () => {
  const brain = {
    customer_type: 'buyer',
    requirement: { budget_max: 1800000 },
    qualification: { status: 'PARTIALLY_QUALIFIED' },
    inventory_matches: [{ asking_price: 1750000, current_location: 'Alwar' }],
    calls: [{ transcript: [{ speaker: 'Customer', message: 'Price zyada hai' }] }],
  };
  const groups = vaaniSales.detectLeadObjections({
    customer_type: brain.customer_type,
    requirement: brain.requirement,
    qualification: brain.qualification,
    inventory_matches: brain.inventory_matches,
    calls: brain.calls,
  });
  assert.equal(groups.current[0].type, 'price_budget');
  assert.deepEqual(groups.unresolved, groups.current);
  assert.equal(groups.owner_needed.length, 1);
});

test('transcript context drives detection; absent transcript yields empty groups', () => {
  const groups = vaaniSales.detectLeadObjections({
    customer_type: 'seller', requirement: {}, qualification: null,
    inventory_matches: [], calls: [{ conversation_outcome: 'inquiry' }],
  });
  assert.deepEqual(groups, { current: [], unresolved: [], owner_needed: [] });
  assert.deepEqual(vaaniSales.detectLeadObjections({ customer_type: 'dnc' }), { current: [], unresolved: [], owner_needed: [] });
});

test('objection status resolves deterministically', () => {
  const base = { type: 'price_budget', status: 'open', facts_to_verify: ['budget'], owner_needed: true };
  assert.equal(vaaniSales.updateObjectionStatus(base, { ownerDecision: 'approved' }).status, 'addressed');
  assert.equal(vaaniSales.updateObjectionStatus(base, { ownerDecision: 'rejected' }).status, 'unresolved');
  const done = vaaniSales.updateObjectionStatus(base, { factsNowKnown: ['budget'] });
  assert.equal(done.status, 'addressed');
  assert.deepEqual(done.facts_to_verify, []);
  const partial = vaaniSales.updateObjectionStatus({ ...base, facts_to_verify: ['a', 'b'] }, { factsNowKnown: ['a'] });
  assert.equal(partial.status, 'unresolved');
  assert.deepEqual(partial.facts_to_verify, ['b']);
  assert.equal(vaaniSales.updateObjectionStatus(base, { ownerReviewed: true }).status, 'needs_owner');
  assert.equal(vaaniSales.updateObjectionStatus(null, {}), null);
});

test('lead360 exposes objection groups without new routes or tables', () => {
  assert.ok(libSrc.includes('objections: objectionGroups'), 'lead360 carries groups');
  assert.ok(!/['"]\/api\/[^'"]*objection/i.test(serverSrc), 'no new objection routes');
  assert.ok(!/CREATE TABLE.*objection/i.test(libSrc), 'no new tables');
});

test('lead360 exposes objections read-only without banned branding', () => {
  const code = strip(dashSrc);
  assert.ok(libSrc.includes('objections: objectionGroups'), 'lead360 carries objection groups');
  assert.ok(!/AI Sales Agent|RapidX|Agency OS/i.test(dashSrc), 'no banned branding');
});
