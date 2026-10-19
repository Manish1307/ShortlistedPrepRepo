'use strict';
// The career toolkit's AI call (careerai.js): Gemini with little thinking, a cut-off answer asked for again with more
// room, a short rate limit waited out, the next model when one is busy, and a clear message when the day's quota is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { completeJson } = require('../admin/lib/careerai');

/** A database with one default key per provider given, and a vault that stores keys as they are. */
function ctxWith(providers = ['gemini']) {
  const keys = Object.fromEntries(providers.map((p, i) => [p, { id: i + 1, provider: p, key_enc: p + '-key' }]));
  const db = { prepare: sql => ({ get: provider => (/FROM api_keys/.test(sql) ? keys[provider] : undefined), run: () => {} }) };
  return { db, vault: { decrypt: v => v }, upstream: { gemini: 'https://gemini.test/models', groq: 'https://groq.test/v1' } };
}
const ok = (obj, extra = {}) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 }, ...extra } });
const cut = { status: 200, body: { candidates: [{ content: { parts: [{ text: '{"score": 7' }] }, finishReason: 'MAX_TOKENS' }] } };
const tooMany = (delay, message = 'Resource has been exhausted') => ({ status: 429, body: { error: { message, details: delay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] : [] } } });

/** Answer each request with the next reply in the list; records what was asked. */
async function withReplies(replies, fn) {
  const real = global.fetch, seen = [], warn = console.warn;
  global.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const r = replies.shift() || { status: 503, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  console.warn = () => {};
  try { return await fn(seen); } finally { global.fetch = real; console.warn = warn; }
}
const ask = ctx => completeJson(ctx, { system: 'S', user: 'U', maxTokens: 4000 });

test('Gemini is asked to think little, so the JSON answer fits', () => withReplies([ok({ a: 1 })], async seen => {
  assert.deepEqual(await ask(ctxWith()), { a: 1 });
  assert.deepEqual(seen[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 4000);
}));

test('an answer cut off at its token limit is asked for again with more room', () => withReplies([cut, cut, ok({ score: 7 })], async seen => {
  assert.deepEqual(await ask(ctxWith()), { score: 7 });
  assert.deepEqual(seen.map(s => s.body.generationConfig.maxOutputTokens), [4000, 8000, 16000]);
  assert.ok(seen.every(s => /gemini-3\.8-flash/.test(s.url)));   // the same model, not "busy"
}));

test('a model that refuses the thinking option is asked again without it', () => withReplies([{ status: 400, body: { error: { message: 'thinking not supported' } } }, ok({ b: 2 })], async seen => {
  assert.deepEqual(await ask(ctxWith()), { b: 2 });
  assert.equal(seen[1].body.generationConfig.thinkingConfig, undefined);
}));

test('a short rate limit is waited out once; a longer one moves to the next model', async () => {
  await withReplies([tooMany('0.05s'), ok({ c: 3 })], async seen => {
    assert.deepEqual(await ask(ctxWith()), { c: 3 });
    assert.equal(seen.length, 2);
    assert.ok(seen.every(s => /gemini-3\.8-flash/.test(s.url)));
  });
  await withReplies([tooMany('40s'), ok({ d: 4 })], async seen => {
    assert.deepEqual(await ask(ctxWith()), { d: 4 });
    assert.match(seen[1].url, /gemini-3\.5-flash:/);
  });
});

test('when every model is busy: Groq, then a clear message; the day\'s quota says so', async () => {
  await withReplies([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { status: 200, body: { choices: [{ message: { content: '{"e":5}' } }] } }], async seen => {
    assert.deepEqual(await ask(ctxWith(['gemini', 'groq'])), { e: 5 });
    assert.equal(seen.filter(s => /gemini\.test/.test(s.url)).length, 3);
  });
  await withReplies([], async () => {
    await assert.rejects(ask(ctxWith()), { status: 502, message: /busy right now/ });
  });
  const day = () => tooMany('3600s', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 250, GenerateRequestsPerDayPerProjectPerModel');
  await withReplies([day(), day(), day()], async seen => {
    await assert.rejects(ask(ctxWith()), { status: 503, message: /Today's AI limit has been reached/ });
    assert.equal(seen.length, 3);                                    // no waiting on a daily limit
  });
});
