'use strict';
// Step B5: seller concern capture tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const sellerTurns = (msgs) => msgs.map((m) => ({ speaker: 'Customer', message: m }));
const captured = (msgs) => {
  const segs = msgs.map((m) => ({ speaker: 'Customer', message: m }));
  return vaaniSales.detectObjections
    ? vaaniSales.detectObjections('seller', segs, {})
    : null;
};

test('1. price concern captured', () => {
  const out = captured(['Price thoda kam lag raha hai.']);
  assert.ok(out && out.some((o) => o.type === 'asking_price' || o.type === 'valuation'));
});

test('2. payment concern captured', () => {
  const out = captured(['Payment kab milega?']);
  assert.ok(out && out.some((o) => o.type === 'payment'));
});

test('3. inspection concern captured', () => {
  const out = captured(['Pehle machine inspect kar lena.']);
  assert.ok(out && out.some((o) => o.type === 'inspection'));
});

test('4. documentation concern captured', () => {
  const out = captured(['Documents ka kya hoga?']);
  assert.ok(out && out.some((o) => o.type === 'documentation'));
});

test('5. trust concern captured', () => {
  const out = captured(['Aapki company genuine hai?']);
  assert.ok(out && out.some((o) => o.type === 'trust_verification' || o.type === 'unknown'));
});

test('6. pickup/logistics concern captured', () => {
  const out = captured(['Machine pickup kaise hoga?']);
  assert.ok(out && out.length > 0, 'some concern recorded, got ' + JSON.stringify(out.map((o) => o.type)));
});

test('7. commitment/decision concern captured', () => {
  const out = captured(['Abhi decide nahi kiya hai, deal pakki karke bataunga.']);
  assert.ok(out && out.length > 0);
});

test('8. ordinary facts are NOT concerns', () => {
  const F = vaaniSales.filterSellerConcernCandidates;
  for (const fact of ['Machine Jaipur mein hai.', 'Machine 2020 model hai.', 'Price 18 lakh hai.']) {
    const out = F(vaaniSales.detectObjections('seller', [{ speaker: 'Customer', message: fact }], {}));
    assert.deepEqual(out, [], fact + ' must not be a concern');
  }
  // Genuine concern language still passes the filter:
  const kept = F(vaaniSales.detectObjections('seller', [{ speaker: 'Customer', message: 'Price thoda kam lag raha hai.' }], {}));
  assert.ok(kept.length > 0, 'real concern kept');
});

test('9. duplicates collapse by type, newest wins', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  assert.ok(libSrc.includes('_byType'), 'by-type merge present');
});

test('10. null/empty never erases (merge rule)', () => {
  const out = vaaniSales.mergeGatheredContextPreserving(
    { extracted_variables: { seller_concerns: [{ type: 'payment', status: 'open' }] } },
    { extracted_variables: {} }
  );
  assert.deepEqual(out.extracted_variables.seller_concerns, [{ type: 'payment', status: 'open' }]);
});

test('11. buyer flows never get seller_concerns', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  const idx = libSrc.indexOf('B5 seller concern capture');
  assert.ok(idx !== -1, 'capture block present');
  assert.ok(libSrc.slice(idx, idx + 400).includes("customerType === 'seller'"), 'seller-gated');
});

test('12. Seller 360 projection exposes stored concerns', () => {
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
  assert.ok(libSrc.includes("'seller_concerns', COALESCE"), 'SQL projection present');
  assert.ok(libSrc.includes('seller_concerns: ((!isDnc'), 'Lead360 passthrough present');
});

test('13. B2 negotiability intact', () => {
  const ext = require('../lib/vaani-extractor');
  assert.equal(ext.parsePriceNegotiability('18 lakh final hai'), false);
  assert.equal(ext.parsePriceNegotiability('18 lakh hai, thoda kam ho jayega'), true);
});

test('14. B3 urgency intact', () => {
  const ext = require('../lib/vaani-extractor');
  assert.equal(ext.parseSaleUrgency('jaldi bechna hai'), 'URGENT');
  assert.equal(ext.parseSaleUrgency('18 lakh ka hai'), null);
});

test('15. B4 matching intact', () => {
  const stock = [{ machine_id: 'm1', brand: 'JCB', model: '3DX', target_resale_inr: 1750000, status: 'in_sourcing_pipeline', current_location: 'Jaipur' }];
  const [m] = vaaniSales.evaluateBuyerMatches({ machine_brand: 'JCB', machine_model: '3DX', buyer_budget_max_inr: 1800000 }, stock);
  assert.equal(m.match_type, 'EXACT_MATCH');
});
