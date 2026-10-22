'use strict';
// Topics and resume per customer: set in the admin dashboard, sent to ShortlistPrep.AI with the licence check, and put
// into the AI prompts so the answers stay in that area.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const licences = require('../admin/lib/licence');
const aikeys = require('../admin/lib/aikeys');
const { cleanTopics } = require('../admin/lib/profiles');
const { LicenceClient, cleanProfile } = require('../src/licence/client');
const { buildUserMessage } = require('../src/ai/answerer');
const { buildExtractMessage, buildScreenMessage, formatProfile } = require('../src/ai/framing');
const { AnswerRouter } = require('../src/ai/router');
const { GroqAnswerer } = require('../src/ai/groq');
const { GeminiAnswerer } = require('../src/ai/gemini');
const { Answerer } = require('../src/ai/answerer');
const { ProxyAnswerer } = require('../src/ai/proxy');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const PROFILE = { topics: ['Power Apps', 'Dataverse security'], resume: 'Asha Rao. 6 years as a Power Platform developer at Contoso.' };

// ---- the prompts ----

test('answers get the topics and the resume; finding questions and reading screenshots get only the topics', () => {
  const answer = buildUserMessage({ subject: 'Power Platform', context: [], question: 'How do I share an app?', profile: PROFILE });
  assert.match(answer, /Topics to focus on .*: Power Apps; Dataverse security/);
  assert.match(answer, /from their resume/);
  assert.match(answer, /6 years as a Power Platform developer/);

  for (const msg of [buildExtractMessage({ subject: 'x', context: [], text: 'hi', profile: PROFILE }), buildScreenMessage({ subject: 'x', profile: PROFILE })]) {
    assert.match(msg, /Topics to focus on/);
    assert.doesNotMatch(msg, /resume/);
  }
  // nothing set: the prompts are exactly as before
  assert.equal(buildUserMessage({ subject: 's', context: [], question: 'q' }), buildUserMessage({ subject: 's', context: [], question: 'q', profile: null }));
  assert.deepEqual(formatProfile(null), []);
  assert.deepEqual(formatProfile({ topics: [], resume: '' }), []);
});

test('a long resume is cut to what the AI reads', () => {
  const lines = formatProfile({ topics: [], resume: 'x'.repeat(9000) });
  assert.equal(lines[1].length, 6001);   // 6000 characters and "…"
});

test('every AI provider takes the profile, through the router and the server proxy', () => {
  const groq = new GroqAnswerer({ apiKey: 'k' }), gemini = new GeminiAnswerer({ apiKey: 'k' }), claude = new Answerer({ apiKey: '' });
  const proxy = new ProxyAnswerer({ serverUrl: 'http://x', getToken: async () => 't' });
  const router = new AnswerRouter({ groq, gemini, claude, proxy, provider: 'groq' });
  router.setProfile(PROFILE);
  for (const p of [groq, gemini, claude, proxy.groq, proxy.gemini]) assert.deepEqual(p.profile, PROFILE);
  router.setProfile(null);
  assert.equal(groq.profile, null);
});

test('the Groq request carries the topics and resume', async () => {
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Share it from the app details.' } }] }) + '\n\ndata: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const groq = new GroqAnswerer({ apiKey: 'k', subject: 'Power Platform', fetchImpl });
  groq.setProfile(PROFILE);
  await groq.answer({ question: 'How do I share an app?' });
  const user = sent.messages.find(m => m.role === 'user').content;
  assert.match(user, /Power Apps; Dataverse security/);
  assert.match(user, /Contoso/);
});

// ---- the server and the dashboard ----

async function start({ gemini } = {}) {
  const app = createApp({ dataDir: tmp('cc-prof-'), aiUpstream: gemini ? { gemini } : undefined });
  const base = await listen(app.server);
  const customer = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('asha@example.com', 'Asha', datetime('now'))").run().lastInsertRowid;
  const lic = licences.createLicence(app.db, { customerId: customer, plan: 'personal', days: 365 });
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
  return { app, base, customer, lic, admin, stop: () => app.close() };
}
async function withServer(opts, fn) { if (!fn) { fn = opts; opts = {}; } const s = await start(opts); try { await fn(s); } finally { await s.stop(); } }

test('topics are cleaned: one per line or comma separated, no duplicates, limited', () => {
  assert.deepEqual(cleanTopics('Power Apps\n power  apps, Dataverse;\n\nReact hooks'), ['Power Apps', 'Dataverse', 'React hooks']);
  assert.deepEqual(cleanTopics(['A', ' ', 'B']), ['A', 'B']);
  assert.throws(() => cleanTopics(Array.from({ length: 31 }, (_, i) => 'T' + i)), /At most 30/);
  assert.throws(() => cleanTopics('x'.repeat(101)), /too long/);
});

