'use strict';
// "How much of ShortlistPrep have you used": the four capabilities share 100%, and each step counts when the records show it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const { CAPABILITIES, strengthOf } = require('../admin/lib/strength');
const { logActivity } = require('../admin/lib/activity');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-strength-')) });
  const base = await listen(app.server);
  const db = app.db;
  const id = Number(db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('asha@example.com', 'Asha', datetime('now'))").run().lastInsertRowid);
  db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(id, hashPassword('a-long-password'));
  const get = async (url, token) => { const r = await fetch(base + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); return { status: r.status, json: await r.json() }; };
  const login = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'a-long-password' }) }).then(r => r.json());
  return { app, db, id, get, token: login.token, close: app.close };
}

test('the shares are 20 / 25 / 20 / 35 and every step adds up to its capability', () => {
  assert.deepEqual(CAPABILITIES.map(c => c.weight), [20, 25, 20, 35]);
  for (const c of CAPABILITIES) assert.equal(c.steps.reduce((n, s) => n + s.weight, 0), c.weight, c.id);
  assert.ok(CAPABILITIES.find(c => c.id === 'prep').steps.filter(s => s.highlight).reduce((n, s) => n + s.weight, 0) >= 12);   // the introduction is most of interview preparation
});

test('a new customer has used 0% and each action moves the percentage', async () => {
  const { db, id, get, token, close } = await start();
  try {
    assert.equal(strengthOf(db, id).percent, 0);
    assert.equal(strengthOf(db, id).name, 'Asha');
    assert.equal(strengthOf(db, id).next.weight, 15);   // the biggest thing left that the plan allows: a Live Search (live sessions are locked on Free)
    db.prepare("INSERT INTO career_resumes (customer_id, file_name, source_text, uploaded_at) VALUES (?, 'cv.pdf', 'text', datetime('now'))").run(id);
    logActivity(db, id, 'ats.checked', 'ATS score 70');
    assert.equal(strengthOf(db, id).percent, 10);       // resume 5 + ATS check 5
    db.prepare("INSERT INTO interview_intros (customer_id, guide_json, answer, created_at) VALUES (?, '{}', 'My answer', datetime('now'))").run(id);
    const s = strengthOf(db, id);
    assert.equal(s.percent, 10 + 6 + 8);
    assert.equal(s.capabilities.find(c => c.id === 'prep').earned, 14);
    const api = await get('/api/strength', token);
    assert.equal(api.status, 200);
    assert.equal(api.json.percent, 24);
    assert.equal(api.json.capabilities.length, 4);
    assert.equal((await get('/api/strength')).status, 401);   // only for a signed-in customer
  } finally { await close(); }
});

test('steps the plan does not include show as locked, with where to unlock them', async () => {
  const { db, id, close } = await start();
  try {
    const s = strengthOf(db, id);
    const live = s.capabilities.find(c => c.id === 'support').steps.find(st => st.id === 'session');
    assert.equal(live.locked, true);
    assert.match(live.lockReason, /Not in your Free plan/);
    assert.equal(live.href, 'pricing.html');
    assert.equal(s.hasLocked, true);
    assert.ok(s.capabilities.every(c => c.steps.filter(st => st.locked).every(st => st.id === 'session')));   // the rest of a Free plan is open
    assert.equal(s.next.locked, false);                                                                       // "next" never points at a locked step
    db.prepare("INSERT INTO customer_plans (customer_id, plan_code, plan_name, limits_json, status, starts_at, ends_at, created_at) VALUES (?, 'offer-30', 'Offer Pass', ?, 'active', datetime('now', '-1 day'), datetime('now', '+30 day'), datetime('now'))").run(id, JSON.stringify({ liveSessions: 10, jobSearches: 100, preps: 100, roleResumes: 8 }));
    assert.equal(strengthOf(db, id).hasLocked, false);   // a plan with live sessions unlocks it
  } finally { await close(); }
});

test('support counts downloads, a computer signed in to the app, and a saved live session', async () => {
  const { db, id, close } = await start();
  try {
    db.prepare("INSERT INTO downloads (at, day, tool, version, customer_id) VALUES (datetime('now'), date('now'), 'interview', '1.0', ?)").run(id);
    const lic = Number(db.prepare("INSERT INTO licences (key, customer_id, plan, kind, created_at) VALUES ('AAAA-BBBB-CCCC', ?, 'personal', 'paid', datetime('now'))").run(id).lastInsertRowid);
    db.prepare("INSERT INTO devices (licence_id, device_id, first_seen, last_seen) VALUES (?, 'pc1', datetime('now'), datetime('now'))").run(lic);
    assert.equal(strengthOf(db, id).capabilities.find(c => c.id === 'support').earned, 17);
    db.prepare("INSERT INTO conversations (uid, licence_id, device_id, started_at, ended_at, created_at) VALUES ('u1', ?, 'pc1', datetime('now'), datetime('now'), datetime('now'))").run(lic);
    assert.equal(strengthOf(db, id).capabilities.find(c => c.id === 'support').earned, 35);
  } finally { await close(); }
});

test('a resume that already scores 100 has nothing to improve, so that step counts as done', async () => {
  const { db, id, close } = await start();
  try {
    db.prepare("INSERT INTO career_resumes (customer_id, file_name, source_text, ats_json, uploaded_at) VALUES (?, 'cv.pdf', 'text', ?, datetime('now'))").run(id, JSON.stringify({ score: 100 }));
    logActivity(db, id, 'ats.checked', 'ATS score 100');
    const ats = strengthOf(db, id).capabilities.find(c => c.id === 'ats');
    assert.equal(ats.steps.find(st => st.id === 'improve').done, true);
    assert.equal(ats.earned, 15);   // resume 5 + check 5 + improve 5
  } finally { await close(); }
});
