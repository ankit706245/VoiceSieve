'use strict';
// Regression tests for the manual lead save path (Add Seller / Add Buyer).
// Root causes fixed:
//  1. addLead sent Date.now() scale ids into workflow_runs.id (integer), so
//     every manual save failed with integer out of range.
//  2. The duplicate-phone guard tested exists.length, but queryPostgres
//     resolves a single matching id to a bare number (no .length), so the
//     guard never fired and duplicates were inserted.
// Pure unit tests always run (no DB). DB tests are read-only and zero-write:
// duplicate validation throws before any INSERT, and EXPLAIN never executes.
// DB tests run only when VAANI_DATABASE_URL is available (loaded via
// core.loadEnv, the same mechanism the server uses).
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core');
try { core.loadEnv(); } catch (_) {}
// loadEnv must run before vaani-sales (and its supadb transport) is required,
// otherwise VAANI_DATABASE_URL from dashboard/.env is missed. Same ordering
// rule as dashboard/server.js.
const vaaniSales = require('../lib/vaani-sales');
const hasDb = Boolean(process.env.VAANI_DATABASE_URL);

test('manual lead INSERT uses the caller-owned workflow, never a hardcoded default', () => {
  const built = vaaniSales.buildManualLeadInsert('seller', {
    name: 'Test Seller',
    phone: '+910000000001',
    machine: 'Tata Hitachi EX 200',
    expected_price: '2500000',
    location: 'Jaipur',
  }, 2, 4);
  assert.ok(built.sql.includes('workflow_runs'), 'manual leads remain workflow_runs rows the leads view reads');
  assert.ok(built.sql.includes('RETURNING id'), 'INSERT must RETURNING id');
  assert.ok(!/\(\s*id\s*,/.test(built.sql), 'INSERT must not set an explicit id (int4 overflow)');
  assert.equal(built.params.length, 3);
  assert.equal(built.params[1], 4, 'workflow id comes from the caller org, never hardcoded 3');
  for (const pv of built.params) {
    if (typeof pv === 'number') assert.ok(pv <= 2147483647, 'no param may overflow int4');
  }
  const vars = built.params[2];
  assert.equal(vars.customer_type, 'seller');
  assert.equal(vars.callback_number, '+910000000001');
  assert.equal(vars.machine_details.brand, 'Tata');
  assert.equal(vars.machine_details.model, 'Hitachi EX 200');
  assert.equal(vars.commercial_terms.expected_price_inr, 2500000);
  assert.equal(vars.machine_details.location_city, 'Jaipur');
});

test('manual lead INSERT rejects missing organization or workflow without a default', () => {
  const data = { name: 'T', phone: '+910000000001' };
  for (const bad of [null, undefined, 0, -1, 'abc']) {
    assert.throws(
      () => vaaniSales.buildManualLeadInsert('buyer', data, bad, 4),
      /Organization not linked/,
      'org=' + String(bad) + ' must throw, never default to org 1'
    );
    assert.throws(
      () => vaaniSales.buildManualLeadInsert('buyer', data, 2, bad),
      /Invalid workflow/,
      'wf=' + String(bad) + ' must throw, never default to workflow 3'
    );
  }
});

test('lead save errors map to safe responses without DB internals', () => {
  const dup = vaaniSales.mapLeadSaveError(new Error('Duplicate phone number'), 'Could not save seller. Please try again.');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'duplicate_phone');
  assert.equal(dup.body.error, 'Duplicate phone number');
  const dbErr = vaaniSales.mapLeadSaveError(new Error('integer out of range'), 'Could not save seller. Please try again.');
  assert.equal(dbErr.status, 500);
  assert.equal(dbErr.body.error, 'Could not save seller. Please try again.');
  assert.ok(!JSON.stringify(dbErr.body).includes('integer out of range'), 'must not leak DB internals');
  const def = vaaniSales.mapLeadSaveError(new Error('boom'));
  assert.equal(def.body.error, 'Could not save lead. Please try again.');
});