test('the dashboard saves a customer\'s topics and resume, and lists every customer', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    const empty = (await boss.get(`/admin/api/customers/${s.customer}/profile`)).json;
    assert.deepEqual(empty.profile.topics, []);

    const saved = await boss.post(`/admin/api/customers/${s.customer}/profile`, { topics: 'Power Apps\nDataverse security', resume: PROFILE.resume, resumeName: 'asha.pdf' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.profile.topics, ['Power Apps', 'Dataverse security']);
    assert.equal(saved.json.profile.resumeName, 'asha.pdf');
    assert.equal(saved.json.profile.updatedBy, 'boss@example.com');

    const list = (await boss.get('/admin/api/profiles')).json.customers;
    assert.equal(list[0].email, 'asha@example.com');
    assert.deepEqual(list[0].topics, ['Power Apps', 'Dataverse security']);
    assert.equal(list[0].resume_chars, PROFILE.resume.length);

    // support may change it too; saving again replaces it
    const help = await s.admin('help@example.com');
    assert.equal((await help.post(`/admin/api/customers/${s.customer}/profile`, { topics: ['React'], resume: '' })).status, 200);
    const now = (await boss.get(`/admin/api/customers/${s.customer}/profile`)).json.profile;
    assert.deepEqual([now.topics, now.resume, now.resumeName], [['React'], '', '']);
    assert.equal((await boss.post('/admin/api/customers/999/profile', { topics: 'x' })).status, 404);
    assert.equal((await boss.post(`/admin/api/customers/${s.customer}/profile`, { resume: 'x'.repeat(20001) })).status, 400);
  });
});

test('ShortlistPrep.AI receives the topics and resume with its licence check', async () => {
  await withServer(async s => {
    const dir = tmp('cc-prof-app-');
    const client = new LicenceClient({ serverUrl: s.base, publicKeyPem: s.app.signer.publicKeyPem, dir, deviceId: crypto.randomBytes(16).toString('hex') });
    assert.equal((await client.activate(s.lic.key)).ok, true);
    assert.equal((await client.appConfig({ proxy: true })).profile, null);   // nothing set yet

    const boss = await s.admin('boss@example.com');
    await boss.post(`/admin/api/customers/${s.customer}/profile`, { topics: PROFILE.topics, resume: PROFILE.resume });
    assert.deepEqual((await client.appConfig({ proxy: true })).profile, PROFILE);
    assert.deepEqual((await client.appConfig()).profile, PROFILE);           // older apps (keys instead of the proxy) too

    // offline: undefined, so ShortlistPrep.AI keeps the profile from the last check
    const offline = new LicenceClient({ serverUrl: s.base, publicKeyPem: s.app.signer.publicKeyPem, dir, deviceId: client.deviceId, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal((await offline.appConfig({ proxy: true })).profile, undefined);
  });
});

test('cleanProfile keeps only topics and resume text', () => {
  assert.equal(cleanProfile(null), null);
  assert.equal(cleanProfile({ topics: [], resume: '' }), null);
  assert.deepEqual(cleanProfile({ topics: [' A ', '', 3], resume: 'cv', extra: 1 }), { topics: ['A', '3'], resume: 'cv' });
});

test('a resume PDF is read into text by Gemini with the default key; without one the admin is told to paste it', async () => {
  let seen = null;
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen = { url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Asha Rao\n- Power Apps developer' }] } }] }));
    });
  });
  const gemini = await listen(fake);
  try {
    await withServer({ gemini }, async s => {
      const boss = await s.admin('boss@example.com');
      const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
      const none = await boss.post('/admin/api/resume-text', { data: pdf });
      assert.equal(none.status, 400);
      assert.match(none.json.error, /default Gemini key/);

      const key = 'AIza' + 'r'.repeat(35) + 'RRRR';
      aikeys.addKey(s.app.db, s.app.vault, { provider: 'gemini', label: 'Gemini', key, makeDefault: true });
      const r = await boss.post('/admin/api/resume-text', { data: pdf });
      assert.equal(r.status, 200);
      assert.equal(r.json.text, 'Asha Rao\n- Power Apps developer');
      assert.equal(seen.key, key);
      assert.match(seen.url, /gemini-3\.5-flash:generateContent$/);
      assert.equal(seen.body.contents[0].parts[0].inline_data.mime_type, 'application/pdf');
      assert.equal((await boss.post('/admin/api/resume-text', { data: '<not base64>' })).status, 400);
    });
  } finally { await new Promise(r => fake.close(r)); }
});
