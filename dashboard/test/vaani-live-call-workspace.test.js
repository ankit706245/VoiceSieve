'use strict';
// Goal 28 Live Call Workspace tests. Static checks over the shipped Vaani
// page proving the workspace is presentation-only over Goals 22-27 state:
// honest connection/timer/transcript behavior, reused context, no invented
// success, no new auth/data surface. No network, no database, no secrets,
// no PSTN, no real calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
const code = strip(dashSrc);

function workspaceBlock() {
  assert.ok(code.includes('function showLiveCallWorkspace'), 'workspace renderer exists');
  return code.split('function showLiveCallWorkspace')[1].split(/^    function \w/m)[0];
}

test('active call workspace exists with header, timer, controls, transcript, context', () => {
  assert.ok(dashSrc.includes('id="liveCallWorkspace"'), 'workspace panel present');
  assert.ok(dashSrc.includes('id="liveCallCustomer"'), 'customer header present');
  assert.ok(dashSrc.includes('id="liveCallStatePill"'), 'state pill present');
  assert.ok(dashSrc.includes('id="liveCallTimer"'), 'timer present');
  assert.ok(dashSrc.includes('id="liveCallMuteBtn"'), 'mute control present');
  assert.ok(dashSrc.includes('id="liveCallEndBtn"'), 'end control present');
  assert.ok(dashSrc.includes('id="liveCallTranscript"'), 'transcript area present');
  assert.ok(dashSrc.includes('id="liveCallContext"'), 'context area present');
});

test('buyer call context displayed with purchase side', () => {
  assert.ok(code.includes("side: 'buyer'") || code.includes('side === '), 'side tracked');
  assert.ok(code.includes("beginCallTrack(data.call_id, { side: 'buyer'"), 'buyer calls tagged buyer');
});

test('seller call context displayed with sell side', () => {
  assert.ok(code.includes("beginCallTrack(data.call_id, { side: 'seller'"), 'seller calls tagged seller');
});

test('connected state only after real connection via existing path', () => {
  assert.ok(code.includes('markLiveCallConnected(mySeq)'), 'connected funnels through guarded marker');
  const marker = code.split('function markLiveCallConnected')[1].split(/^    function \w/m)[0];
  assert.ok(marker.includes('webrtcCall.seq !== seq'), 'stale generations rejected');
});

test('connecting state displayed honestly before connection', () => {
  assert.ok(code.includes("updateDrawerStatus('Connecting...')"), 'connecting status set');
  assert.ok(code.includes("setLiveCallPill('connecting')") || code.includes("setLiveCallPill("), 'pill reflects connecting');
});

test('failed call state ends media and marks failed', () => {
  assert.ok(code.includes("endWebRTCVoiceCall('error'"), 'failures finalize as error');
  const fin = code.split('function finalizeCallLifecycle')[1].split(/^    function \w/m)[0];
  assert.ok(fin.includes("status = 'failed'"), 'failed terminal state exists');
});

test('terminal call state stops timer and poll', () => {
  const fin = code.split('function finalizeCallLifecycle')[1].split(/^    function \w/m)[0];
  assert.ok(fin.includes('stopLiveCallTimer()'), 'timer stopped at terminal');
  assert.ok(fin.includes('stopLiveTranscriptPoll()'), 'poll stopped at terminal');
});

test('timer starts on connected, never on button click', () => {
  const marker = code.split('function markLiveCallConnected')[1].split('function updateSimControllerStatus')[0];
  assert.ok(marker.includes('startLiveCallTimer()'), 'timer starts at real connection');
  assert.ok(marker.includes('connectedAt'), 'connection timestamp recorded');
  assert.equal((code.match(/[^A-Za-z]startLiveCallTimer\(\);/g) || []).length, 1, 'exactly one timer start site: the real-connection marker');
});

test('timer stops on terminal state with no fabrication', () => {
  assert.ok(code.includes('clearInterval(liveCallTimerId)'), 'interval cleared');
  assert.ok(code.includes('00:00'), 'timer resets to zero for next call');
});

test('transcript renders only real arriving segments', () => {
  assert.ok(code.includes('function renderLiveTranscript'), 'renderer exists');
  const fn = code.split('function renderLiveTranscript')[1].split(/^    function \w/m)[0];
  assert.ok(fn.includes('No transcript yet.'), 'honest empty state');
  assert.ok(fn.includes('escapeHtml'), 'segments escaped');
});

