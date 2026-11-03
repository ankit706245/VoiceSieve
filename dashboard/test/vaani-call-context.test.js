'use strict';
// Call-origin context tests. Loads the actual apiVaaniOutboundBuyer/Seller
// handlers from server.js source (never boots the server) with stubbed DB
// and Dograh mint, then asserts the Dograh-bound context carries an explicit
// pre-classified buyer/purchase or seller/supply origin. No network, no
// database, no secrets, no calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadBound(name, core, vaaniSales, mintDograhVoiceSession, resolveOrganizationId, primaryOrganizationId) {
  const re = new RegExp('async function ' + name + '\\(req, res, ctx\\) \\{[\\s\\S]*?\\n\\}');
  const m = serverSrc.match(re);
  assert.ok(m, name + ' found in server.js');
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}

function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}
function resolveOrg(ctx) {
  if (!ctx || !ctx.tenant) return null;
  if (ctx.tenant.organization_id === undefined || ctx.tenant.organization_id === null) return null;
  const n = parseInt(ctx.tenant.organization_id, 10);
  return isNaN(n) ? null : n;
}
function dbStub() {
  return {
    resolveOrgWorkflowId: async () => 3,
    queryPostgres: async (sql) => {
      if (/INSERT INTO vaani_customers/.test(sql)) return { id: 9001 };
      if (/INSERT INTO vaani_calls/.test(sql)) return { id: 9002 };
      return {};
    },
  };
}
function buyerCtx() {
  return {
    user: { id: 'u-1', email: 'user@example.invalid' },
    tenant: { id: 't_1', organization_id: 1 },
    body: { name: 'Asha Singh', phone: '919999900001', machine_requirement: 'excavator', brand: 'JCB', model: '3DX', budget: '18 Lakh', city: 'Jaipur', notes: 'evening', machine_type: 'Excavator', budget_min: '15 Lakh', budget_max: '18 Lakh', year_min: '2018', year_max: '2021', max_hours: '6000', preferred_city: 'Jaipur', purchase_timeline: 'immediate', lead_status: 'NEW' },
  };
}
function sellerCtx() {
  return {
    user: { id: 'u-1', email: 'user@example.invalid' },
    tenant: { id: 't_1', organization_id: 1 },
    body: { name: 'Ravi Kumar', phone: '919999900002', machine_requirement: 'excavator', price: '2500000', city: 'Ajmer', machine_type: 'Excavator', year: '2019', hours: '4800', condition: 'Good', availability_status: 'Ready', asking_price: '2600000', machine_location: 'Ajmer' },
  };
}
async function runCall(name, ctx) {
  let mintArg = null;
  const mint = async (req, context) => { mintArg = context; return { workflowRunId: 'wr-ctx' }; };
  const fn = loadBound(name, stubCore(), dbStub(), mint, resolveOrg, () => 1);
  const res = { status: null, body: null };
  await fn({ url: '/', headers: { host: 'localhost' } }, res, ctx);
  assert.equal(res.status, 200);
  assert.ok(mintArg && mintArg.crmVariables, 'Dograh mint reached with CRM variables');
  return mintArg.crmVariables;
}

test('Call Buyer context contains buyer/purchase origin', async () => {
  const c = await runCall('apiVaaniOutboundBuyer', buyerCtx());
  assert.equal(c.buyer_seller_classification, 'buyer');
  assert.equal(c.call_intent, 'purchase');
  assert.equal(c.call_origin, 'vaani_buyer_crm');
  assert.equal(c.organization_id, 1);
  assert.equal(c.customer_name, 'Asha Singh');
  assert.equal(c.contact_phone, '919999900001');
  assert.equal(c.lead_customer_id, 9001);
  assert.equal(c.city, 'Jaipur');
  assert.equal(c.budget, '18 Lakh');
});

test('new buyer requirement fields reach Dograh context when supplied', async () => {
  const c = await runCall('apiVaaniOutboundBuyer', buyerCtx());
  assert.equal(c.machine_type, 'Excavator');
  assert.equal(c.budget_min, '15 Lakh');
  assert.equal(c.budget_max, '18 Lakh');
  assert.equal(c.year_min, '2018');
  assert.equal(c.year_max, '2021');
  assert.equal(c.max_hours, '6000');
  assert.equal(c.preferred_city, 'Jaipur');
  assert.equal(c.purchase_timeline, 'immediate');
  assert.equal(c.lead_status, 'NEW');
  assert.equal(c.organization_id, 1);
});

test('new seller machine fields reach Dograh context when supplied', async () => {
  const c = await runCall('apiVaaniOutboundSeller', sellerCtx());
  assert.equal(c.machine_type, 'Excavator');
  assert.equal(c.year, '2019');
  assert.equal(c.hours, '4800');
  assert.equal(c.condition, 'Good');
  assert.equal(c.availability_status, 'Ready');
  assert.equal(c.asking_price, '2600000');
  assert.equal(c.machine_location, 'Ajmer');
  assert.equal(c.organization_id, 1);
});

test('Call Seller context contains seller/supply origin', async () => {
  const c = await runCall('apiVaaniOutboundSeller', sellerCtx());
  assert.equal(c.buyer_seller_classification, 'seller');
  assert.equal(c.call_intent, 'sell');
  assert.equal(c.call_origin, 'vaani_seller_crm');
  assert.equal(c.organization_id, 1);
  assert.equal(c.customer_name, 'Ravi Kumar');
  assert.equal(c.contact_phone, '919999900002');
  assert.equal(c.lead_customer_id, 9001);
  assert.equal(c.city, 'Ajmer');
});

test('Buyer greeting frames purchase without a sell-side choice question', async () => {
  const c = await runCall('apiVaaniOutboundBuyer', buyerCtx());
  const g = c.greeting_override;
  assert.ok(g && g.type === 'text' && typeof g.text === 'string' && g.text.length > 0, 'valid greeting_override');
  assert.ok(/purchase/i.test(g.text), 'purchase framed');
  assert.ok(!/sell|bech/i.test(g.text), 'no sell-side choice wording');
  assert.ok(g.text.includes('Asha Singh'), 'verified name used, nothing invented');
});

test('Seller greeting frames supply without a buy-side choice question', async () => {
  const c = await runCall('apiVaaniOutboundSeller', sellerCtx());
  const g = c.greeting_override;
  assert.ok(g && g.type === 'text' && typeof g.text === 'string' && g.text.length > 0, 'valid greeting_override');
  assert.ok(/sell/i.test(g.text), 'supply framed');
  assert.ok(!/purchase|kharid|buy/i.test(g.text), 'no buy-side choice wording');
  assert.ok(g.text.includes('Ravi Kumar'), 'verified name used, nothing invented');
});

test('missing optional CRM fields stay absent, never fabricated', async () => {
  const minimal = {
    user: { id: 'u-1', email: 'user@example.invalid' },
    tenant: { id: 't_1', organization_id: 1 },
    body: { name: 'Minimal Buyer', phone: '919999900003', machine_requirement: 'excavator' },
  };
  const c = await runCall('apiVaaniOutboundBuyer', minimal);
  assert.equal(c.buyer_seller_classification, 'buyer');
  assert.equal(c.call_intent, 'purchase');
  for (const k of ['brand', 'model', 'budget', 'city', 'notes']) {
    assert.ok(!(k in c), k + ' must be absent when not supplied, got ' + JSON.stringify(c[k]));
  }
  assert.ok(!/undefined|null|unknown/i.test(c.greeting_override.text), 'greeting has no placeholder leakage');
});
