'use strict';
// Pricing: the plans master and active plans (shown on the website), price history, payment settings, and buying a
// plan: an order, payment by UPI / bank transfer, the admin confirming it, and the plan's daily AI tokens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const tokens = require('../admin/lib/tokens');
const { gstSplit } = require('../admin/lib/pricing');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pricing-')) });
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
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
  };
  const site = async () => {
    const { token } = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'a-long-password' }) }).then(r => r.json());
    const call = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) }).then(json);
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
  };
  const anon = u => fetch(base + u).then(json);
  return { app, db, asha, base, admin, site, anon, stop: () => app.close() };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('GST is split out of a price (included) or added to it', () => {
  assert.deepEqual(gstSplit(59900, { gstRate: 18, pricesIncludeGst: true }), { total: 59900, base: 50763, gst: 9137, rate: 18 });
  assert.deepEqual(gstSplit(50000, { gstRate: 18, pricesIncludeGst: false }), { total: 59000, base: 50000, gst: 9000, rate: 18 });
  assert.deepEqual(gstSplit(29900, { gstRate: 0 }), { total: 29900, base: 29900, gst: 0, rate: 0 });
});

test('the plans master: default plans, editing with price history, and which plans the website shows', async () => {
  await withServer(async s => {
    let pub = (await s.anon('/api/pricing')).json;                                    // public: no sign-in needed
    assert.deepEqual(pub.plans.map(p => [p.name, p.price]), [['Free', 0], ['Shortlist Pass', 299], ['Interview Pass', 599]]);
    assert.deepEqual([pub.currency, pub.gst, pub.plans[2].featured, pub.plans[2].mrp], ['INR', { rate: 18, included: true }, true, 799]);
    assert.equal(pub.plans[0].dailyTokens, 30000);
    assert.equal(pub.payment.online, false);

    const help = await s.admin('help@example.com');
    assert.equal((await help.post('/admin/api/pricing/plans', { name: 'X', price: 1, durationDays: 30 })).status, 403);   // support may look, not change
    const boss = await s.admin('boss@example.com');
    let page = (await boss.get('/admin/api/pricing')).json;
    assert.equal(page.plans.length, 5);
    const interview = page.plans.find(p => p.code === 'interview-30');
    const offer = page.plans.find(p => p.code === 'offer-30');

    // change a price: history is kept
    assert.equal((await boss.post('/admin/api/pricing/plans', { ...interview, price: 499, mrp: 400 })).status, 400);       // strike-through must be higher
    await boss.post('/admin/api/pricing/plans', { ...interview, price: '499', mrp: 799, features: 'Line one\nLine two', limits: { dailyTokens: 120000 } });
    page = (await boss.get('/admin/api/pricing')).json;
    assert.deepEqual(page.history.map(h => [h.planName, h.oldPrice, h.newPrice]), [['Interview Pass', 599, 499]]);
    assert.deepEqual(page.plans.find(p => p.id === interview.id).features, ['Line one', 'Line two']);

    // active pricing: show the Offer Pass, feature it, move it first, then archive the Shortlist Pass
    await boss.post(`/admin/api/pricing/plans/${offer.id}/action`, { action: 'activate' });
    await boss.post(`/admin/api/pricing/plans/${offer.id}/action`, { action: 'feature' });
    for (let i = 0; i < 4; i++) await boss.post(`/admin/api/pricing/plans/${offer.id}/action`, { action: 'up' });
    const shortlist = page.plans.find(p => p.code === 'shortlist-30');
    await boss.post(`/admin/api/pricing/plans/${shortlist.id}/action`, { action: 'archive' });
    pub = (await s.anon('/api/pricing')).json;
    assert.deepEqual(pub.plans.map(p => [p.name, p.featured]), [['Offer Pass', true], ['Free', false], ['Interview Pass', false]]);   // one featured plan at a time
    assert.equal((await boss.post(`/admin/api/pricing/plans/${shortlist.id}/action`, { action: 'activate' })).status, 409);        // archived: restore first

    // a new plan starts hidden
    await boss.post('/admin/api/pricing/plans', { name: 'Campus Pass', price: 149, durationDays: 365, features: ['For students'] });
    assert.ok(!(await s.anon('/api/pricing')).json.plans.some(p => p.name === 'Campus Pass'));
    assert.equal((await boss.post('/admin/api/pricing/plans', { name: 'Campus Pass', price: 99, durationDays: 30 })).status, 409);  // the code is taken
  });
});

