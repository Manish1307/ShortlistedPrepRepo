'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const { verifySigned, generateKey, effectiveStatus } = require('../admin/lib/licence');
const { compareVersions } = require('../admin/lib/routes');

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-admin-'));
  const app = createApp({ dataDir });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const addAdmin = (email, role, password = 'correct-horse-battery') =>
    app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(email, email, role, hashPassword(password));

  /** A tiny client that keeps its own cookie, like one browser. */
  const client = () => {
    let cookie = '';
    const call = async (method, url, body, { csrf = true } = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['X-Requested-With'] = 'admin';
      const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch (_) { json = text; }
      return { status: res.status, json, headers: res.headers };
    };
    return {
      get: (u, o) => call('GET', u, undefined, o), post: (u, b, o) => call('POST', u, b, o),
      patch: (u, b, o) => call('PATCH', u, b, o), del: (u, o) => call('DELETE', u, undefined, o),
      login: async (email, password = 'correct-horse-battery') => call('POST', '/admin/api/login', { email, password }),
    };
  };
  return { app, base, client, addAdmin, stop: () => app.close() };
}

async function withServer(fn) {
  const s = await start();
  try { await fn(s); } finally { await s.stop(); }
}

test('sign-in: wrong password fails, right one works, and the page needs it', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const c = s.client();
    assert.equal((await c.get('/admin/api/overview')).status, 401);
    assert.equal((await c.login('boss@example.com', 'wrong-password')).status, 401);
    assert.equal((await c.login('nobody@example.com')).status, 401);
    const ok = await c.login('boss@example.com');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await c.get('/admin/api/overview')).status, 200);
    await c.post('/admin/api/logout', {});
    assert.equal((await c.get('/admin/api/overview')).status, 401);
  });
});

test('too many wrong passwords lock the sign-in for a while', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const c = s.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.login('boss@example.com', 'nope-nope-nope')).status, 401);
    assert.equal((await c.login('boss@example.com')).status, 429, 'even the right password is refused while locked');
  });
});

test('changes without the same-site header are refused (cross-site request protection)', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const c = s.client();
    await c.login('boss@example.com');
    const res = await c.post('/admin/api/customers', { email: 'a@b.co' }, { csrf: false });
    assert.equal(res.status, 403);
  });
});

test('roles: support can read and answer messages but not create licences or manage the team', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    s.addAdmin('help@example.com', 'support');
    const boss = s.client(); await boss.login('boss@example.com');
    const cust = (await boss.post('/admin/api/customers', { email: 'teacher@school.org', name: 'T' })).json.customer;
    const lic = (await boss.post('/admin/api/licences', { customerId: cust.id, plan: 'personal' })).json.licence;

    const help = s.client(); await help.login('help@example.com');
    assert.equal((await help.get('/admin/api/customers')).status, 200);
    assert.equal((await help.post('/admin/api/licences', { customerId: cust.id, plan: 'personal' })).status, 403);
    assert.equal((await help.patch(`/admin/api/licences/${lic.id}`, { action: 'revoke' })).status, 403);
    assert.equal((await help.patch(`/admin/api/licences/${lic.id}`, { action: 'extend', days: 30 })).status, 200);
    assert.equal((await help.get('/admin/api/team')).status, 403);
    assert.equal((await help.post('/admin/api/orders', { customerId: cust.id, plan: 'personal', amountCents: 900 })).status, 403);
  });
});

test('licence flow: activate, same computer again, device limit, revoke, expiry', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    const cust = (await boss.post('/admin/api/customers', { email: 'teacher@school.org' })).json.customer;
    const lic = (await boss.post('/admin/api/licences', { customerId: cust.id, plan: 'personal', days: 30 })).json.licence;
    assert.match(lic.key, /^CC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(lic.max_devices, 2);

    const app = s.client();
    const activate = (deviceId, key = lic.key) => app.post('/api/licence/activate', { key, deviceId, deviceName: 'PC', appVersion: '0.1.0' }, { csrf: false });
    const first = await activate('device-1');
    assert.equal(first.status, 200);
    assert.equal(first.json.plan, 'personal');
    assert.ok(verifySigned(s.app.signer.publicKeyPem, first.json), 'the answer carries a valid signature');
    assert.equal(JSON.parse(first.json.payload).deviceId, 'device-1');

    assert.equal((await activate('device-1')).status, 200, 'the same computer can activate again');
    assert.equal((await activate('device-2')).status, 200);
    const third = await activate('device-3');
    assert.equal(third.status, 403);
    assert.equal(third.json.code, 'device_limit');

    const validate = d => app.post('/api/licence/validate', { key: lic.key, deviceId: d }, { csrf: false });
    assert.equal((await validate('device-1')).status, 200);
    assert.equal((await validate('device-9')).json.code, 'not_activated', 'validate never adds a new computer');
    assert.equal((await activate('x', 'CC-AAAA-BBBB-CCCC')).json.code, 'invalid_key');
    assert.equal((await activate('x', 'garbage')).json.code, 'invalid_key');

    // free a computer and the third can join
    assert.equal((await boss.patch(`/admin/api/licences/${lic.id}`, { action: 'resetDevices' })).status, 200);
    assert.equal((await activate('device-3')).status, 200);

    // revoke
    await boss.patch(`/admin/api/licences/${lic.id}`, { action: 'revoke' });
    assert.equal((await validate('device-3')).json.code, 'revoked');
    await boss.patch(`/admin/api/licences/${lic.id}`, { action: 'reinstate' });
    assert.equal((await validate('device-3')).status, 200);

    // expiry
    s.app.db.prepare('UPDATE licences SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), lic.id);
    assert.equal((await validate('device-3')).json.code, 'expired');
    // extending an expired licence counts from today, not from the old date
    const ext = (await boss.patch(`/admin/api/licences/${lic.id}`, { action: 'extend', days: 10 })).json.licence;
    const days = (new Date(ext.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 9.9 && days < 10.1, `extended from now, got ${days}`);
    assert.equal((await validate('device-3')).status, 200);
  });
});