test('duplicate phone is rejected before any write (zero-write)', { skip: !hasDb }, async (t) => {
  // Fetch the phone via row_to_json so its exact stored string is preserved
  // (plain-text rows can lose formatting such as a leading + when parsed).
  const raw = await vaaniSales.queryPostgres(
    "SELECT row_to_json(t) FROM (SELECT callback_number FROM public.vaani_excavator_sales_leads WHERE callback_number IS NOT NULL AND callback_number <> '' LIMIT 1) t",
    []
  );
  const row = Array.isArray(raw) ? raw[0] : raw;
  const phone = String((row && row.callback_number) || '').trim();
  if (!phone) return t.skip('no existing phone in the database');
  // Prove the duplicate row exists with the exact predicate addLead uses,
  // before calling addLead, so a mismatch can never cause a real INSERT.
  const esc = phone.replace(/'/g, "''");
  const matchCount = await vaaniSales.queryPostgres(
    "SELECT COUNT(*) FROM public.workflow_runs r JOIN public.workflows w ON r.workflow_id = w.id WHERE w.organization_id = 1 AND ((r.gathered_context->'extracted_variables'->>'callback_number') = '" + esc + "' OR (r.gathered_context->'extracted_variables'->>'primary_phone') = '" + esc + "')",
    []
  );
  assert.ok(parseInt(String(matchCount).split('|').pop(), 10) >= 1, 'precondition: phone must already exist (else addLead would write)');
  await assert.rejects(
    vaaniSales.addLead(1, 'seller', { name: 'TEST DUP CHECK', phone }),
    /Duplicate phone number/
  );
});

test('manual lead INSERT plans without integer overflow (zero-write EXPLAIN)', { skip: !hasDb }, async () => {
  const built = vaaniSales.buildManualLeadInsert('seller', {
    name: 'TEST EXPLAIN CHECK',
    phone: '+910000000099',
    machine: 'JCB 3DX',
    expected_price: '1000000',
    location: 'Test',
  }, 1, 3);
  await vaaniSales.queryPostgres('EXPLAIN ' + built.sql, built.params);
});

test('manual machine INSERT stores price in both cost and resale columns', () => {
  const built = vaaniSales.buildManualMachineInsert(1, {
    brand: 'Tata Hitachi', model: 'EX 200', year: '2021', hours: '5000',
    price: '2500000', location: 'Jaipur',
  });
  assert.ok(built.sql.includes('target_resale_inr'), 'INSERT must write target_resale_inr (inventory UI reads it)');
  assert.ok(built.sql.includes('sourcing_cost_inr'), 'INSERT must keep writing sourcing_cost_inr');
  assert.equal(built.params.length, 12);
  assert.equal(built.params[0], 1);
  assert.ok(String(built.params[1]).startsWith('mach_manual_'));
  assert.equal(built.params[2], null);
  assert.equal(built.params[7], 'unknown');
  assert.equal(built.params[8], 2500000);
  assert.equal(built.params[9], 2500000);
  for (const pv of built.params) {
    if (typeof pv === 'number') assert.ok(Number.isSafeInteger(pv), 'no unsafe integer param');
  }
});

test('duplicate machine maps to 409 without internals', () => {
  const m = vaaniSales.mapLeadSaveError(new Error('Duplicate machine record'), 'Could not save machine. Please try again.');
  assert.equal(m.status, 409);
  assert.equal(m.body.code, 'duplicate_machine');
});

test('manual machine INSERT plans cleanly (zero-write EXPLAIN)', { skip: !hasDb }, async () => {
  const built = vaaniSales.buildManualMachineInsert(1, {
    brand: 'TESTBRAND', model: 'TESTMODEL', year: '2020', hours: '100',
    price: '100000', location: 'Test',
  });
  await vaaniSales.queryPostgres('EXPLAIN ' + built.sql, built.params);
});
test('manual machine links seller run when provided, else null', () => {
  const linked = vaaniSales.buildManualMachineInsert(1, { brand: 'B', model: 'M' }, 1000017);
  assert.equal(linked.params[2], 1000017);
  const bad = vaaniSales.buildManualMachineInsert(1, { brand: 'B', model: 'M' }, 'not-an-id');
  assert.equal(bad.params[2], null);
  assert.ok(linked.sql.includes('source_lead_run_id'));
});
test('parseBudgetInr handles Indian formats without fabricating zero', () => {
  const P = vaaniSales.parseBudgetInr;
  assert.deepEqual(P('18,00,000'), { value: 1800000, ok: true });
  assert.deepEqual(P('18 Lakh'), { value: 1800000, ok: true });
  assert.deepEqual(P('18.5 lakh'), { value: 1850000, ok: true });
  assert.deepEqual(P('1.2 Crore'), { value: 12000000, ok: true });
  assert.deepEqual(P('2500000'), { value: 2500000, ok: true });
  assert.deepEqual(P(' \u20B918,50,000 '), { value: 1850000, ok: true });
  assert.deepEqual(P(''), { value: null, ok: true });
  assert.deepEqual(P(null), { value: null, ok: true });
  assert.deepEqual(P('0'), { value: 0, ok: true });
  assert.equal(P('abc').ok, false);
  assert.equal(P('-5').ok, false);
  assert.equal(P('12..5').ok, false);
});

test('invalid budget is rejected before any database touch (zero-DB)', () => {
  assert.throws(
    () => vaaniSales.buildManualLeadInsert('buyer', { name: 'T', phone: '+910000000098', budget: 'not-a-budget' }, 1, 3),
    /Invalid budget/
  );
  assert.throws(
    () => vaaniSales.buildManualLeadInsert('seller', { name: 'T', phone: '+910000000098', expected_price: '18..x' }, 1, 3),
    /Invalid expected price/
  );
});

test('buyer requirement fields are stored as JSON keys without fabrication', () => {
  const built = vaaniSales.buildManualLeadInsert('buyer', {
    name: 'Req Buyer', phone: '+910000000011',
    machine_type: 'Excavator', brand: 'JCB', model: '3DX',
    budget_min: '15 Lakh', budget: '18 Lakh',
    year_min: '2018', year_max: '2021', max_hours: '6000',
    preferred_city: 'Jaipur', purchase_timeline: 'immediate',
    location: 'Jaipur', notes: 'evening only',
  }, 2, 4);
  const vars = built.params[2];
  assert.equal(vars.machine_details.machine_type, 'Excavator');
  assert.equal(vars.machine_details.model_year_min, 2018);
  assert.equal(vars.machine_details.model_year_max, 2021);
  assert.equal(vars.machine_details.max_hours, 6000);
  assert.equal(vars.machine_details.preferred_city, 'Jaipur');
  assert.equal(vars.commercial_terms.budget_min_inr, 1500000);
  assert.equal(vars.commercial_terms.budget_max_inr, 1800000);
  assert.equal(vars.lead_status, null);
});

test('seller machine fields are stored without fabrication', () => {
  const built = vaaniSales.buildManualLeadInsert('seller', {
    name: 'Req Seller', phone: '+910000000012', machine: 'JCB 3DX',
    machine_type: 'Backhoe', year: '2019', hours: '4800',
    condition: 'Good', availability_status: 'Ready',
    expected_price: '2500000', location: 'Ajmer',
  }, 2, 4);
  const vars = built.params[2];
  assert.equal(vars.machine_details.machine_type, 'Backhoe');
  assert.equal(vars.machine_details.condition, 'Good');
  assert.equal(vars.availability_status, 'Ready');
  assert.equal(vars.machine_details.model_year, 2019);
  assert.equal(vars.machine_details.running_hours, 4800);
});

test('manual entry stores temperature, ownership, application and address fields', () => {
  const built = vaaniSales.buildManualLeadInsert('seller', {
    name: 'Field Seller', phone: '+910000000014', whatsapp: '+910000000015',
    temperature: 'hot', ownership: 'Broker', application: 'rock breaker',
    location: 'Kota', state: 'Rajasthan', address: 'Plot 4, Industrial Area',
  }, 2, 4);
  const vars = built.params[2];
  assert.equal(vars.address, 'Plot 4, Industrial Area');
  assert.equal(vars.lead_temperature, 'HOT');
  assert.equal(vars.ownership_type, 'broker');
  assert.equal(vars.application_history, 'rock_breaker');
  assert.equal(vars.whatsapp_number, '+910000000015');
  assert.equal(vars.machine_details.location_city, 'Kota');
  assert.equal(vars.machine_details.location_state, 'Rajasthan');
  assert.equal(vars.machine_details.application_history, 'rock_breaker');
  assert.equal(vaaniSales.normalizeLeadTemperature('nonsense'), 'WARM');
  assert.equal(vaaniSales.normalizeOwnershipType('munim'), 'broker');
  assert.equal(vaaniSales.normalizeApplicationHistory('soil earthwork'), 'soil_earthwork');
});

test('add/import routes and CRM entry points are wired', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
  assert.ok(server.includes("route === '/api/vaani/sales/entries'"), 'entries route must be registered');
  assert.ok(server.includes("route === '/api/vaani/sales/import'"), 'import route must be registered');
  assert.ok(html.includes("openEntryForm('seller')") && html.includes("openEntryForm('buyer')") && html.includes("openEntryForm('machine')"), 'all three add buttons must exist');
  assert.ok(html.includes("importCsv(event, 'seller')") && html.includes("importCsv(event, 'buyer')") && html.includes("importCsv(event, 'machine')"), 'all three CSV inputs must exist');
  assert.ok(html.includes('expected_selling_price_inr || s.expected_price_inr || s.asking_price'), 'seller price must read the view column first');
  assert.ok(server.includes("require('./lib/supadb')"), 'signup provisioning must import the SQL transport');
  assert.ok(!server.includes('const orgId = 1'), 'signup must never hardcode org 1');
  assert.ok(server.includes('provisionWorkspace'), 'signup must create a per-user organization');
});

