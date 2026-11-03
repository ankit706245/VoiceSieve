'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core');
const vaaniSales = require('../lib/vaani-sales');

test('overview KPI calculation and funnel structure', async () => {
  const overview = await vaaniSales.getOverview(true);
  assert.ok(overview, 'Overview should return a valid object');
  assert.equal(overview.is_demo, true);
  assert.ok(typeof overview.total_leads === 'number');
  assert.ok(typeof overview.connected_calls === 'number');
  assert.ok(typeof overview.hot_sellers === 'number');
  assert.ok(typeof overview.hot_buyers === 'number');
  assert.ok(typeof overview.qualified_leads === 'number');
  assert.ok(typeof overview.follow_ups_due === 'number');
  assert.ok(typeof overview.dnc_total === 'number');

  // Verify connected_calls is allowed to exceed total_leads (multiple calls per unique lead)
  assert.ok(overview.connected_calls >= overview.total_leads, 'Connected calls count can naturally exceed total unique leads');

  // Verify funnel stages count unique leads
  assert.ok(Array.isArray(overview.funnel), 'Funnel must be an array');
  const stageNames = overview.funnel.map(f => f.stage);
  assert.ok(stageNames.includes('NEW'));
  assert.ok(stageNames.includes('CONTACTED'));
  assert.ok(stageNames.includes('CONNECTED'));
  assert.ok(stageNames.includes('INTERESTED'));
  assert.ok(stageNames.includes('QUALIFIED'));
  assert.ok(stageNames.includes('PRICE_DISCUSSION'));
  assert.ok(stageNames.includes('FOLLOW_UP'));
  assert.ok(stageNames.includes('CLOSED_WON'));

  // Every funnel stage count must be <= total_leads (proving it counts unique leads, not call attempts)
  overview.funnel.forEach(step => {
    assert.ok(step.count <= overview.total_leads, `Funnel stage ${step.stage} (${step.count}) must not exceed total unique leads (${overview.total_leads})`);
  });
});

test('seller filtering by temperature, role, and brand', async () => {
  const allSellers = await vaaniSales.getSellers({}, true);
  assert.ok(allSellers.length > 0, 'Should load demo sellers');

  // Filter by HOT
  const hotSellers = await vaaniSales.getSellers({ lead_temperature: 'HOT' }, true);
  assert.ok(hotSellers.length > 0);
  assert.ok(hotSellers.every(s => s.lead_temperature === 'HOT'));

  // Filter by Broker
  const brokers = await vaaniSales.getSellers({ caller_role: 'broker' }, true);
  assert.ok(brokers.length > 0);
  assert.ok(brokers.every(s => (s.ownership_type || '').includes('broker') || (s.ownership_type || '').includes('munim')));

  // Filter by Brand
  const tataSellers = await vaaniSales.getSellers({ machine_brand: 'Tata Hitachi' }, true);
  assert.ok(tataSellers.length > 0);
  assert.ok(tataSellers.every(s => s.machine_brand === 'Tata Hitachi'));
});

test('buyer filtering by temperature, tonnage, and timeline', async () => {
  const allBuyers = await vaaniSales.getBuyers({}, true);
  assert.ok(allBuyers.length > 0, 'Should load demo buyers');

  // Filter by HOT
  const hotBuyers = await vaaniSales.getBuyers({ lead_temperature: 'HOT' }, true);
  assert.ok(hotBuyers.length > 0);
  assert.ok(hotBuyers.every(b => b.lead_temperature === 'HOT'));

  // Filter by Tonnage Class
  const ton20Buyers = await vaaniSales.getBuyers({ required_tonnage_class: '20_ton_class' }, true);
  assert.ok(ton20Buyers.length > 0);
  assert.ok(ton20Buyers.every(b => b.required_tonnage_class === '20_ton_class'));

  // Filter by Immediate Timeline
  const urgentBuyers = await vaaniSales.getBuyers({ purchase_timeline: 'immediate_under_7d' }, true);
  assert.ok(urgentBuyers.length > 0);
  assert.ok(urgentBuyers.every(b => b.purchase_timeline === 'immediate_under_7d'));
});

