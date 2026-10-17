'use strict';
// Customer logins for the website's My account page: an admin makes the login (generated password, shown once),
// the customer must choose their own password first, then sees only their own licences, computers and classes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const licences = require('../admin/lib/licence');
const { generatePassword } = require('../admin/lib/accounts');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acct-')) });
  const base = await listen(app.server);
  const addCustomer = (email, name) => app.db.prepare("INSERT INTO customers (email, name, organisation, created_at) VALUES (?, ?, 'Green School', datetime('now'))").run(email, name).lastInsertRowid;
  const asha = addCustomer('asha@example.com', 'Asha');
  const ravi = addCustomer('ravi@example.com', 'Ravi');
  for (const [mail, role] of [['boss@example.com', 'owner'], ['help@example.com', 'support']]) {
    app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(mail, mail, role, hashPassword('correct-horse-battery'));
  }
  const admin = async email => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, json: await res.json() };
    };
    await call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' });
    return { get: url => call('GET', url), post: (url, body) => call('POST', url, body) };
  };
  /** The website: Bearer token, from another origin. */
  const site = (token = null) => {
    const call = async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://shortlistprep.example', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json(), headers: res.headers };
    };
    return {
      login: async (email, password) => { const r = await call('POST', '/api/account/login', { email, password }); if (r.json.token) token = r.json.token; return r; },
      get: url => call('GET', url), post: (url, body) => call('POST', url, body),
    };
  };
  return { app, base, asha, ravi, admin, site, stop: () => app.close() };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('generated passwords are easy to type and different every time', () => {
  const a = generatePassword(), b = generatePassword();
  assert.match(a, /^[A-HJ-NP-Za-km-np-z2-9]{4}-[A-HJ-NP-Za-km-np-z2-9]{4}-[A-HJ-NP-Za-km-np-z2-9]{4}$/);
  assert.notEqual(a, b);
});

test('an admin creates the login; the customer must choose a password, then sees their account', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    assert.equal((await boss.get(`/admin/api/customers/${s.asha}/account`)).json.account.exists, false);
    const made = (await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'reset' })).json;
    assert.equal(made.email, 'asha@example.com');
    assert.equal(made.account.mustChange, true);
    assert.ok(!JSON.stringify(s.app.db.prepare('SELECT * FROM customer_accounts').all()).includes(made.password), 'only a hash is stored');

    const web = s.site();
    assert.equal((await web.login('asha@example.com', 'wrong-password')).status, 401);
    const signed = await web.login('ASHA@example.com', made.password);
    assert.equal(signed.status, 200);
    assert.equal(signed.json.mustChange, true);
    assert.equal(signed.headers.get('access-control-allow-origin'), '*');

    // nothing is shown until the password is changed
    const blocked = await web.get('/api/account/me');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.code, 'password_change');
    assert.equal((await web.post('/api/account/password', { current: made.password, next: 'short' })).status, 400);
    assert.equal((await web.post('/api/account/password', { current: 'nope', next: 'a-long-new-password' })).status, 400);
    assert.equal((await web.post('/api/account/password', { current: made.password, next: 'a-long-new-password' })).status, 200);

    const me = (await web.get('/api/account/me')).json;
    assert.equal(me.customer.email, 'asha@example.com');
    assert.equal(me.customer.organisation, 'Green School');
    assert.ok(me.account.lastLogin);
    // the old generated password no longer works, the new one does
    assert.equal((await s.site().login('asha@example.com', made.password)).status, 401);
    assert.equal((await s.site().login('asha@example.com', 'a-long-new-password')).status, 200);
  });
});

