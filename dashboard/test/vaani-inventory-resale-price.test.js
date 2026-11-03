'use strict';
// Step B1: target_resale_inr inventory fix tests.
// Voice-ingest must persist expected_price_inr into target_resale_inr on both
// insert and conflict-update; manual path and matching logic stay unchanged.
// Source-level + pure-function level only: no DB writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');

// Isolate the voice-ingest vaani_machines block (section marker "// 2.").
const voiceBlock = (() => {
  const start = libSrc.indexOf('// 2. vaani_machines record');
  const end = libSrc.indexOf('// 3. vaani_digital_evidence record');
  return libSrc.slice(start, end);
})();

test('A/B. voice-ingest INSERT maps expected_price into target_resale_inr', () => {
  assert.ok(voiceBlock.includes('target_resale_inr'), 'column present in voice insert');
  // Same escaped value feeds both sourcing and resale columns.
  const escUses = [...voiceBlock.matchAll(/\$\{sqlEscapeInt\(expectedPrice\)\}/g)].length;
  assert.equal(escUses, 2, 'expectedPrice feeds sourcing_cost_inr and target_resale_inr, got ' + escUses);
});

test('C. conflict/update path preserves target_resale_inr', () => {
  assert.ok(
    voiceBlock.includes('target_resale_inr = EXCLUDED.target_resale_inr'),
    'conflict update sets target_resale_inr from excluded row'
  );
});

test('D. manual inventory creation unchanged', () => {
  const manualStart = libSrc.indexOf('function buildManualMachineInsert');
  const manualBlock = libSrc.slice(manualStart, manualStart + 2500);
  assert.ok(manualBlock.includes('target_resale_inr'), 'manual path still writes target_resale_inr');
  assert.ok(manualBlock.includes('sourcing_cost_inr'), 'manual path still writes sourcing_cost_inr');
});

test('E. voice-created machine prices correctly in buyer matching', () => {
  const stock = [{
    machine_id: 'mach_run_1', brand: 'JCB', model: '3DX',
    manufacturing_year: 2020, hour_meter_reading: 4000,
    application_history: 'soil_earthwork',
    target_resale_inr: 1800000,
    status: 'in_sourcing_pipeline', current_location: 'Jaipur', organization_id: 2,
  }];
  const [m] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000 }, stock);
  assert.ok(m, 'match found against voice-created price');
  assert.equal(m.machine.target_resale_inr, 1800000);
});