test('machine master and verified stock separation (no phantom inventory)', async () => {
  const machines = await vaaniSales.getMachines(true);
  assert.ok(Array.isArray(machines.machine_master), 'machine_master must be an array');
  assert.ok(Array.isArray(machines.actual_stock), 'actual_stock must be an array');

  // Machine Master contains canonical market taxonomy
  const models = machines.machine_master.map(m => m.canonical_model);
  assert.ok(models.includes('EX 200 LC'));
  assert.ok(models.includes('EX 210 LC / Super'));
  assert.ok(models.includes('JS 205'));
  assert.ok(models.includes('Robex R210-7'));
  assert.ok(models.includes('PC 210-10M0'));

  // Aliases and indicative pricing bands exist
  const ex200 = machines.machine_master.find(m => m.canonical_model === 'EX 200 LC');
  assert.ok(ex200.aliases.includes('Tata 200'));
  assert.ok(ex200.indicative_bands['2023_2024']);

  // Actual stock holds verified units
  assert.ok(machines.actual_stock.length > 0);
  const unit = machines.actual_stock[0];
  assert.ok(unit.machine_id);
  assert.ok(unit.current_location);
  assert.ok(unit.target_resale_inr > 0);
});

test('demand analytics and buyer-to-stock matchmaking with real stock only', async () => {
  const demand = await vaaniSales.getDemand(true);
  assert.ok(demand.top_requested_brands, 'Must have top requested brands');
  assert.ok(demand.top_requested_tonnage, 'Must have top requested tonnage');
  assert.ok(Array.isArray(demand.matches), 'Matches must be an array');

  // Verify that match items only match against real stock records
  demand.matches.forEach(m => {
    assert.ok(m.buyer_name);
    assert.ok(Array.isArray(m.matching_stock));
    if (m.matching_stock.length > 0) {
      m.matching_stock.forEach(unit => {
        assert.ok(unit.target_resale_inr <= (m.budget_max_inr || Infinity), 'Unit price must be within buyer budget');
      });
    }
  });
});

test('follow-up categorization and status mutation', async () => {
  const followups = await vaaniSales.getFollowUps(true);
  assert.ok(Array.isArray(followups.overdue));
  assert.ok(Array.isArray(followups.due_today));
  assert.ok(Array.isArray(followups.upcoming));

  // Test mutation
  const testId = 'fup_01';
  const updated = await vaaniSales.updateFollowUpStatus(testId, 'completed');
  assert.equal(updated.success, true);
  assert.equal(updated.status, 'completed');

  // Verify status is reflected in categorization
  const followupsAfter = await vaaniSales.getFollowUps(true);
  const found = [...followupsAfter.overdue, ...followupsAfter.due_today, ...followupsAfter.upcoming].find(f => f.id === testId);
  if (found) {
    assert.equal(found.status, 'completed');
  }
});

test('call records and call detail retrieval', async () => {
  const calls = await vaaniSales.getCalls(true);
  assert.ok(Array.isArray(calls));
  assert.ok(calls.length > 0);

  // Detail inspection
  const firstCall = calls[0];
  const detail = await vaaniSales.getCallDetail(firstCall.run_id, true);
  assert.ok(detail, 'Call detail should exist');
  assert.equal(detail.run_id, firstCall.run_id);
  assert.ok(Array.isArray(detail.transcript));
});

test('DNC isolation and suppression enforcement', async () => {
  const dncList = await vaaniSales.getDncRegistry(true);
  assert.ok(Array.isArray(dncList));
  assert.ok(dncList.length > 0);

  const dncPhone = dncList[0].phone_number;
  assert.ok(dncPhone);

  // Verify DNC is flagged as non-callable
  const sellers = await vaaniSales.getSellers({}, true);
  const sellerDnc = sellers.find(s => s.primary_phone === dncPhone);
  if (sellerDnc) {
    assert.equal(sellerDnc.dnc_requested, true);
    assert.equal(sellerDnc.lead_temperature, 'COLD');
  }
});