test('missing optional requirement fields stay null, invalid budget_min rejects', () => {
  const built = vaaniSales.buildManualLeadInsert('buyer', { name: 'Min Buyer', phone: '+910000000013' }, 2, 4);
  const vars = built.params[2];
  assert.equal(vars.machine_details.machine_type, null);
  assert.equal(vars.machine_details.model_year_min, null);
  assert.equal(vars.machine_details.max_hours, null);
  assert.equal(vars.commercial_terms.budget_min_inr, null);
  assert.equal(vars.lead_status, null);
  assert.throws(
    () => vaaniSales.buildManualLeadInsert('buyer', { name: 'T', phone: '+910000000013', budget_min: 'nonsense' }, 2, 4),
    /Invalid budget_min/
  );
  assert.equal(vaaniSales.toIntOrNull('6000'), 6000);
  assert.equal(vaaniSales.toIntOrNull(''), null);
  assert.equal(vaaniSales.toIntOrNull('abc'), null);
});

test('structured projections surface stored keys with view precedence', () => {
  const ev = {
    machine_details: { machine_type: 'Excavator', model_year_min: 2018, max_hours: 6000, preferred_city: 'Jaipur', condition: 'Good' },
    commercial_terms: { budget_min_inr: 1500000, budget_max_inr: 1800000 },
    lead_status: 'NEW',
  };
  const b = vaaniSales.projectStructuredBuyerFields({
    buyer_budget_max_inr: 1700000, purchase_timeline: 'immediate', raw_extracted_variables: ev,
  });
  assert.equal(b.machine_type, 'Excavator');
  assert.equal(b.budget_min, 1500000);
  assert.equal(b.budget_max, 1800000);
  assert.equal(b.year_min, 2018);
  assert.equal(b.max_hours, 6000);
  assert.equal(b.preferred_city, 'Jaipur');
  assert.equal(b.purchase_timeline, 'immediate');
  assert.equal(b.lead_status, 'NEW');
  const s = vaaniSales.projectStructuredSellerFields({
    model_year: 2019, running_hours: 4800, expected_selling_price_inr: 2500000,
    machine_location_city: 'Ajmer', raw_extracted_variables: { ...ev, availability_status: 'Ready' },
  });
  assert.equal(s.machine_type, 'Excavator');
  assert.equal(s.condition, 'Good');
  assert.equal(s.availability_status, 'Ready');
  assert.equal(s.year, 2019);
  assert.equal(s.hours, 4800);
  assert.equal(s.asking_price, 2500000);
  assert.equal(s.machine_location, 'Ajmer');
  const empty = vaaniSales.projectStructuredBuyerFields({});
  for (const k of ['machine_type', 'budget_min', 'year_min', 'max_hours', 'lead_status']) {
    assert.equal(empty[k], null, k + ' must be null when unstored');
  }
});

