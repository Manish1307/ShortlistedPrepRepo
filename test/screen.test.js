'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pipeline } = require('../src/pipeline');
const { GeminiAnswerer } = require('../src/ai/gemini');
const { GroqAnswerer } = require('../src/ai/groq');
const { toLines, toReadingText } = require('../src/format');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fakeAnswerer({ found = ['What is the output of this code?\nfor i in range(3):\n    print(i)'], fail = null } = {}) {
  return {
    ready: true, asked: [], shots: [],
    setSubject() {},
    async readScreen(args) { this.shots.push(args); if (fail) throw fail; return found; },
    async answer({ question, source, onDelta }) {
      this.asked.push({ question, source });
      onDelta('It prints 0, 1 and 2.');
      return { text: 'It prints 0, 1 and 2.', skipped: false, refused: false };
    },
  };
}
function collect(p) {
  const ev = [];
  for (const name of ['screen', 'answer-start', 'answer-done', 'warning', 'error']) p.on(name, d => ev.push({ name, ...d }));
  return ev;
}

test('a captured question is read from the picture and answered, marked as from the screen', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: null, answerer });   // no speech engine needed
  const ev = collect(p);
  const got = await p.askFromScreen({ image: 'BASE64', mimeType: 'image/png' });
  await sleep(20);
  assert.equal(got.length, 1);
  assert.equal(answerer.shots[0].image, 'BASE64');
  assert.deepEqual(ev.map(e => e.name), ['screen', 'screen', 'answer-start', 'answer-done']);
  assert.equal(ev[0].state, 'reading');
  assert.equal(ev[2].source, 'screen');
  assert.equal(answerer.asked[0].source, 'screen');
  assert.match(answerer.asked[0].question, /print\(i\)/);
});

test('nothing found in the picture: a warning, no answer', async () => {
  const p = new Pipeline({ whisper: null, answerer: fakeAnswerer({ found: [] }) });
  const ev = collect(p);
  await p.askFromScreen({ image: 'x' });
  assert.equal(ev.find(e => e.name === 'screen' && e.state === 'none').name, 'screen');
  assert.ok(!ev.some(e => e.name === 'answer-start'));
});

test('a failing AI is reported as a screen error in plain words', async () => {
  const p = new Pipeline({ whisper: null, answerer: fakeAnswerer({ fail: Object.assign(new Error('quota'), { status: 429 }) }) });
  const ev = collect(p);
  await p.askFromScreen({ image: 'x' });
  const err = ev.find(e => e.state === 'error');
  assert.match(err.message, /429/);
});

test('more questions than can run at once: the first three are answered and the teacher is told', async () => {
  const answerer = fakeAnswerer({ found: ['Question one?', 'Question two?', 'Question three?', 'Question four?'] });
  const p = new Pipeline({ whisper: null, answerer });
  const ev = collect(p);
  await p.askFromScreen({ image: 'x' });
  await sleep(20);
  assert.equal(answerer.asked.length, 3);
  assert.ok(ev.some(e => e.name === 'warning' && e.code === 'screen-many'));
});

test('no key: the teacher is told, the picture is not sent anywhere', async () => {
  const answerer = { ...fakeAnswerer(), ready: false };
  const p = new Pipeline({ whisper: null, answerer });
  const ev = collect(p);
  await p.askFromScreen({ image: 'x' });
  assert.equal(answerer.shots.length, 0);
  assert.equal(ev[0].name, 'error');
});

test('code between ``` lines keeps its indentation and is not split into sentences', () => {
  const text = 'The loop prints each number. Here is the fix.\n```python\nfor i in range(3):\n    print(i)\n```\nThat is all.';
  const lines = toLines(text);
  assert.deepEqual(lines, ['The loop prints each number.', 'Here is the fix.', '```python', 'for i in range(3):', '    print(i)', '```', 'That is all.']);
  assert.equal(toReadingText(toReadingText(text)), toReadingText(text), 'safe to apply twice');
});

async function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  try { return await fn(); } finally { global.fetch = real; }
}

test('Gemini: the picture is sent inline with the reading instructions, and the JSON list comes back', async () => {
  let body, url;
  const list = await withFetch(async (u, init) => {
    url = u; body = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '["Solve 2x + 3 = 11."]' }] } }] }), { status: 200 });
  }, () => new GeminiAnswerer({ apiKey: 'k', subject: 'Algebra' }).readScreen({ image: 'AAAA', mimeType: 'image/png' }));
  assert.deepEqual(list, ['Solve 2x + 3 = 11.']);
  assert.match(url, /gemini-3.5-flash:generateContent/);   // the fast picture reader goes first
  assert.deepEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'image/png', data: 'AAAA' } });
  assert.match(body.contents[0].parts[1].text, /Algebra/);
  assert.match(body.systemInstruction.parts[0].text, /screenshot/);
});

