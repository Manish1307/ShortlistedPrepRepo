'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiAnswerer, thinkingConfig } = require('../src/ai/gemini');
const { AnswerRouter } = require('../src/ai/router');

function sse(...events) {
  const text = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // deliver in awkward 7-byte pieces to prove that events split across chunks are reassembled
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
}
const part = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text, ...extra }] } }] });

async function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  try { return await fn(); } finally { global.fetch = real; }
}

test('streams text, ignores thought parts, sends key as header', async () => {
  let seen;
  const out = await withFetch(async (url, init) => {
    seen = { url, init };
    return new Response(sse(part('thinking...', { thought: true }), part('The discriminant is '), part('b^2 - 4ac.')), { status: 200 });
  }, async () => {
    const deltas = [];
    const g = new GeminiAnswerer({ apiKey: 'k123' });
    const r = await g.answer({ question: 'What is the discriminant?', context: ['quadratics'], onDelta: d => deltas.push(d) });
    return { r, deltas };
  });
  assert.equal(out.r.text, 'The discriminant is b^2 - 4ac.');
  assert.equal(out.deltas.join(''), out.r.text);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k123');
  assert.ok(!seen.url.includes('k123'), 'key is not put in the URL');
  assert.match(seen.url, /gemini-3.8-flash:streamGenerateContent\?alt=sse/);
});

test('SKIP replies are not shown', async () => {
  const r = await withFetch(async () => new Response(sse(part('SKIP')), { status: 200 }), () =>
    new GeminiAnswerer({ apiKey: 'k' }).answer({ question: 'Can you hear me?', onDelta: () => assert.fail('should not emit') }));
  assert.equal(r.skipped, true);
  assert.equal(r.text, '');
});

test('safety block is reported as refused', async () => {
  const r = await withFetch(async () => new Response(sse({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 }), () =>
    new GeminiAnswerer({ apiKey: 'k' }).answer({ question: 'x' }));
  assert.equal(r.refused, true);
});

test('HTTP errors carry status and message; missing key is flagged', async () => {
  await withFetch(async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }), async () => {
    await assert.rejects(new GeminiAnswerer({ apiKey: 'bad' }).answer({ question: 'x' }), e => e.status === 400 && /API key/.test(e.message));
  });
  await assert.rejects(new GeminiAnswerer({}).answer({ question: 'x' }), e => e.code === 'no-key');
});

test('busy model (503) is retried, then the next model answers', async () => {
  const urls = [];
  const r = await withFetch(async url => {
    urls.push(url);
    if (urls.length <= 2) return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
    return new Response(sse(part('Fine.')), { status: 200 });
  }, () => new GeminiAnswerer({ apiKey: 'k', retryDelayMs: 1 }).answer({ question: 'x' }));
  assert.equal(r.text, 'Fine.');
  assert.equal(urls.length, 3);
  assert.match(urls[2], /gemini-3.5-flash:/);
});

test('a rejected key is not retried', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 403 }); }, async () => {
    await assert.rejects(new GeminiAnswerer({ apiKey: 'k', retryDelayMs: 1 }).answer({ question: 'x' }), e => e.status === 403);
  });
  assert.equal(calls, 1);
});

test('thinking budget follows the thinking-time setting', () => {
  assert.deepEqual(thinkingConfig('gemini-2.5-flash', 'low'), { thinkingBudget: 0 });
  assert.deepEqual(thinkingConfig('gemini-2.5-pro', 'low'), { thinkingBudget: 128 });
  assert.deepEqual(thinkingConfig('gemini-2.5-flash', 'high'), { thinkingBudget: -1 });
  assert.deepEqual(thinkingConfig('gemini-3.8-flash', 'low'), { thinkingLevel: 'minimal' });   // Quick: almost no thinking
  assert.deepEqual(thinkingConfig('gemini-3.8-flash', 'medium'), { thinkingLevel: 'low' });
});

test('router forwards to the selected provider', async () => {
  const mk = name => ({ name, ready: name === 'a', effort: '', setSubject() {}, answer: async () => name });
  const router = new AnswerRouter({ gemini: mk('a'), claude: mk('b'), provider: 'gemini' });
  assert.equal(router.ready, true);
  assert.equal(await router.answer({}), 'a');
  router.setProvider('claude');
  assert.equal(router.ready, false);
  assert.equal(await router.answer({}), 'b');
});

