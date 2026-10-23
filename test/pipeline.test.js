'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pipeline } = require('../src/pipeline');

const RATE = 16000;
function speech(seconds, amp = 0.25) {
  const n = Math.round(seconds * RATE), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = Math.round(amp * 32767 * (0.7 * Math.sin(2 * Math.PI * 200 * t) + 0.3 * Math.sin(2 * Math.PI * 900 * t)) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 4 * t)));
  }
  return out;
}
function silence(seconds) { return new Int16Array(Math.round(seconds * RATE)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Say one phrase: speech followed by enough silence for the splitter to close it. */
function say(p, seconds = 1) { p.feed(speech(seconds)); p.feed(silence(1.2)); }

function fakeWhisper(lines) {
  const queue = [...lines];
  return { calls: 0, async transcribe() { this.calls++; await sleep(5); return queue.shift() || ''; } };
}
function fakeAnswerer({ ready = true, delayMs = 5, reply = 'The discriminant is b^2 - 4ac.' } = {}) {
  return {
    ready, subject: '', asked: [],
    setSubject(s) { this.subject = s; },
    async answer({ question, context, previous, onDelta, signal }) {
      this.asked.push({ question, context, previous });
      for (const part of reply.split(' ')) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        onDelta(part + ' ');
        await sleep(delayMs);
      }
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { text: reply, skipped: false, refused: false };
    },
  };
}
function collect(p) {
  const ev = [];
  for (const name of ['transcript', 'answer-start', 'answer-delta', 'answer-done', 'answer-skip', 'answer-cancelled', 'answer-error', 'error', 'warning']) {
    p.on(name, data => ev.push({ name, ...data }));
  }
  return ev;
}
const names = ev => ev.map(e => e.name);

test('a question flows through: speech -> text -> answer streamed back', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['What is the discriminant of a quadratic equation?']), answerer, quietMs: 60 });
  const ev = collect(p);
  say(p);
  await sleep(500);
  const order = names(ev);
  assert.ok(order.indexOf('transcript') < order.indexOf('answer-start'));
  assert.ok(order.indexOf('answer-start') < order.indexOf('answer-delta'));
  assert.equal(order[order.length - 1], 'answer-done');
  const done = ev.find(e => e.name === 'answer-done');
  assert.equal(done.text, 'The discriminant is b^2 - 4ac.');
  assert.equal(ev.filter(e => e.name === 'answer-delta').map(e => e.delta).join('').trim(), done.text);
  assert.equal(answerer.asked.length, 1);
});

test('statements and classroom logistics are transcribed but never answered', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({
    whisper: fakeWhisper(['Today we will solve quadratic equations.', 'Can you hear me?', '[BLANK_AUDIO]']),
    answerer, quietMs: 60,
  });
  const ev = collect(p);
  say(p); say(p); say(p);
  await sleep(700);
  assert.equal(ev.filter(e => e.name === 'transcript').length, 2, 'blank audio is dropped');
  assert.equal(answerer.asked.length, 0);
});

test('the same question twice in a row is answered once', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?', 'What is a prime number?']), answerer, quietMs: 60 });
  collect(p);
  say(p); await sleep(400); say(p); await sleep(400);
  assert.equal(answerer.asked.length, 1);
});

test('a question split by a short pause is sent as one piece together with the sentence before it', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({
    whisper: fakeWhisper(['Remember that a quadratic has degree two.', 'What is the', 'discriminant for?']),
    answerer, quietMs: 600,
  });
  collect(p);
  say(p); await sleep(100);          // statement first
  say(p); say(p);                    // question in two pieces, no pause long enough to close it between
  await sleep(1600);
  assert.equal(answerer.asked.length, 1);
  // nothing is cut away: the AI sees the whole thing and decides what is being asked
  assert.equal(answerer.asked[0].question, 'Remember that a quadratic has degree two. What is the discriminant for?');
});

test('a scenario question keeps its real request when the AI tidy-up is not available', async () => {
  const answerer = fakeAnswerer();
  const spoken = 'Okay, so tell me the steps of enabling API in Dataverse and how you will call using jQuery. Could you please explain this to me?';
  const p = new Pipeline({ whisper: fakeWhisper([spoken]), answerer, quietMs: 40 });
  say(p); await sleep(500);
  assert.equal(answerer.asked.length, 1);
  assert.match(answerer.asked[0].question, /steps of enabling API in Dataverse/);
  assert.match(answerer.asked[0].question, /jQuery/);
});

