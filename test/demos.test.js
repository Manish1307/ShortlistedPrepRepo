'use strict';
// Free 1-on-1 demo: open slots, booking (no double booking), and the admin's bookings list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const demos = require('../admin/lib/demos');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-demos-')) });
  const base = await listen(app.server);
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES ('boss@example.com', 'Boss', 'owner', ?, datetime('now'))").run(hashPassword('correct-horse-battery'));
  let cookie = '';
  const call = async (method, url, body, admin) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Requested-With': 'admin', Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  await call('POST', '/admin/api/login', { email: 'boss@example.com', password: 'correct-horse-battery' }, true);
  return { app, call, close: app.close };
}

const person = (email, slot, extra = {}) => ({ name: 'Neha', email, phone: '+91 98765 43210', goal: 'Resume help', date: slot.date, time: slot.time, ...extra });

test('slots skip Sundays and the lunch hour, and a booked slot disappears', async () => {
  const { call, close } = await start();
  try {
    const { json } = await call('GET', '/api/demo/slots');
    assert.ok(json.slots.length > 5);
    for (const day of json.slots) {
      assert.notEqual(new Date(day.date + 'T00:00:00Z').getUTCDay(), 0);
      assert.ok(!day.times.includes('13:00'));
    }
    const slot = { date: json.slots[1].date, time: json.slots[1].times[0] };
    assert.equal((await call('POST', '/api/demo/book', person('neha@example.com', slot))).status, 201);
    const after = (await call('GET', '/api/demo/slots')).json.slots;
    const day = after.find(d => d.date === slot.date);
    assert.ok(!day || !day.times.includes(slot.time));
  } finally { await close(); }
});

test('booking: no double booking, one demo per email, bad slots refused, and an opportunity is made', async () => {
  const { app, call, close } = await start();
  try {
    const slots = (await call('GET', '/api/demo/slots')).json.slots;
    const slot = { date: slots[2].date, time: slots[2].times[0] };
    assert.equal((await call('POST', '/api/demo/book', person('a@example.com', slot))).status, 201);
    assert.equal((await call('POST', '/api/demo/book', person('b@example.com', slot))).status, 409);      // same slot
    const other = { date: slots[2].date, time: slots[2].times[1] };
    assert.equal((await call('POST', '/api/demo/book', person('a@example.com', other))).status, 409);     // same person again
    assert.equal((await call('POST', '/api/demo/book', person('c@example.com', { date: '2020-01-01', time: '10:00' }))).status, 400);
    assert.equal((await call('POST', '/api/demo/book', person('c@example.com', { date: slot.date, time: '13:00' }))).status, 400);
    assert.equal((await call('POST', '/api/demo/book', { ...person('c@example.com', other), phone: '' })).status, 400);
    const opp = app.db.prepare("SELECT * FROM opportunities WHERE email = 'a@example.com'").get();
    assert.equal(opp.kind, 'demo');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM demo_bookings').get().n, 1);
  } finally { await close(); }
});

test('admin sees bookings, adds a meeting link, moves the slot, and a cancelled slot opens up again', async () => {
  const { call, close } = await start();
  try {
    const slots = (await call('GET', '/api/demo/slots')).json.slots;
    const slot = { date: slots[3].date, time: slots[3].times[0] };
    await call('POST', '/api/demo/book', person('a@example.com', slot));
    const list = (await call('GET', '/admin/api/demos?when=upcoming', undefined, true)).json;
    assert.equal(list.demos.length, 1);
    assert.equal(list.counts.booked, 1);
    const id = list.demos[0].id;
    assert.equal((await call('PATCH', '/admin/api/demos/' + id, { meetingLink: 'javascript:alert(1)' }, true)).status, 400);
    const ok = await call('PATCH', '/admin/api/demos/' + id, { status: 'confirmed', meetingLink: 'https://meet.google.com/abc', assignedTo: 'Manish', time: slots[3].times[1] }, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.demo.slot_time, slots[3].times[1]);
    assert.equal((await call('PATCH', '/admin/api/demos/' + id, { status: 'cancelled' }, true)).status, 200);
    const again = (await call('GET', '/api/demo/slots')).json.slots.find(d => d.date === slot.date);
    assert.ok(again.times.includes(slots[3].times[1]));
    assert.equal((await call('GET', '/admin/api/demos')).status, 401);
  } finally { await close(); }
});

test('checkSlot works in India time', () => {
  const noon = Date.parse('2026-11-04T06:30:00Z');   // 12:00 IST on a Wednesday
  assert.equal(demos.checkSlot('2026-11-04', '12:00', noon) !== '', true);   // inside the two-hour notice
  assert.equal(demos.checkSlot('2026-11-04', '15:00', noon), '');
  assert.equal(demos.checkSlot('2026-11-08', '10:00', noon) !== '', true);   // Sunday
  assert.equal(demos.checkSlot('2026-12-30', '10:00', noon) !== '', true);   // too far ahead
});