test('a tampered answer fails signature checking', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    const cust = (await boss.post('/admin/api/customers', { email: 't@x.org' })).json.customer;
    const lic = (await boss.post('/admin/api/licences', { customerId: cust.id, plan: 'trial' })).json.licence;
    const answer = (await s.client().post('/api/licence/activate', { key: lic.key, deviceId: 'd' }, { csrf: false })).json;
    assert.ok(verifySigned(s.app.signer.publicKeyPem, answer));
    const forged = { ...answer, payload: answer.payload.replace('trial', 'schools') };
    assert.equal(verifySigned(s.app.signer.publicKeyPem, forged), false);
  });
});

test('orders: paid order can issue a licence; refund can revoke it', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    const cust = (await boss.post('/admin/api/customers', { email: 'teacher@school.org' })).json.customer;
    const made = await boss.post('/admin/api/orders', { customerId: cust.id, plan: 'personal', amountCents: 900, currency: 'usd', issueLicence: true });
    assert.equal(made.status, 201);
    assert.equal(made.json.order.currency, 'USD');
    assert.ok(made.json.licence.key);
    assert.equal(made.json.licence.order_id, made.json.order.id);
    assert.equal((await boss.post('/admin/api/orders', { customerId: cust.id, plan: 'trial', amountCents: 0 })).status, 400);
    assert.equal((await boss.post('/admin/api/orders', { customerId: cust.id, plan: 'personal', amountCents: -5 })).status, 400);

    const refund = await boss.post(`/admin/api/orders/${made.json.order.id}/refund`, { revokeLicences: true });
    assert.equal(refund.json.order.status, 'refunded');
    const detail = (await boss.get(`/admin/api/customers/${cust.id}`)).json;
    assert.equal(detail.licences[0].effective_status, 'revoked');
    assert.equal((await boss.post(`/admin/api/orders/${made.json.order.id}/refund`, {})).status, 400, 'cannot refund twice');

    const overview = (await boss.get('/admin/api/overview')).json;
    assert.equal(overview.customers, 1);
    assert.equal(overview.licences.revoked, 1);
    assert.deepEqual(overview.refundedTotal, [{ currency: 'USD', cents: 900 }]);
  });
});

test('trial to paid conversion is counted', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    const a = (await boss.post('/admin/api/customers', { email: 'a@x.org' })).json.customer;
    const b = (await boss.post('/admin/api/customers', { email: 'b@x.org' })).json.customer;
    for (const c of [a, b]) await boss.post('/admin/api/licences', { customerId: c.id, plan: 'trial' });
    await boss.post('/admin/api/licences', { customerId: a.id, plan: 'personal' });
    const o = (await boss.get('/admin/api/overview')).json;
    assert.deepEqual(o.trialConversion, { trialCustomers: 2, converted: 1, percent: 50 });
    assert.equal(o.signupSeries.length, 30);
    assert.equal(o.signupSeries[29].count, 2);
  });
});

test('customers: duplicates refused, search works, bad input is rejected', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    assert.equal((await boss.post('/admin/api/customers', { email: 'a@x.org', name: 'Alice' })).status, 201);
    assert.equal((await boss.post('/admin/api/customers', { email: 'A@X.org' })).status, 409);
    assert.equal((await boss.post('/admin/api/customers', { email: 'not-an-email' })).status, 400);
    await boss.post('/admin/api/customers', { email: 'b@y.org', name: '100% Bob' });
    assert.equal((await boss.get('/admin/api/customers?q=alice')).json.customers.length, 1);
    assert.equal((await boss.get('/admin/api/customers?q=100%25')).json.customers.length, 1, 'a % in the search is not a wildcard');
    assert.equal((await boss.get('/admin/api/customers?q=%27%3B%20DROP%20TABLE%20customers%3B--')).json.customers.length, 0);
    assert.equal((await boss.get('/admin/api/customers')).json.customers.length, 2);
  });
});