test('a second question is answered at the same time, the first keeps going', async () => {
  const answerer = fakeAnswerer({ delayMs: 60, reply: 'one two three four five six seven eight nine ten' });
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?', 'How do you factor a trinomial?']), answerer, quietMs: 40 });
  const ev = collect(p);
  say(p); await sleep(350);          // first answer is under way
  say(p); await sleep(1500);
  assert.ok(!names(ev).includes('answer-cancelled'), 'nothing is cancelled');
  const dones = ev.filter(e => e.name === 'answer-done');
  assert.equal(dones.length, 2, 'both questions get a finished answer');
  assert.notEqual(dones[0].id, dones[1].id);
  assert.equal(answerer.asked[1].question, 'How do you factor a trinomial?');
});

test('too many answers at once: the oldest one is cancelled', async () => {
  const answerer = fakeAnswerer({ delayMs: 200, reply: 'one two three four five six seven eight nine ten' });
  const qs = ['What is a prime number?', 'How do you factor a trinomial?', 'What is the derivative of sine x?', 'Why does the parabola open downwards?'];
  const p = new Pipeline({ whisper: fakeWhisper(qs), answerer, quietMs: 30 });
  const ev = collect(p);
  for (let i = 0; i < 4; i++) { say(p); await sleep(250); }
  await sleep(3000);
  assert.equal(ev.filter(e => e.name === 'answer-cancelled').length, 1);
  assert.equal(ev.filter(e => e.name === 'answer-done').length, 3);
});

test('without an API key the question is reported, nothing crashes', async () => {
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?']), answerer: fakeAnswerer({ ready: false }), quietMs: 60 });
  const ev = collect(p);
  say(p); await sleep(400);
  const err = ev.find(e => e.name === 'error');
  assert.ok(err && err.code === 'no-key');
});

test('a Whisper failure is reported and the next phrase still works', async () => {
  let n = 0;
  const whisper = { async transcribe() { n++; if (n === 1) throw new Error('boom'); return 'What is a prime number?'; } };
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper, answerer, quietMs: 60 });
  const ev = collect(p);
  say(p); await sleep(100); say(p); await sleep(500);
  assert.ok(ev.some(e => e.name === 'error' && e.code === 'stt'));
  assert.equal(answerer.asked.length, 1);
});

test('pause() stops listening, resume() continues', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?']), answerer, quietMs: 60 });
  collect(p);
  p.pause(); say(p); await sleep(300);
  assert.equal(answerer.asked.length, 0);
  p.resume(); say(p); await sleep(400);
  assert.equal(answerer.asked.length, 1);
});

test('a second question gets its own answer; the first is not repeated or sent as context', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?', 'How do you factor a trinomial?']), answerer, quietMs: 40 });
  say(p); await sleep(400);
  say(p); await sleep(600);
  assert.equal(answerer.asked.length, 2);
  assert.equal(answerer.asked[1].question, 'How do you factor a trinomial?');
  assert.ok(!answerer.asked[1].context.some(l => /prime number/.test(l)), 'answered question is not context');
});

test('"answer last" answers the most recent thing heard, not the previous question', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['Who is the first president?', 'And another question is, what is a prime number?']), answerer, quietMs: 2000 });
  say(p); await sleep(300);
  p.askNow(p.lastQuestionText());
  await sleep(100);
  say(p); await sleep(300);        // second phrase heard, but the quiet gate has not released it yet
  p.askNow(p.lastQuestionText());
  await sleep(200);
  assert.equal(answerer.asked[0].question, 'Who is the first president?');
  assert.equal(answerer.asked[1].question, 'What is a prime number?');   // the lead-in is dropped
});

test('two questions asked together are framed by the AI first, then each is answered', async () => {
  const answerer = fakeAnswerer();
  answerer.extractQuestions = async ({ text }) => {
    answerer.extractInput = text;
    return ['What is a web service in .NET?', 'What is the difference between an API and a web service?'];
  };
  const p = new Pipeline({
    whisper: fakeWhisper(['My question is, what is web services in .NET? And another question is, what is the difference between API and web services?']),
    answerer, quietMs: 40,
  });
  say(p); await sleep(700);
  assert.match(answerer.extractInput, /web services in \.NET/);
  assert.deepEqual(answerer.asked.map(a => a.question), [
    'What is a web service in .NET?',
    'What is the difference between an API and a web service?',
  ]);
});