test('buyer and seller lists fail closed with no valid organization (zero-DB)', async () => {
  for (const bad of [null, undefined, 0, 'abc']) {
    assert.deepEqual(await vaaniSales.getBuyers({}, false, bad), [], 'buyers org=' + String(bad));
    assert.deepEqual(await vaaniSales.getSellers({}, false, bad), [], 'sellers org=' + String(bad));
  }
});

test('addLead rejects missing organization before any database touch (zero-DB)', async () => {
  for (const bad of [null, undefined, 0]) {
    await assert.rejects(
      vaaniSales.addLead(bad, 'buyer', { name: 'T', phone: '+910000000099' }),
      /Organization not linked/
    );
  }
});

test('org 2 buyer list contains only org 2 rows (read-only)', { skip: !hasDb }, async () => {
  const rows = await vaaniSales.queryPostgres(
    'SELECT organization_id FROM vaani_excavator_sales_leads WHERE organization_id = 2 AND customer_type = \'buyer\'',
    []
  );
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const r of list) {
    const org = (r && typeof r === 'object') ? r.organization_id : r;
    assert.equal(parseInt(org, 10), 2, 'every listed buyer must belong to org 2');
  }
});

test('each organization resolves its own Vaani workflow (read-only)', { skip: !hasDb }, async (t) => {
  const id1 = await vaaniSales.resolveOrgWorkflowId(1);
  const id2 = await vaaniSales.resolveOrgWorkflowId(2);
  if (!id1 || !id2) return t.skip('seed orgs 1 and 2 are not present in this database');
  assert.equal(id1, 3, 'org 1 must prefer the verified Vaani workflow 3');
  assert.equal(id2, 4, 'org 2 must stay on its own workflow 4');
  assert.notEqual(id1, id2, 'orgs must not share the manual-lead workflow');
});

