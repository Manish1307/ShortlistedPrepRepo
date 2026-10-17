'use strict';
// Live Class conversations: the app saves each finished class on the licence server (with the AI proxy's access
// token), and the dashboard lists them by date and time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const licences = require('../admin/lib/licence');
const { cleanConversation } = require('../admin/lib/conversations');
const { ConversationOutbox } = require('../src/conversations/outbox');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: tmp('cc-conv-') });
  const base = await listen(app.server);
  const customer = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('teacher@example.com', 'Asha Teacher', datetime('now'))").run().lastInsertRowid;
  const lic = licences.createLicence(app.db, { customerId: customer, plan: 'personal', days: 365 });
  const deviceId = crypto.randomBytes(16).toString('hex');
  await fetch(base + '/api/licence/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: lic.key, deviceId, deviceName: 'CLASSROOM-PC' }) });
  const token = async () => {
    const r = await fetch(base + '/api/app/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: lic.key, deviceId, deviceName: 'CLASSROOM-PC', proxy: true }) });
    return (await r.json()).aiProxy.token;
  };
  const upload = (tok, body) => fetch(base + '/api/app/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json() }));

  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run('boss@example.com', 'Boss', 'owner', hashPassword('correct-horse-battery'));
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run('help@example.com', 'Help', 'support', hashPassword('correct-horse-battery'));
  const admin = async email => {
    let cookie = '';
    const call = async (method, url) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) },
        body: method === 'POST' ? JSON.stringify({ email, password: 'correct-horse-battery' }) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, json: await res.json() };
    };
    await call('POST', '/admin/api/login');
    return { get: url => call('GET', url), del: url => call('DELETE', url) };
  };
  return { app, base, lic, deviceId, token, upload, admin, stop: () => app.close() };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

const sample = (over = {}) => ({
  uid: crypto.randomUUID(),
  startedAt: '2026-10-16T09:00:00.000Z', endedAt: '2026-10-16T09:45:30.000Z',
  transcript: [{ at: '2026-10-16T09:01:00.000Z', text: 'Good morning everyone.' }, { at: '2026-10-16T09:02:10.000Z', text: 'What is a closure in JavaScript?' }],
  items: [
    { at: '2026-10-16T09:02:12.000Z', question: 'What is a closure in JavaScript?', answer: 'A function that keeps the variables around it.', status: 'done', source: 'speech', vote: 1 },
    { at: '2026-10-16T09:44:00.000Z', question: 'Is there homework?', answer: '', status: 'unanswered' },
  ],
  ...over,
});

test('the app saves a finished class and the dashboard shows it with its questions and transcript', async () => {
  await withServer(async s => {
    const tok = await s.token();
    const c = sample();
    const r = await s.upload(tok, c);
    assert.equal(r.status, 201);
    assert.ok(r.json.id);

    const boss = await s.admin('boss@example.com');
    const list = (await boss.get('/admin/api/conversations')).json.conversations;
    assert.equal(list.length, 1);
    assert.equal(list[0].customer_email, 'teacher@example.com');
    assert.equal(list[0].device_name, 'CLASSROOM-PC');
    assert.equal(list[0].question_count, 2);
    assert.equal(list[0].duration_sec, 45 * 60 + 30);
    assert.equal(list[0].first_question, 'What is a closure in JavaScript?');

    const d = (await boss.get('/admin/api/conversations/' + r.json.id)).json;
    assert.equal(d.conversation.started_at, c.startedAt);
    assert.equal(d.conversation.licence_key, s.lic.key);
    assert.deepEqual(d.conversation.transcript.map(p => p.text), ['Good morning everyone.', 'What is a closure in JavaScript?']);
    assert.deepEqual(d.items.map(i => [i.position, i.question, i.status, i.vote]), [[1, 'What is a closure in JavaScript?', 'done', 1], [2, 'Is there homework?', 'unanswered', 0]]);
  });
});

test('sending the same class again (a retry) does not make a second copy', async () => {
  await withServer(async s => {
    const tok = await s.token();
    const c = sample();
    const first = await s.upload(tok, c);
    const again = await s.upload(tok, c);
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.id, first.json.id);
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  });
});

test('saving needs a valid token, an active licence and an activated computer', async () => {
  await withServer(async s => {
    assert.equal((await s.upload(null, sample())).status, 401);
    assert.equal((await s.upload('forged.token', sample())).status, 401);
    const tok = await s.token();
    s.app.db.prepare("UPDATE licences SET status = 'revoked' WHERE id = ?").run(s.lic.id);
    assert.equal((await s.upload(tok, sample())).status, 403);
    s.app.db.prepare("UPDATE licences SET status = 'active' WHERE id = ?").run(s.lic.id);
    s.app.db.prepare('DELETE FROM devices WHERE licence_id = ?').run(s.lic.id);
    assert.equal((await s.upload(tok, sample())).status, 403);
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  });
});