test('if the AI cannot frame the question, the raw words are still answered', async () => {
  const answerer = fakeAnswerer();
  answerer.extractQuestions = async () => { throw Object.assign(new Error('busy'), { status: 503 }); };
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number? And another question is, why is two special?']), answerer, quietMs: 40 });
  const gates = [];
  p.on('gate', g => gates.push(g.decision));
  say(p); await sleep(600);
  assert.equal(answerer.asked.length, 1);
  assert.equal(answerer.asked[0].question, 'What is a prime number? And another question is, why is two special?');
  assert.ok(gates.some(d => /tidy-up-failed/.test(d)));
});

test('a slow AI tidy-up is given up on after the time limit and the raw words are answered', async () => {
  const answerer = fakeAnswerer();
  answerer.extractQuestions = ({ signal }) => new Promise((resolve, reject) => {   // never answers by itself
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const p = new Pipeline({
    whisper: fakeWhisper(['What is a prime number? And another question is, why is two special?']), answerer, quietMs: 40,
    setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 80)),   // shrink the 5 s limit so the test stays quick
  });
  const gates = [];
  p.on('gate', g => gates.push(g.decision));
  say(p); await sleep(900);
  assert.equal(answerer.asked.length, 1, 'answered without waiting for the AI tidy-up');
  assert.ok(gates.some(d => /too-slow/.test(d)));
});

test('a framed question that was already answered is not answered again', async () => {
  const answerer = fakeAnswerer();
  const frames = [['What is a prime number?', 'Why is two special?'], ['What is a prime number?', 'What is a composite number?']];
  answerer.extractQuestions = async () => frames.shift();
  const p = new Pipeline({ whisper: fakeWhisper([
    'What is a prime number? And another question is, why is two special?',
    'What is a prime number? And what is a composite number?',
  ]), answerer, quietMs: 40 });
  say(p); await sleep(500);
  say(p); await sleep(500);
  assert.deepEqual(answerer.asked.map(x => x.question), ['What is a prime number?', 'Why is two special?', 'What is a composite number?']);
});

test('one question skips the framing call (saves seconds and quota); several questions use it', async () => {
  const answerer = fakeAnswerer();
  let framed = 0;
  answerer.extractQuestions = async () => { framed++; return ['What is a prime number?', 'Why is two special?']; };
  const p = new Pipeline({ whisper: fakeWhisper(['Okay, so what is a prime number? Please explain with an example.', 'What is a prime number? And another question is, why is two special?']), answerer, quietMs: 40 });
  say(p); await sleep(400);
  assert.equal(framed, 0);
  assert.equal(answerer.asked[0].question, 'What is a prime number? Please explain with an example.');
  say(p); await sleep(500);
  assert.equal(framed, 1);
});

test('pressing Stop does not lose the phrase that was still being spoken', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?']), answerer, quietMs: 40 });
  const heard = [];
  p.on('transcript', t => heard.push(t.text));
  p.feed(speech(1.5));          // still talking, no pause yet
  p.pause();                    // Stop listening
  await sleep(500);
  assert.deepEqual(heard, ['What is a prime number?']);
  p.feed(speech(1.5)); p.feed(silence(1.2));   // after Stop, nothing more is picked up
  await sleep(200);
  assert.equal(heard.length, 1);
});

test('manual mode: nothing is answered until "question finished", then everything heard so far is handed over', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['Today we cover primes.', 'What is a prime number and', 'why is two special?']), answerer, quietMs: 40, autoAnswer: false });
  say(p); await sleep(150);
  say(p); await sleep(150);
  say(p); await sleep(600);
  assert.equal(answerer.asked.length, 0, 'not answered by itself, even after long pauses');
  await p.completeQuestion();
  await sleep(100);
  assert.equal(answerer.asked.length, 1);
  assert.match(answerer.asked[0].question, /prime number and why is two special\?/);
  await p.completeQuestion();    // nothing new since then
  assert.equal(answerer.asked.length, 1);
});

test('"question finished" includes the phrase still being spoken, and does not double-answer in auto mode', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?']), answerer, quietMs: 60 });
  const warnings = [];
  p.on('warning', w => warnings.push(w.code));
  p.feed(speech(1.5));               // still talking: the app has not heard a pause yet
  await p.completeQuestion();
  await sleep(400);                  // long enough for the automatic path to have fired too
  assert.equal(answerer.asked.length, 1);
  assert.equal(answerer.asked[0].question, 'What is a prime number?');
});

