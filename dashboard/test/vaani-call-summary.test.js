'use strict';
// Goal 29 automatic call-summary tests. Pure composer coverage, stubbed
// persist/merge behavior, source guards for wiring, org isolation, and
// no-fabrication rules. Rollback-free: stubs record SQL instead of touching
// production. No secrets, no PSTN, no WhatsApp, no negotiation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const B = vaaniSales.buildTerminalCallSummary;

function buyerInput(over = {}) {
  return {
    call: { id: 78, status: 'completed', started_at: '2026-10-03T10:00:00Z', ended_at: '2026-10-03T10:05:00Z', duration: 300 },
    customer_type: 'buyer',
    customer: { name: 'Asha Singh', phone: '+919999900001' },
    requirement: { machine_type: 'Excavator', brand: 'JCB', model: '3DX', budget_max: 1800000, preferred_city: 'Alwar' },
    qualification: { status: 'PARTIALLY_QUALIFIED', collected_fields: ['machine_type', 'brand', 'budget'], missing_fields: ['purchase_timeline'] },
    objections: [{ type: 'price_budget', status: 'open', owner_needed: true }],
    matches: [{ machine_id: 'm1', brand: 'JCB', model: '3DX', match_score: 100 }],
    transcriptSegments: [{ speaker: 'Vaani', message: 'Namaste' }, { speaker: 'Customer', message: 'JCB 3DX chahiye' }],
    conversationOutcome: 'inquiry',
    existingNextAction: null,
    ...over,
  };
}
function sellerInput(over = {}) {
  return {
    call: { id: 79, status: 'completed' },
    customer_type: 'seller',
    customer: { name: 'Ravi Kumar', phone: '+919999900002' },
    requirement: { brand: 'JCB', model: '3DX', year: 2020, hours: 4500, condition: 'Good', asking_price: 1900000, machine_location: 'Ajmer' },
    qualification: { status: 'QUALIFIED', collected_fields: ['brand'], missing_fields: [] },
    objections: [],
    matches: [],
    transcriptSegments: [],
    conversationOutcome: 'lead_qualified',
    existingNextAction: null,
    ...over,
  };
}

test('buyer completed call summary with all factual sections', () => {
  const s = B(buyerInput());
  assert.equal(s.customer_type, 'buyer');
  assert.equal(s.intent, 'purchase');
  assert.equal(s.outcome, 'inquiry');
  assert.equal(s.call_status, 'completed');
  assert.ok(s.key_points.some((k) => /Asha Singh/.test(k)), 'identity present');
  assert.ok(s.key_points.some((k) => /JCB 3DX/.test(k)), 'machine present');
  assert.ok(s.key_points.some((k) => /2 recorded transcript/.test(k)), 'exchange count factual');
  assert.ok(s.key_points.some((k) => /1 inventory match/.test(k)), 'match count factual');
  assert.ok(s.key_points.some((k) => /price_budget.*owner needed/.test(k)), 'objection recorded');
  assert.ok(s.summary_text.includes('Asha Singh'), 'text names customer');
  assert.deepEqual(s.commitments, [], 'never any commitments');
  assert.equal(s.next_action, 'Collect: purchase_timeline');
  assert.deepEqual(s.owner_action, { needed: true, reasons: ['price_budget'] });
  assert.deepEqual(s.missing_info, ['purchase_timeline']);
  assert.equal(s.inventory_discussed.length, 1);
  assert.equal(s.inventory_discussed[0].match_score, 100);
});

test('seller completed call summary keeps supply schema', () => {
  const s = B(sellerInput());
  assert.equal(s.customer_type, 'seller');
  assert.equal(s.intent, 'sell');
  assert.equal(s.outcome, 'lead_qualified');
  assert.ok(s.key_points.some((k) => /2020/.test(k)), 'year present');
  assert.ok(s.key_points.some((k) => /4500/.test(k)), 'hours present');
  assert.ok(s.key_points.some((k) => /1900000|19/.test(k)), 'price present');
  assert.equal(s.next_action, null, 'nothing missing, no invented action');
  assert.deepEqual(s.owner_action, { needed: false, reasons: [] });
});

test('transcript-derived key points only from real segments', () => {
  const s = B(buyerInput({ transcriptSegments: [] }));
  assert.ok(!s.key_points.some((k) => /recorded transcript/.test(k)), 'no exchange claim without segments');
  assert.ok(s.summary_text.length > 0, 'text still built from structured data');
});

test('structured-field-derived summary without transcript', () => {
  const s = B(buyerInput({ transcriptSegments: [], objections: [], matches: [] }));
  assert.ok(s.key_points.some((k) => /JCB 3DX/.test(k)), 'structured facts stand alone');
  assert.equal(s.objections.length, 0);
  assert.equal(s.inventory_discussed.length, 0);
});

test('qualification and missing information included verbatim', () => {
  const s = B(buyerInput());
  assert.equal(s.qualification.status, 'PARTIALLY_QUALIFIED');
  assert.deepEqual(s.qualification.missing_fields, ['purchase_timeline']);
  assert.deepEqual(s.missing_info, ['purchase_timeline']);
});

test('objections included with owner flags preserved', () => {
  const s = B(buyerInput({ objections: [
    { type: 'price_budget', status: 'open', owner_needed: true },
    { type: 'timing', status: 'open', owner_needed: false },
  ] }));
  assert.equal(s.objections.length, 2);
  assert.deepEqual(s.owner_action, { needed: true, reasons: ['price_budget'] });
});

test('inventory context included when available, empty otherwise', () => {
  assert.equal(B(buyerInput()).inventory_discussed.length, 1);
  assert.deepEqual(B(sellerInput()).inventory_discussed, []);
});

