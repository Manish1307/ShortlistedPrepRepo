'use strict';
// AI proxy: ShortlistPrep.AI sends its AI requests to the licence server, which adds the licence's Groq / Gemini key, so no
// key reaches the computer. A fake Groq / Gemini records what the server forwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { Limiter } = require('../admin/lib/auth');
const licences = require('../admin/lib/licence');
const aikeys = require('../admin/lib/aikeys');
const { TokenSigner } = require('../admin/lib/aiproxy');
const { LicenceClient } = require('../src/licence/client');
const { ProxyAnswerer } = require('../src/ai/proxy');
const { GroqAnswerer } = require('../src/ai/groq');

const GROQ = 'gsk_' + 'p'.repeat(40) + 'PPPP';
const GEMINI = 'AIza' + 'q'.repeat(35) + 'QQQQ';
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

/** A fake Groq + Gemini: records each request; answers stream as SSE like Groq's. */
async function fakeUpstream() {
  const seen = [];
  let reply = null;   // optional override: (req, body) => {status, body}
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (reply) { const r = reply(req, body); res.writeHead(r.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r.body)); }
      if (req.url === '/groq/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile', owned_by: 'x' }] })); }
      if (req.url.startsWith('/gemini/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '["What is a closure?"]' }] } }] }));
      }
      if (body && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const piece of ['A closure ', 'keeps its ', 'variables.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '["Why?"]' } }] }));
    });
  });
  const base = await listen(server);
  return { base, seen, setReply: f => { reply = f; }, close: () => new Promise(r => server.close(r)) };
}