test('a long question cut into pieces is not answered until the speaker has really stopped', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({
    whisper: fakeWhisper(['What is the discriminant of', 'a quadratic equation?']),
    answerer, quietMs: 100,
  });
  p.feed(speech(9.2)); p.feed(silence(0.2));   // a long stretch, cut at a breath: first piece goes to the speech engine
  p.feed(speech(2));                            // ...and the speaker is still going
  await sleep(500);                             // much longer than the quiet time: the old code answered half a question here
  assert.equal(answerer.asked.length, 0, 'must keep waiting while the speaker is talking');
  p.feed(silence(1.2));                         // now they stop
  await sleep(500);
  assert.equal(answerer.asked.length, 1);
  assert.equal(answerer.asked[0].question, 'What is the discriminant of a quadratic equation?');
});

test('a follow-up question is given the earlier questions and answers', async () => {
  const answerer = fakeAnswerer({ reply: 'REST uses plain HTTP verbs.' });
  const frames = [];
  answerer.extractQuestions = async ({ text, previous }) => { frames.push(previous); return [text]; };
  const p = new Pipeline({ whisper: fakeWhisper(['What is a REST API in Dataverse?', 'And how do I call it from jQuery?', 'Why use it?']), answerer, quietMs: 40 });
  say(p); await sleep(400);
  assert.deepEqual(answerer.asked[0].previous, [], 'the first question has nothing before it');
  say(p); await sleep(500);
  assert.equal(answerer.asked.length, 2);
  assert.deepEqual(answerer.asked[1].previous, [{ question: 'What is a REST API in Dataverse?', answer: 'REST uses plain HTTP verbs.' }]);
  say(p); await sleep(500);
  assert.equal(answerer.asked[2].previous.length, 2);
});

test('only the last few answers are remembered, and old ones are forgotten', async () => {
  const answerer = fakeAnswerer({ reply: 'ok' });
  const qs = ['What is one thing?', 'What is two thing?', 'What is three thing?', 'What is four thing?', 'What is five thing?', 'What is six thing?'];
  const p = new Pipeline({ whisper: fakeWhisper(qs), answerer, quietMs: 30 });
  for (let i = 0; i < 6; i++) { say(p); await sleep(250); }
  const last = answerer.asked[5].previous;
  assert.equal(last.length, 4, 'at most four earlier answers');
  assert.equal(last[0].question, 'What is two thing?');
  p.qa.forEach(x => { x.at -= 46 * 60000; });   // 46 minutes later: a new topic
  p.askNow('What is a seventh thing?');
  await sleep(100);
  assert.deepEqual(answerer.asked[6].previous, []);
});

test('the same sentence heard twice (microphone and speakers) is only handled once', async () => {
  const answerer = fakeAnswerer();
  const p = new Pipeline({ whisper: fakeWhisper(['How you will onboard external?', 'How you will onboard external?']), answerer, quietMs: 40 });
  const heard = [];
  p.on('transcript', t => heard.push(t.text));
  say(p); await sleep(150);
  say(p); await sleep(400);
  assert.equal(heard.length, 1);
  assert.equal(answerer.asked.length, 1);
});

test('timings are reported: first words and total time', async () => {
  const answerer = fakeAnswerer({ delayMs: 20 });
  const p = new Pipeline({ whisper: fakeWhisper(['What is a prime number?']), answerer, quietMs: 40 });
  const timings = [];
  p.on('timing', t => timings.push(t));
  say(p); await sleep(700);
  assert.equal(timings.length, 1);
  assert.ok(timings[0].firstWordMs >= 0 && timings[0].totalMs >= timings[0].firstWordMs);
});

test('the finished answer is delivered one statement per line', async () => {
  const answerer = fakeAnswerer({ reply: 'A custom connector links an outside API to Power Platform. You give it the web address and the sign-in method. Then it shows up like any built-in action.' });
  const p = new Pipeline({ whisper: fakeWhisper(['What is a custom connector?']), answerer, quietMs: 40 });
  const ev = collect(p);
  say(p); await sleep(700);
  const done = ev.find(e => e.name === 'answer-done');
  assert.deepEqual(done.text.split('\n'), [
    'A custom connector links an outside API to Power Platform.',
    'You give it the web address and the sign-in method.',
    'Then it shows up like any built-in action.',
  ]);
});

