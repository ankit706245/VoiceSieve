'use strict';
// Phase 2 Step 3: conversation sales-context guards.
// - Prompt-level: Hindi numeral glossary present, WhatsApp no-sent rule,
//   no new/used buyer question, one-question discipline.
// - Extraction-level: numeral comprehension end to end (deterministic).
// Live multi-turn behavior is verified via a controlled text conversation
// (see completion report); these guards keep the prompt contract pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core');
try { core.loadEnv(); } catch (_) {}
const vaaniSales = require('../lib/vaani-sales');
const ext = require('../lib/vaani-extractor');
const hasDb = Boolean(process.env.VAANI_DATABASE_URL);

async function livePrompt(nodeId) {
  const res = await vaaniSales.queryPostgres(
    'SELECT workflow_json FROM workflow_definitions WHERE id = 6;'
  );
  const row = Array.isArray(res) ? res[0] : res;
  const raw = row && row.workflow_json !== undefined ? row.workflow_json : res;
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = (j && j.nodes) || (Array.isArray(j) ? j : []);
  const node = (Array.isArray(list) ? list : []).find((n) => n.id === nodeId);
  return (node && node.data && node.data.prompt) || '';
}

test('A/B. numeral glossary covers required words', { skip: !hasDb }, async () => {
  const p1 = await livePrompt('1');
  for (const w of ['bees=20', 'bais=22', 'pandrah=15', 'atharah=18', 'pachees=25', 'tees=30']) {
    assert.ok(p1.includes(w), 'Start prompt maps ' + w);
  }
  assert.ok(/bees se bais/i.test(p1), 'range pattern documented');
});

test('C/D. multi-fact + WhatsApp rules on Buyer node, no new/used ask', { skip: !hasDb }, async () => {
  const p2 = await livePrompt('2');
  assert.ok(p2.includes('several facts in one message'), 'multi-fact rule present');
  assert.ok(p2.includes('WHATSAPP NUMBER FLOW'), 'WhatsApp number flow present');
  assert.ok(!/NEVER say the WhatsApp message was already sent/i.test(p2) === false, 'no-sent rule present');
  assert.ok(!/new ya used machine chahiye\?/i.test(p2.replace(/NEVER ask new-vs-used[^.]*/i, '')), 'no new/used question asked');
});

test('E/F. deterministic numeral comprehension (no hallucinated budgets)', () => {
  const cases = [
    ['Budget bees lakh hai', 2000000, 2000000],
    ['Budget bees se bais lakh hai', 2000000, 2200000],
    ['pandrah lakh', 1500000, 1500000],
    ['atharah lakh', 1800000, 1800000],
    ['pachees lakh', 2500000, 2500000],
    ['tees lakh', 3000000, 3000000],
    ['bees se pachees lakh', 2000000, 2500000],
  ];
  for (const [text, min, max] of cases) {
    const r = ext.parseSpokenPrice(text);
    assert.ok(r, 'parsed: ' + text);
    assert.equal(r.min_inr, min, 'min: ' + text);
    assert.equal(r.max_inr, max, 'max: ' + text);
  }
});

test('G. buyer qualifies across turns without new_or_used', () => {
  const C = vaaniSales.evaluateQualificationCompleteness;
  const r = C('buyer', { machine_type: 'excavator', budget_min: 2000000, budget_max: 2200000, preferred_city: 'Jaipur', purchase_timeline: 'within_15_30_days' });
  assert.equal(r.status, 'QUALIFIED');
  assert.ok(!r.missing_fields.includes('new_or_used'));
});