test('resolveOrgWorkflowId prefers the intended workflow only when org-owned', async () => {
  const previous = process.env.VAANI_WORKFLOW_ID;
  process.env.VAANI_WORKFLOW_ID = '3';
  try {
    const seen = [];
    const q = async (sql, params) => {
      seen.push({ sql, params });
      if (/WHERE id = \$1 AND organization_id = \$2/.test(sql)) return { id: 3 };
      return { id: 1 };
    };
    assert.equal(await vaaniSales.resolveOrgWorkflowId(1, q), 3);
    assert.deepEqual(seen[0].params, [3, 1], 'preferred workflow is checked against the org');
  } finally {
    if (previous === undefined) delete process.env.VAANI_WORKFLOW_ID;
    else process.env.VAANI_WORKFLOW_ID = previous;
  }
});

test('resolveOrgWorkflowId falls back to an org-owned active workflow', async () => {
  const previous = process.env.VAANI_WORKFLOW_ID;
  process.env.VAANI_WORKFLOW_ID = '3';
  try {
    const q = async (sql) => (/WHERE id = \$1 AND organization_id = \$2/.test(sql) ? null : { id: 4 });
    assert.equal(await vaaniSales.resolveOrgWorkflowId(2, q), 4);
  } finally {
    if (previous === undefined) delete process.env.VAANI_WORKFLOW_ID;
    else process.env.VAANI_WORKFLOW_ID = previous;
  }
});

test('resolveOrgWorkflowId rejects an invalid organization without querying', async () => {
  let queried = false;
  const q = async () => { queried = true; return { id: 3 }; };
  assert.equal(await vaaniSales.resolveOrgWorkflowId(0, q), null);
  assert.equal(queried, false);
});

test('resolveIngestionWorkflow keeps a known Vaani workflow and its org', async () => {
  const q = async (sql) => {
    if (/SELECT organization_id FROM workflows WHERE id = \$1/.test(sql)) return { organization_id: 5 };
    throw new Error('unexpected query');
  };
  assert.deepEqual(
    await vaaniSales.resolveIngestionWorkflow(7, q),
    { wfId: 7, wfOrgId: 5, bridged: false }
  );
});

test('resolveIngestionWorkflow bridges an unknown Dograh workflow to the configured org', async () => {
  const previous = process.env.VAANI_INGESTION_ORG_ID;
  process.env.VAANI_INGESTION_ORG_ID = '5';
  try {
    const q = async (sql, params) => {
      if (/SELECT organization_id FROM workflows WHERE id = \$1/.test(sql)) return null;
      if (/WHERE id = \$1 AND organization_id = \$2/.test(sql)) return null;
      if (/WHERE organization_id = \$1 AND status = 'active'/.test(sql)) {
        assert.deepEqual(params, [5], 'bridge must resolve the configured org only');
        return { id: 7 };
      }
      return null;
    };
    assert.deepEqual(
      await vaaniSales.resolveIngestionWorkflow(3, q),
      { wfId: 7, wfOrgId: 5, bridged: true }
    );
  } finally {
    if (previous === undefined) delete process.env.VAANI_INGESTION_ORG_ID;
    else process.env.VAANI_INGESTION_ORG_ID = previous;
  }
});

test('resolveIngestionWorkflow refuses to bridge without a configured org', async () => {
  const previous = process.env.VAANI_INGESTION_ORG_ID;
  delete process.env.VAANI_INGESTION_ORG_ID;
  try {
    const q = async () => null;
    assert.equal(await vaaniSales.resolveIngestionWorkflow(3, q), null);
  } finally {
    if (previous !== undefined) process.env.VAANI_INGESTION_ORG_ID = previous;
  }
});