test('the dashboard filters by day and searches questions, answers and what was heard', async () => {
  await withServer(async s => {
    const tok = await s.token();
    await s.upload(tok, sample());
    await s.upload(tok, sample({ startedAt: '2026-10-14T15:00:00.000Z', endedAt: '2026-10-14T15:30:00.000Z',
      transcript: [{ at: '2026-10-14T15:01:00.000Z', text: 'Today we cover recursion.' }], items: [{ question: 'What is recursion?', answer: 'A function calling itself.', status: 'done' }] }));
    const boss = await s.admin('boss@example.com');
    const q = async query => (await boss.get('/admin/api/conversations?' + query)).json.conversations.map(c => c.started_at.slice(0, 10));
    assert.deepEqual(await q(''), ['2026-10-16', '2026-10-14']);   // newest first
    assert.deepEqual(await q('from=2026-10-15'), ['2026-10-16']);
    assert.deepEqual(await q('to=2026-10-14'), ['2026-10-14']);
    assert.deepEqual(await q('from=2026-10-14&to=2026-10-14'), ['2026-10-14']);
    assert.deepEqual(await q('q=recursion'), ['2026-10-14']);
    assert.deepEqual(await q('q=' + encodeURIComponent('keeps the variables')), ['2026-10-16']);
    assert.deepEqual(await q('q=Good%20morning'), ['2026-10-16']);
    assert.equal((await boss.get('/admin/api/conversations?from=16-10-2026')).status, 400);
  });
});

test('only owners and admins can delete a conversation; its questions go with it', async () => {
  await withServer(async s => {
    const { json } = await s.upload(await s.token(), sample());
    const help = await s.admin('help@example.com');
    assert.equal((await help.get('/admin/api/conversations/' + json.id)).status, 200);   // support can read
    assert.equal((await help.del('/admin/api/conversations/' + json.id)).status, 403);
    const boss = await s.admin('boss@example.com');
    assert.equal((await boss.del('/admin/api/conversations/' + json.id)).status, 200);
    assert.equal((await boss.get('/admin/api/conversations/' + json.id)).status, 404);
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM conversation_items').get().n, 0);
  });
});

test('what the app sends is checked and trimmed', () => {
  assert.throws(() => cleanConversation({ uid: 'x' }), /Bad conversation id/);
  const c = cleanConversation({
    uid: 'abcdefgh-1234', startedAt: '2026-10-16T10:00:00Z', endedAt: '2026-10-16T09:00:00Z',
    transcript: [{ text: '  ' }, { text: 'hello', at: 'not a date' }],
    items: [{ question: '' }, { question: 'Q?', status: 'thinking', vote: 5, source: 'sp<e>ech' }],
  });
  assert.equal(c.startedAt, c.endedAt);           // a start after the end is moved to the end
  assert.deepEqual(c.transcript, [{ at: c.startedAt, text: 'hello' }]);
  assert.deepEqual(c.items.map(i => [i.question, i.status, i.vote, i.source]), [['Q?', 'unanswered', 0, 'speech']]);
});

test('outbox: a class waits on the computer while offline and is sent when the server is back', async () => {
  await withServer(async s => {
    const dir = tmp('cc-outbox-');
    let online = false;
    let tokenCalls = 0;
    const outbox = new ConversationOutbox({
      dir, serverUrl: s.base, getToken: async () => { tokenCalls++; return s.token(); },
      fetchImpl: (url, init) => (online ? fetch(url, init) : Promise.reject(new Error('offline'))),
    });
    outbox.add(sample());
    const offline = await outbox.flush();
    assert.equal(offline.sent, 0);
    assert.equal(offline.waiting, 1);
    assert.match(offline.error, /Cannot reach the server/);
    assert.equal(outbox.pending().length, 1);

    online = true;
    outbox.add(sample());
    const back = await outbox.flush();
    assert.deepEqual(back, { sent: 2, waiting: 0, error: '' });
    assert.equal(outbox.pending().length, 0);
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2);
    assert.ok(tokenCalls >= 2);
  });
});

test('outbox: an expired token is renewed once; without a licence the class stays on the computer', async () => {
  await withServer(async s => {
    const renewed = [];
    const outbox = new ConversationOutbox({ dir: tmp('cc-outbox-'), serverUrl: s.base, getToken: async renew => { renewed.push(renew); return renew ? s.token() : 'expired.token'; } });
    outbox.add(sample());
    assert.deepEqual(await outbox.flush(), { sent: 1, waiting: 0, error: '' });
    assert.deepEqual(renewed, [false, true]);

    const none = new ConversationOutbox({ dir: tmp('cc-outbox-'), serverUrl: s.base, getToken: async () => null });
    none.add(sample());
    const r = await none.flush();
    assert.equal(r.waiting, 1);
    assert.match(r.error, /No active licence/);
  });
});

test('outbox: a class the server will never accept is dropped so it does not block the others', async () => {
  await withServer(async s => {
    const dir = tmp('cc-outbox-');
    const outbox = new ConversationOutbox({ dir, serverUrl: s.base, getToken: () => s.token() });
    fs.writeFileSync(path.join(dir, 'aaaaaaaa-bad.json'), JSON.stringify({ uid: 'no' }));   // the server answers 400
    fs.writeFileSync(path.join(dir, 'bbbbbbbb-damaged.json'), '{not json');
    outbox.add(sample());
    const r = await outbox.flush();
    assert.deepEqual(r, { sent: 1, waiting: 0, error: '' });
    assert.equal(outbox.pending().length, 0);
  });
});