async function start({ proxyLimiters } = {}) {
  const up = await fakeUpstream();
  const app = createApp({ dataDir: tmp('cc-aiproxy-'), aiUpstream: { groq: up.base + '/groq', gemini: up.base + '/gemini' }, proxyLimiters });
  const base = await listen(app.server);
  aikeys.addKey(app.db, app.vault, { provider: 'groq', label: 'Groq main', key: GROQ });
  aikeys.addKey(app.db, app.vault, { provider: 'gemini', label: 'Gemini main', key: GEMINI });
  const customer = app.db.prepare("INSERT INTO customers (email, created_at) VALUES ('t@example.com', datetime('now'))").run().lastInsertRowid;
  const lic = licences.createLicence(app.db, { customerId: customer, plan: 'personal', days: 365 });
  const deviceId = crypto.randomBytes(16).toString('hex');
  await fetch(base + '/api/licence/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: lic.key, deviceId }) });
  const config = body => fetch(base + '/api/app/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: lic.key, deviceId, ...body }) })
    .then(async r => ({ status: r.status, json: await r.json() }));
  const grant = async () => (await config({ proxy: true })).json.aiProxy;
  const call = (pathname, token, body) => fetch(base + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answerer = async (opts = {}) => {
    const g = await grant();
    return new ProxyAnswerer({ serverUrl: base, getToken: async () => g.token, services: g.services, retryDelayMs: 0, ...opts });
  };
  return { app, base, up, lic, deviceId, config, grant, call, answerer, stop: async () => { await app.close(); await up.close(); } };
}
async function withServer(opts, fn) { if (!fn) { fn = opts; opts = {}; } const s = await start(opts); try { await fn(s); } finally { await s.stop(); } }

const chat = { model: 'llama-3.3-70b-versatile', stream: false, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };

test('an app that asks for the proxy gets a short-lived token and which services it covers, never the keys', () => withServer(async s => {
  const res = await s.config({ proxy: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.ai, {});
  assert.deepEqual(res.json.aiProxy.services, { groq: true, gemini: true });
  assert.ok(Date.parse(res.json.aiProxy.expiresAt) > Date.now());
  assert.ok(!JSON.stringify(res.json).includes(GROQ) && !JSON.stringify(res.json).includes(GEMINI));
  // older apps still get the keys (unless AI_KEY_HANDOUT=off)
  assert.equal((await s.config({})).json.ai.groq.apiKey, GROQ);
  process.env.AI_KEY_HANDOUT = 'off';
  try { assert.deepEqual((await s.config({})).json.ai, {}); } finally { delete process.env.AI_KEY_HANDOUT; }
}));

test('answers stream through the proxy with the server key, and the request is the one Groq would get directly', () => withServer(async s => {
  const proxy = await s.answerer({ subject: 'JavaScript' });
  const deltas = [];
  const out = await proxy.answer({ question: 'What is a closure?', context: ['we covered scope'], onDelta: d => deltas.push(d) });
  assert.equal(out.text, 'A closure keeps its variables.');
  assert.equal(deltas.join(''), 'A closure keeps its variables.');
  const sent = s.up.seen.at(-1);
  assert.equal(sent.url, '/groq/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer ' + GROQ);

  // the same question asked straight to Groq with a key: identical body, so identical answers
  let direct;
  const groq = new GroqAnswerer({ apiKey: 'gsk_local', subject: 'JavaScript', fetchImpl: async (url, init) => { direct = JSON.parse(init.body); throw Object.assign(new Error('stop'), { status: 400 }); } });
  await groq.answer({ question: 'What is a closure?', context: ['we covered scope'] }).catch(() => {});
  assert.deepEqual(sent.body, direct);
}));

test('question lists and screenshots go through the proxy; Gemini gets the Gemini key and the model', () => withServer(async s => {
  const proxy = await s.answerer();
  assert.deepEqual(await proxy.extractQuestions({ text: 'why is that' }), ['Why?']);
  const list = await proxy.readScreen({ image: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
  assert.deepEqual(list, ['What is a closure?']);
  const sent = s.up.seen.at(-1);
  assert.match(sent.url, /^\/gemini\/gemini-[\w.-]+:generateContent$/);
  assert.equal(sent.headers['x-goog-api-key'], GEMINI);
  assert.equal(sent.body.contents[0].parts[0].inline_data.data, Buffer.from('png').toString('base64'));
  // without a Gemini key on the server, screenshots use Groq's picture models through the proxy
  proxy.setServices({ groq: true, gemini: false });
  await proxy.readScreen({ image: 'aGk=', mimeType: 'image/png' });
  assert.equal(s.up.seen.at(-1).url, '/groq/chat/completions');
  assert.equal(s.up.seen.at(-1).body.messages[1].content[1].type, 'image_url');
}));

test('the proxy refuses missing, forged and expired tokens, revoked licences and removed computers', () => withServer(async s => {
  const g = await s.grant();
  assert.equal((await s.call('/api/ai/answer', null, chat)).status, 401);
  // without a token a large body is refused before it is read (401, not "too large")
  assert.equal((await s.call('/api/ai/read-screen?model=gemini-3.5-flash', null, { pad: 'x'.repeat(7 * 1024 * 1024) })).status, 401);
  assert.equal((await s.call('/api/ai/answer', g.token.slice(0, -2) + 'xx', chat)).status, 401);
  const old = new TokenSigner(s.app.vault.secret, { clock: () => Date.now() - 2 * 60 * 60 * 1000 }).issue({ licenceId: s.lic.id, deviceId: s.deviceId });
  assert.equal((await s.call('/api/ai/answer', old.token, chat)).status, 401, 'expired');
  const other = new TokenSigner(crypto.randomBytes(32)).issue({ licenceId: s.lic.id, deviceId: s.deviceId });
  assert.equal((await s.call('/api/ai/answer', other.token, chat)).status, 401, 'signed with another secret');
  assert.equal((await s.call('/api/ai/answer', g.token, chat)).status, 200);

  licences.removeDevice(s.app.db, { key: s.lic.key, deviceId: s.deviceId });
  assert.equal((await s.call('/api/ai/answer', g.token, chat)).status, 403, 'computer removed');
  s.app.db.prepare("INSERT INTO devices (licence_id, device_id, name, app_version, first_seen, last_seen) VALUES (?,?,'','',datetime('now'),datetime('now'))").run(s.lic.id, s.deviceId);
  s.app.db.prepare("UPDATE licences SET status = 'revoked' WHERE id = ?").run(s.lic.id);
  assert.equal((await s.call('/api/ai/answer', g.token, chat)).status, 403, 'licence revoked');
  assert.equal(s.up.seen.length, 1, 'only the one allowed request reached Groq');
}));

test('requests are rate-limited per licence', () => withServer({
  proxyLimiters: { answer: [new Limiter({ max: 2, windowMs: 60000 })], screen: [new Limiter({ max: 1, windowMs: 60000 })], models: [new Limiter({ max: 1, windowMs: 60000 })] },
}, async s => {
  const { token } = await s.grant();
  assert.deepEqual([(await s.call('/api/ai/answer', token, chat)).status, (await s.call('/api/ai/answer', token, chat)).status], [200, 200]);
  const blocked = await s.call('/api/ai/answer', token, chat);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, 'rate');
  // screenshots have their own allowance
  const shot = { contents: [{ role: 'user', parts: [{ text: 'read' }] }] };
  assert.equal((await s.call('/api/ai/read-screen?model=gemini-3.5-flash', token, shot)).status, 200);
  assert.equal((await s.call('/api/ai/read-screen?model=gemini-3.5-flash', token, shot)).status, 429);
}));

test('only the fields the app uses are forwarded, reply length is capped, and odd models are refused', () => withServer(async s => {
  const { token } = await s.grant();
  await s.call('/api/ai/answer', token, { ...chat, max_tokens: 100000, tools: [{ type: 'function' }], n: 5 });
  const sent = s.up.seen.at(-1).body;
  assert.equal(sent.max_tokens, 2000);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.n, undefined);
  assert.equal((await s.call('/api/ai/answer', token, { ...chat, model: '../../evil' })).status, 400);
  assert.equal((await s.call('/api/ai/read-screen?model=../models', token, { contents: [{}] })).status, 400);
  await s.call('/api/ai/read-screen?model=gemini-3.5-flash', token, { contents: [{ parts: [] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 99999 } });
  assert.equal(s.up.seen.at(-1).body.tools, undefined);
  assert.equal(s.up.seen.at(-1).body.generationConfig.maxOutputTokens, 4096);
  // a screenshot is larger than the normal 100 KB request limit
  const big = 'A'.repeat(3 * 1024 * 1024);
  assert.equal((await s.call('/api/ai/read-screen?model=gemini-3.5-flash', token, { contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: big } }] }] })).status, 200);
  // the model list sends names only
  assert.deepEqual(await (await s.call('/api/ai/models', token)).json(), { object: 'list', data: [{ id: 'llama-3.3-70b-versatile' }] });
}));