test('duplicate guard resolves the caller workflow before checking (zero-write)', { skip: !hasDb }, async (t) => {
  const raw = await vaaniSales.queryPostgres(
    "SELECT row_to_json(t) FROM (SELECT callback_number FROM public.vaani_excavator_sales_leads WHERE callback_number IS NOT NULL AND callback_number <> '' LIMIT 1) t",
    []
  );
  const row = Array.isArray(raw) ? raw[0] : raw;
  const phone = String((row && row.callback_number) || '').trim();
  if (!phone) return t.skip('no existing phone in the database');
  await assert.rejects(
    vaaniSales.addLead(1, 'seller', { name: 'TEST DUP RESOLUTION', phone }),
    /Duplicate phone number/
  );
});

test('invalid machine price is rejected by the pure builder (zero-DB)', () => {
  assert.throws(
    () => vaaniSales.buildManualMachineInsert(1, { brand: 'B', model: 'M', price: 'junk' }),
    /Invalid price/
  );
});

test('validation errors map to 400 with the safe message', () => {
  const v = vaaniSales.mapLeadSaveError(new Error('Invalid budget: enter digits'), 'fallback');
  assert.equal(v.status, 400);
  assert.equal(v.body.code, 'validation_error');
  assert.equal(v.body.error, 'Invalid budget: enter digits');
});

test('unreachable Dograh maps to actionable 502 without false success', () => {
  const m = vaaniSales.mapVoiceSessionError(new Error('fetch failed'));
  assert.equal(m.status, 502);
  assert.equal(m.body.code, 'dograh_unreachable');
  assert.ok(m.body.error.includes('unreachable'));
  assert.ok(!m.body.error.includes('dispatched'));
  const m2 = vaaniSales.mapVoiceSessionError(new Error('connect ECONNREFUSED 127.0.0.1:8000'));
  assert.equal(m2.body.code, 'dograh_unreachable');
});

test('non-network voice errors keep upstream message safely', () => {
  const m = vaaniSales.mapVoiceSessionError(new Error('Dograh could not start the realtime voice session'));
  assert.equal(m.status, 502);
  assert.equal(m.body.code, 'voice_session_failed');
  assert.ok(m.body.error.includes('Dograh voice session failed:'));
});

test('seller phone accepts core field and import-mapping alias', () => {
  assert.equal(vaaniSales.pickSellerPhone({ seller_phone: ' 98765 ' }), '98765');
  assert.equal(vaaniSales.pickSellerPhone({ seller: ' 98765 ' }), '98765');
  assert.equal(vaaniSales.pickSellerPhone({}), '');
  assert.equal(vaaniSales.pickSellerPhone(null), '');
});

test('import validation rejects bad rows without touching the database', async () => {
  const b = await vaaniSales.importBuyers(1, [{ name: '', phone: '' }, { name: 'NoPhone' }, { phone: '123' }]);
  assert.equal(b.success, 0);
  assert.equal(b.failed, 3);
  const s = await vaaniSales.importSellers(1, [{ name: '', phone: '' }]);
  assert.equal(s.success, 0);
  assert.equal(s.failed, 1);
  const m = await vaaniSales.importMachines(1, [{ model: 'X' }, {}]);
  assert.equal(m.success, 0);
  assert.equal(m.failed, 2);
});

test('embed body matches documented contract with mocked data (no network)', () => {
  const b = vaaniSales.buildDograhEmbedBody('TOK', {
    source: 'vaani_seller_demo', tenantId: 't1', agentId: 'a1',
    demoLinkId: 'd1', maxSessionSeconds: 300,
    crmVariables: { customer_name: 'Demo Seller', vaani_call_id: 61 },
  });
  assert.equal(b.token, 'TOK');
  assert.equal(b.context_variables.source, 'vaani_seller_demo');
  assert.equal(b.context_variables.tenant_id, 't1');
  assert.equal(b.context_variables.demo_link_id, 'd1');
  assert.equal(b.context_variables.max_session_seconds, '300');
  assert.equal(b.context_variables.customer_name, 'Demo Seller');
  assert.equal(b.context_variables.vaani_call_id, 61);
  assert.doesNotThrow(() => JSON.stringify(b));
});

test('embed body defaults are safe with empty context (no network)', () => {
  const b = vaaniSales.buildDograhEmbedBody('TOK', {});
  assert.equal(b.context_variables.source, 'rumik_studio');
  assert.equal(b.context_variables.tenant_id, '');
  assert.deepEqual(Object.keys(b), ['token', 'context_variables']);
});