test('global search across customers, machine model, and location', async () => {
  // Search by brand
  const brandSearch = await vaaniSales.searchLeads('Tata', true);
  assert.ok(Array.isArray(brandSearch));
  assert.ok(brandSearch.length > 0);
  assert.ok(brandSearch.some(r => (r.machine || '').includes('Tata')));

  // Search by city
  const citySearch = await vaaniSales.searchLeads('Jaipur', true);
  assert.ok(Array.isArray(citySearch));
  assert.ok(citySearch.length > 0);

  // Empty search handling
  const emptySearch = await vaaniSales.searchLeads('nonexistentxyz123', true);
  assert.ok(Array.isArray(emptySearch));
  assert.equal(emptySearch.length, 0);
});

test('HTTP API endpoints return valid status and schema', async () => {
  const baseUrl = process.env.DASHBOARD_TEST_URL || 'http://localhost:8787';

  // Verify unauthenticated request returns 401
  const unauthRes = await fetch(`${baseUrl}/api/vaani/sales/overview?demo=1`);
  assert.equal(unauthRes.status, 401);

  // Authenticate with valid session token for demo user
  const token = await core.createSession('u_02162b1d2ea3f939', 't_87a6e07e9cd2fe2d');
  const headers = { Cookie: `rxv_sess=${token}` };

  // Overview and Buyers are bearer-only BRAIVEX endpoints. The legacy rxv_sess
  // cookie must be rejected here; the bearer path is covered by
  // test/braivex-require-auth.test.js and test/vaani-overview-braivex.test.js.
  const resOverview = await fetch(`${baseUrl}/api/vaani/sales/overview?demo=1`, { headers });
  assert.equal(resOverview.status, 401);
  const dataOverview = await resOverview.json();
  assert.equal(dataOverview.code, 'bad_token');

  // Sellers
  const resSellers = await fetch(`${baseUrl}/api/vaani/sales/sellers?demo=1`, { headers });
  assert.equal(resSellers.status, 200);
  const dataSellers = await resSellers.json();
  assert.ok(Array.isArray(dataSellers.sellers));

  // Buyers
  const resBuyers = await fetch(`${baseUrl}/api/vaani/sales/buyers?demo=1`, { headers });
  assert.equal(resBuyers.status, 401);
  const dataBuyers = await resBuyers.json();
  assert.equal(dataBuyers.code, 'bad_token');

  // Machines
  const resMachines = await fetch(`${baseUrl}/api/vaani/sales/machines?demo=1`, { headers });
  assert.equal(resMachines.status, 200);
  const dataMachines = await resMachines.json();
  assert.ok(Array.isArray(dataMachines.machine_master));

  // DNC
  const resDnc = await fetch(`${baseUrl}/api/vaani/sales/dnc?demo=1`, { headers });
  assert.equal(resDnc.status, 200);
  const dataDnc = await resDnc.json();
  assert.ok(Array.isArray(dataDnc.dnc_records));

  // Existing receptionist endpoint must remain unbroken
  const resReceptionist = await fetch(`${baseUrl}/api/vaani/leads`, { headers });
  assert.equal(resReceptionist.status, 200);

  // New Phase B Lead 360 endpoints
  const resLead360 = await fetch(`${baseUrl}/api/vaani/sales/leads/demo_lead_s01?demo=1`, { headers });
  assert.equal(resLead360.status, 200);
  const dataLead360 = await resLead360.json();
  assert.equal(dataLead360.lead_id, 'demo_lead_s01');
  assert.equal(dataLead360.customer_name, 'Ramesh Patel');

  const resTimeline = await fetch(`${baseUrl}/api/vaani/sales/leads/demo_lead_s01/timeline?demo=1`, { headers });
  assert.equal(resTimeline.status, 200);
  const dataTimeline = await resTimeline.json();
  assert.ok(Array.isArray(dataTimeline));
  assert.ok(dataTimeline.length > 0);

  const resActivities = await fetch(`${baseUrl}/api/vaani/sales/activities?demo=1`, { headers });
  assert.equal(resActivities.status, 200);
  const dataActivities = await resActivities.json();
  assert.ok(Array.isArray(dataActivities.activities));
});

