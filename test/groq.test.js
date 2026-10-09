'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GroqAnswerer } = require('../src/ai/groq');
const { AnswerRouter } = require('../src/ai/router');

function sse(...pieces) {
  const lines = pieces.map(p => `data: ${JSON.stringify({ choices: [{ delta: p === null ? {} : { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(lines);
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 9) c.enqueue(bytes.slice(i, i + 9)); c.close(); } });
}
async function withFetch(impl, fn) {
  const real = global.fetch; global.fetch = impl;
  try { return await fn(); } finally { global.fetch = real; }
}

test('Groq: streams the answer, sends the key as a bearer token, includes earlier answers', async () => {
  let seen;
  const deltas = [];
  const r = await withFetch(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return new Response(sse('A web service ', 'lets programs talk.'), { status: 200 }); },
    () => new GroqAnswerer({ apiKey: 'gsk_test' }).answer({
      question: 'And how do I call it?', previous: [{ question: 'What is a web service?', answer: 'It lets programs talk.' }],
      onDelta: d => deltas.push(d),
    }));
  assert.equal(r.text, 'A web service lets programs talk.');
  assert.equal(deltas.join(''), r.text);
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer gsk_test');
  assert.equal(seen.body.stream, true);
  assert.match(seen.body.messages[1].content, /Q: What is a web service\?/);
  assert.match(seen.body.messages[0].content, /50 to 90 words/, 'Quick mode asks for short answers');
});

test('Groq: SKIP is not shown; closing offers are trimmed', async () => {
  const skipped = await withFetch(async () => new Response(sse('SKIP'), { status: 200 }),
    () => new GroqAnswerer({ apiKey: 'k' }).answer({ question: 'Can you hear me?', onDelta: () => assert.fail('no output expected') }));
  assert.equal(skipped.skipped, true);
  const trimmed = await withFetch(async () => new Response(sse('It is simple. ', 'Let me know if you want more!'), { status: 200 }),
    () => new GroqAnswerer({ apiKey: 'k' }).answer({ question: 'x' }));
  assert.equal(trimmed.text, 'It is simple.');
});

test('Groq: a rate limit moves to the next model without retrying the same one; a bad key is not retried', async () => {
  const models = [];
  const ok = await withFetch(async (url, init) => {
    const model = JSON.parse(init.body).model; models.push(model);
    return model === 'llama-3.3-70b-versatile' ? new Response(JSON.stringify({ error: { message: 'limit' } }), { status: 429 }) : new Response(sse('Fine.'), { status: 200 });
  }, () => new GroqAnswerer({ apiKey: 'k', retryDelayMs: 1 }).answer({ question: 'x' }));
  assert.equal(ok.text, 'Fine.');
  assert.deepEqual(models, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);

  let calls = 0;
  await withFetch(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }); }, async () => {
    await assert.rejects(new GroqAnswerer({ apiKey: 'bad' }).answer({ question: 'x' }), e => e.status === 401);
  });
  assert.equal(calls, 1);
  await assert.rejects(new GroqAnswerer({}).answer({ question: 'x' }), e => e.code === 'no-key');
});

test('Groq: question tidy-up returns a list; the router can select Groq', async () => {
  const list = await withFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["What is X?","Why Y?"]' } }] }), { status: 200 }),
    () => new GroqAnswerer({ apiKey: 'k' }).extractQuestions({ text: 'what is x and why y' }));
  assert.deepEqual(list, ['What is X?', 'Why Y?']);
  const mk = n => ({ ready: n === 'g', effort: '', setSubject() {}, answer: async () => n });
  const router = new AnswerRouter({ gemini: mk('a'), groq: mk('g'), claude: mk('c'), provider: 'groq' });
  assert.equal(router.ready, true);
  assert.equal(await router.answer({}), 'g');
});

test('Groq: if none of the known model names work, it asks Groq what the key can use and carries on', async () => {
  const asked = [];
  const g = new GroqAnswerer({ apiKey: 'k', retryDelayMs: 1 });
  const r = await withFetch(async (url, init) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'brand-new-chat-model' }, { id: 'meta-llama/llama-guard-4' }] }), { status: 200 });
    const model = JSON.parse(init.body).model;
    asked.push(model);
    return model === 'brand-new-chat-model' ? new Response(sse('Works.'), { status: 200 })
      : new Response(JSON.stringify({ error: { message: 'The model `' + model + '` does not exist or you do not have access to it.' } }), { status: 404 });
  }, () => g.answer({ question: 'x' }));
  assert.equal(r.text, 'Works.');
  assert.deepEqual(asked.slice(-1), ['brand-new-chat-model']);
  assert.ok(!asked.includes('whisper-large-v3') && !asked.includes('meta-llama/llama-guard-4'), 'speech and safety models are never used for chat');
  assert.equal(g.model, 'brand-new-chat-model', 'the working model is remembered');
});

test('Groq: when the key can use no model at all, the error says so', async () => {
  await withFetch(async url => (url.endsWith('/models') ? new Response(JSON.stringify({ data: [] }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: 'The model does not exist or you do not have access to it.' } }), { status: 404 })),
  async () => {
    await assert.rejects(new GroqAnswerer({ apiKey: 'k', retryDelayMs: 1 }).answer({ question: 'x' }), /did not list any model/);
  });
});

test('Groq: the connection test lists models and reports the one that works', async () => {
  const g = new GroqAnswerer({ apiKey: 'k', model: 'llama-3.1-8b-instant' });
  const lines = await withFetch(async (url, init) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'llama-3.3-70b-versatile' }] }), { status: 200 });
    const model = JSON.parse(init.body).model;
    return model === 'llama-3.3-70b-versatile' ? new Response(JSON.stringify({ error: { message: 'The model does not exist or you do not have access to it.' } }), { status: 404 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
  }, () => g.diagnose());
  const text = lines.join('\n');
  assert.match(text, /Models Groq lists for this key \(3\)/);
  assert.match(text, /✗ llama-3\.3-70b-versatile/);
  assert.match(text, /✓ openai\/gpt-oss-20b works/);
  assert.equal(g.model, 'openai/gpt-oss-20b');
});

test('Groq: the connection test explains a rejected key', async () => {
  const lines = await withFetch(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }), () => new GroqAnswerer({ apiKey: 'bad' }).diagnose());
  assert.match(lines.join(' '), /rejected the key/);
  assert.match((await new GroqAnswerer({}).diagnose()).join(' '), /No Groq key is saved/);
});

test('Groq: if every model name fails the same way, the original error is still reported (never undefined)', async () => {
  await withFetch(async url => (url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: 'The model `x` does not exist or you do not have access to it.' } }), { status: 404 })),
  async () => {
    await assert.rejects(new GroqAnswerer({ apiKey: 'k', retryDelayMs: 1 }).answer({ question: 'x' }), e => e && /does not exist/.test(e.message));
  });
});