test('behind on speech: phrases are joined, none is dropped or skipped', async () => {
  const heard = [];
  // a slow speech engine: each request takes a while, so phrases pile up behind it
  const whisper = { calls: 0, async transcribe(wav) { this.calls++; await sleep(120); return 'phrase ' + this.calls; } };
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false });
  const warnings = [];
  p.on('warning', w => warnings.push(w.code));
  p.on('transcript', t => heard.push(t.text));
  for (let i = 0; i < 8; i++) say(p, 1);     // eight phrases arrive at once
  await sleep(1200);
  assert.ok(!warnings.includes('behind'), 'no phrase was skipped');
  assert.ok(whisper.calls < 8, 'neighbouring phrases were joined into fewer requests (' + whisper.calls + ')');
  assert.ok(heard.length >= 1 && heard.length === whisper.calls, 'every request produced its text');
});

test('status tells the screen how many phrases are still being converted, and whether someone is speaking', async () => {
  const whisper = { async transcribe() { await sleep(150); return 'hello there'; } };
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false });
  const status = [], speaking = [];
  p.on('status', s => status.push(s));
  p.on('speaking', s => speaking.push(s.on));
  say(p, 1);
  await sleep(60);
  assert.ok(status.some(s => s.transcribing && s.queued >= 1), 'busy while converting');
  await sleep(300);
  assert.equal(status[status.length - 1].transcribing, false);
  assert.ok(speaking.includes(true) && speaking.includes(false), 'speaking on and off was reported');
});

test('live preview: words so far are shown while someone is still speaking, then replaced by the real text', async () => {
  const whisper = { calls: 0, async transcribe() { this.calls++; await sleep(10); return 'what is a th'; } };
  let t = 0;
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false, livePartials: true, now: () => (t += 400) });
  const partials = [];
  p.on('partial', m => partials.push(m.text));
  for (let i = 0; i < 6; i++) { p.feed(speech(0.5)); await sleep(30); }   // still speaking: no pause yet
  assert.ok(partials.some(x => x === 'what is a th'), 'a preview was shown while speaking');
  p.feed(silence(1.2));
  await sleep(100);
  assert.equal(partials[partials.length - 1], '', 'the preview is cleared when the real text arrives');
});

test('live previews are off unless asked for', async () => {
  const whisper = { calls: 0, async transcribe() { this.calls++; return 'x'; } };
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false });
  for (let i = 0; i < 6; i++) { p.feed(speech(0.5)); await sleep(20); }
  assert.equal(whisper.calls, 0);
});

test('parallel: two phrases are converted at the same time and the text still comes out in the order spoken', async () => {
  let active = 0, peak = 0, n = 0;
  const whisper = {
    async transcribe() {
      const me = ++n;
      active++; peak = Math.max(peak, active);
      await sleep(me === 1 ? 160 : 20);      // the first phrase is slow, the second is quick: it finishes first
      active--;
      return 'phrase ' + me;
    },
  };
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false, parallel: 2 });
  const heard = [];
  p.on('transcript', t => heard.push(t.text));
  say(p, 1); say(p, 1);
  await sleep(400);
  assert.equal(peak, 2, 'both were converted at once');
  assert.deepEqual(heard, ['phrase 1', 'phrase 2'], 'in the order they were spoken');
});

test('parallel: the status counts every phrase being converted', async () => {
  const whisper = { async transcribe() { await sleep(120); return 'hello world'; } };
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false, parallel: 3 });
  const queued = [];
  p.on('status', s => queued.push(s.queued));
  say(p, 1); say(p, 1); say(p, 1);
  await sleep(500);
  assert.ok(Math.max(...queued) >= 2, 'several phrases were reported as being converted');
  assert.equal(queued[queued.length - 1], 0);
});

test('parallel: when the engine fails, the phrases behind it are not lost out of order and it restarts once', async () => {
  let restarts = 0, calls = 0;
  const whisper = {
    async transcribe() { const me = ++calls; await sleep(30); if (me <= 2) throw new Error('stuck'); return 'ok ' + me; },
    async restart() { restarts++; await sleep(20); },
  };
  const p = new Pipeline({ whisper, answerer: fakeAnswerer(), autoAnswer: false, parallel: 2 });
  const heard = [], errors = [];
  p.on('transcript', t => heard.push(t.text));
  p.on('error', e => errors.push(e.code));
  say(p, 1); say(p, 1); say(p, 1);
  await sleep(600);
  assert.equal(restarts, 1, 'one restart for two failures at the same time');
  assert.deepEqual(errors, ['stt', 'stt']);
  assert.deepEqual(heard, ['ok 3'], 'the phrase after the failures still arrived');
});
