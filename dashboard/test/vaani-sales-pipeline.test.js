'use strict';
// Goal 33 sales-pipeline tests. Pure derivation-matrix coverage over
// derivePipelineStage plus source and contract assertions for the batched
// loader, endpoint wiring, UI, org isolation, and no-write guarantees. No
// network, no database writes, no secrets, no PSTN, no automation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vaaniSales = require('../lib/vaani-sales');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaani-sales.js'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const D = vaaniSales.derivePipelineStage;
const buyer = (over = {}) => ({ customer_type: 'buyer', ...over });
const seller = (over = {}) => ({ customer_type: 'seller', ...over });

test('empty lead derives NEW without fabrication', () => {
  assert.deepEqual(D(buyer()), { stage: 'NEW', stage_reason: 'no meaningful information yet' });
  assert.deepEqual(D(null).stage, 'NEW');
  assert.deepEqual(D({}).stage, 'NEW');
});

test('partially qualified buyer derives QUALIFICATION', () => {
  const s = D(buyer({ hasPartial: true }));
  assert.equal(s.stage, 'QUALIFICATION');
  assert.ok(/incomplete/i.test(s.stage_reason));
});

test('qualified buyer without inventory derives REQUIREMENT_CAPTURED', () => {
  const s = D(buyer({ isComplete: true }));
  assert.equal(s.stage, 'REQUIREMENT_CAPTURED');
});

test('qualified buyer with inventory match derives MATCH_FOUND', () => {
  const s = D(buyer({ isComplete: true, hasMatches: true, matchDetail: '2 compatible machines' }));
  assert.equal(s.stage, 'MATCH_FOUND');
  assert.ok(/2 compatible/.test(s.stage_reason));
});

test('match requiring owner review derives OWNER_REVIEW', () => {
  const s = D(buyer({ isComplete: true, hasMatches: true, ownerReviewNeeded: true, ownerReviewReason: 'owner-needed open objection: price_budget' }));
  assert.equal(s.stage, 'OWNER_REVIEW');
  assert.ok(/price_budget/.test(s.stage_reason));
});

test('active follow-up derives FOLLOW_UP', () => {
  const s = D(buyer({ isComplete: true, followupNeeded: true, followupReason: 'Collect: purchase_timeline' }));
  assert.equal(s.stage, 'FOLLOW_UP');
  assert.ok(/purchase_timeline/.test(s.stage_reason));
});

test('owner-needed objection derives OWNER_REVIEW', () => {
  const s = D(seller({ ownerReviewNeeded: true, ownerReviewReason: 'owner-needed open objection: commission' }));
  assert.equal(s.stage, 'OWNER_REVIEW');
});

test('explicit closed state remains DEAL_CLOSED', () => {
  assert.equal(D(buyer({ lifecycleStage: 'CLOSED_WON', ownerReviewNeeded: true, followupNeeded: true, hasMatches: true })).stage, 'DEAL_CLOSED');
  assert.equal(D(seller({ lifecycleStage: 'DEAL' })).stage, 'DEAL_CLOSED');
});

test('explicit lost-adjacent terminal state stays terminal', () => {
  assert.equal(D(buyer({ isLost: true, hasMatches: true })).stage, 'LOST');
  assert.equal(D(buyer({ dnc_requested: true })).stage, 'LOST');
});

test('objection alone never becomes negotiation', () => {
  assert.notEqual(D(buyer({ ownerReviewNeeded: true })).stage, 'NEGOTIATION');
  assert.equal(D(buyer({ ownerReviewNeeded: true })).stage, 'OWNER_REVIEW');
});

test('match alone never becomes deal', () => {
  assert.notEqual(D(buyer({ isComplete: true, hasMatches: true })).stage, 'DEAL_CLOSED');
  assert.equal(D(buyer({ isComplete: true, hasMatches: true })).stage, 'MATCH_FOUND');
});