test('no fabrication when fields are missing', () => {
  const s = B({ call: { id: 1, status: 'completed' }, customer_type: 'buyer' });
  assert.ok(s.key_points.some((k) => /unknown buyer contact/.test(k)), 'unknown identity stated');
  assert.equal(s.next_action, null);
  assert.equal(s.outcome, 'completed');
  assert.ok(!/₹|Lakh|JCB|Alwar|timeline|finance/i.test(s.summary_text), 'no invented specifics');
  assert.deepEqual(s.commitments, []);
});

test('no fabricated commitments under any input', () => {
  for (const inp of [buyerInput(), sellerInput(), {}, null, { call: {}, customer_type: 'buyer' }]) {
    assert.deepEqual(B(inp).commitments, [], 'commitments always empty');
    assert.ok(!/discount|guarantee|promise|deal closed|won/i.test(B(inp).summary_text), 'no commitment language');
  }
});

test('failed call summary is minimal and factual', () => {
  const s = B({ call: { id: 5, status: 'failed' }, customer_type: 'buyer', customer: { name: 'X', phone: '1' }, transcriptSegments: [] });
  assert.equal(s.call_status, 'failed');
  assert.equal(s.outcome, 'failed');
  assert.ok(!s.key_points.some((k) => /recorded transcript/.test(k)), 'no conversation claimed');
  assert.ok(s.key_points.some((k) => /failed/.test(k)), 'status recorded');
});

test('no-answer summary records absence of conversation', () => {
  const s = B({ call: { id: 6, status: 'no_answer' }, customer_type: 'seller', customer: {}, transcriptSegments: [] });
  assert.equal(s.outcome, 'no_answer');
  assert.ok(s.key_points.some((k) => /unknown seller contact/.test(k) || /no_answer/.test(k)));
});

test('cancelled call summary is minimal without invention', () => {
  const s = B({ call: { id: 7, status: 'cancelled' }, customer_type: 'buyer', customer: { name: 'Y' } });
  assert.equal(s.outcome, 'cancelled');
  assert.equal(s.next_action, null);
  assert.deepEqual(s.commitments, []);
});

test('repeated processing is idempotent in shape', () => {
  const a = B(buyerInput());
  const b = B(JSON.parse(JSON.stringify(buyerInput())));
  assert.deepEqual(a, b);
});

test('organization isolation via existing gates, never browser org', () => {
  assert.ok(serverSrc.includes('resolveVaaniCallOrg'), 'call ownership helper used');
  const ep = serverSrc.match(/async function apiVaaniCallStatus[\s\S]*?\n\}/)[0];
  assert.ok(!/body\.organization|query\.organization/.test(ep), 'endpoint never reads org from input');
  assert.ok(ep.includes('summarizeTerminalCall'), 'terminal transitions summarize');
});

test('existing auth gates remain respected', () => {
  assert.ok(serverSrc.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"), 'legacy login intact');
  assert.ok(serverSrc.includes('requireBraivexAuth(req, res, apiVaaniSalesOverviewBraivex)'), 'bearer routes intact');
});

test('existing summary data survives empty reprocessing', async () => {
  const issued = [];
  const q = async (sql) => {
    issued.push(sql);
    if (/FROM vaani_call_summaries/.test(sql)) {
      return { customer_requirement: 'kept', machine_discussed: null, interest_level: null, budget: null, customer_intent: 'buyer', outcome: null, next_action: null };
    }
    return null;
  };
  const out = await vaaniSales.upsertTerminalCallSummary(78, {
    customer_requirement: null, machine_discussed: null, interest_level: null,
    budget: null, customer_intent: 'buyer', outcome: null, next_action: null,
  }, q);
  assert.deepEqual(out, { stored: false, updated: false }, 'all-null row never touches storage');
  const out2 = await vaaniSales.upsertTerminalCallSummary(78, {
    customer_requirement: null, machine_discussed: 'JCB 3DX', interest_level: null,
    budget: null, customer_intent: 'buyer', outcome: 'inquiry', next_action: null,
  }, q);
  assert.equal(out2.updated, true, 'only null columns filled');
  const upd = issued.find((s) => s.trim().startsWith('UPDATE'));
  assert.ok(upd && upd.includes('machine_discussed') && upd.includes('outcome'), 'fills exactly the null columns');
  assert.ok(!upd.includes('customer_requirement'), 'good data never overwritten');
});

test('buyer and seller fields remain correctly separated', () => {
  const b = B(buyerInput());
  assert.ok(!('asking_price' in b.requirement) || b.requirement.asking_price === undefined, 'no seller price on buyer');
  const s = B(sellerInput());
  assert.ok(!s.key_points.some((k) => /Budget|Timeline/i.test(k)), 'no buyer fields on seller');
  assert.ok(s.key_points.some((k) => /Asking price/i.test(k)), 'seller price shown');
});

test('terminal summary orchestration is fail-closed and scoped', async () => {
  const calls = [];
  const q = async (sql) => {
    calls.push(sql);
    return null;
  };
  const badOrg = await vaaniSales.summarizeTerminalCall({ callId: 1, status: 'completed', orgId: null }, q);
  assert.equal(badOrg.stored, false);
  const badCall = await vaaniSales.summarizeTerminalCall({ callId: 0, status: 'completed', orgId: 2 }, q);
  assert.equal(badCall.stored, false);
  const badStatus = await vaaniSales.summarizeTerminalCall({ callId: 1, status: 'connecting', orgId: 2 }, q);
  assert.equal(badStatus.stored, false, 'non-terminal never summarizes');
});