test('extractQuestions returns the framed questions as a list', async () => {
  const { parseQuestionList } = require('../src/ai/framing');
  assert.deepEqual(parseQuestionList('```json\n["What is X?", "Why Y?"]\n```'), ['What is X?', 'Why Y?']);
  assert.deepEqual(parseQuestionList('[]'), []);
  assert.equal(parseQuestionList('no list here'), null);
  let body;
  const out = await withFetch(async (url, init) => {
    body = JSON.parse(init.body);
    assert.match(url, /:generateContent$/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '["What is a web service in .NET?"]' }] } }] }), { status: 200 });
  }, () => new GeminiAnswerer({ apiKey: 'k' }).extractQuestions({ text: 'my question is what is web services in dot net', context: ['REST'] }));
  assert.deepEqual(out, ['What is a web service in .NET?']);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.match(body.contents[0].parts[0].text, /NEW speech:\nmy question is/);
});

test('a rate limit (429) goes to the next model without hammering the same one', async () => {
  const urls = [];
  const r = await withFetch(async url => {
    urls.push(url);
    if (/gemini-3\.8-flash/.test(url)) return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    return new Response(sse(part('Fine.')), { status: 200 });
  }, () => new GeminiAnswerer({ apiKey: 'k', retryDelayMs: 1 }).answer({ question: 'x' }));
  assert.equal(r.text, 'Fine.');
  // 3.8 is asked twice at most (full options, then plain), never retried again; then the next model answers
  assert.ok(urls.filter(u => /3\.8-flash/.test(u)).length <= 2);
  assert.match(urls[urls.length - 1], /3\.5-flash:/);
});

test('earlier questions and answers are sent so follow-ups make sense', async () => {
  let body;
  await withFetch(async (url, init) => { body = JSON.parse(init.body); return new Response(sse(part('Sure.')), { status: 200 }); },
    () => new GeminiAnswerer({ apiKey: 'k' }).answer({
      question: 'And how do I call it from jQuery?',
      previous: [{ question: 'What is a REST API in Dataverse?', answer: 'REST uses plain HTTP verbs.' }],
    }));
  const sent = body.contents[0].parts[0].text;
  assert.match(sent, /Earlier questions in this class and the answers you gave/);
  assert.match(sent, /Q: What is a REST API in Dataverse?/);
  assert.match(sent, /A: REST uses plain HTTP verbs./);
  assert.ok(sent.indexOf('Earlier questions') < sent.indexOf('Question just asked'), 'history comes before the new question');
  assert.match(body.systemInstruction.parts[0].text, /follow-up/);
});

test('closing offers and questions back to the teacher are trimmed; the answer itself is untouched', () => {
  const { cleanAnswer } = require('../src/ai/answerer');
  const body = 'A web service lets two programs talk over the internet.\n\nThink of it like ordering at a restaurant: the menu is the API and the waiter carries your order.';
  assert.equal(cleanAnswer(body + ' Let me know if you want more detail!'), body);
  assert.equal(cleanAnswer(body + '\n\nWould you like an example in jQuery?'), body);
  assert.equal(cleanAnswer(body + ' Does that make sense? Feel free to ask more.'), body);
  assert.equal(cleanAnswer(body + ' I hope this helps!'), body);
  assert.equal(cleanAnswer(body), body, 'a normal answer is not changed');
  assert.equal(cleanAnswer('Let me know if you want more detail!'), 'Let me know if you want more detail!', 'never empties the answer');
  assert.equal(cleanAnswer('First step.\nSecond step.\nThird step.'), 'First step.\nSecond step.\nThird step.', 'line breaks stay');
});

test('the instructions ask for a spoken, easy-words answer with no closing offer', () => {
  const { SYSTEM_PROMPT } = require('../src/ai/answerer');
  assert.match(SYSTEM_PROMPT, /out loud/);
  assert.match(SYSTEM_PROMPT, /easy, everyday words/);
  assert.match(SYSTEM_PROMPT, /Do NOT end with an offer/);
  assert.match(SYSTEM_PROMPT, /Do not ask the user any question/);
});

test('Gemini: the connection test reports success or the reason', async () => {
  const ok = await withFetch(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }), () => new GeminiAnswerer({ apiKey: 'k' }).diagnose());
  assert.match(ok.join(' '), /✓ gemini-3\.8-flash works/);
  const bad = await withFetch(async () => new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 400 }), () => new GeminiAnswerer({ apiKey: 'bad' }).diagnose());
  assert.match(bad.join(' '), /key looks wrong/);
});

test('the instructions ask for one short statement per line', () => {
  const { SYSTEM_PROMPT } = require('../src/ai/answerer');
  assert.match(SYSTEM_PROMPT, /ONE short statement per line/);
  assert.match(SYSTEM_PROMPT, /read a line, pause, then read the next/);
});