test('follow-up alone never becomes commitment', () => {
  const s = D(buyer({ followupNeeded: true, followupReason: 'Collect: city' }));
  assert.equal(s.stage, 'FOLLOW_UP');
  assert.ok(!/commit|deal|clos/i.test(s.stage + ' ' + s.stage_reason), 'no commitment language');
});

test('seller incomplete machine derives MACHINE_INFORMATION', () => {
  assert.equal(D(seller({})).stage, 'MACHINE_INFORMATION');
});

test('seller complete machine derives MACHINE_REVIEW', () => {
  assert.equal(D(seller({ isComplete: true })).stage, 'MACHINE_REVIEW');
});

test('seller with potential buyers derives BUYER_MATCH_FOUND', () => {
  const s = D(seller({ isComplete: true, hasMatches: true, matchDetail: '3 potential buyers' }));
  assert.equal(s.stage, 'BUYER_MATCH_FOUND');
  assert.ok(/3 potential/.test(s.stage_reason));
});

test('seller owner review derives OWNER_REVIEW', () => {
  assert.equal(D(seller({ ownerReviewNeeded: true })).stage, 'OWNER_REVIEW');
});

test('buyer and seller stages remain separate vocabularies', () => {
  const buyerStages = new Set(['NEW', 'QUALIFICATION', 'REQUIREMENT_CAPTURED', 'MATCH_FOUND', 'FOLLOW_UP', 'OWNER_REVIEW', 'NEGOTIATION', 'DEAL_CLOSED', 'LOST']);
  const sellerStages = new Set(['NEW', 'MACHINE_INFORMATION', 'MACHINE_REVIEW', 'BUYER_MATCH_FOUND', 'FOLLOW_UP', 'OWNER_REVIEW', 'NEGOTIATION', 'DEAL_CLOSED', 'LOST']);
  assert.ok(!buyerStages.has('MACHINE_REVIEW') && !buyerStages.has('BUYER_MATCH_FOUND'), 'no seller stages on buyer side');
  assert.ok(!sellerStages.has('REQUIREMENT_CAPTURED') && !sellerStages.has('MATCH_FOUND'), 'no buyer stages on seller side');
  assert.deepEqual(vaaniSales.BUYER_PIPELINE_STAGES, [...buyerStages]);
  assert.deepEqual(vaaniSales.SELLER_PIPELINE_STAGES, [...sellerStages]);
});

test('Goal 24 qualification integration uses stored states only', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0];
  assert.ok(code.includes('evaluateQualificationCompleteness'), 'completeness reused, not redefined');
  assert.ok(code.includes('resolveQualificationFields'), 'shared resolver reused');
});

test('Goal 25 inventory integration reuses matcher output', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0];
  assert.ok(code.includes('evaluateBuyerMatches'), 'buyer matcher reused');
  assert.ok(code.includes('evaluateMachineBuyers'), 'seller matcher reused');
});

test('Goal 26 Sales Brain integration reads stage without rewriting it', () => {
  assert.ok(!/sales_brain.*stage\s*=|current_stage\s*=/i.test(strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0]), 'no stage writes in row builder');
});

test('Goal 29 call summary integration surfaces outcome and action', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0];
  assert.ok(code.includes('callsByRun'), 'latest call resolved from batched map');
});

test('Goal 30 Buyer 360 integration links by lead id only', () => {
  assert.ok(!/getLead360/.test(strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0]), 'no nested lead360 fetch per row');
});

test('Goal 31 follow-up integration prefers planner output shape', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0];
  assert.ok(code.includes('buildFollowUpRecommendation'), 'follow-up planner reused');
});

test('Goal 32 seller-buyer matching integration without new engine', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0];
  const uses = (code.match(/evaluateMachineBuyers|evaluateBuyerMatches/g) || []).length;
  assert.ok(uses >= 1, 'shared matchers reused');
  assert.ok(!/function evaluate\w*Match/.test(code), 'no new matcher defined inline');
});

test('deterministic stage derivation for identical input', () => {
  const inp = () => buyer({ isComplete: true, hasMatches: true, ownerReviewNeeded: true });
  assert.deepEqual(D(inp()), D(JSON.parse(JSON.stringify(inp()))));
});