test('a key the AI service rejects is reported as a server problem (502), not as an expired token', () => withServer(async s => {
  const { token } = await s.grant();
  s.up.setReply(() => ({ status: 401, body: { error: { message: 'Invalid API Key' } } }));
  const res = await s.call('/api/ai/answer', token, chat);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.message, 'Invalid API Key');
}));

test('an expired token is renewed once and the request repeated', () => withServer(async s => {
  const fresh = await s.grant();
  const stale = new TokenSigner(s.app.vault.secret, { clock: () => Date.now() - 2 * 60 * 60 * 1000 }).issue({ licenceId: s.lic.id, deviceId: s.deviceId });
  const asked = [];
  const proxy = new ProxyAnswerer({ serverUrl: s.base, services: fresh.services, getToken: async renew => { asked.push(renew); return renew ? fresh.token : stale.token; } });
  const out = await proxy.answer({ question: 'What is a closure?' });
  assert.equal(out.text, 'A closure keeps its variables.');
  assert.deepEqual(asked, [false, true]);
  // no token at all: a clear error, nothing sent
  const none = new ProxyAnswerer({ serverUrl: s.base, services: fresh.services, getToken: async () => null });
  await assert.rejects(none.answer({ question: 'x' }), /could not get AI access/);
}));

test('the licence client asks for the proxy and falls back to keys on a server without it', () => withServer(async s => {
  const dir = tmp('cc-aiproxy-app-');
  const app = new LicenceClient({ serverUrl: s.base, publicKeyPem: s.app.signer.publicKeyPem, dir, deviceId: s.deviceId });
  assert.equal((await app.activate(s.lic.key)).ok, true);
  const cfg = await app.appConfig({ proxy: true });
  assert.deepEqual(cfg.ai, {});
  assert.deepEqual(cfg.proxy.services, { groq: true, gemini: true });
  assert.ok(cfg.proxy.expiresAt > Date.now());
  // without asking (Mock Interview), keys as before
  assert.equal((await app.appConfig()).ai.groq.apiKey, GROQ);
  assert.equal((await app.appConfig()).proxy, null);
  // an older server ignores "proxy" and sends keys: the app uses them
  const old = new LicenceClient({ serverUrl: s.base, publicKeyPem: s.app.signer.publicKeyPem, dir, deviceId: s.deviceId,
    fetchImpl: (url, o) => fetch(url, { ...o, body: JSON.stringify({ ...JSON.parse(o.body), proxy: undefined }) }) });
  const fallback = await old.appConfig({ proxy: true });
  assert.equal(fallback.proxy, null);
  assert.equal(fallback.ai.groq.apiKey, GROQ);
}));
