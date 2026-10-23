'use strict';
// Free sign-up on the website, then counted downloads: the Download page is public, the file link needs an account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dl-')) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, token, extra = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://shortlistprep.example', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const admin = async () => {
    app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run('boss@example.com', 'Boss', 'owner', hashPassword('correct-horse-battery'));
    let cookie = '';
    const a = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, json: await res.json() };
    };
    await a('POST', '/admin/api/login', { email: 'boss@example.com', password: 'correct-horse-battery' });
    return a;
  };
  return { app, call, admin, stop: () => app.close() };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }
const form = (over = {}) => ({ name: 'Neha', email: 'Neha@Example.com', password: 'a-long-password', terms: true, ...over });

test('sign-up makes a free account, a free licence that never expires, and signs the person in', async () => {
  await withServer(async s => {
    const r = await s.call('POST', '/api/account/signup', form());
    assert.equal(r.status, 201);
    assert.ok(r.json.token);
    const me = await s.call('GET', '/api/account/me', undefined, r.json.token);
    assert.equal(me.status, 200);
    assert.equal(me.json.customer.email, 'neha@example.com');
    assert.equal(me.json.licences.length, 1);
    assert.equal(me.json.licences[0].status, 'active');
    assert.equal(me.json.licences[0].expiresAt, null);
    // the password works for a normal sign-in too, and no forced password change
    const login = await s.call('POST', '/api/account/login', { email: 'neha@example.com', password: 'a-long-password' });
    assert.equal(login.status, 200);
    assert.equal(login.json.mustChange, false);
  });
});

test('sign-up refuses a bad form and an email that already has a record', async () => {
  await withServer(async s => {
    assert.equal((await s.call('POST', '/api/account/signup', form({ password: 'short' }))).status, 400);
    assert.equal((await s.call('POST', '/api/account/signup', form({ terms: false }))).status, 400);
    assert.equal((await s.call('POST', '/api/account/signup', form({ email: 'nope' }))).status, 400);
    assert.equal((await s.call('POST', '/api/account/signup', form())).status, 201);
    const again = await s.call('POST', '/api/account/signup', form({ password: 'another-long-one' }));
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'exists');
    // an email that only has a trial licence from the app cannot be claimed either
    s.app.db.prepare("INSERT INTO customers (email, created_at) VALUES ('trial@example.com', datetime('now'))").run();
    assert.equal((await s.call('POST', '/api/account/signup', form({ email: 'trial@example.com' }))).status, 409);
  });
});

test('the download list is public and never shows the link', async () => {
  await withServer(async s => {
    const before = await s.call('GET', '/api/downloads');
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.tools.map(t => t.id), ['shortlistprep-ai', 'mock-interview']);
    assert.ok(before.json.tools.every(t => t.available === true && t.version === '1.1.3'));   // the GitHub release is built in
    const a = await s.admin();
    const set = await a('POST', '/admin/api/downloads/shortlistprep-ai', { version: '1.0.0', url: 'https://github.com/o/r/releases/download/v1.0.0/ShortlistPrep-Setup-1.0.0.exe', sizeMb: 180 });
    assert.equal(set.status, 200);
    const after = await s.call('GET', '/api/downloads');
    const t = after.json.tools.find(x => x.id === 'shortlistprep-ai');
    assert.equal(t.available, true);
    assert.equal(t.version, '1.0.0');
    assert.ok(!JSON.stringify(after.json).includes('github.com'));
    assert.equal((await a('POST', '/admin/api/downloads/shortlistprep-ai', { version: '1.0.0', url: 'http://insecure.example/x.exe' })).status, 400);
    assert.equal((await a('POST', '/admin/api/downloads/nope', { version: '1.0.0', url: 'https://x.example/y' })).status, 404);
  });
});

test('starting a download needs an account, is counted, and returns the link', async () => {
  await withServer(async s => {
    const a = await s.admin();
    await a('POST', '/admin/api/downloads/shortlistprep-ai', { version: '1.0.0', url: 'https://github.com/o/r/releases/download/v1.0.0/a.exe', sizeMb: 180 });
    const anon = await s.call('POST', '/api/downloads/shortlistprep-ai/start', {});
    assert.equal(anon.status, 401);
    assert.equal(anon.json.code, 'signin');

    const { json: { token } } = await s.call('POST', '/api/account/signup', form());
    const ok = await s.call('POST', '/api/downloads/shortlistprep-ai/start', {}, token);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.url, 'https://github.com/o/r/releases/download/v1.0.0/a.exe');
    await s.call('POST', '/api/downloads/shortlistprep-ai/start', {}, token);

    assert.match((await s.call('POST', '/api/downloads/mock-interview/start', {}, token)).json.url, /ShortlistPrep-Interview-Setup-1.1.3.exe$/);   // the built-in release link
    assert.equal((await s.call('POST', '/api/downloads/nope/start', {}, token)).status, 404);

    const stats = (await a('GET', '/admin/api/downloads')).json.tools.find(t => t.id === 'shortlistprep-ai');
    assert.equal(stats.total, 2);      // not counted: the unauthenticated and not-ready attempts
    assert.equal(stats.people, 1);
    assert.equal(stats.last30, 2);
    assert.deepEqual(stats.byVersion, [{ version: '1.0.0', n: 2 }]);
  });
});
