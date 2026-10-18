'use strict';
// AI tokens: each customer's daily allowance, extra tokens, requests for more (packs or custom), and the
// dashboard's AI tokens page (settings, packs, approving requests, giving tokens).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const tokens = require('../admin/lib/tokens');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tokens-')) });
  const base = await listen(app.server);
  const db = app.db;
  for (const [mail, role] of [['boss@example.com', 'owner'], ['help@example.com', 'support']]) {
    db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(mail, mail, role, hashPassword('correct-horse-battery'));
  }
  const asha = Number(db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('asha@example.com', 'Asha', datetime('now'))").run().lastInsertRowid);
  db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(asha, hashPassword('a-long-password'));
  const json = async r => ({ status: r.status, json: await r.json() });
  const admin = async email => {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return json(r);
    };
    await call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' });
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), del: u => call('DELETE', u) };
  };
  const site = async () => {
    const { token } = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'a-long-password' }) }).then(r => r.json());
    const call = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) }).then(json);
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
  };
  return { app, db, asha, admin, site, stop: () => app.close() };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('the token day is India time, and spending goes from the daily allowance, then the extra tokens', async () => {
  assert.equal(tokens.tokenDay(Date.parse('2026-10-18T18:29:00Z')), '2026-10-18');      // 11:59 PM in India
  assert.equal(tokens.tokenDay(Date.parse('2026-10-18T18:31:00Z')), '2026-10-19');      // 12:01 AM in India
  await withServer(async s => {
    let t = tokens.status(s.db, s.asha);
    assert.deepEqual([t.used, t.daily, t.bonus, t.left, t.level], [0, 100000, 0, 100000, 'ok']);
    tokens.record(s.db, s.asha, 85000);
    t = tokens.status(s.db, s.asha);
    assert.deepEqual([t.pct, t.level], [85, 'warn']);
    tokens.grant(s.db, s.asha, { kind: 'topup', tokens: 20000 });
    assert.equal(tokens.status(s.db, s.asha).level, 'ok');                                  // extra tokens: no warning yet
    tokens.record(s.db, s.asha, 25000);                                                      // the 10,000 past the allowance come from the extra tokens
    t = tokens.status(s.db, s.asha);
    assert.deepEqual([t.used, t.bonus, t.left], [110000, 10000, 10000]);
    tokens.record(s.db, s.asha, 10000);
    t = tokens.status(s.db, s.asha);
    assert.deepEqual([t.bonus, t.left, t.level], [0, 0, 'out']);
    assert.throws(() => tokens.check(s.db, s.asha), /today's AI tokens/);
    tokens.grant(s.db, s.asha, { kind: 'daily', tokens: 300000, days: 30 });                 // a bigger daily allowance
    t = tokens.status(s.db, s.asha);
    assert.deepEqual([t.daily, t.left, t.level], [300000, 180000, 'ok']);
    assert.ok(t.dailyUntil > t.day);
  });
});

test('customers ask for more tokens; the dashboard sets packs, approves, rejects and gives tokens', async () => {
  await withServer(async s => {
    const help = await s.admin('help@example.com');
    assert.equal((await help.post('/admin/api/tokens/packs', { name: 'X', tokens: 10000, price: 10 })).status, 403);   // support may look, not change
    const boss = await s.admin('boss@example.com');
    let packs = (await boss.post('/admin/api/tokens/packs', { name: 'Booster', kind: 'topup', tokens: 200000, price: 99, description: 'Two lakh tokens' })).json.packs;
    packs = (await boss.post('/admin/api/tokens/packs', { name: 'Job hunt month', kind: 'daily', tokens: 300000, days: 30, price: 499 })).json.packs;
    packs = (await boss.post('/admin/api/tokens/packs', { name: 'Hidden', tokens: 5000, price: 1, active: false })).json.packs;
    assert.equal(packs.length, 3);
    assert.equal((await boss.post('/admin/api/tokens/settings', { dailyDefault: 50000, warnPct: 5 })).status, 400);
    assert.deepEqual((await boss.post('/admin/api/tokens/settings', { dailyDefault: 50000, warnPct: 75 })).json.settings, { dailyDefault: 50000, warnPct: 75 });

    const web = await s.site();
    let mine = (await web.get('/api/account/tokens')).json;
    assert.equal(mine.tokens.daily, 50000);
    assert.deepEqual(mine.packs.map(p => p.name), ['Booster', 'Job hunt month']);             // hidden packs are not offered
    const booster = mine.packs[0], month = mine.packs[1];
    assert.equal((await web.post('/api/account/tokens/claim', { tokens: 50000 })).status, 400);  // a custom request needs a reason
    assert.equal((await web.post('/api/account/tokens/claim', { tokens: 500, message: 'x' })).status, 400);
    const custom = (await web.post('/api/account/tokens/claim', { tokens: 150000, message: 'Interviews this week' })).json.claim;
    assert.deepEqual([custom.status, custom.packName, custom.price], ['pending', 'Custom request', 0]);
    const a = (await web.post('/api/account/tokens/claim', { packId: booster.id })).json.claim;
    const b = (await web.post('/api/account/tokens/claim', { packId: month.id })).json.claim;
    assert.equal((await web.post('/api/account/tokens/claim', { packId: booster.id })).status, 400);   // at most 3 waiting

    let page = (await boss.get('/admin/api/tokens')).json;
    assert.equal(page.totals.pending, 3);
    assert.equal(page.claims[0].customer.email, 'asha@example.com');
    // approve the custom one with a price agreed, and fewer tokens
    assert.equal((await boss.post(`/admin/api/tokens/claims/${custom.id}`, { action: 'approve', tokens: 100000, price: 59, note: 'Paid by UPI' })).json.claim.status, 'approved');
    assert.equal((await boss.post(`/admin/api/tokens/claims/${custom.id}`, { action: 'approve' })).status, 409);
    await boss.post(`/admin/api/tokens/claims/${b.id}`, { action: 'approve' });                   // the pack as offered
    await boss.post(`/admin/api/tokens/claims/${a.id}`, { action: 'reject', note: 'No payment' });
    mine = (await web.get('/api/account/tokens')).json;
    assert.deepEqual([mine.tokens.bonus, mine.tokens.daily], [100000, 300000]);
    assert.deepEqual(mine.claims.map(k => k.status), ['approved', 'rejected', 'approved']);
    assert.equal(mine.claims[2].price, 59);

    // give tokens directly, and back to the default allowance
    await boss.post(`/admin/api/tokens/customers/${s.asha}`, { kind: 'topup', tokens: 25000 });
    const back = (await boss.post(`/admin/api/tokens/customers/${s.asha}`, { action: 'reset-daily' })).json.tokens;
    assert.deepEqual([back.bonus, back.daily], [125000, 50000]);
    page = (await boss.get('/admin/api/tokens')).json;
    assert.equal(page.customers[0].email, 'asha@example.com');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'tokens.%'").get().n, 9);
    assert.deepEqual(s.db.prepare("SELECT action FROM career_activity WHERE action LIKE 'tokens.%' ORDER BY id").all().map(r => r.action),
      ['tokens.claimed', 'tokens.claimed', 'tokens.claimed', 'tokens.granted', 'tokens.granted', 'tokens.granted']);
    assert.equal((await boss.del(`/admin/api/tokens/packs/${booster.id}`)).json.packs.length, 2);
  });
});

test('the token pages need a sign-in', async () => {
  await withServer(async s => {
    const base = `http://127.0.0.1:${s.app.server.address().port}`;
    assert.equal((await fetch(base + '/api/account/tokens')).status, 401);
    assert.equal((await fetch(base + '/admin/api/tokens')).status, 401);
  });
});