test('releases: newest version is served to the app, 1.10 beats 1.9, links must be https', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    for (const v of ['1.9.0', '1.10.0', '1.2.0']) assert.equal((await boss.post('/admin/api/releases', { version: v, downloadUrl: 'https://example.com/x.exe' })).status, 201);
    assert.equal((await boss.post('/admin/api/releases', { version: '1.9.0' })).status, 409);
    assert.equal((await boss.post('/admin/api/releases', { version: 'v1' })).status, 400);
    assert.equal((await boss.post('/admin/api/releases', { version: '2.0.0', downloadUrl: 'javascript:alert(1)' })).status, 400);
    await boss.post('/admin/api/releases', { version: '2.0.0-beta', channel: 'beta' });
    const latest = (await s.client().get('/api/releases/latest')).json;
    assert.equal(latest.release.version, '1.10.0');
    assert.equal((await s.client().get('/api/releases/latest?channel=beta')).json.release.version, '2.0.0-beta');
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  });
});

test('contact form: stored for support, validated and rate limited', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const web = s.client();
    const send = msg => web.post('/api/contact', msg, { csrf: false });
    assert.equal((await send({ name: 'Sam', email: 'sam@school.org', topic: 'Billing', message: 'Hello <script>alert(1)</script>' })).status, 201);
    assert.equal((await send({ name: '', email: 'sam@school.org', message: 'x' })).status, 400);
    assert.equal((await send({ name: 'Sam', email: 'bad', message: 'x' })).status, 400);
    for (let i = 0; i < 4; i++) await send({ name: 'Sam', email: 'sam@school.org', message: 'again ' + i });
    assert.equal((await send({ name: 'Sam', email: 'sam@school.org', message: 'too many' })).status, 429);

    const boss = s.client(); await boss.login('boss@example.com');
    const list = (await boss.get('/admin/api/messages?status=open')).json.messages;
    assert.equal(list.length, 5);
    const closed = await boss.patch(`/admin/api/messages/${list[0].id}`, { status: 'closed', note: 'replied' });
    assert.equal(closed.json.message.status, 'closed');
    assert.equal((await boss.get('/admin/api/overview')).json.openMessages, 4);
  });
});

test('team: the last owner cannot be removed, you cannot lock yourself out, disabling ends sessions', async () => {
  await withServer(async s => {
    const ownerId = s.addAdmin('boss@example.com', 'owner').lastInsertRowid;
    const boss = s.client(); await boss.login('boss@example.com');
    assert.equal((await boss.patch(`/admin/api/team/${ownerId}`, { disabled: true })).status, 400);
    assert.equal((await boss.patch(`/admin/api/team/${ownerId}`, { role: 'admin' })).status, 400);
    assert.equal((await boss.post('/admin/api/team', { email: 'new@example.com', role: 'support', password: 'short' })).status, 400);
    assert.equal((await boss.post('/admin/api/team', { email: 'new@example.com', role: 'support', password: 'a-long-enough-password' })).status, 201);
    const helper = s.client(); await helper.login('new@example.com', 'a-long-enough-password');
    assert.equal((await helper.get('/admin/api/me')).status, 200);
    const list = (await boss.get('/admin/api/team')).json.admins;
    const helperId = list.find(a => a.email === 'new@example.com').id;
    await boss.patch(`/admin/api/team/${helperId}`, { disabled: true });
    assert.equal((await helper.get('/admin/api/me')).status, 401, 'a disabled account is signed out straight away');
    assert.equal((await helper.login('new@example.com', 'a-long-enough-password')).status, 401);
  });
});

test('audit log records admin actions; the dashboard files are served safely', async () => {
  await withServer(async s => {
    s.addAdmin('boss@example.com', 'owner');
    const boss = s.client(); await boss.login('boss@example.com');
    await boss.post('/admin/api/customers', { email: 'a@x.org' });
    const entries = (await boss.get('/admin/api/audit')).json.entries.map(e => e.action);
    assert.ok(entries.includes('customer.created') && entries.includes('login'));

    const page = await fetch(s.base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(s.base + '/..%2f..%2fpackage.json')).status, 404, 'no escaping from the public folder');
    assert.equal((await fetch(s.base + '/admin/api/nothing')).status, 404);
  });
});

test('helpers: key format and licence status', () => {
  assert.match(generateKey(), /^CC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(effectiveStatus({ status: 'active', expires_at: null }), 'active');
  assert.equal(effectiveStatus({ status: 'active', expires_at: '2000-01-01T00:00:00Z' }), 'expired');
  assert.equal(effectiveStatus({ status: 'revoked', expires_at: null }), 'revoked');
});
