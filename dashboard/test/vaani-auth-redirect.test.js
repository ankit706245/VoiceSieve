'use strict';
// Vaani auth-redirect tests. Static read-only checks that the CRM routes are
// gated and that the login page returns to a safe local destination.
// No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const vaaniSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'vaani-sales.html'), 'utf8');
const loginSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'braivex-login.html'), 'utf8');

test('unauthenticated CRM routes redirect to the Braivex login', () => {
  assert.ok(serverSrc.includes("const isCrm = /^\\/(app|vaani-sales|sales)"),
    'CRM gate covers app and vaani-sales aliases');
  assert.ok(serverSrc.includes('Location: `/braivex-login.html?redirect=${target}`'),
    'gate redirects to braivex-login with the requested target');
  assert.ok(serverSrc.includes("route.startsWith('/app') ? '/app.html' : '/vaani-sales.html'"),
    'target maps to a canonical CRM URL');
});

test('login returns to the CRM by default', () => {
  assert.ok(loginSrc.includes("DASHBOARD_URL = '/app.html'"), 'default destination is /app.html');
  assert.ok(!loginSrc.includes('access_token='), 'no token appended to the redirect URL');
  assert.ok(loginSrc.includes("fetch('/api/auth/session'"), 'email-link token is exchanged for the cookie');
  assert.ok(loginSrc.includes('window.location.hash.slice(1)'), 'email link token read from the URL hash');
});

test('session expiry returns to the login form', () => {
  assert.ok(vaaniSrc.includes("'/braivex-login.html?redirect=' + encodeURIComponent(target) + '&fresh=1'"),
    'expiry URL carries redirect and fresh=1');
  assert.ok(vaaniSrc.includes('function loginUrl()'), 'single helper builds the login URL');
});

test('external redirect URLs are rejected', () => {
  assert.ok(loginSrc.includes("q.charAt(0) === '/'"), 'redirect must be a local path');
  assert.ok(loginSrc.includes("q.charAt(1) !== '/'"), 'protocol-relative URLs rejected');
  assert.ok(loginSrc.includes("q.charAt(1) !== '\\\\'"), 'backslash redirects rejected');
});

test('Vaani logout clears the cookie session and leaves the CRM', () => {
  assert.ok(vaaniSrc.includes("fetch('/api/auth/logout', { method: 'POST' })"),
    'logout posts to backend endpoint');
  assert.ok(vaaniSrc.includes("window.location.href = '/braivex-login.html'"),
    'logout returns to the login page');
});

test('app.html no longer loads the old RapidX console', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.ok(!appSrc.includes('/assets/app.js'), 'no RapidX SPA bundle');
  assert.ok(appSrc.includes("window.location.replace('/vaani-sales.html' + window.location.search)"),
    'static fallback opens the Vaani CRM and preserves the access token');
  assert.ok(!appSrc.includes('http-equiv="refresh"'), 'meta refresh would drop the access token');
});

test('login session survives the app.html hop and a CRM refresh without web storage', () => {
  assert.ok(!loginSrc.includes('sessionStorage'), 'login does not store the token');
  assert.ok(!vaaniSrc.includes('sessionStorage'), 'CRM does not store the token');
  assert.ok(vaaniSrc.includes("credentials: 'same-origin'"), 'CRM sends the HttpOnly cookie');
  assert.ok(serverSrc.includes('HttpOnly'), 'session cookie is HttpOnly');
});
