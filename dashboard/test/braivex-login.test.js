'use strict';
// BRAIVEX login UI tests. Static read-only checks against the new login
// page plus regression guards for the existing auth stack. No network,
// no database, no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '..', 'public', 'braivex-login.html');
const src = fs.readFileSync(pagePath, 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('login page contains BRAIVEX branding', () => {
  assert.ok(src.includes('BRAIVEX'), 'BRAIVEX brand present');
  assert.ok(src.includes('VAANI'), 'VAANI product name present');
  assert.ok(/<input[^>]*type="email"/i.test(src), 'email input present');
  assert.ok(/<input[^>]*type="password"/i.test(src), 'password input present');
  assert.ok(/<button[^>]*type="submit"/i.test(src), 'login button present');
});

test('login page does not contain RapidX branding', () => {
  assert.ok(!/rapidx/i.test(src), 'no RapidX references');
  assert.ok(!/AI Sales Agent/i.test(src), 'no old agent wording');
  assert.ok(!/Agency OS/i.test(src), 'no Agency OS wording');
});

test('login form submits to the BRAIVEX bridge endpoint', () => {
  assert.ok(src.includes('/api/auth/braivex/login'), 'posts to bridge route');
  assert.ok(!src.includes('/api/auth/login"') || src.includes('/api/auth/braivex/login'),
    'does not use the legacy login route');
});

test('successful login redirects to the Vaani dashboard', () => {
  assert.ok(src.includes('/vaani-sales.html'), 'redirects to vaani-sales');
});

test('failed login shows a generic error without internals', () => {
  assert.ok(src.includes('Invalid email or password.'), 'generic error shown');
  assert.ok(!src.includes('access_token'), 'no token leakage in page');
  assert.ok(!/supabase.+error/i.test(src.replace('Sign in with your BRAIVEX account', '')),
    'no Supabase internals in error path');
});

test('password is never persisted to web storage', () => {
  const codeOnly = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!codeOnly.includes('localStorage'), 'no localStorage usage');
  assert.ok(!codeOnly.includes('sessionStorage'), 'no sessionStorage usage');
});

test('old RapidX auth and UI remain available as rollback', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'app.html')), 'app.html intact');
  assert.ok(serverSrc.includes('async function apiLogin(req, res, body)'), 'apiLogin intact');
  assert.ok(serverSrc.includes("if (route === '/api/auth/login') return apiLogin(req, res, body);"),
    'legacy login route intact');
  assert.ok(serverSrc.includes("if (route === '/api/auth/braivex/login') return apiBraivexLogin(req, res, body);"),
    'bridge route intact');
});
