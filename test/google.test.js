'use strict';
// "Sign in with Google": the ID token check (a test key stands in for Google's) and the website sign-up / sign-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { makeVerifier } = require('../admin/lib/googleauth');
const auth = require('../admin/lib/auth');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/** A Google-style ID token signed with the test key. */
function token(claims = {}, { header = {}, key = privateKey } = {}) {
  const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const p = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234', email: 'neha@example.com', email_verified: true, name: 'Neha Sharma', exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const verifier = (extra = {}) => makeVerifier({ clientId: CLIENT_ID, fetchKeys: async () => ({ keys: [jwk] }), ...extra });
const rejects = async (promise, status) => assert.rejects(promise, err => err.status === status, `expected status ${status}`);

test('a correctly signed token gives the verified email and name', async () => {
  const g = await verifier()(token({ email: 'Neha@Example.com' }));
  assert.deepEqual(g, { sub: '1234', email: 'neha@example.com', name: 'Neha Sharma' });
});

test('tokens that are forged, for another app, expired or unverified are refused', async () => {
  const v = verifier();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await rejects(v(token({}, { key: other })), 401);                                  // signed with another key
  await rejects(v(token({ aud: 'someone-else.apps.googleusercontent.com' })), 401);  // made for another app
  await rejects(v(token({ iss: 'https://evil.example' })), 401);
  await rejects(v(token({ exp: Math.floor(Date.now() / 1000) - 3600 })), 401);       // expired
  await rejects(v(token({ email_verified: false })), 403);
  await rejects(v(token({}, { header: { alg: 'none' } })), 401);                     // no signature check asked for
  await rejects(v(token({}, { header: { kid: 'unknown' } })), 401);
  await rejects(v('not.a.token'), 400);
  await rejects(v(''), 400);
});

test('a verifier without a client ID refuses everything, and Google being down is a clear error', async () => {
  await rejects(makeVerifier({ clientId: '' })(token()), 503);
  await rejects(verifier({ fetchKeys: async () => { throw new Error('offline'); } })(token()), 503);
});

test('the keys are fetched once and kept', async () => {
  let fetched = 0;
  const v = verifier({ fetchKeys: async () => { fetched++; return { keys: [jwk] }; } });
  await v(token()); await v(token());
  assert.equal(fetched, 1);
});

// ---------- the website's endpoints ----------

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function withServer(options, fn) {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-google-')), ...options });
  const base = await listen(app.server);
  const call = async (method, url, body, bearer) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://shortlistprep.example', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try { await fn({ app, call }); } finally { await app.close(); }
}
const configured = { googleClientId: CLIENT_ID, googleVerify: verifier() };

test('the website asks whether Google sign-in is turned on', async () => {
  await withServer({}, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/account/google/config')).json, { enabled: false, clientId: '' });
    assert.equal((await call('POST', '/api/account/google', { credential: token(), terms: true })).status, 503);
  });
  await withServer(configured, async ({ call }) => {
    assert.deepEqual((await call('GET', '/api/account/google/config')).json, { enabled: true, clientId: CLIENT_ID });
  });
});

test('a new person gets a free account and licence, and is signed in', async () => {
  await withServer(configured, async ({ app, call }) => {
    const r = await call('POST', '/api/account/google', { credential: token(), terms: true });
    assert.equal(r.status, 201);
    assert.equal(r.json.created, true);
    assert.equal(r.json.customer.email, 'neha@example.com');
    const me = await call('GET', '/api/account/me', null, r.json.token);
    assert.equal(me.status, 200);
    assert.equal(me.json.customer.name, 'Neha Sharma');
    assert.equal(me.json.licences.length, 1);
    // nobody can sign in with a password for it
    assert.equal((await call('POST', '/api/account/login', { email: 'neha@example.com', password: 'anything-at-all-123' })).status, 401);
    assert.equal(app.db.prepare("SELECT created_by FROM customer_accounts").get().created_by, 'google');
  });
});

test('a new account needs the terms accepted, and nothing is created without it', async () => {
  await withServer(configured, async ({ app, call }) => {
    const r = await call('POST', '/api/account/google', { credential: token() });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'terms');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
  });
});

test('signing in again uses the same account, with no second licence', async () => {
  await withServer(configured, async ({ app, call }) => {
    await call('POST', '/api/account/google', { credential: token(), terms: true });
    const again = await call('POST', '/api/account/google', { credential: token() });   // terms are not asked again
    assert.equal(again.status, 200);
    assert.equal(again.json.created, false);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM licences').get().n, 1);
  });
});

test('Google signs in to the password account for the same email, and keeps its data', async () => {
  await withServer(configured, async ({ app, call }) => {
    const signup = await call('POST', '/api/account/signup', { name: 'Neha', email: 'neha@example.com', password: 'a-long-password-1', terms: true });
    assert.equal(signup.status, 201);
    const r = await call('POST', '/api/account/google', { credential: token() });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, false);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
    // the password still works
    assert.equal((await call('POST', '/api/account/login', { email: 'neha@example.com', password: 'a-long-password-1' })).status, 200);
  });
});

test('a customer from the app with no login can claim it with a verified Google email', async () => {
  await withServer(configured, async ({ app, call }) => {
    app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('neha@example.com', 'Neha', datetime('now'))").run();
    const r = await call('POST', '/api/account/google', { credential: token(), terms: true });
    assert.equal(r.status, 201);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  });
});

test('a generated login that was never used stops working once Google signs in', async () => {
  await withServer(configured, async ({ app, call }) => {
    const id = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('neha@example.com', 'Neha', datetime('now'))").run().lastInsertRowid;
    app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, disabled, created_at, created_by, password_set_at) VALUES (?,?,1,0,datetime('now'),'admin',datetime('now'))")
      .run(id, auth.hashPassword('Kp7m-Qx3r-Tn9w'));
    const r = await call('POST', '/api/account/google', { credential: token() });
    assert.equal(r.status, 200);
    assert.equal(r.json.mustChange, false);
    assert.equal((await call('GET', '/api/account/me', null, r.json.token)).status, 200);
    assert.equal((await call('POST', '/api/account/login', { email: 'neha@example.com', password: 'Kp7m-Qx3r-Tn9w' })).status, 401);
  });
});

test('a turned-off account stays turned off, and a bad token is refused', async () => {
  await withServer(configured, async ({ app, call }) => {
    await call('POST', '/api/account/google', { credential: token(), terms: true });
    app.db.prepare('UPDATE customer_accounts SET disabled = 1').run();
    assert.equal((await call('POST', '/api/account/google', { credential: token() })).status, 403);
    assert.equal((await call('POST', '/api/account/google', { credential: 'garbage' })).status, 400);
    assert.equal((await call('POST', '/api/account/google', { credential: token({ aud: 'other' }) })).status, 401);
  });
});
