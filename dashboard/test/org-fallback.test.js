'use strict';
// organization_id fallback tests. Loads the actual publicTenant serializer
// from server.js source (never boots the server) and proves unmapped
// tenants serialize as null instead of silently becoming org 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadPublicTenant() {
  const m = serverSrc.match(/function publicTenant\(t\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'publicTenant found in server.js');
  return eval('(' + m[0] + ')'); // eslint-disable-line no-eval
}

const base = {
  id: 't_1', name: 'Test', slug: 'test', createdAt: '2026-01-01',
  branding: {}, providers: {}, plan: 'studio', status: 'active', privacyMode: 'standard',
};

test('valid organization_id values remain unchanged', () => {
  const publicTenant = loadPublicTenant();
  assert.equal(publicTenant({ ...base, organization_id: 1 }).organization_id, 1);
  assert.equal(publicTenant({ ...base, organization_id: 2 }).organization_id, 2);
  assert.equal(publicTenant({ ...base, organization_id: 3 }).organization_id, 3);
});

test('missing organization_id does not become 1', () => {
  const publicTenant = loadPublicTenant();
  const cases = [
    [{ ...base }, 'absent'],
    [{ ...base, organization_id: undefined }, 'undefined'],
    [{ ...base, organization_id: null }, 'null'],
    [{ ...base, organization_id: 0 }, 'zero'],
    [{ ...base, organization_id: -2 }, 'negative'],
    [{ ...base, organization_id: 'abc' }, 'non-numeric'],
  ];
  for (const [tenant, label] of cases) {
    const org = publicTenant(tenant).organization_id;
    assert.equal(org, null, label + ' must serialize as null');
    assert.notEqual(org, 1, label + ' must never leak into org 1');
  }
});

test('BRAIVEX mapped Org 2 still resolves to Org 2', () => {
  const publicTenant = loadPublicTenant();
  const shadow = {
    ...base, name: 'BRAIVEX (user)', managedBy: 'braivex',
    organization_id: 2,
  };
  assert.equal(publicTenant(shadow).organization_id, 2);
});

test('no silent org-1 fallback remains in server source', () => {
  assert.ok(!serverSrc.includes('organization_id || 1'), 'fallback removed');
});
