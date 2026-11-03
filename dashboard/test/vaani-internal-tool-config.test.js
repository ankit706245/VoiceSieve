'use strict';
// Inventory tool-config guards. Pure JSON/source assertions: no database,
// no network, no secrets, no Workflow 3 access.
// Run: node --test dashboard/test/vaani-internal-tool-config.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const specPath = path.join(__dirname, '..', '..', 'docs', 'vaani-internal-inventory-tool.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const config = spec.definition.config;
const workflowSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'workflows', 'vaani-used-excavator-sales.json'), 'utf8'
);

test('tool stays draft and unattached', () => {
  assert.equal(spec.lifecycle.status, 'draft');
  assert.equal(spec.lifecycle.attached_to_workflow_3, false);
  assert.equal(spec.lifecycle.live_credential_created, false);
  assert.ok(!workflowSrc.includes(spec.name), 'workflow JSON references the tool nowhere');
});

test('LLM receives zero arguments so it cannot override buyer_run_id', () => {
  assert.deepEqual(config.parameters, []);
});

test('buyer_run_id is a required server-templated preset, not an LLM guess', () => {
  const preset = (config.preset_parameters || []).find((p) => p.name === 'buyer_run_id');
  assert.ok(preset, 'preset present');
  assert.equal(preset.required, true);
  assert.equal(preset.value_template, '{{initial_context.workflow_run_id}}');
  assert.ok(config.url.includes('buyer_run_id={{buyer_run_id}}'), 'URL consumes the preset');
});

test('no secret material in the spec', () => {
  assert.deepEqual(config.headers, {});
  assert.equal(config.credential_uuid, null);
  const blob = JSON.stringify(spec);
  assert.ok(!/Bearer [A-Za-z0-9]/i.test(blob), 'no bearer token');
  assert.ok(!/x-vaani-internal-secret":\s*"(?!")/.test(blob), 'no secret value assigned');
  assert.ok(!/[0-9a-f]{32,}/i.test(blob.replace(/placeholder/gi, '')), 'no hex-secret-looking value');
});

test('endpoint, method, and status defaults preserved', () => {
  assert.equal(config.method, 'GET');
  assert.ok(config.url.includes('/api/vaani/internal/machines'), 'internal endpoint');
  assert.ok(config.url.includes('<DASHBOARD_BASE_URL>'), 'host left as operator placeholder');
  assert.ok(/in_sourcing_pipeline/.test(config.buyer_available_status_default), 'defaults documented');
});