test('Lead 360 structure for seller: Next Action engine, captured vs missing, 8-point evidence, and journey', async () => {
  const lead = await vaaniSales.getLead360('demo_lead_s01', true);
  assert.ok(lead, 'Lead 360 object must exist');
  assert.equal(lead.lead_id, 'demo_lead_s01');
  assert.equal(lead.customer_name, 'Ramesh Patel');
  assert.equal(lead.customer_type, 'seller');
  assert.equal(lead.lead_temperature, 'HOT');

  // Next Action Engine verification
  assert.ok(lead.current_status, 'Current status must be exposed');
  assert.ok(lead.next_action, 'Next action must be exposed');
  assert.ok(lead.owner, 'Owner must be specified');
  assert.ok(lead.due_display, 'Due date/time must be specified');
  assert.ok(lead.current_status.includes('Waiting for RC/NOC'), 'Current status must reflect pending verification');

  // What Vaani Learned: Captured vs Missing
  assert.ok(lead.extracted_vs_missing, 'Extracted vs Missing object must exist');
  const { captured, missing } = lead.extracted_vs_missing;
  assert.ok(Array.isArray(captured), 'Captured fields must be an array');
  assert.ok(Array.isArray(missing), 'Missing fields must be an array');
  
  const capturedFields = captured.map(c => c.field);
  assert.ok(capturedFields.includes('Brand'));
  assert.ok(capturedFields.includes('Model'));
  assert.ok(capturedFields.includes('Manufacturing Year'));
  assert.ok(capturedFields.includes('Hour Meter Reading (HMR)'));
  assert.ok(capturedFields.includes('Asking Price'));

  // 8-Point Physical Evidence Checklist
  assert.ok(Array.isArray(lead.evidence_checklist), 'Evidence checklist must be an array');
  assert.equal(lead.evidence_checklist.length, 8, 'Must contain standard 8-point evidence items');
  
  const evidenceKeys = lead.evidence_checklist.map(e => e.key);
  assert.ok(evidenceKeys.includes('boom_photo'));
  assert.ok(evidenceKeys.includes('undercarriage_photo'));
  assert.ok(evidenceKeys.includes('cabin_photo'));
  assert.ok(evidenceKeys.includes('counterweight_photo'));
  assert.ok(evidenceKeys.includes('hmr_photo'));
  assert.ok(evidenceKeys.includes('running_video'));
  assert.ok(evidenceKeys.includes('rc_copy'));
  assert.ok(evidenceKeys.includes('finance_noc'));

  // Verify honest labeling in evidence checklist (no fake WhatsApp claims)
  lead.evidence_checklist.forEach(item => {
    assert.ok(item.status in { received: 1, verified: 1, pending: 1, requested: 1 }, `Invalid status ${item.status}`);
    assert.ok(item.note, 'Each evidence item must have an honest operational note');
    assert.ok(!item.note.includes('WhatsApp message confirmed delivered'), 'Must not claim false WhatsApp delivery');
  });

  // Seller Sales Journey Progression
  assert.ok(Array.isArray(lead.journey_progression), 'Journey progression must be an array');
  assert.equal(lead.journey_progression.length, 14, 'Seller journey must have 14 operational stages');
  const stageKeys = lead.journey_progression.map(s => s.key);
  assert.ok(stageKeys.includes('call_initial'));
  assert.ok(stageKeys.includes('machine_details'));
  assert.ok(stageKeys.includes('asking_price'));
  assert.ok(stageKeys.includes('evidence_collection'));
  assert.ok(stageKeys.includes('qualification'));
  assert.ok(stageKeys.includes('buyer_matching'));
  assert.ok(stageKeys.includes('deal_closing'));

  // Verify active stage
  const activeStages = lead.journey_progression.filter(s => s.status === 'active');
  assert.equal(activeStages.length, 1, 'Exactly one stage must be active');
  assert.equal(activeStages[0].key, 'evidence_collection');
});

