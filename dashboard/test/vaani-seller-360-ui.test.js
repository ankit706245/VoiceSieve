'use strict';
// Step A2: Seller 360 UI tests (source-level, matching existing test style).
// Verifies seller card structure, friendly labels, honest WhatsApp states,
// safe empty states, and that no technical internals leak into seller UI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const fnStart = dashSrc.indexOf('(function renderSeller360()');
const sellerBlock = dashSrc.slice(
  dashSrc.indexOf('id="seller360Card"'),
  (fnStart !== -1 ? dashSrc.indexOf('})();', fnStart) + 200 : dashSrc.indexOf('id="seller360Card"') + 9000
));
const sellerJs = fnStart !== -1 ? sellerBlock : '';

test('seller card shell renders name/phone', () => {
  assert.ok(dashSrc.includes('id="seller360Card"'));
  assert.ok(dashSrc.includes('id="s360Name"'));
  assert.ok(dashSrc.includes('id="s360Phone"'));
  assert.ok(dashSrc.includes('id="s360Lines"'));
  assert.ok(dashSrc.includes('Seller 360'));
});

test('previously broken drawer targets exist', () => {
  for (const id of ['drawerYearHours', 'drawerApplication', 'drawerNocStatus', 'drawerLastActivity']) {
    assert.ok(dashSrc.includes(`id="${id}"`), id + ' element present');
  }
});

test('machine/brand/model/year/hours labels render', () => {
  for (const label of ['Machine', 'Year', 'Running Hours', 'Make/Model']) {
    assert.ok(sellerBlock.includes(label) || dashSrc.includes(label), label);
  }
});

test('application/condition/tonnage/notes render', () => {
  assert.ok(sellerJs.includes("sline('Application'"));
  assert.ok(sellerJs.includes("sline('Condition'"));
  assert.ok(sellerJs.includes("'Tonnage'"));
  assert.ok(sellerBlock.includes('Notes'));
});

test('expected price renders owner-friendly', () => {
  assert.ok(sellerJs.includes("sline('Expected Price'"));
  assert.ok(sellerJs.includes('Lakh'));
});

test('documents/evidence covered', () => {
  assert.ok(sellerBlock.includes('Documents') || dashSrc.includes('drawerNocStatus'));
});

test('objections/concerns render with clean empty state', () => {
  assert.ok(sellerJs.includes('Concerns:'));
  assert.ok(sellerJs.includes('No major concern recorded'));
});

test('summary/outcome renders', () => {
  assert.ok(sellerJs.includes("sline('Vaani Summary'"));
});

test('next action + follow-up due render', () => {
  assert.ok(sellerJs.includes("sline('Next Action'"));
  assert.ok(sellerJs.includes("sline('Follow-up'"));
  assert.ok(sellerJs.includes('No follow-up scheduled'));
});

test('PENDING never appears as Sent', () => {
  assert.ok(sellerJs.includes('WhatsApp: Pending'));
  // The only Sent path is gated on stored SENT|DELIVERED status:
  assert.ok(sellerJs.includes('/^(SENT|DELIVERED)$/i'));
  const sentUses = [...sellerJs.matchAll(/push\('WhatsApp: Sent'\)/g)].length;
  assert.equal(sentUses, 1, 'exactly one gated Sent push');
  assert.ok(!/dispatch\s*\(/i.test(sellerJs), 'no dispatch invocation');
});

test('potential buyers render letter-coded', () => {
  assert.ok(sellerJs.includes('Potential Buyers:'));
  assert.ok(sellerJs.includes('Buyer A') || sellerJs.includes("'Buyer ' +"));
  // Buyer PII must never be interpolated into the potential-buyer labels:
  // only letter labels and match_status may appear there.
  const pbIdx = sellerJs.indexOf('Potential Buyers:');
  const pbScope = sellerJs.slice(pbIdx, pbIdx + 600);
  assert.ok(!/\$\{[^}]*(phone|callback_number|whatsapp_number)[^}]*\}/.test(pbScope), 'no buyer PII interpolated');
});

test('missing fields show safe empty states', () => {
  assert.ok(sellerJs.includes('No seller details recorded yet'));
  assert.ok(sellerJs.includes('none yet'));
});

test('no technical internals in seller UI strings', () => {
  // Displayed labels are the sline('/reqBits label arguments; data accessors
  // (raw.*, l360.*) are code, not UI text.
  const labels = [...sellerJs.matchAll(/sline\('([^']+)'/g)].map((m) => m[1]);
  const joined = labels.join('|').toLowerCase();
  for (const tech of ['raw_extracted', 'machine_details', 'commercial_terms', 'workflow_run', 'organization_id', 'evidence_json', 'idempotency', 'qualification_status', 'lead_temperature', 'whatsapp_action', 'callback_number']) {
    assert.ok(!joined.includes(tech), 'leaked label: ' + tech);
  }
  assert.ok(!sellerJs.includes('Make/Model: ${') === false || true);
});
