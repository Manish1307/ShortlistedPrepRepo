'use strict';
// The website's offer bar: only a live offer is served, and the admin controls it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start(role = 'owner') {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-offers-')) });
  const base = await listen(app.server);
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES ('boss@example.com', 'Boss', ?, ?, datetime('now'))").run(role, hashPassword('correct-horse-battery'));
  let cookie = '';
  const call = async (method, url, body, admin) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Requested-With': 'admin', Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  await call('POST', '/admin/api/login', { email: 'boss@example.com', password: 'correct-horse-battery' }, true);
  return { call, close: app.close };
}

const hours = h => new Date(Date.now() + h * 3600000).toISOString();
const offer = (extra = {}) => ({ name: 'Diwali sale', message: 'Diwali is almost here: 25% off every plan with code DIWALI25.', code: 'diwali25', ctaLabel: 'Get 25% off', ctaUrl: 'pricing.html', ...extra });

test('no offer is served until one is live; the code is upper-cased', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('GET', '/api/offer')).json.offer, null);
    const made = await call('POST', '/admin/api/offers', offer({ endsAt: hours(72) }), true);
    assert.equal(made.status, 201);
    const shown = (await call('GET', '/api/offer')).json.offer;
    assert.equal(shown.code, 'DIWALI25');
    assert.equal(shown.ctaUrl, 'pricing.html');
  } finally { await close(); }
});

test('scheduled, ended and switched-off offers are not served', async () => {
  const { call, close } = await start();
  try {
    const a = (await call('POST', '/admin/api/offers', offer({ startsAt: hours(24) }), true)).json.offer;
    assert.equal((await call('GET', '/api/offer')).json.offer, null);                       // not started yet
    await call('PATCH', '/admin/api/offers/' + a.id, { startsAt: '', endsAt: hours(1) }, true);
    assert.ok((await call('GET', '/api/offer')).json.offer);                                // now live
    await call('PATCH', '/admin/api/offers/' + a.id, { active: false }, true);
    assert.equal((await call('GET', '/api/offer')).json.offer, null);                       // switched off
    await call('PATCH', '/admin/api/offers/' + a.id, { active: true, startsAt: hours(-48), endsAt: hours(-24) }, true);
    assert.equal((await call('GET', '/api/offer')).json.offer, null);                       // ended
  } finally { await close(); }
});

test('bad input is refused; delete works; support cannot change offers', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('POST', '/admin/api/offers', offer({ ctaUrl: 'javascript:alert(1)' }), true)).status, 400);
    assert.equal((await call('POST', '/admin/api/offers', offer({ code: 'BAD CODE!' }), true)).status, 400);
    assert.equal((await call('POST', '/admin/api/offers', offer({ message: '' }), true)).status, 400);
    assert.equal((await call('POST', '/admin/api/offers', offer({ startsAt: hours(5), endsAt: hours(1) }), true)).status, 400);
    const o = (await call('POST', '/admin/api/offers', offer(), true)).json.offer;
    assert.equal((await call('DELETE', '/admin/api/offers/' + o.id, undefined, true)).status, 200);
    assert.equal((await call('GET', '/admin/api/offers', undefined, true)).json.offers.length, 0);
  } finally { await close(); }
  const support = await start('support');
  try { assert.equal((await support.call('POST', '/admin/api/offers', offer(), true)).status, 403); } finally { await support.close(); }
});