test('Lead 360 structure for buyer: requirement extraction, buyer journey, and matched options', async () => {
  const buyerLead = await vaaniSales.getLead360('demo_lead_b01', true);
  assert.ok(buyerLead, 'Buyer Lead 360 must exist');
  assert.equal(buyerLead.lead_id, 'demo_lead_b01');
  assert.ok(buyerLead.customer_name.includes('Sunil Sharma'));
  assert.equal(buyerLead.customer_type, 'buyer');
  assert.equal(buyerLead.lead_temperature, 'HOT');

  // Buyer extracted vs missing
  const { captured, missing } = buyerLead.extracted_vs_missing;
  const capturedFields = captured.map(c => c.field);
  assert.ok(capturedFields.includes('Required Brand'));
  assert.ok(capturedFields.includes('Tonnage Class'));
  assert.ok(capturedFields.includes('Maximum Budget'));
  assert.ok(capturedFields.includes('Purchase Timeline'));

  // Buyer Journey (14 stages)
  assert.ok(Array.isArray(buyerLead.journey_progression));
  assert.equal(buyerLead.journey_progression.length, 14, 'Buyer journey must have 14 operational stages');
  const buyerStageKeys = buyerLead.journey_progression.map(s => s.key);
  assert.ok(buyerStageKeys.includes('machine_requirement'));
  assert.ok(buyerStageKeys.includes('budget'));
  assert.ok(buyerStageKeys.includes('matching'));
  assert.ok(buyerStageKeys.includes('yard_visit'));
  assert.ok(buyerStageKeys.includes('deal'));

  const activeBuyerStages = buyerLead.journey_progression.filter(s => s.status === 'active');
  assert.equal(activeBuyerStages.length, 1);
  assert.ok(['matching', 'yard_visit'].includes(activeBuyerStages[0].key));
});

test('Lead timeline ordering, multi-day grouping, customer quotes, and actor attribution', async () => {
  const timeline = await vaaniSales.getLeadTimeline('demo_lead_s01', true);
  assert.ok(Array.isArray(timeline));
  assert.ok(timeline.length >= 6, 'Timeline should contain multi-event history');

  // Verify chronological ordering
  for (let i = 0; i < timeline.length - 1; i++) {
    const tCurrent = new Date(timeline[i].timestamp).getTime();
    const tNext = new Date(timeline[i + 1].timestamp).getTime();
    assert.ok(tCurrent <= tNext, `Timeline events must be in chronological order: ${timeline[i].title} (${tCurrent}) > ${timeline[i + 1].title} (${tNext})`);
  }

  // Verify multi-day progression
  const days = new Set(timeline.map(e => e.day_label));
  assert.ok(days.size >= 2, 'Timeline must persist across multiple days (Day 1, Day 2, etc.)');
  assert.ok(days.has('Day 1'));
  assert.ok(days.has('Day 2'));

  // Verify actor attribution
  const validActors = ['vaani', 'customer', 'operator', 'system'];
  timeline.forEach(event => {
    assert.ok(validActors.includes(event.actor), `Event actor ${event.actor} must be one of ${validActors.join(', ')}`);
    assert.ok(event.actor_label, 'Event must have a human-readable actor label');
  });

  const actorsPresent = new Set(timeline.map(e => e.actor));
  assert.ok(actorsPresent.has('vaani'), 'Timeline must include AI Vaani actions');
  assert.ok(actorsPresent.has('customer'), 'Timeline must include Customer actions');
  assert.ok(actorsPresent.has('operator'), 'Timeline must include Sales Operator actions');
  assert.ok(actorsPresent.has('system'), 'Timeline must include System actions');

  // Verify customer speech quotes are preserved
  const quotes = timeline.filter(e => e.customer_quote);
  assert.ok(quotes.length > 0, 'Customer speech quotes should be preserved in timeline');
  assert.ok(quotes.some(q => q.customer_quote.includes('Tata')));

  // Verify activity types match sales ontology
  const supportedTypes = [
    'CALL_STARTED', 'CALL_CONNECTED', 'CALL_COMPLETED', 'INFORMATION_EXTRACTED',
    'LEAD_QUALIFIED', 'TEMPERATURE_CHANGED', 'EVIDENCE_REQUESTED', 'EVIDENCE_RECEIVED',
    'EVIDENCE_VERIFIED', 'PRICE_CAPTURED', 'PRICE_CHANGED', 'FOLLOW_UP_CREATED',
    'FOLLOW_UP_COMPLETED', 'FOLLOW_UP_MISSED', 'BUYER_MATCH_FOUND', 'BUYER_INTERESTED',
    'NEGOTIATION_STARTED', 'INSPECTION_SCHEDULED', 'DEAL_WON', 'DEAL_LOST', 'DNC_REGISTERED'
  ];
  timeline.forEach(event => {
    assert.ok(supportedTypes.includes(event.activity_type), `Activity type ${event.activity_type} must be supported`);
  });
});

