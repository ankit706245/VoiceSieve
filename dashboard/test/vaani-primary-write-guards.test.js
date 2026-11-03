'use strict';
// Primary-org write guards for legacy Vaani routes. These tests load the
// actual handlers from server.js and only exercise the fail-closed paths, so
// no database write, Dograh call, PSTN call, or WhatsApp send can occur.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function load(name, coreStub, vaaniSalesStub, resolveOrganizationId, primaryOrganizationId) {
  const re = new RegExp('async function ' + name + '\\(req, res, ctx\\) \\{[\\s\\S]*?\\n\\}');
  const m = serverSrc.match(re);
  assert.ok(m, name + ' found in server.js');
  return new Function(
    'core',
    'vaaniSales',
    'resolveOrganizationId',
    'primaryOrganizationId',
    'return (' + m[0] + ');'
  )(coreStub, vaaniSalesStub, resolveOrganizationId, primaryOrganizationId);
}

function stubCore() {
  return { sendJson(res, status, body) { res.status = status; res.body = body; } };
}

function resolveOrgFromCtx(ctx) {
  if (!ctx || !ctx.tenant) return null;
  if (ctx.tenant.organization_id === undefined || ctx.tenant.organization_id === null) return null;
  const n = parseInt(ctx.tenant.organization_id, 10);
  return isNaN(n) ? null : n;
}

function dbStub() {
  const calls = [];
  return {
    calls,
    queryPostgres: async (sql, params) => {
      calls.push({ sql, params });
      return {};
    },
  };
}

for (const name of ['apiVaaniCustomerCreate', 'apiVaaniDemoCallComplete']) {
  test(name + ' rejects Org 2 before any database write', async () => {
    const db = dbStub();
    const fn = load(name, stubCore(), db, resolveOrgFromCtx, () => 1);
    const res = { status: null, body: null };
    await fn({ headers: { host: 'localhost' } }, res, {
      tenant: { organization_id: 2 },
      body: { name: 'Blocked', phone: '919999900000', customer_id: 1, transcripts: [{ s: 'Agent', m: 'hi' }] },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'primary_org_required');
    assert.equal(db.calls.length, 0);
  });

  test(name + ' rejects a missing organization before any database write', async () => {
    const db = dbStub();
    const fn = load(name, stubCore(), db, resolveOrgFromCtx, () => 1);
    const res = { status: null, body: null };
    await fn({ headers: { host: 'localhost' } }, res, {
      tenant: { organization_id: null },
      body: { name: 'Blocked', phone: '919999900000', customer_id: 1, transcripts: [{ s: 'Agent', m: 'hi' }] },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'forbidden');
    assert.equal(db.calls.length, 0);
  });
}
