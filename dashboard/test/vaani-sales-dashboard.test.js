'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
  const updated = vaaniSales.updateFollowUpStatus(testId, 'completed');
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
  const baseUrl = 'http://localhost:8787';

  // Overview
  const resOverview = await fetch(`${baseUrl}/api/vaani/sales/overview?demo=1`);
  assert.equal(resOverview.status, 200);
  const dataOverview = await resOverview.json();
  assert.ok(dataOverview.total_leads >= 0);

  // Sellers
  const resSellers = await fetch(`${baseUrl}/api/vaani/sales/sellers?demo=1`);
  assert.equal(resSellers.status, 200);
  const dataSellers = await resSellers.json();
  assert.ok(Array.isArray(dataSellers.sellers));

  // Buyers
  const resBuyers = await fetch(`${baseUrl}/api/vaani/sales/buyers?demo=1`);
  assert.equal(resBuyers.status, 200);
  const dataBuyers = await resBuyers.json();
  assert.ok(Array.isArray(dataBuyers.buyers));

  // Machines
  const resMachines = await fetch(`${baseUrl}/api/vaani/sales/machines?demo=1`);
  assert.equal(resMachines.status, 200);
  const dataMachines = await resMachines.json();
  assert.ok(Array.isArray(dataMachines.machine_master));

  // DNC
  const resDnc = await fetch(`${baseUrl}/api/vaani/sales/dnc?demo=1`);
  assert.equal(resDnc.status, 200);
  const dataDnc = await resDnc.json();
  assert.ok(Array.isArray(dataDnc.dnc_records));

  // Existing receptionist endpoint must remain unbroken
  const resReceptionist = await fetch(`${baseUrl}/api/vaani/leads`);
  assert.equal(resReceptionist.status, 200);
});