test('Multiple calls belonging to ONE lead (call count vs lead count)', async () => {
  const overview = await vaaniSales.getOverview(true);
  
  // Total unique leads = 12, Connected calls = 18
  assert.equal(overview.total_leads, 12, 'Total unique leads count is 12');
  assert.equal(overview.connected_calls, 18, 'Connected calls count is 18');
  assert.ok(overview.connected_calls > overview.total_leads, 'Calls count exceeds unique leads count');

  // Lead demo_lead_s01 has 3 linked calls
  const leadS01 = await vaaniSales.getLead360('demo_lead_s01', true);
  assert.ok(Array.isArray(leadS01.linked_calls));
  assert.equal(leadS01.linked_calls.length, 3, 'Ramesh Patel must have 3 linked call sessions');

  // Verify all 3 calls belong to this same lead and have distinct run_ids
  const runIds = leadS01.linked_calls.map(c => c.run_id);
  assert.equal(runIds.length, 3);
  assert.equal(new Set(runIds).size, 3, 'Run IDs must be distinct across calls');
  assert.ok(runIds.includes(101));
  assert.ok(runIds.includes(104));
  assert.ok(runIds.includes(105));

  // Buyer demo_lead_b01 has 2 linked calls
  const leadB01 = await vaaniSales.getLead360('demo_lead_b01', true);
  assert.ok(Array.isArray(leadB01.linked_calls));
  assert.equal(leadB01.linked_calls.length, 2, 'Sunil Sharma must have 2 linked call sessions');
});

test('DNC isolation in Lead 360 and timeline', async () => {
  const dncLead = await vaaniSales.getLead360('demo_lead_dnc01', true);
  assert.ok(dncLead, 'DNC lead must be retrievable for compliance audit');
  assert.equal(dncLead.customer_type, 'dnc');
  assert.equal(dncLead.dnc_requested, true);
  assert.equal(dncLead.lead_temperature, 'COLD');
  assert.ok(dncLead.next_action.includes('DO NOT CALL') || dncLead.next_action.includes('Do Not Call'));

  // Timeline must contain DNC_REGISTERED
  const dncTimeline = await vaaniSales.getLeadTimeline('demo_lead_dnc01', true);
  assert.ok(dncTimeline.some(e => e.activity_type === 'DNC_REGISTERED'));
});

