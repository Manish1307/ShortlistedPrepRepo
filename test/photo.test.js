'use strict';
// A profile photo with the Verified badge is for paid members only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');

// a tiny but valid JPEG header followed by filler, big enough to pass the size floor
const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64');

async function withApp(fn) {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-photo-')) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const member = async email => {
    const id = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES (?, 'Asha', datetime('now'))").run(email).lastInsertRowid;
    app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(id, hashPassword('a-long-password'));
    const { token } = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-password' }) }).then(r => r.json());
    const call = async (url, body) => {
      const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    return { id, call };
  };
  try { await fn({ app, member }); } finally { app.close(); }
}

test('a free member cannot add a photo, a paid member can, and the badge follows the plan', async () => {
  await withApp(async ({ app, member }) => {
    const free = await member('free@example.com');
    const denied = await free.call('/api/account/photo', { image: jpeg });
    assert.equal(denied.status, 402);
    assert.match(denied.json.error, /paid members/);
    const me = (await free.call('/api/account/me')).json.customer;
    assert.deepEqual([me.paid, me.photo, me.verified], [false, '', false]);

    const paid = await member('paid@example.com');
    app.db.prepare("INSERT INTO customer_plans (customer_id, plan_code, plan_name, limits_json, status, starts_at, ends_at, created_at) VALUES (?, 'offer-30', 'Offer Pass', '{}', 'active', datetime('now', '-1 day'), datetime('now', '+30 day'), datetime('now'))").run(paid.id);
    const ok = await paid.call('/api/account/photo', { image: jpeg });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.verified, true);
    const shown = (await paid.call('/api/account/me')).json.customer;
    assert.equal(shown.photo, jpeg);
    assert.equal(shown.verified, true);

    // the plan ends: the photo is kept but the badge and the picture are not shown
    app.db.prepare("UPDATE customer_plans SET ends_at = datetime('now', '-1 day') WHERE customer_id = ?").run(paid.id);
    const lapsed = (await paid.call('/api/account/me')).json.customer;
    assert.deepEqual([lapsed.paid, lapsed.photo, lapsed.verified], [false, '', false]);
  });
});

test('photo uploads are checked: type, real image bytes, size; and a photo can be removed', async () => {
  await withApp(async ({ app, member }) => {
    const m = await member('paid@example.com');
    app.db.prepare("INSERT INTO customer_plans (customer_id, plan_code, plan_name, limits_json, status, starts_at, ends_at, created_at) VALUES (?, 'offer-30', 'Offer Pass', '{}', 'active', datetime('now', '-1 day'), datetime('now', '+30 day'), datetime('now'))").run(m.id);
    assert.equal((await m.call('/api/account/photo', { image: 'data:text/html;base64,PGI+aGk8L2I+' })).status, 400);
    const fake = 'data:image/jpeg;base64,' + Buffer.alloc(600, 1).toString('base64');
    assert.equal((await m.call('/api/account/photo', { image: fake })).status, 400, 'not a JPEG inside');
    const big = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(210 * 1024, 2)]).toString('base64');
    assert.equal((await m.call('/api/account/photo', { image: big })).status, 400, 'over 200 KB');
    assert.equal((await m.call('/api/account/photo', { image: jpeg })).status, 200);
    const gone = await m.call('/api/account/photo/delete', {});
    assert.equal(gone.json.photo, '');
    assert.equal((await m.call('/api/account/me')).json.customer.verified, false);
  });
});

test('signed-out visitors cannot upload a photo', async () => {
  await withApp(async ({ app }) => {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const r = await fetch(base + '/api/account/photo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: jpeg }) });
    assert.ok([401, 403].includes(r.status), String(r.status));
  });
});