test('empty transcript never fabricates content', () => {
  const fn = code.split('function renderLiveTranscript')[1].split(/^    function \w/m)[0];
  assert.ok(!/lorem|Lorem|sample|Sample|demo|Demo|fake|Fake/.test(fn), 'no placeholder conversation');
});

test('speaker separation without invented identities', () => {
  const fn = code.split('function renderLiveTranscript')[1].split(/^    function \w/m)[0];
  assert.ok(fn.includes('s.speaker || s.role'), 'stored speaker labels reused');
  assert.ok(fn.includes('Unknown'), 'unlabeled speakers stay unknown');
  assert.ok(fn.includes('nearBottom'), 'autoscroll respects reading position');
});

test('sales brain reused, never duplicated', () => {
  assert.ok(code.includes('l360.sales_brain'), 'brain sourced from lead360');
  assert.ok(!/buildSalesBrain/.test(code), 'no second composer in frontend');
});

test('qualification reused from existing output', () => {
  const ctx = code.split('function renderLiveCallContext')[1].split(/^    function \w/m)[0];
  assert.ok(ctx.includes('brain.qualification') || ctx.includes('l360.qualification'), 'qualification reused');
});

test('objections reused from existing groups', () => {
  const ctx = code.split('function renderLiveCallContext')[1].split(/^    function \w/m)[0];
  assert.ok(ctx.includes('l360.objections'), 'objections reused');
});

test('inventory matches reused without new fetching logic', () => {
  const ctx = code.split('function renderLiveCallContext')[1].split(/^    function \w/m)[0];
  assert.ok(ctx.includes('l360.inventory_matches'), 'matches reused');
  assert.ok(!/fetch\(.vaani\/sales\/(machines|sellers)/.test(ctx), 'no extra inventory fetching');
});

test('missing fields displayed from existing qualification', () => {
  const ctx = code.split('function renderLiveCallContext')[1].split(/^    function \w/m)[0];
  assert.ok(ctx.includes('next_information_to_collect') || ctx.includes('missing'), 'missing surfaced');
});

test('buyer and seller workspace context stays separated', () => {
  assert.ok(code.includes("(t && t.side === 'seller')"), 'side resolved per call');
  assert.ok(code.includes("const intent = side === 'Seller' ? 'Sell' : 'Purchase';"), 'intent separated');
});

test('end call uses the existing lifecycle finalization path', () => {
  assert.ok(dashSrc.includes("onclick=\"endWebRTCVoiceCall('user')\""), 'end controls finalize as user');
  const fin = code.split('function finalizeCallLifecycle')[1].split(/^    function \w/m)[0];
  assert.ok(fin.includes("status = 'cancelled'"), 'user end maps to cancelled');
});

test('no fake connection success anywhere in workspace', () => {
  const ws = code.split('function showLiveCallWorkspace')[1].split('function renderLiveCallContext')[0];
  assert.ok(!/connected|Live call connected/.test(ws), 'workspace show never claims connection');
  assert.ok(ws.includes("setLiveCallPill('connecting')"), 'fresh workspace starts connecting');
});

test('no new negotiation logic in workspace', () => {
  const ws = code.split('function showLiveCallWorkspace')[1].split(/^    async function pollLiveCallTranscript/m)[0];
  assert.ok(!/discount|negotiat|deal|close|contract|payment/i.test(ws), 'no commercial actions');
});

test('organization isolation untouched with no new endpoints', () => {
  assert.ok(!/['"]\/api\/[^'"]*live-call|liveCallWorkspace.*fetch\(/.test(code.split('function pollLiveCallTranscript')[1].split(/^    function \w/m)[0].replace(/fetch\('\/api\/vaani\/buyers\/'/, '')), 'only pre-existing org-checked detail route polled');
  assert.ok(!/\/api\/[^'"]+/.test(code.split('function showLiveCallWorkspace')[1].split('function renderLiveCallContext')[0]), 'workspace show performs no fetch');
});

test('unauthorized access remains blocked on polled route', () => {
  assert.ok(serverSrc.includes('/api/vaani/buyers/'), 'buyer call-detail route intact');
  assert.ok(serverSrc.includes('call does not belong to this organization'), 'org gate intact');
});

test('no banned branding in workspace', () => {
  const ws = dashSrc.split('id="liveCallWorkspace"')[1].split('id="toast"')[0];
  assert.ok(!/AI Sales Agent|RapidX|rapidx|Agency OS|Demo/i.test(ws), 'clean branding');
  assert.ok(/VAANI|Live Call/.test(ws), 'product framing intact');
});
