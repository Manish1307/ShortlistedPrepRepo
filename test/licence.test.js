'use strict';
// The app's licence client against the real licence server (in a temporary folder).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const licences = require('../admin/lib/licence');
const { LicenceClient } = require('../src/licence/client');

const DAY = 86400000;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function server() {
  const app = createApp({ dataDir: tmp('cc-lic-srv-') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { app, url: `http://127.0.0.1:${app.server.address().port}`, close: () => app.close() };
}
const client = (srv, o = {}) => new LicenceClient({
  serverUrl: srv.url, publicKeyPem: srv.app.signer.publicKeyPem, dir: o.dir || tmp('cc-lic-app-'),
  deviceId: o.deviceId || crypto.randomBytes(16).toString('hex'), deviceName: o.deviceName || 'Test PC', appVersion: '1.0.0', ...o,
});
function paidKey(srv, { maxDevices = 2, days = 365, email = 'buyer@example.com' } = {}) {
  const db = srv.app.db;
  let c = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
  if (!c) c = { id: db.prepare("INSERT INTO customers (email, created_at) VALUES (?, datetime('now'))").run(email).lastInsertRowid };
  return licences.createLicence(db, { customerId: c.id, plan: 'personal', days, maxDevices }).key;
}

test('no licence yet: locked', async () => {
  const srv = await server();
  try { assert.equal(client(srv).status().state, 'none'); } finally { await srv.close(); }
});

test('free trial: starts, is active with days left, and survives a reinstall on the same PC', async () => {
  const srv = await server();
  try {
    const deviceId = 'pc-trial-1';
    const a = client(srv, { deviceId });
    const res = await a.startTrial('teacher@school.org');
    assert.equal(res.ok, true, res.message);
    const s = a.status();
    assert.equal(s.state, 'active'); assert.equal(s.kind, 'trial'); assert.equal(s.daysLeft, 7);
    // reinstall: the app data is gone, but it is the same computer -> the same running trial comes back
    const again = await client(srv, { deviceId }).startTrial('other@school.org');
    assert.equal(again.ok, true);
    assert.equal(again.status.key, s.key);
  } finally { await srv.close(); }
});

test('free trial: one per email and one per computer once it has ended', async () => {
  const srv = await server();
  try {
    assert.equal((await client(srv, { deviceId: 'pc-a' }).startTrial('same@school.org')).ok, true);
    const sameEmail = await client(srv, { deviceId: 'pc-b' }).startTrial('Same@School.org');
    assert.equal(sameEmail.code, 'trial_used');
    srv.app.db.prepare("UPDATE licences SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'trial'").run();
    const ended = await client(srv, { deviceId: 'pc-a' }).startTrial('new@school.org');
    assert.equal(ended.code, 'trial_used');
    assert.equal((await client(srv).startTrial('not-an-email')).code, 'invalid_email');
  } finally { await srv.close(); }
});

test('licence key: activates, the PC limit is enforced, and deactivating frees a place', async () => {
  const srv = await server();
  try {
    const key = paidKey(srv, { maxDevices: 1 });
    const first = client(srv);
    assert.equal((await first.activate(key.toLowerCase())).ok, true);
    assert.equal(first.status().state, 'active');
    assert.equal(first.status().kind, 'paid');
    assert.equal((await client(srv).activate(key)).code, 'device_limit');
    assert.equal((await first.deactivate()).ok, true);
    assert.equal(first.status().state, 'none');
    assert.equal((await client(srv).activate(key)).ok, true);
    assert.equal((await client(srv).activate('CC-AAAA-BBBB-CCCC')).code, 'invalid_key');
    assert.equal((await client(srv).activate('hello')).code, 'invalid_key');
  } finally { await srv.close(); }
});

test('cancelled or expired on the server: the app locks at its next check', async () => {
  const srv = await server();
  try {
    const key = paidKey(srv);
    const c = client(srv);
    await c.activate(key);
    srv.app.db.prepare("UPDATE licences SET status = 'revoked' WHERE key = ?").run(key);
    assert.equal((await c.refresh()).state, 'revoked');
    srv.app.db.prepare("UPDATE licences SET status = 'active' WHERE key = ?").run(key);
    assert.equal((await c.refresh()).state, 'active', 'reinstated licences unlock again');
    srv.app.db.prepare("UPDATE licences SET expires_at = '2000-01-01T00:00:00.000Z' WHERE key = ?").run(key);
    assert.equal((await c.refresh()).state, 'expired');
  } finally { await srv.close(); }
});

test('a PC removed in the dashboard locks at its next check', async () => {
  const srv = await server();
  try {
    const key = paidKey(srv);
    const c = client(srv, { deviceId: 'pc-removed' });
    await c.activate(key);
    srv.app.db.prepare("DELETE FROM devices WHERE device_id = 'pc-removed'").run();
    assert.equal((await c.refresh()).state, 'removed');
  } finally { await srv.close(); }
});

test('the licence ends by itself when its date passes, even offline', async () => {
  const srv = await server();
  try {
    const c = client(srv);
    await c.activate(paidKey(srv, { days: 3 }));
    c.now = () => Date.now() + 4 * DAY;
    assert.equal(c.status().state, 'expired');
  } finally { await srv.close(); }
});

test('offline: works during the grace period, then asks for a check', async () => {
  const srv = await server();
  const dir = tmp('cc-lic-app-');
  const c = client(srv, { dir, deviceId: 'pc-offline' });
  await c.activate(paidKey(srv));
  await srv.close();
  c.now = () => Date.now() + 3 * DAY;
  const s = await c.refresh();                               // server unreachable
  assert.equal(s.state, 'active');
  assert.match(c.lastError, /Cannot reach the licence server/);
  c.now = () => Date.now() + 8 * DAY;
  assert.equal(c.status().state, 'check-needed');
});

test('a faked or copied licence file is not accepted', async () => {
  const srv = await server();
  try {
    const dir = tmp('cc-lic-app-');
    const c = client(srv, { dir, deviceId: 'pc-real' });
    await c.activate(paidKey(srv, { days: 1 }));
    const file = path.join(dir, 'licence.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 1. edit the expiry date in the file: the signature no longer matches
    fs.writeFileSync(file, JSON.stringify({ ...saved, payload: saved.payload.replace(/"expiresAt":"[^"]+"/, '"expiresAt":"2099-01-01T00:00:00.000Z"') }));
    assert.equal(c.status().state, 'none');
    // 2. copy a genuine file to another computer: it was signed for a different PC
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.equal(c.status().state, 'active');
    assert.equal(client(srv, { dir, deviceId: 'pc-other' }).status().state, 'none');
    // 3. an answer signed with another key (a fake server)
    const fake = new licences.Signer(tmp('cc-fake-'));
    fs.writeFileSync(file, JSON.stringify(fake.sign({ ...JSON.parse(saved.payload), expiresAt: null })));
    assert.equal(c.status().state, 'none');
  } finally { await srv.close(); }
});

test('the public key built into the app matches the local signing key', () => {
  const keyFile = path.join(__dirname, '..', 'admin', 'data', 'signing-key.pem');
  if (!fs.existsSync(keyFile)) return;                       // a fresh checkout has no signing key yet
  const pub = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyFile))).export({ type: 'spki', format: 'pem' });
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'src', 'licence', 'public-key.pem'), 'utf8'), pub);
});