test('Gemini: a screen question gets room for code even in Quick mode', () => {
  const g = new GeminiAnswerer({ apiKey: 'k', effort: 'low' });
  assert.equal(g._body('gemini-3.8-flash', { question: 'q', source: 'screen' }).generationConfig.maxOutputTokens, 2048);
  assert.equal(g._body('gemini-3.8-flash', { question: 'q' }).generationConfig.maxOutputTokens, 700);
  assert.match(g._body('gemini-3.8-flash', { question: 'q', source: 'screen' }).contents[0].parts[0].text, /copied from the teacher's screen/);
});

test('Groq: uses a picture-reading model, not the text model', async () => {
  const models = [];
  const list = await withFetch(async (u, init) => {
    const b = JSON.parse(init.body);
    models.push(b.model);
    assert.equal(b.messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA');
    return new Response(JSON.stringify({ choices: [{ message: { content: '["What does this SQL query return?"]' } }] }), { status: 200 });
  }, () => new GroqAnswerer({ apiKey: 'k' }).readScreen({ image: 'AAAA' }));
  assert.deepEqual(list, ['What does this SQL query return?']);
  assert.match(models[0], /llama-4/);
});

test('screen capture can use a different AI: Groq answers, Claude reads the picture', async () => {
  const { AnswerRouter } = require('../src/ai/router');
  const make = (name, ready = true) => ({ name, ready, setSubject() {}, async readScreen() { return [name]; }, async answer() { return { text: name }; } });
  const r = new AnswerRouter({ gemini: make('gemini'), groq: make('groq'), claude: make('claude'), provider: 'groq', screenProvider: 'claude' });
  assert.deepEqual(await r.readScreen({}), ['claude']);
  assert.equal((await r.answer({})).text, 'groq');
  r.setScreenProvider('same');
  assert.deepEqual(await r.readScreen({}), ['groq']);
  r.setScreenProvider('nonsense');
  assert.equal(r.screenProvider, 'same');
  const noClaudeKey = new AnswerRouter({ gemini: make('gemini'), groq: make('groq'), claude: make('claude', false), provider: 'groq', screenProvider: 'claude' });
  assert.equal(noClaudeKey.screenReady, false);
  assert.equal(noClaudeKey.ready, true);
});

test('"Ask selected": the selected text becomes a question, with the answer it came from as background', async () => {
  const seen = [];
  const answerer = {
    ready: true, setSubject() {},
    async answer(args) { seen.push(args); return { text: 'More detail.', skipped: false, refused: false }; },
  };
  const p = new Pipeline({ whisper: null, answerer });
  const ev = collect(p);
  p.askSelection('  every web service is an API  ', { question: 'API vs web service?', answer: 'So every web service is an API, but not all APIs are web services.' });
  await sleep(20);
  assert.equal(seen[0].question, 'every web service is an API');
  assert.equal(seen[0].source, 'selection');
  assert.deepEqual(seen[0].previous.at(-1), { question: 'API vs web service?', answer: 'So every web service is an API, but not all APIs are web services.' });
  assert.equal(ev.find(e => e.name === 'answer-start').source, 'selection');
  p.askSelection('   ');
  await sleep(10);
  assert.equal(seen.length, 1, 'an empty selection asks nothing');
});

test('a selected statement is never skipped as small talk', () => {
  const { buildUserMessage } = require('../src/ai/answerer');
  assert.match(buildUserMessage({ question: 'REST', source: 'selection' }), /never reply SKIP/);
});

test('markdown bold and headings are removed outside code, kept inside code', () => {
  assert.deepEqual(toLines('**Example:**\n## Steps\nUse __this__ one.\n```\nx = a**2\n```'), ['Example:', 'Steps', 'Use this one.', '```', 'x = a**2', '```']);
});

test('the Ask box: typed keywords become a question marked as typed, never skipped', async () => {
  const seen = [];
  const p = new Pipeline({ whisper: null, answerer: { ready: true, setSubject() {}, async answer(a) { seen.push(a); return { text: 'ok', skipped: false, refused: false }; } } });
  p.askTyped('  React useEffect cleanup ');
  p.askTyped('');
  await sleep(20);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].question, 'React useEffect cleanup');
  assert.equal(seen[0].source, 'typed');
  const { buildUserMessage } = require('../src/ai/answerer');
  assert.match(buildUserMessage({ question: 'x', source: 'typed' }), /keywords[\s\S]*never reply SKIP/);
});

test('a corrected question is re-asked as "corrected" and is never skipped', async () => {
  const seen = [];
  const p = new Pipeline({ whisper: null, answerer: { ready: true, setSubject() {}, async answer(a) { seen.push(a); return { text: 'ok', skipped: false, refused: false }; } } });
  p.askTyped('What is a custom connector in Power Automate?', { corrected: true });
  await sleep(20);
  assert.equal(seen[0].source, 'corrected');
  const { buildUserMessage } = require('../src/ai/answerer');
  assert.match(buildUserMessage({ question: 'x', source: 'corrected' }), /corrected the wording[\s\S]*never reply SKIP/);
});
