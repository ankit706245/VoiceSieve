'use strict';
// Braivex login UI tests. Static read-only checks against the login page and
// the cookie-based auth routes it uses. No network, no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '..', 'public', 'braivex-login.html');
const src = fs.readFileSync(pagePath, 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('login page contains Braivex branding and both auth modes', () => {
  assert.ok(src.includes('BRAIVEX'), 'BRAIVEX brand present');
  assert.ok(src.includes('Vaani CRM'), 'Vaani product name present');
  assert.ok(/<input[^>]*type="email"/i.test(src), 'email input present');
  assert.ok(/<input[^>]*type="password"/i.test(src), 'password input present');
  assert.ok(/<button[^>]*type="submit"/i.test(src), 'submit button present');
  assert.ok(src.includes('Create account'), 'signup tab present');
});

test('login page does not contain RapidX branding', () => {
  assert.ok(!/rapidx/i.test(src), 'no RapidX references');
  assert.ok(!/Agency OS/i.test(src), 'no Agency OS wording');
});

test('login form uses the implemented local auth routes', () => {
  assert.ok(src.includes("LOGIN_ROUTE = '/api/auth/login'"), 'posts to /api/auth/login');
  assert.ok(src.includes("SIGNUP_ROUTE = '/api/auth/signup'"), 'signup posts to /api/auth/signup');
  assert.ok(!src.includes('/api/auth/braivex/login'), 'no dead bridge route');
  assert.ok(serverSrc.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"),
    'server implements the login route');
  assert.ok(serverSrc.includes("if (route === '/api/auth/signup') return apiSignup(req, res, body);"),
    'server implements the signup route');
});

test('successful auth lands on the CRM with a safe local redirect', () => {
  assert.ok(src.includes("DASHBOARD_URL = '/app.html'"), 'default destination is the CRM');
  assert.ok(src.includes("q.charAt(0) === '/'"), 'redirect must be a local path');
  assert.ok(src.includes("q.charAt(1) !== '/'"), 'protocol-relative URLs rejected');
  assert.ok(src.includes("q.charAt(1) !== '\\\\'"), 'backslash redirects rejected');
});

test('failed login shows a generic error without internals', () => {
  assert.ok(src.includes('Invalid email or password.'), 'generic error shown');
  assert.ok(!src.includes('access_token = '), 'no hardcoded token value in page');
  assert.ok(!/supabase.+error/i.test(src), 'no Supabase internals in error path');
});

test('password and token are never persisted to web storage', () => {
  const codeOnly = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!codeOnly.includes('localStorage'), 'no localStorage usage');
  assert.ok(!codeOnly.includes('sessionStorage'), 'no sessionStorage usage');
  assert.ok(!codeOnly.includes('setItem'), 'nothing is persisted');
});
