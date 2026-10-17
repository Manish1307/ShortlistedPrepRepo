'use strict';
// AI keys: stored encrypted, managed in the admin dashboard, assigned per licence (or the default), and handed only
// to an active licence on an activated computer through /api/app/config.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const licences = require('../admin/lib/licence');
const { LicenceClient } = require('../src/licence/client');

const GROQ_A = 'gsk_' + 'a'.repeat(40) + 'AAAA';
const GROQ_B = 'gsk_' + 'b'.repeat(40) + 'BBBB';
const GEMINI = 'AIza' + 'g'.repeat(35) + 'GGGG';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function start() {
  const dataDir = tmp('cc-aikeys-');
  const app = createApp({ dataDir });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const addAdmin = (email, role) => app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(email, email, role, hashPassword('correct-horse-battery'));
  const client = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'admin' };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b || {}), del: u => call('DELETE', u),
      login: email => call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' }) };
  };
  const licence = (email = 'teacher@example.com') => {
    const c = app.db.prepare('INSERT INTO customers (email, created_at) VALUES (?, datetime(\'now\'))').run(email).lastInsertRowid;
    return licences.createLicence(app.db, { customerId: c, plan: 'personal', days: 365 });
  };
  const appConfig = (key, deviceId) => fetch(base + '/api/app/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, deviceId }) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  const activate = (key, deviceId) => fetch(base + '/api/licence/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, deviceId }) });
  return { app, base, dataDir, client, addAdmin, licence, appConfig, activate, stop: () => app.close() };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('keys are stored encrypted, shown masked, and the first key of a service becomes its default', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const c = s.client();
    await c.login('boss@example.com');
    assert.equal((await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Main', key: GROQ_A })).status, 201);
    assert.equal((await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Spare', key: GROQ_B })).status, 201);
    assert.equal((await c.post('/admin/api/ai-keys', { provider: 'gemini', label: 'Images', key: GEMINI })).status, 201);

    const { keys } = (await c.get('/admin/api/ai-keys')).json;
    const text = JSON.stringify(keys);
    assert.ok(!text.includes(GROQ_A) && !text.includes(GEMINI), 'the dashboard never receives a key');
    assert.deepEqual(keys.map(k => [k.label, k.masked, k.is_default]), [['Main', '••••AAAA', 1], ['Spare', '••••BBBB', 0], ['Images', '••••GGGG', 1]]);

    const stored = JSON.stringify(s.app.db.prepare('SELECT * FROM api_keys').all());
    assert.ok(!stored.includes(GROQ_A) && !stored.includes(GEMINI), 'the database holds only encrypted keys');

    const spare = keys.find(k => k.label === 'Spare');
    await c.patch(`/admin/api/ai-keys/${spare.id}`, { action: 'default' });
    const after = (await c.get('/admin/api/ai-keys')).json.keys.filter(k => k.provider === 'groq' && k.is_default);
    assert.deepEqual(after.map(k => k.label), ['Spare'], 'one default per service');

    assert.equal((await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Bad', key: 'not-a-key' })).status, 400);
    assert.equal((await c.post('/admin/api/ai-keys', { provider: 'openai', label: 'X', key: GROQ_A })).status, 400);
  });
});

test('support can see keys (masked) but not add, change or assign them', async () => {
  await withServer(async s => {
    s.addAdmin('help@example.com', 'support');
    const c = s.client();
    await c.login('help@example.com');
    assert.equal((await c.get('/admin/api/ai-keys')).status, 200);
    assert.equal((await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Main', key: GROQ_A })).status, 403);
    const lic = s.licence();
    assert.equal((await c.post(`/admin/api/licences/${lic.id}/ai-keys`, { provider: 'groq', apiKeyId: null })).status, 403);
  });
});

test('the app gets the default keys, a licence can have its own key, and a key turned off falls back to the default', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const c = s.client();
    await c.login('boss@example.com');
    const a = (await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Main', key: GROQ_A })).json.key;
    const b = (await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Own', key: GROQ_B })).json.key;
    await c.post('/admin/api/ai-keys', { provider: 'gemini', label: 'Images', key: GEMINI });
    const lic = s.licence();
    const device = crypto.randomBytes(16).toString('hex');

    // not activated on this computer yet: no keys
    const before = await s.appConfig(lic.key, device);
    assert.equal(before.status, 403);
    assert.equal(before.json.ai, undefined);

    await s.activate(lic.key, device);
    let res = await s.appConfig(lic.key, device);
    assert.equal(res.status, 200);
    assert.ok(licences.verifySigned(s.app.signer.publicKeyPem, res.json), 'the licence part is signed as usual');
    assert.deepEqual([res.json.ai.groq.apiKey, res.json.ai.groq.source, res.json.ai.gemini.apiKey], [GROQ_A, 'default', GEMINI]);

    // its own Groq key
    const assigned = await c.post(`/admin/api/licences/${lic.id}/ai-keys`, { provider: 'groq', apiKeyId: b.id });
    assert.equal(assigned.json.aiKeys.groq.source, 'assigned');
    res = await s.appConfig(lic.key, device);
    assert.deepEqual([res.json.ai.groq.apiKey, res.json.ai.groq.source], [GROQ_B, 'assigned']);

    // a Gemini key cannot be given as the Groq key
    const gem = (await c.get('/admin/api/ai-keys')).json.keys.find(k => k.provider === 'gemini');
    assert.equal((await c.post(`/admin/api/licences/${lic.id}/ai-keys`, { provider: 'groq', apiKeyId: gem.id })).status, 400);

    // its own key turned off: the default is used
    await c.patch(`/admin/api/ai-keys/${b.id}`, { action: 'disable' });
    res = await s.appConfig(lic.key, device);
    assert.deepEqual([res.json.ai.groq.apiKey, res.json.ai.groq.source], [GROQ_A, 'default']);
    const detail = (await c.get(`/admin/api/licences/${lic.id}`)).json.aiKeys.groq;
    assert.equal(detail.assignedDisabled, true);

    // replaced key: the app gets the new one; deleted assigned key: back to the default
    await c.patch(`/admin/api/ai-keys/${a.id}`, { action: 'replace', key: GROQ_B });
    assert.equal((await s.appConfig(lic.key, device)).json.ai.groq.apiKey, GROQ_B);
    await c.del(`/admin/api/ai-keys/${b.id}`);
    assert.equal((await c.get(`/admin/api/licences/${lic.id}`)).json.aiKeys.groq.assignedId, null);

    // last used is recorded; changes are in the audit log
    assert.ok((await c.get('/admin/api/ai-keys')).json.keys.find(k => k.id === a.id).last_used_at);
    const actions = (await c.get('/admin/api/audit')).json.entries.map(e => e.action);
    for (const a2 of ['aikey.added', 'aikey.disable', 'aikey.replace', 'aikey.deleted', 'licence.aikey']) assert.ok(actions.includes(a2), a2);

    // a cancelled licence gets no keys
    await c.patch(`/admin/api/licences/${lic.id}`, { action: 'revoke' });
    const revoked = await s.appConfig(lic.key, device);
    assert.equal(revoked.status, 403);
    assert.equal(revoked.json.ai, undefined);
  });
});

test('the app client returns the keys without saving them on the computer', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const c = s.client();
    await c.login('boss@example.com');
    await c.post('/admin/api/ai-keys', { provider: 'groq', label: 'Main', key: GROQ_A });
    const lic = s.licence();
    const dir = tmp('cc-aikeys-app-');
    const app = new LicenceClient({ serverUrl: s.base, publicKeyPem: s.app.signer.publicKeyPem, dir, deviceId: crypto.randomBytes(16).toString('hex') });

    assert.deepEqual((await app.appConfig()).ai, {}, 'no licence yet: no keys');
    assert.equal((await app.activate(lic.key)).ok, true);
    const cfg = await app.appConfig();
    assert.equal(cfg.status.state, 'active');
    assert.equal(cfg.ai.groq.apiKey, GROQ_A);
    assert.equal(cfg.ai.gemini, undefined, 'no Gemini key set up: none sent');
    for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(GROQ_A), `${f} must not contain the key`);

    // an older server without /api/app/config: the licence keeps working, no keys
    const old = new LicenceClient({ serverUrl: s.base, publicKeyPem: s.app.signer.publicKeyPem, dir, deviceId: app.deviceId,
      fetchImpl: (url, o) => (url.endsWith('/api/app/config') ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404 })) : fetch(url, o)) });
    const fallback = await old.appConfig();
    assert.deepEqual([fallback.status.state, fallback.ai], ['active', {}]);
  });
});
