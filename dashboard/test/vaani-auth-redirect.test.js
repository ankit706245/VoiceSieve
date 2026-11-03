'use strict';
// Vaani auth-redirect tests. Static read-only checks that the Vaani
// dashboard session-expiry path points at the BRAIVEX login page with a
// safe local destination. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const vaaniSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'braivex-login.html'), 'utf8');

test('unauthenticated Vaani dashboard redirects to BRAIVEX login', () => {
  assert.ok(
    serverSrc.includes("Location: '/braivex-login.html?redirect=/vaani-sales.html'"),
    'server gate redirects to braivex-login');
  assert.ok(vaaniSrc.includes('/braivex-login.html?redirect=/vaani-sales.html'),
    'vaani-sales session-expiry path redirects to braivex-login');
});

test('redirect preserves the safe Vaani destination', () => {
  assert.ok(vaaniSrc.includes('redirect=/vaani-sales.html'), 'destination preserved');
  assert.ok(loginSrc.includes('/vaani-sales.html'), 'login page returns to dashboard');
  assert.ok(loginSrc.includes("fetch('/api/me'"), 'login page checks existing session');
});

test('no redirect to old RapidX login remains in Vaani session path', () => {
  assert.ok(!vaaniSrc.includes('/app.html'), 'vaani-sales has no app.html redirects');
  const gate = serverSrc.split('isVaaniSales')[1].split('console.html')[0];
  assert.ok(!gate.includes('/app.html'), 'server vaani gate has no app.html redirect');
});

test('external redirect URLs are rejected', () => {
  assert.ok(loginSrc.includes("q.charAt(0) === '/'"), 'redirect must be a local path');
  assert.ok(loginSrc.includes("q.charAt(1) !== '/'"), 'protocol-relative URLs rejected');
});

test('Vaani logout still uses backend logout endpoint', () => {
  assert.ok(vaaniSrc.includes("fetch('/api/auth/logout', { method: 'POST' })"),
    'logout posts to backend endpoint');
});

test('old RapidX login and auth remain intact', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'app.html')), 'app.html intact');
  assert.ok(serverSrc.includes('async function apiLogin(req, res, body)'), 'apiLogin intact');
  assert.ok(serverSrc.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"),
    'legacy login route intact');
});
