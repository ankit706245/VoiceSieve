'use strict';
// Goal 31 follow-up engine tests. Pure deterministic unit tests over
// buildFollowUpRecommendation plus source and contract assertions for
// Buyer 360 wiring, org isolation, and planning-only guarantees. No network,
// no database writes, no secrets, no PSTN, no WhatsApp, no SMS, no email.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const F = vaaniSales.buildFollowUpRecommendation;
const qual = (missing, collected = ['machine_type']) => ({
  status: missing.length ? 'PARTIALLY_QUALIFIED' : 'QUALIFIED',
  collected_fields: collected, missing_fields: missing,
});

test('qualified buyer with nothing pending needs no follow-up', () => {
  const out = F({
    customer_type: 'buyer', phone: '+919999900001',
    qualification: { status: 'QUALIFIED', collected_fields: ['machine_type'], missing_fields: [] },
    objections: [], matches: [], existingNextAction: null, followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.needed, false);
  assert.equal(out.priority, 'NONE');
  assert.equal(out.state, 'not_needed');
  assert.equal(out.due_at, null);
  assert.equal(out.owner_required, false);
});

test('buyer missing required qualification field', () => {
  const out = F({
    customer_type: 'buyer', phone: '+919999900001',
    qualification: qual(['purchase_timeline']), objections: [], matches: [],
    existingNextAction: null, followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.needed, true);
  assert.equal(out.priority, 'MEDIUM');
  assert.equal(out.follow_up_type, 'qualification');
  assert.ok(/purchase_timeline/.test(out.reason), 'names the gap, got: ' + out.reason);
  assert.ok(/purchase_timeline/.test(out.recommended_action), 'action targets the gap');
  assert.equal(out.due_at, null);
  assert.equal(out.owner_required, false);
  assert.equal(out.state, 'recommended');
});

test('buyer with previous next action reuses it verbatim', () => {
  const out = F({
    customer_type: 'buyer', phone: '+919999900001',
    qualification: qual([]), objections: [], matches: [],
    existingNextAction: 'Call back Friday 11am', followUpDatetime: '2026-10-10', dnc_requested: false,
  });
  assert.equal(out.needed, true);
  assert.equal(out.follow_up_type, 'callback_action');
  assert.equal(out.recommended_action, 'Call back Friday 11am');
  assert.equal(out.due_at, '2026-10-10');
});

test('buyer with owner-needed objection escalates first', () => {
  const out = F({
    customer_type: 'buyer', phone: '+919999900001',
    qualification: qual(['purchase_timeline']), objections: [{ type: 'price_budget', status: 'open', owner_needed: true }],
    matches: [{ machine_id: 'm1' }], existingNextAction: 'Call back', followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.needed, true);
  assert.equal(out.priority, 'HIGH');
  assert.equal(out.follow_up_type, 'owner_review');
  assert.equal(out.recommended_channel, 'owner_review');
  assert.ok(/Owner review required/.test(out.recommended_action));
  assert.ok(/price_budget/.test(out.reason));
  assert.equal(out.owner_required, true);
  assert.equal(out.state, 'owner_review');
});

test('buyer with inventory match gets review recommendation', () => {
  const out = F({
    customer_type: 'buyer', phone: '+919999900001',
    qualification: { status: 'QUALIFIED', collected_fields: ['a'], missing_fields: [] },
    objections: [], matches: [{ machine_id: 'm1' }, { machine_id: 'm2' }],
    existingNextAction: null, followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.needed, true);
  assert.equal(out.follow_up_type, 'inventory_review');
  assert.ok(/2 inventory match/.test(out.reason));
  assert.equal(out.owner_required, false);
});

test('buyer with no inventory gets gap-based recommendation', () => {
  const out = F({
    customer_type: 'buyer', phone: '+919999900001',
    qualification: qual(['preferred_city']), objections: [], matches: [],
    existingNextAction: null, followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.follow_up_type, 'qualification');
  assert.ok(!/inventory/i.test(out.reason), 'no inventory claims without stock');
});

test('seller with missing machine information', () => {
  const out = F({
    customer_type: 'seller', phone: '+919999900002',
    qualification: { status: 'PARTIALLY_QUALIFIED', collected_fields: ['brand'], missing_fields: ['asking_price', 'condition'] },
    objections: [], matches: [], existingNextAction: null, followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.needed, true);
  assert.equal(out.follow_up_type, 'qualification');
  assert.ok(/asking_price/.test(out.recommended_action) && /condition/.test(out.recommended_action));
});

test('seller with previous next action', () => {
  const out = F({
    customer_type: 'seller', phone: '+919999900002',
    qualification: qual([]), objections: [], matches: [],
    existingNextAction: 'Collect RC copy', followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.recommended_action, 'Collect RC copy');
  assert.equal(out.follow_up_type, 'callback_action');
});

test('seller with owner-needed objection escalates', () => {
  const out = F({
    customer_type: 'seller', phone: '+919999900002',
    qualification: qual([]), objections: [{ type: 'commission', status: 'open', owner_needed: true }],
    matches: [], existingNextAction: 'Call back', followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.priority, 'HIGH');
  assert.equal(out.owner_required, true);
  assert.equal(out.state, 'owner_review');
});

test('no fabricated due date without factual basis', () => {
  for (const inp of [
    { customer_type: 'buyer', phone: '1', qualification: qual(['x']), objections: [], matches: [] },
    { customer_type: 'seller', phone: '1', qualification: qual(['y']), objections: [], matches: [] },
  ]) {
    assert.equal(F(inp).due_at, null);
  }
});

test('no fabricated urgency, prices, or discounts', () => {
  const dumped = JSON.stringify([
    F({ customer_type: 'buyer', phone: '1', qualification: qual(['a']), objections: [], matches: [] }),
    F({ customer_type: 'seller', phone: '1', qualification: qual(['b']), objections: [], matches: [] }),
  ]);
  assert.ok(!/urgent|hurry|immediately|discount|deal|offer|tomorrow|10 AM|probability|score/i.test(dumped), 'no invented urgency or offers');
});

test('no fabricated price or discount language anywhere', () => {
  const dumped = JSON.stringify(F({ customer_type: 'buyer', phone: '1', qualification: qual(['a']), objections: [{ type: 'price_budget', status: 'open', owner_needed: true }], matches: [] }));
  assert.ok(!/₹|lakh|discount|deal closed|won/i.test(dumped), 'no money or deal claims');
});

test('recommended channel never triggers communication', () => {
  const code = strip(libSrc).split('function buildFollowUpRecommendation')[1].split('\nfunction normalizeNewOrUsed')[0];
  assert.ok(!/fetch\(|whatsapp|sms|email|dial|pstn|send/i.test(code), 'planner calls nothing external');
  assert.ok(['phone', 'owner_review', 'unknown'].includes(F({ customer_type: 'buyer', phone: '1', qualification: qual(['a']), objections: [], matches: [] }).recommended_channel));
});

test('recommendation is deterministic for identical input', () => {
  const inp = () => ({ customer_type: 'buyer', phone: '1', qualification: qual(['a']), objections: [{ type: 'x', status: 'open', owner_needed: false }], matches: [{ machine_id: 'm1' }], existingNextAction: null, followUpDatetime: null, dnc_requested: false });
  assert.deepEqual(F(inp()), F(JSON.parse(JSON.stringify(inp()))));
});

test('same input produces same output across sides independently', () => {
  const b = F({ customer_type: 'buyer', phone: '1', qualification: qual(['a']), objections: [], matches: [] });
  const s = F({ customer_type: 'seller', phone: '1', qualification: qual(['a']), objections: [], matches: [] });
  assert.deepEqual(b, { ...s });
});

test('buyer and seller logic remains separate via inputs, not branches', () => {
  const code = strip(libSrc).split('function buildFollowUpRecommendation')[1].split('\nfunction normalizeNewOrUsed')[0];
  assert.ok(!/buyer.*purchase|seller.*supply|intent/i.test(code), 'no side-specific intent logic inside planner');
});

test('empty and unknown leads yield no recommendation', () => {
  assert.equal(F({}).needed, false);
  assert.equal(F(null).needed, false);
  assert.equal(F({ customer_type: 'unknown', phone: '1', qualification: qual(['a']), objections: [], matches: [] }).needed, false);
  assert.equal(F({ customer_type: 'buyer', dnc_requested: true, phone: '1', qualification: qual([]), objections: [{ type: 'x', status: 'open', owner_needed: true }], matches: [{ machine_id: 'm1' }], existingNextAction: 'Call' }).needed, false);
});

test('buyer 360 integration exposes follow_up without duplication', () => {
  assert.ok(libSrc.includes('follow_up: followUpRec'), 'lead360 attaches planner output');
  assert.ok(libSrc.includes('buyer360Data.follow_up = followUpRec'), 'buyer snapshot reuses same object');
  const defs = (libSrc.match(/(^|\n)function buildFollowUpRecommendation\(/g) || []).length;
  assert.equal(defs, 1, 'single planner definition, wired (not duplicated) into lead360');
});

test('sales brain integration consumes stage and focus read-only', () => {
  assert.ok(!/sales_brain.*=|salesBrainData\s*=/i.test(strip(libSrc).split('function buildFollowUpRecommendation')[1].split('\nfunction normalizeNewOrUsed')[0]), 'planner never writes brain state');
});

test('Goal 29 summary integration prefers stored next actions', () => {
  const out = F({
    customer_type: 'buyer', phone: '1', qualification: qual(['a']),
    objections: [], matches: [], existingNextAction: 'Stored action from summary', followUpDatetime: null, dnc_requested: false,
  });
  assert.equal(out.recommended_action, 'Stored action from summary');
});

test('organization isolation through existing lead360 gates', () => {
  assert.ok(libSrc.includes('WHERE w.organization_id = $1'), 'lead360 stays org-filtered');
  const fn = strip(libSrc).split('function buildFollowUpRecommendation')[1].split('\nfunction normalizeNewOrUsed')[0];
  assert.ok(!/organization_id/.test(fn), 'planner takes no org input; callers scope');
});

test('authentication protection unchanged', () => {
  assert.ok(serverSrc.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"), 'legacy login intact');
  assert.ok(serverSrc.includes('requireBraivexAuth(req, res, apiVaaniSalesOverviewBraivex)'), 'bearer routes intact');
});

test('no new memory system beyond the pure planner', () => {
  const fn = strip(libSrc).split('function buildFollowUpRecommendation')[1].split('\nfunction normalizeNewOrUsed')[0];
  assert.ok(!/\b(queryPostgres|INSERT|UPDATE|DELETE)\b|\bnew Map\(|globalThis|\bcache\b/i.test(fn), 'no storage, no cache, no queries');
});

test('no WhatsApp, PSTN, SMS, or email calls from planner or UI card', () => {
  const fn = strip(libSrc).split('function buildFollowUpRecommendation')[1].split('\nfunction normalizeNewOrUsed')[0];
  assert.ok(!/whatsapp|sms|email|pstn|dial/i.test(fn), 'planner is contact-free');
  assert.ok(dashSrc.includes('id="followUpCard"'), 'UI card present');
  const ui = dashSrc.split('id="followUpCard"')[1].split('id="toast"')[0];
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|whatsapp|sms|mailto|tel:/i.test(ui), 'UI card is read-only display');
});
