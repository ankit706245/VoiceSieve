'use strict';
// Buyers GET tests for the consolidated sales handler. The handler source is
// eval'd with injected stubs, so no server boot, network, or database is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadHandler(core, vaaniSales) {
  const resolveSrc = serverSrc.match(/function resolveOrganizationId\(ctx\) \{[\s\S]*?\n\}/);
  const handlerSrc = serverSrc.match(/async function apiVaaniSalesGet\(req, res, ctx\) \{[\s\S]*?\n\}/);
  assert.ok(resolveSrc, 'organization resolver found in server.js');
  assert.ok(handlerSrc, 'sales GET handler found in server.js');
  return new Function('core', 'vaaniSales', resolveSrc[0] + '\n' + handlerSrc[0] + '\nreturn apiVaaniSalesGet;')(core, vaaniSales);
}

function mockCtx(org) {
  return { user: { id: 'u-1' }, organization_id: org, role: 'member' };
}
function mockReq(url) {
  return { url, method: 'GET', headers: { host: 'localhost' } };
}
function mockRes() {
  return { status: null, body: null };
}
function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}

test('response shape passes through identical to vaaniSales.getBuyers', async () => {
  const rows = [{ lead_id: 1 }, { lead_id: 2 }];
  const fn = loadHandler(stubCore(), { getBuyers: async () => rows });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { total: 2, buyers: rows });
});

