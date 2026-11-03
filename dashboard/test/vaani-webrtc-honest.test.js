'use strict';
// WebRTC honest-failure tests. Static checks over the shipped Vaani page:
// Dograh error frames and answer timeouts must surface visibly instead of
// hanging silently, and the offer contract must match the Dograh signaling
// handler (pc_id, sdp, type). No network, no database, no secrets, no calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dashSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
const code = strip(dashSrc);

test('Dograh error frames end the call visibly, never silently', () => {
  assert.ok(code.includes("msg.type === 'error'"), 'error branch present');
  const branch = code.split("msg.type === 'error'")[1].split('} catch (error)')[0];
  assert.ok(branch.includes("endWebRTCVoiceCall('error'"), 'error tears down with error reason');
  const finalize = code.split('function finalizeCallLifecycle')[1].split('function endWebRTCVoiceCall')[0];
  assert.ok(finalize.includes("status = 'failed'"), 'error reason maps to failed');
  assert.ok(finalize.includes('Call failed'), 'failed status is shown, never silent');
});

test('missing SDP answer fails loudly instead of hanging with mic hot', () => {
  assert.ok(code.includes('webrtcAnswered'), 'answer flag tracked');
  assert.ok(code.includes('webrtcAnswerTimeout'), 'answer timeout exists');
  assert.ok(code.includes('No answer from voice service'), 'timeout message is explicit');
  assert.ok(code.includes('clearTimeout(webrtcAnswerTimeout)'), 'timeout cleared on answer/end');
});

test('offer contract matches Dograh signaling requirements', () => {
  assert.ok(code.includes('pc_id: peerId'), 'offer carries pc_id');
  assert.ok(code.includes('sdp: offer.sdp'), 'offer carries sdp');
  assert.ok(code.includes("type: 'offer'"), 'offer carries type');
  assert.ok(code.includes('workflow_id: session.workflowId'), 'offer carries workflow id');
  assert.ok(code.includes('workflow_run_id: session.workflowRunId'), 'offer carries run id');
});

test('connected state only fires on real WebRTC connection', () => {
  const onChange = code.split('onconnectionstatechange')[1].split('webrtcWs = new WebSocket')[0];
  assert.ok(onChange.includes("=== 'connected'"), 'connected gated on connection state');
  assert.ok(onChange.includes('Live call connected'), 'connected toast present');
});

test('no PSTN or WhatsApp in the browser call flow', () => {
  assert.ok(!code.includes('/api/telephony/dial'), 'no PSTN dial in page');
  const callFlow = code.split('async function startWebRTCVoiceCall')[1].split('function endWebRTCVoiceCall')[0];
  assert.ok(!callFlow.toLowerCase().includes('whatsapp'), 'voice flow has no WhatsApp');
  assert.ok(!callFlow.includes('/api/telephony/'), 'voice flow has no telephony API');
});

test('remote audio attaches to an audio element with user-gesture playback', () => {
  const flow = code.split('async function startWebRTCVoiceCall')[1].split('function endWebRTCVoiceCall')[0];
  assert.ok(flow.includes('ontrack'), 'ontrack handler present');
  assert.ok(flow.includes('srcObject'), 'remote stream attached');
  assert.ok(flow.includes('tryPlayRemoteAudio()'), 'playback routed through autoplay-safe helper');
  assert.ok(flow.includes('getUserMedia'), 'microphone requested in call chain');
});

test('blocked autoplay surfaces loudly with one-tap recovery, never silent', () => {
  assert.ok(!/\.play\(\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(code), 'no silent play swallow');
  assert.ok(code.includes('function tryPlayRemoteAudio'), 'recovery helper present');
  const fn = code.split('function tryPlayRemoteAudio')[1].split(/^    function \w/m)[0];
  assert.ok(/click anywhere to enable sound/i.test(fn), 'user is told what to do');
  assert.ok(fn.includes("addEventListener('click'"), 'recovery waits for a real user gesture');
  assert.ok(fn.includes('removeEventListener'), 'recovery listener is one-time');
});

test('autoplay recovery listener is cleaned up on teardown', () => {
  const teardown = code.split('function teardownWebRTCMedia')[1].split(/^    function \w/m)[0];
  assert.ok(teardown.includes('webrtcAudioResume'), 'teardown clears the recovery listener');
});