test('payment settings: checked, and secrets are kept encrypted and never shown', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    assert.equal((await boss.post('/admin/api/pricing/config', { methods: { upi: false, card: false, netbanking: false, wallet: false, emi: false, bank_transfer: false } })).status, 400);
    assert.equal((await boss.post('/admin/api/pricing/config', { manual: { upiId: 'not-a-upi' } })).status, 400);
    assert.equal((await boss.post('/admin/api/pricing/config', { manual: { ifsc: 'BAD' } })).status, 400);
    const saved = (await boss.post('/admin/api/pricing/config', { provider: 'razorpay', mode: 'test', keyId: 'rzp_test_123', keySecret: 'super-secret-value', gstin: '09ABCDE1234F1Z5',
      manual: { upiId: 'shortlistprep@icici', payeeName: 'ShortlistPrep', bankName: 'ICICI Bank', accountNumber: '1234 5678 9012', ifsc: 'icic0001234' } })).json.config;
    assert.deepEqual([saved.provider, saved.connected, saved.secrets.keySecret, saved.manual.accountNumber, saved.manual.ifsc], ['razorpay', false, true, '123456789012', 'ICIC0001234']);
    assert.ok(!JSON.stringify(saved).includes('super-secret-value'));
    const stored = s.db.prepare("SELECT value FROM job_settings WHERE key = 'payment_secrets'").get().value;
    assert.ok(!stored.includes('super-secret-value'));                                   // encrypted at rest
    assert.equal((await fetch(s.base + '/api/payments/webhook/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 501);   // not connected yet
    assert.equal((await fetch(s.base + '/api/payments/webhook/nobody', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  });
});

test('buying a plan: order with GST, UPI / bank details, the customer reports payment, the admin confirms, and the plan gives its tokens', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    await boss.post('/admin/api/pricing/config', { manual: { upiId: 'shortlistprep@icici', payeeName: 'ShortlistPrep', bankName: 'ICICI Bank', accountNumber: '123456789012', ifsc: 'ICIC0001234' } });
    const web = await s.site();
    const plans = (await s.anon('/api/pricing')).json.plans;
    const free = plans.find(p => p.price === 0), interview = plans.find(p => p.name === 'Interview Pass');

    // the free plan starts at once
    const f = (await web.post('/api/account/plans/checkout', { planId: free.id })).json;
    assert.equal(f.free, true);
    assert.equal(tokens.status(s.db, s.asha).daily, 30000);
    assert.equal(tokens.status(s.db, s.asha).plan.name, 'Free');

    // a paid plan: an order and how to pay
    const c = (await web.post('/api/account/plans/checkout', { planId: interview.id })).json;
    assert.deepEqual([c.order.amount, c.order.gst, c.order.status, c.order.number], [599, 91.37, 'created', 'SP-000001']);
    assert.equal(c.payment.type, 'manual');
    assert.match(c.payment.upi.link, /^upi:\/\/pay\?pa=shortlistprep%40icici&pn=ShortlistPrep&am=599\.00&cu=INR&tn=SP-000001/);
    assert.equal(c.payment.bank.ifsc, 'ICIC0001234');
    assert.equal((await web.post(`/api/account/orders/${c.order.id}/paid`, { reference: '' })).status, 400);
    const paid = (await web.post(`/api/account/orders/${c.order.id}/paid`, { reference: '412345678901', method: 'upi' })).json.order;
    assert.deepEqual([paid.status, paid.reference, paid.paymentMode], ['pending', '412345678901', 'upi']);

    // the admin sees it waiting and confirms it: the Interview Pass replaces the free plan
    let page = (await boss.get('/admin/api/pricing')).json;
    assert.equal(page.stats.pending, 1);
    assert.equal(page.orders[0].customer.email, 'asha@example.com');
    const ok = (await boss.post(`/admin/api/pricing/orders/${c.order.id}`, { action: 'mark-paid', note: 'Seen in ICICI' })).json.order;
    assert.equal(ok.status, 'paid');
    let mine = (await web.get('/api/account/plan')).json;
    assert.equal(mine.plan.name, 'Interview Pass');
    assert.equal(Math.round((Date.parse(mine.plan.endsAt) - Date.now()) / 86400000), 30);
    assert.equal(tokens.status(s.db, s.asha).daily, 150000);                             // the plan's daily AI tokens
    assert.equal((await boss.post(`/admin/api/pricing/orders/${c.order.id}`, { action: 'mark-paid' })).status, 409);
    page = (await boss.get('/admin/api/pricing')).json;
    assert.deepEqual([page.stats.paidMonth.n, page.stats.paidMonth.t, page.stats.subscribers], [1, 59900, 1]);

    // buying the same pass again adds 30 days
    const again = (await web.post('/api/account/plans/checkout', { planId: interview.id })).json.order;
    await boss.post(`/admin/api/pricing/orders/${again.id}`, { action: 'mark-paid' });
    mine = (await web.get('/api/account/plan')).json;
    assert.equal(Math.round((Date.parse(mine.plan.endsAt) - Date.now()) / 86400000), 60);

    // an unpaid order can be cancelled by the customer; a refund ends the plan
    const third = (await web.post('/api/account/plans/checkout', { planId: interview.id })).json.order;
    assert.equal((await web.post(`/api/account/orders/${third.id}/cancel`)).json.order.status, 'cancelled');
    await boss.post(`/admin/api/pricing/orders/${again.id}`, { action: 'refund', note: 'Refunded by UPI' });
    assert.equal((await web.get('/api/account/plan')).json.plan, null);
    assert.equal(tokens.status(s.db, s.asha).daily, 100000);                             // back to the default allowance
    assert.ok(s.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'pricing.%'").get().n >= 4);
  });
});

test('a plan sets what a candidate can do: Free limits are enforced, a paid plan lifts them, and My account and the dashboard show the same numbers', async () => {
  await withServer(async s => {
    const db = s.app.db;
    const ent = require('../admin/lib/entitlements');
    db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('p@example.com', 'P', datetime('now'))").run();
    const id = db.prepare("SELECT id FROM customers WHERE email = 'p@example.com'").get().id;
    let e = ent.forCustomer(db, id);
    assert.equal(e.plan.code, 'free');
    assert.deepEqual(e.limits.find(l => l.key === 'jobSearches').limit, 2);
    // two searches used: the third is refused with a message that points to Pricing
    for (let i = 0; i < 2; i++) db.prepare("INSERT INTO career_job_searches (customer_id, params_json, status, created_at) VALUES (?, '{}', 'done', datetime('now'))").run(id);
    assert.throws(() => ent.check(db, id, 'jobSearches'), err => err.status === 402 && /Upgrade/.test(err.message));
    // a failed search is not counted
    db.prepare("UPDATE career_job_searches SET status = 'failed' WHERE id = (SELECT MIN(id) FROM career_job_searches)").run();
    ent.check(db, id, 'jobSearches');
    // a paid plan (Shortlist Pass: about 30 searches) replaces the Free limits from the day it starts
    const plan = db.prepare("SELECT * FROM pricing_plans WHERE code = 'shortlist-30'").get();
    db.prepare("INSERT INTO customer_plans (customer_id, plan_id, plan_code, plan_name, limits_json, starts_at, ends_at, status, created_at) VALUES (?,?,?,?,?,?,?, 'active', datetime('now'))")
      .run(id, plan.id, plan.code, plan.name, plan.limits_json, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86400000 * 30).toISOString());
    e = ent.forCustomer(db, id);
    assert.deepEqual([e.plan.code, e.plan.free, e.limits.find(l => l.key === 'jobSearches').limit, e.limits.find(l => l.key === 'jobSearches').used], ['shortlist-30', false, 30, 0]);
    ent.check(db, id, 'jobSearches');
  });
});