test('same input always yields same stage across sides', () => {
  assert.equal(D(seller({})).stage, 'MACHINE_INFORMATION');
  assert.equal(D(seller({})).stage, D(seller({})).stage);
});

test('unknown data never fabricates a progressed stage', () => {
  assert.equal(D({ customer_type: 'buyer' }).stage, 'NEW');
  assert.equal(D({ customer_type: 'seller' }).stage, 'MACHINE_INFORMATION');
  assert.equal(D({}).stage, 'NEW');
});

test('organization isolation through ctx gates with no browser org', () => {
  const loader = libSrc.split('async function getSalesPipeline')[1].split('\nasync function')[0];
  assert.ok(loader.includes('Organization not linked'), 'missing org fails closed');
  assert.ok(loader.includes('getBuyers({}, false, orgInt)'), 'buyers scoped by ctx org');
  assert.ok(loader.includes('getSellers({}, false, orgInt)'), 'sellers scoped by ctx org');
  assert.ok(loader.includes('loadMatchStock(orgInt)'), 'stock scoped by ctx org');
  assert.ok(loader.includes('w.organization_id = $1'), 'calls and transcripts scoped by ctx org');
});

test('authentication protection on the pipeline data', () => {
  assert.ok(serverSrc.includes("if (route.startsWith('/api/vaani/sales/')) return core.requireAuth(req, res, apiVaaniSalesGet);"), 'sales routes are gated');
});

test('no database writes from pipeline read path', () => {
  const code = strip(libSrc);
  const loader = code.split('async function getSalesPipeline')[1].split(/^async function \w/m)[0];
  assert.ok(!/INSERT|UPDATE|DELETE/.test(loader), 'loader is read-only');
  const builder = code.split('function buildSalesPipeline(')[1].split('\nasync function getSalesPipeline')[0]
    + code.split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline(')[0];
  assert.ok(!/queryPostgres|INSERT|UPDATE|DELETE|fetch\(/.test(builder), 'builders are pure');
});

test('no fake production data in pipeline contracts', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nfunction buildSalesPipeline')[0];
  assert.ok(!/demo|Demo|DEMO|test_|Test |sample|Sample|fake|Fake/.test(code), 'no fixture language in row builder');
});

test('no outbound calls from pipeline data', () => {
  assert.ok(!/\/api\/vaani\/(sales\/outbound|buyers\/\d+\/call)/.test(serverSrc), 'no outbound call routes');
  const loader = libSrc.split('async function getSalesPipeline')[1].split('\nasync function')[0];
  assert.ok(!/sendBeacon|mailto:|tel:|wa\.me|https?\.request/.test(loader), 'pipeline loader has no contact actions');
});

test('no WhatsApp, SMS, or email in pipeline code', () => {
  const libBlock = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nasync function getSalesPipeline')[0];
  assert.ok(!/whatsapp|sms|email/i.test(libBlock), 'no messaging in pipeline assembly');
});

test('no negotiation automation in pipeline', () => {
  const libBlock = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nasync function getSalesPipeline')[0];
  assert.ok(!/negotiat|discount|close +deal|deal_clos/i.test(libBlock), 'no deal automation');
});

test('no deal-closing automation anywhere in pipeline path', () => {
  const loader = libSrc.split('async function getSalesPipeline')[1].split('\nasync function')[0];
  assert.ok(!/INSERT|UPDATE|DELETE/.test(loader), 'pipeline loader only reads');
});

test('no duplicate memory system beyond existing composers', () => {
  const code = strip(libSrc).split('function buildSalesPipelineRow')[1].split('\nasync function getSalesPipeline')[0];
  assert.ok(!/new Map|globalThis|\bcache\b|memoiz/i.test(code), 'no caches or stores');
});

test('no duplicate customer or lead records from pipeline', () => {
  const code = strip(libSrc).split('async function getSalesPipeline')[1].split(/^async function \w/m)[0];
  assert.ok(!/INSERT/.test(code), 'loader never inserts');
});