test('org comes from context and hostile params cannot change scope', async () => {
  let seenArgs = null;
  const fn = loadHandler(stubCore(), {
    getBuyers: async (filters, isDemo, orgId) => { seenArgs = [filters, isDemo, orgId]; return []; },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers?organization_id=1&organizationId=1&tenant_id=t_1&tenantId=t_1'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.equal(seenArgs[1], false);
  assert.equal(seenArgs[2], 2);
  for (const key of ['organization_id', 'organizationId', 'tenant_id', 'tenantId']) {
    assert.ok(!(key in seenArgs[0]), key + ' stripped from filters');
  }
});

test('search and filter parameters flow through untouched', async () => {
  let seenArgs = null;
  const fn = loadHandler(stubCore(), {
    getBuyers: async (filters, isDemo, orgId) => { seenArgs = [filters, isDemo, orgId]; return []; },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers?q=JCB&limit=25'), res, mockCtx(2));
  assert.equal(res.status, 200);
  assert.equal(seenArgs[0].q, 'JCB');
  assert.equal(seenArgs[0].limit, '25');
  assert.equal(seenArgs[2], 2);
});

test('unmapped context fails closed with 403 and never queries data', async () => {
  let called = false;
  const fn = loadHandler(stubCore(), {
    getBuyers: async () => { called = true; throw new Error('must not be called'); },
  });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(null));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'forbidden');
  assert.equal(called, false);
});

test('sales routes are auth gated and the browser cannot choose the org', () => {
  assert.ok(serverSrc.includes("if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);"),
    'sales GET route is auth gated');
  assert.ok(serverSrc.includes("if (route === '/api/vaani/sales/entries') return core.requireAuth(req, res, apiVaaniCreateEntry, body);"),
    'buyer/seller/machine POST route is auth gated');
  assert.ok(!serverSrc.includes('apiVaaniSalesBuyersBraivex'), 'no legacy buyer-only handler remains');
  assert.ok(!serverSrc.includes('req.query.organization'), 'organization never comes from the query string');
});

test('dashboard authenticates with the HttpOnly cookie, not web storage or the URL', () => {
  const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
  assert.ok(!dashSrc.includes('sessionStorage') && !dashSrc.includes('localStorage'), 'no token in web storage');
  assert.ok(!dashSrc.includes('access_token='), 'no token in the URL');
  assert.ok(dashSrc.includes("credentials: 'same-origin'"), 'cookie is sent with API calls');
});

test('buyer rows expose caller_name/callback_number and budget fallback fields', async () => {
  // Simulates the DB view row shape AFTER projectStructuredBuyerFields projection
  const projectedRow = {
    run_id: 1001,
    lead_id: 1001,
    created_at: new Date().toISOString(),
    caller_name: 'Test Buyer',
    callback_number: '919876543210',
    whatsapp_number: '',
    machine_brand: 'CAT',
    machine_model: '320D',
    required_tonnage_class: '20_ton_class',
    buyer_budget_max_inr: null,          // intentionally null (CSV import had price only)
    expected_price_inr: 2300000,        // from CSV 'price' column
    price_raw: '23 Lakh',
    purchase_timeline: 'immediate_under_7d',
    machine_location_city: 'Jaipur',
    machine_location_state: 'Rajasthan',
    yard_visit_agreed: true,
    yard_visit_schedule: null,
    lead_temperature: 'HOT',
    qualification_state: 'QUALIFIED',
    conversation_outcome: 'lead_qualified',
    next_action: 'Share yard inventory',
    follow_up_required: false,
    follow_up_datetime: null,
    call_notes: '',
    dnc_requested: false,
    application_history: 'soil_earthwork',  // projected from raw_extracted_variables
    raw_extracted_variables: JSON.stringify({
      machine_details: { application_history: 'soil_earthwork' }
    })
  };
  const fn = loadHandler(stubCore(), { getBuyers: async () => [projectedRow] });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/buyers'), res, mockCtx(2));
  assert.equal(res.status, 200);
  const buyer = res.body.buyers[0];
  // Frontend reads these exact names
  assert.equal(buyer.caller_name, 'Test Buyer');
  assert.equal(buyer.callback_number, '919876543210');
  // Budget fallback: expected_price_inr should be present when budget is null
  assert.equal(buyer.expected_price_inr, 2300000);
  assert.equal(buyer.price_raw, '23 Lakh');
  // Application history from extracted variables (projected)
  assert.equal(buyer.application_history, 'soil_earthwork');
  // Location fields
  assert.equal(buyer.machine_location_city, 'Jaipur');
  assert.equal(buyer.machine_location_state, 'Rajasthan');
  assert.equal(buyer.yard_visit_agreed, true);
});

test('seller rows expose caller_name/callback_number/model_year/running_hours and rock_breaker label', async () => {
  const rawRow = {
    run_id: 2001,
    lead_id: 2001,
    created_at: new Date().toISOString(),
    caller_name: 'Test Seller',
    callback_number: '919876543211',
    whatsapp_number: '',
    ownership_type: 'owner',
    machine_brand: 'JCB',
    machine_model: '3DX',
    model_year: 2022,
    running_hours: 3500,
    application_history: 'rock_breaker',
    machine_location_city: 'Udaipur',
    machine_location_state: 'Rajasthan',
    document_status: 'Verified',
    expected_selling_price_inr: 1800000,
    price_raw: null,
    photos_agreed: false,
    running_video_agreed: false,
    rc_copy_agreed: false,
    lead_temperature: 'WARM',
    qualification_state: 'IN_PROGRESS',
    conversation_outcome: 'inquiry',
    next_action: 'WhatsApp summary',
    follow_up_required: false,
    follow_up_datetime: null,
    call_notes: '',
    dnc_requested: false,
    raw_extracted_variables: JSON.stringify({})
  };
  const fn = loadHandler(stubCore(), { getSellers: async () => [rawRow] });
  const res = mockRes();
  await fn(mockReq('/api/vaani/sales/sellers'), res, mockCtx(2));
  assert.equal(res.status, 200);
  const seller = res.body.sellers[0];
  assert.equal(seller.caller_name, 'Test Seller');
  assert.equal(seller.callback_number, '919876543211');
  assert.equal(seller.model_year, 2022);
  assert.equal(seller.running_hours, 3500);
  assert.equal(seller.application_history, 'rock_breaker');
  assert.equal(seller.machine_location_city, 'Udaipur');
  assert.equal(seller.machine_location_state, 'Rajasthan');
});