test('My account shows only this customer\'s licences, machines, orders, topics and classes', async () => {
  await withServer(async s => {
    const lic = licences.createLicence(s.app.db, { customerId: s.asha, plan: 'personal', days: 365 });
    licences.createLicence(s.app.db, { customerId: s.ravi, plan: 'personal', days: 365 });
    const deviceId = crypto.randomBytes(16).toString('hex');
    await fetch(s.base + '/api/licence/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: lic.key, deviceId, deviceName: 'CLASSROOM-PC', appVersion: '1.2.0' }) });
    s.app.db.prepare("INSERT INTO orders (customer_id, plan, amount_cents, currency, status, created_at) VALUES (?, 'personal', 9900, 'USD', 'paid', datetime('now'))").run(s.asha);
    s.app.db.prepare("INSERT INTO customer_profiles (customer_id, topics, resume_text, resume_name, updated_at) VALUES (?, '[\"Power Apps\"]', 'My resume', 'cv.pdf', datetime('now'))").run(s.asha);
    const conv = s.app.db.prepare(`INSERT INTO conversations (uid, licence_id, device_id, device_name, started_at, ended_at, duration_sec, question_count, transcript, created_at)
      VALUES ('abcdefgh-1', ?, ?, 'CLASSROOM-PC', '2026-10-16T09:00:00Z', '2026-10-16T09:40:00Z', 2400, 1, '[{"at":"2026-10-16T09:01:00Z","text":"What is a closure?"}]', datetime('now'))`).run(lic.id, deviceId).lastInsertRowid;
    s.app.db.prepare("INSERT INTO conversation_items (conversation_id, position, asked_at, question, answer, status) VALUES (?, 1, '2026-10-16T09:01:02Z', 'What is a closure?', 'A function that remembers.', 'done')").run(conv);

    const boss = await s.admin('boss@example.com');
    const made = (await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'reset' })).json;
    const web = s.site();
    await web.login('asha@example.com', made.password);
    await web.post('/api/account/password', { current: made.password, next: 'a-long-new-password' });

    const me = (await web.get('/api/account/me')).json;
    assert.deepEqual(me.licences.map(l => [l.key, l.status, l.devices.length]), [[lic.key, 'active', 1]]);
    assert.deepEqual(me.licences[0].devices[0], { ...me.licences[0].devices[0], name: 'CLASSROOM-PC', appVersion: '1.2.0', machineId: deviceId.slice(0, 8).toUpperCase() });
    assert.equal(me.orders.length, 1);
    assert.deepEqual(me.profile.topics, ['Power Apps']);
    assert.equal(me.profile.resumeName, 'cv.pdf');
    assert.equal(me.conversations.length, 1);
    assert.equal(me.conversations[0].first_question, 'What is a closure?');
    assert.ok(!JSON.stringify(me).includes(deviceId), 'the full computer id is not shown');

    const detail = (await web.get('/api/account/conversations/' + conv)).json;
    assert.equal(detail.items[0].answer, 'A function that remembers.');
    assert.equal(detail.conversation.transcript[0].text, 'What is a closure?');

    // Ravi cannot open Asha's class
    const raviLogin = (await boss.post(`/admin/api/customers/${s.ravi}/account`, { action: 'reset' })).json;
    const ravi = s.site();
    await ravi.login('ravi@example.com', raviLogin.password);
    await ravi.post('/api/account/password', { current: raviLogin.password, next: 'ravis-own-password' });
    assert.equal((await ravi.get('/api/account/conversations/' + conv)).status, 404);
    assert.equal((await ravi.get('/api/account/me')).json.conversations.length, 0);
  });
});

test('turning the login off or making a new password signs the customer out', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    const made = (await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'reset' })).json;
    const web = s.site();
    await web.login('asha@example.com', made.password);
    await web.post('/api/account/password', { current: made.password, next: 'a-long-new-password' });
    assert.equal((await web.get('/api/account/me')).status, 200);

    assert.equal((await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'disable' })).status, 200);
    assert.equal((await web.get('/api/account/me')).status, 401);
    assert.equal((await s.site().login('asha@example.com', 'a-long-new-password')).status, 401);
    await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'enable' });
    const again = s.site();
    assert.equal((await again.login('asha@example.com', 'a-long-new-password')).status, 200);

    await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'reset' });
    assert.equal((await again.get('/api/account/me')).status, 401);
  });
});

test('signing out ends the session; support staff cannot make logins; too many wrong passwords are blocked', async () => {
  await withServer(async s => {
    const help = await s.admin('help@example.com');
    assert.equal((await help.post(`/admin/api/customers/${s.asha}/account`, { action: 'reset' })).status, 403);
    assert.equal((await help.get(`/admin/api/customers/${s.asha}/account`)).status, 200);

    const boss = await s.admin('boss@example.com');
    const made = (await boss.post(`/admin/api/customers/${s.asha}/account`, { action: 'reset' })).json;
    const web = s.site();
    await web.login('asha@example.com', made.password);
    assert.equal((await web.post('/api/account/logout', {})).status, 200);
    assert.equal((await web.post('/api/account/password', { current: made.password, next: 'whatever-long' })).status, 401);

    const attacker = s.site();
    for (let i = 0; i < 8; i++) assert.equal((await attacker.login('asha@example.com', 'guess-' + i)).status, 401);
    assert.equal((await attacker.login('asha@example.com', made.password)).status, 429);
    assert.equal((await s.site().login('nobody@example.com', 'x')).status, 401);
  });
});