test('Overview recent activities feed and honest empty state in Real DB', async () => {
  // Demo mode activities
  const demoActivities = await vaaniSales.getRecentActivities(10, true);
  assert.ok(Array.isArray(demoActivities));
  assert.ok(demoActivities.length > 0);
  assert.ok(demoActivities[0].actor);
  assert.ok(demoActivities[0].title);
  assert.ok(demoActivities[0].activity_type);

  // Overview includes recent activities
  const overview = await vaaniSales.getOverview(true);
  assert.ok(Array.isArray(overview.recent_activities));
  assert.ok(overview.recent_activities.length > 0);

  // Real DB activity test (non-demo)
  const realActivities = await vaaniSales.getRecentActivities(10, false);
  assert.ok(Array.isArray(realActivities), 'Real DB activities must return an array');
  // Must NEVER fabricate fake activities
  realActivities.forEach(act => {
    assert.ok(act.run_id || act.id, 'Real DB activities must have actual run_id/id groundings');
  });
});

test('Classification: Dograh buyer_seller_classification = "buyer" -> "buyer"', async () => {
  const runId = 999901;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { buyer_seller_classification: "buyer" } };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'buyer');
});

test('Classification: Dograh buyer_seller_classification = "seller" -> "seller"', async () => {
  const runId = 999902;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { buyer_seller_classification: "seller" } };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'seller');
});

test('Classification: intent = "purchase" -> "buyer"', async () => {
  const runId = 999903;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { intent: "purchase" } };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'buyer');
});

test('Classification: intent = "sell" -> "seller"', async () => {
  const runId = 999904;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { intent: "sell" } };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'seller');
});

test('Classification: intent = "not_interested" -> "other"', async () => {
  const runId = 999905;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { intent: "not_interested" } };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'other');
});

test('Classification: Machine-only data remains unknown', async () => {
  const runId = 999906;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", machine_brand: "JCB" };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'unknown');
});

test('Classification: Buyer + machine -> "buyer"', async () => {
  const runId = 999907;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { intent: "purchase" }, machine_brand: "JCB", machine_model: "3DX" };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'buyer');
});

test('Classification: Seller + machine -> "seller"', async () => {
  const runId = 999908;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { intent: "sell" }, machine_brand: "JCB", machine_model: "3DX" };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'seller');
});

test('Classification: Explicit correction seller -> buyer -> "buyer"', async () => {
  const runId = 999909;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { buyer_seller_classification: "seller" }, transcript: "actually mujhe machine kharidni hai, not sell" };
  
  const originalExtractor = vaaniSales.extractFromConversation;
  vaaniSales.extractFromConversation = (transcript) => {
    return {
      extracted: { customer_type: 'buyer', machine_details: {}, commercial_terms: {}, evidence_readiness: {} },
      provenance: {}, missing_info: [], correction_history: [{ old: 'seller', new: 'buyer' }], follow_up_question: null
    };
  };
  await vaaniSales.ingestCallComplete(payload);
  vaaniSales.extractFromConversation = originalExtractor;

  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'buyer');
});

test('Classification: Explicit correction buyer -> seller -> "seller"', async () => {
  const runId = 999910;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { buyer_seller_classification: "buyer" }, transcript: "I want to sell it, not buy" };
  const originalExtractor = vaaniSales.extractFromConversation;
  vaaniSales.extractFromConversation = (transcript) => {
    return {
      extracted: { customer_type: 'seller', machine_details: {}, commercial_terms: {}, evidence_readiness: {} },
      provenance: {}, missing_info: [], correction_history: [{ old: 'buyer', new: 'seller' }], follow_up_question: null
    };
  };
  await vaaniSales.ingestCallComplete(payload);
  vaaniSales.extractFromConversation = originalExtractor;

  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'seller');
});

test('Classification: Missing classification -> unknown', async () => {
  const runId = 999911;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000" };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'unknown');
});

test('Classification: Invalid classification -> unknown', async () => {
  const runId = 999912;
  const payload = { call_metadata: { run_id: runId }, id: runId, workflow_id: 3, organization_id: 1, primary_phone: "+919999900000", extracted_variables: { intent: "nonsense_string_123" } };
  await vaaniSales.ingestCallComplete(payload);
  const row = await vaaniSales.queryPostgres(`SELECT customer_type FROM vaani_excavator_sales_leads WHERE run_id = ${runId}`);
  assert.equal(row, 'unknown');
});
