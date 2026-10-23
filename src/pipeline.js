'use strict';
// Glue: microphone / system audio  ->  utterances  ->  Whisper text  ->  question detection  ->  Claude answer.
// Emits events for the UI; has no Electron or network code of its own, so it can be tested with fakes.

const { EventEmitter } = require('events');
const { Segmenter } = require('./audio/vad');
const { toReadingText } = require('./format');
const { pcm16ToWav } = require('./audio/wav');
const { QuestionGate, cleanTranscript, isHallucination, extractQuestion, looksLikeQuestion, stripLeadIn, countQuestions, normalizeForCompare } = require('./ai/questions');

const SOFT_QUEUE = 2;         // more than this many phrases waiting: neighbours are joined into one request (fewer, longer ones catch up faster)
const HARD_QUEUE = 24;        // only if joining cannot keep up: the oldest phrase is dropped, with a warning
const MERGE_MAX_MS = 13000;   // a joined phrase stays within what the speech engine reads at once (about 15 s)
const PARTIAL_MS = 1100;      // a live preview of the phrase being spoken is refreshed about this often
const PARTIAL_MIN_MS = 900;   // ...once it has lasted this long
const CONTEXT_LINES = 8;      // transcript lines sent to Claude along with the question
const CONTEXT_WINDOW_MS = 120000;
const MEMORY_ANSWERS = 4;                 // earlier questions and answers shown to the AI, for follow-up questions
const MEMORY_MINUTES = 45;               // older ones are forgotten (a new topic)
const FRAME_TIMEOUT_MS = 6000;
const STT_TIMEOUT_MS = 25000;    // a speech request that takes longer than this is stuck   // longest we wait for the AI to tidy up a question before using the words as heard
const MAX_PARALLEL_ANSWERS = 3; // questions answered at the same time; beyond this the oldest is cancelled
const SCREEN_TIMEOUT_MS = 45000; // longest we wait for the AI to read a captured picture

class Pipeline extends EventEmitter {
  /**
   * @param {{whisper: {transcribe: Function}, answerer: object, subject?: string,
   *          now?: () => number, setTimer?: Function, clearTimer?: Function, quietMs?: number}} o
   */
  constructor(o) {
    super();
    this.whisper = o.whisper;
    this.answerer = o.answerer;
    this.subject = o.subject || '';
    this.now = o.now || Date.now;
    this.setTimer = o.setTimer || setTimeout;
    this.clearTimer = o.clearTimer || clearTimeout;
    this.autoAnswer = o.autoAnswer !== false;
    this.livePartials = o.livePartials === true;   // the words so far of the phrase being spoken (opt-in: it asks the speech engine more often)
    this.mergeMaxMs = o.mergeMaxMs || MERGE_MAX_MS;   // joined phrases stay inside what the speech engine reads at once (-ac 512: ~10 s, -ac 768: ~15 s)
    this.partialGap = PARTIAL_MS;
    this.partialAt = 0;
    this.partialBusy = false;
    this.speakingNow = false;

    this.lastLevel = null;
    this.segmenter = new Segmenter(seg => this._onSegment(seg), lvl => {
      this.lastLevel = lvl; this.emit('level', lvl);
      if (lvl.speaking !== this.speakingNow) { this.speakingNow = lvl.speaking; this.emit('speaking', { on: lvl.speaking }); this._status(); }
    }, o.vad);
    this.gate = new QuestionGate({ quietMs: o.quietMs || 1000 });
    this.history = [];      // { at, text }
    this.queue = [];
    this.qa = [];           // finished answers: { question, answer, at } for follow-up questions
    this.sinceLast = [];    // what was heard since the last question was handed to the AI
    this.holdPoll = false;  // true while the "question finished" button is collecting the last phrase
    this.busy = false;
    this.paused = false;
    this.pollTimer = null;
    this.active = new Map(); // answers in progress: id -> AbortController (several can run at once)
    this.nextId = 1;
    this.lastKeyWarning = 0;
  }

  /** Feed 16 kHz mono Int16 samples. */
  feed(samples) {
    if (this.paused) return;
    this.segmenter.push(samples);
    if (this.livePartials) this._maybePartial();
  }

  pause() { this.segmenter.flush(); this.paused = true; this._status(); }   // flush first: the phrase being spoken when Stop is pressed is still transcribed
  resume() { this.paused = false; this._status(); }
  setSubject(s) { this.subject = s || ''; this.answerer.setSubject(this.subject); }
  setAutoAnswer(on) { this.autoAnswer = !!on; }

  /**
   * Screen capture: the AI copies the question(s) out of the captured picture, then each one is answered like a
   * spoken question (same list, same follow-up memory). Works without the speech engine.
   * @param {{image: string, mimeType?: string}} shot  base64 picture
   */
  async askFromScreen({ image, mimeType = 'image/png' }) {
    const canRead = 'screenReady' in this.answerer ? this.answerer.screenReady : this.answerer.ready;   // may be another AI
    if (!canRead) {
      this.emit('error', { code: 'no-key', message: 'No API key is set for the AI that reads captured questions. Open Settings and add it under "Screen capture AI".' });
      return [];
    }
    this.emit('screen', { state: 'reading' });
    const controller = new AbortController();
    const timer = this.setTimer(() => controller.abort(), SCREEN_TIMEOUT_MS);
    let questions;
    try {
      questions = await this.answerer.readScreen({ image, mimeType, previous: this._previous(), signal: controller.signal });
    } catch (err) {
      const message = controller.signal.aborted ? 'Reading the screen took too long. Try again, or capture a smaller area.' : friendlyError(err);
      this.emit('screen', { state: 'error', message });
      return [];
    } finally {
      this.clearTimer(timer);
    }
    if (!questions || !questions.length) {
      this.emit('screen', { state: 'none', message: 'No question was found in the captured area. Capture again and draw the box around the question.' });
      return [];
    }
    if (questions.length > MAX_PARALLEL_ANSWERS) {               // more would cancel each other: answer the first ones
      this.emit('warning', { code: 'screen-many', message: `${questions.length} questions were found; the first ${MAX_PARALLEL_ANSWERS} are answered. Capture the others separately.` });
      questions = questions.slice(0, MAX_PARALLEL_ANSWERS);
    }
    this.emit('screen', { state: 'found', count: questions.length, text: questions.join(' | ') });
    const context = this._context('');
    for (const q of questions) this._answer(q, context, 'screen');
    return questions;
  }

  /** Ask for an answer to arbitrary text (used by the "answer last question" hotkey / button). */
  askNow(text) {
    const q = String(text || '').trim();
    if (!q) return;
    this.clearTimer(this.pollTimer);   // this speech is handled now: the automatic timer must not answer it a second time
    this.gate.pending = [];
    this._frameAndAnswer(q, { force: true });
  }

  /**
   * The "question finished" button / shortcut. Everything heard since the last answer (including the phrase
   * being spoken right now) is handed to the AI, which finds the question(s) in it and answers.
   * Works in both modes: in manual mode it is the only trigger; in auto mode it just skips the waiting.
   */
  async completeQuestion() {
    this.holdPoll = true;
    try {
      this.segmenter.flush();                                  // the phrase being spoken counts too
      await this._whenIdle(20000);                             // wait until it has been turned into text
      this.clearTimer(this.pollTimer);
      this.gate.pending = [];                                  // the text is taken from sinceLast instead
      const heard = this.sinceLast.join(' ').trim();
      if (!heard) { this.emit('warning', { code: 'nothing-heard', message: 'Nothing new has been heard since the last answer.' }); return; }
      await this._frameAndAnswer(heard, { force: true });
    } finally {
      this.holdPoll = false;
    }
  }

  _whenIdle(maxMs) {
    const started = Date.now();
    return new Promise(resolve => {
      const check = () => {
        if ((!this.busy && !this.queue.length) || Date.now() - started > maxMs) return resolve();
        setTimeout(check, 40);
      };
      check();
    });
  }

  /**
   * Newly heard speech -> the AI works out which questions were asked and words each one clearly ->
   * every question is answered (in parallel). Without that step (or if it fails) the plain heuristic is used.
   */
  async _frameAndAnswer(heard, { force = false } = {}) {
    this.sinceLast = [];                                         // this speech is now being handled
    const context = this._context(heard);                       // earlier speech, for the framing step
    // for the answers: every unanswered statement, including ones spoken just before the question; no questions
    const statements = this._context('').filter(t => !looksLikeQuestion(t));
    for (const h of this.history) if (heard.indexOf(h.text) !== -1) h.used = true;
    let questions = null;
    // one short, clean question needs no tidying: skipping the extra AI call halves the requests (free-tier limits)
    // several questions in one go are the only case that needs a separate tidy-up call (it costs seconds)
    const single = countQuestions(heard) <= 1;
    if (!single && this.answerer.ready && typeof this.answerer.extractQuestions === 'function') {
      const controller = new AbortController();
      const timer = this.setTimer(() => controller.abort(), FRAME_TIMEOUT_MS);   // a slow AI must not hold the answer back
      try {
        questions = await this.answerer.extractQuestions({ text: heard, context, previous: this._previous(), signal: controller.signal });
      } catch (err) {
        const timedOut = controller.signal.aborted;
        this.emit('gate', { decision: timedOut ? 'tidy-up-too-slow, using raw words' : 'tidy-up-failed, using raw words', text: timedOut ? `> ${FRAME_TIMEOUT_MS} ms` : friendlyError(err) });
      } finally {
        this.clearTimer(timer);
      }
    }
    // fallback: everything that was said. A scenario question has its real request in the earlier sentences,
    // so cutting it down to the last question sentence would lose the point ("...could you please explain this?").
    if (questions === null) {
      const words = stripLeadIn(heard);
      questions = [words.length > 700 ? words.slice(-700) : words];
    }
    this.emit('gate', { decision: 'questions', text: questions.join(' | ') || '(none)' });
    for (const q of questions) {
      if (!force && !this.gate.claim(q, this.now())) continue;       // already answered recently
      this._answer(q, statements);
    }
  }

  /**
   * What "answer last" should answer: the most recent thing that was heard (phrases spoken within a few seconds
   * of each other count as one), NOT the last question that was answered before.
   */
  lastQuestionText() {
    const newest = this.history[this.history.length - 1];
    if (newest && looksLikeQuestion(newest.text)) return extractQuestion(newest.text); // a complete question on its own
    const recent = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (recent.length && recent[0].at - h.at > 6000) break;
      recent.unshift(h);
    }
    const heard = recent.map(h => h.text).join(' ');
    return heard ? extractQuestion(heard) : (this.lastQuestion || '');
  }

  stop() {
    this.paused = true;
    this.segmenter.flush();
    this.queue.length = 0;
    this.clearTimer(this.pollTimer);
    for (const c of this.active.values()) c.abort();
  }

  // ---- internals -------------------------------------------------------------------------------

  _status() {
    this.emit('status', {
      listening: !this.paused,
      transcribing: this.busy || this.queue.length > 0,
      speaking: this.speakingNow,
      answering: this.active.size > 0,
      queued: this.queue.length + (this.busy ? 1 : 0),   // phrases not yet turned into text, including the one being worked on
    });
  }

  _onSegment(seg) {
    if (this.paused) return;
    this.queue.push(seg);
    this._compact();
    while (this.queue.length > HARD_QUEUE) {
      this.queue.shift();
      this.emit('warning', { code: 'behind', message: 'Transcription is falling behind; an earlier phrase was skipped.' });
    }
    this._status();
    this._drain();
  }

  /**
   * Behind on speech: join neighbouring phrases into one request instead of dropping any. The speech engine reads a
   * fixed window per request, so one joined request costs about the same as one short one, and nothing is lost.
   */
  _compact() {
    while (this.queue.length > SOFT_QUEUE) {
      let at = -1;
      for (let i = 0; i + 1 < this.queue.length; i++) {
        if (this.queue[i + 1].endMs - this.queue[i].startMs <= this.mergeMaxMs) { at = i; break; }
      }
      if (at < 0) return;
      const a = this.queue[at], b = this.queue[at + 1];
      const gapSamples = Math.round(Math.min(300, Math.max(0, b.startMs - a.endMs)) * 16);   // a little silence between the two
      const pcm = new Int16Array(a.pcm.length + gapSamples + b.pcm.length);
      pcm.set(a.pcm, 0); pcm.set(b.pcm, a.pcm.length + gapSamples);
      this.queue.splice(at, 2, { pcm, startMs: a.startMs, endMs: b.endMs, voicedMs: (a.voicedMs || 0) + (b.voicedMs || 0), peakDb: Math.max(a.peakDb, b.peakDb) });
    }
  }

  /** A live preview: the words so far of the phrase being spoken, asked only while the speech engine is otherwise idle. */
  _maybePartial() {
    const seg = this.segmenter;
    if (this.partialBusy || this.busy || this.queue.length || !seg.isSpeaking() || seg.speechMs() < PARTIAL_MIN_MS) return;
    const t = this.now();
    if (t - this.partialAt < this.partialGap) return;
    const pcm = seg.snapshot(this.mergeMaxMs - 1000);
    if (!pcm) return;
    this.partialBusy = true; this.partialAt = t;
    const utterance = seg.utteranceId;
    const started = Date.now();
    this.whisper.transcribe(pcm16ToWav(pcm), { prompt: this._whisperPrompt(), timeoutMs: 6000 }).then(raw => {
      const text = cleanTranscript(raw);
      if (!this.paused && utterance === seg.utteranceId && seg.isSpeaking() && text && !isHallucination(text)) this.emit('partial', { text });
    }).catch(() => { /* a preview is optional: the real transcript follows */ }).finally(() => {
      this.partialBusy = false;
      // slow computer: ask less often, so the previews never hold up the real transcript
      this.partialGap = Math.min(6000, Math.max(PARTIAL_MS, (Date.now() - started) * 1.6));
    });
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const seg = this.queue.shift();
        this._status();
        let raw = '';
        try {
          raw = await this.whisper.transcribe(pcm16ToWav(seg.pcm), { prompt: this._whisperPrompt(), timeoutMs: STT_TIMEOUT_MS });
        } catch (err) {
          this.emit('segment', { ms: seg.endMs - seg.startMs, peakDb: Math.round(seg.peakDb), raw: '', outcome: 'engine-failed: ' + err.message });
          this.emit('error', { code: 'stt', message: `Speech recognition failed: ${err.message}` });
          // a stuck request would block every phrase behind it: start the speech engine again
          if (typeof this.whisper.restart === 'function') {
            try { await this.whisper.restart(); this.emit('warning', { code: 'stt-restart', message: 'The speech engine was restarted.' }); } catch (e) { /* the next phrase will report it */ }
          }
          continue;
        }
        const text = cleanTranscript(raw);
        if (!text || isHallucination(text)) {
          this.emit('segment', { ms: seg.endMs - seg.startMs, peakDb: Math.round(seg.peakDb), raw, outcome: !text ? 'nothing-recognised' : 'ignored-as-noise' });
          continue;
        }
        const at = this.now();
        const echo = this.history.length && this.history[this.history.length - 1];
        if (echo && at - echo.at < 12000 && normalizeForCompare(echo.text) === normalizeForCompare(text)) {   // same sentence heard twice (mic + speakers)
          this.emit('segment', { ms: seg.endMs - seg.startMs, peakDb: Math.round(seg.peakDb), raw, outcome: 'repeat-of-previous-line' });
          continue;
        }
        this.history.push({ at, text });
        if (this.history.length > 60) this.history.shift();
        this.emit('segment', { ms: seg.endMs - seg.startMs, peakDb: Math.round(seg.peakDb), raw, outcome: 'heard' });
        this.emit('partial', { text: '' });   // the preview is replaced by the real text
        this.emit('transcript', { text, at, durationMs: seg.endMs - seg.startMs });
        this.sinceLast.push(text);
        if (this.sinceLast.length > 30) this.sinceLast.shift();
        if (this.autoAnswer) { this.gate.push(text, at); this._schedulePoll(); }
      }
    } finally {
      this.busy = false;
      this._status();
    }
  }

  /** Subject + a few recent words help Whisper spell the vocabulary correctly. */
  _whisperPrompt() {
    // questions that were already answered are left out, or Whisper tends to repeat them in the next phrase
    const recent = this.history.filter(h => !h.used).slice(-2).map(h => h.text).join(' ');
    return [this.subject ? `Topic: ${this.subject}.` : '', recent].join(' ').trim().slice(-400);
  }

  _schedulePoll() {
    this.clearTimer(this.pollTimer);
    const wait = Math.max(50, this.gate.dueIn(this.now()));
    this.pollTimer = this.setTimer(() => this._poll(), wait);
  }

  _poll() {
    if (this.holdPoll) return;   // the button is taking over this speech
    if (this.segmenter.isSpeaking()) {   // still talking (a long question was cut into pieces): the question is not finished
      this.gate.lastAt = this.now();
      this._schedulePoll();
      return;
    }
    if (this.busy || this.queue.length) { this._schedulePoll(); return; } // more speech still being transcribed
    const heard = this.gate.release(this.now());
    if (this.gate.lastDecision) { this.emit('gate', this.gate.lastDecision); this.gate.lastDecision = null; }
    if (heard) this._frameAndAnswer(heard);
    else if (this.gate.hasPending()) this._schedulePoll();
  }

  /** The last few finished questions and answers (recent ones only). */
  _previous() {
    const cutoff = this.now() - MEMORY_MINUTES * 60000;
    return this.qa.filter(x => x.at >= cutoff).slice(-MEMORY_ANSWERS).map(({ question, answer }) => ({ question, answer }));
  }

  _context(question) {
    const cutoff = this.now() - CONTEXT_WINDOW_MS;
    return this.history
      .filter(h => h.at >= cutoff && !h.used)   // earlier questions were already answered
      .map(h => h.text)
      .filter(t => question.indexOf(t) === -1)  // the question itself is sent separately
      .slice(-CONTEXT_LINES);
  }

  /**
   * "Ask selected": the teacher selected some text in an answer; it becomes the next question. The answer it came
   * from is always given to the AI as background, even when it is older than the usual follow-up memory.
   * @param {string} text  the selected text
   * @param {{question: string, answer: string}} [from]  the question and answer the text was selected in
   */
  askSelection(text, from) {
    const q = String(text || '').trim().slice(0, 2000);
    if (!q) return;
    const parent = from && from.question ? { question: String(from.question).slice(0, 2000), answer: String(from.answer || '').slice(0, 4000) } : null;
    this._answer(q, this._context(''), 'selection', parent);
  }

  /** The "Ask" box (a question or a few keywords the teacher typed), or a question the teacher corrected and re-asked. */
  askTyped(text, { corrected = false } = {}) {
    const q = String(text || '').trim().slice(0, 2000);
    if (!q) return;
    this._answer(q, this._context(''), corrected ? 'corrected' : 'typed');
  }

  async _answer(question, givenContext, source = 'speech', parent = null) {
    this.lastQuestion = question;
    const context = givenContext || this._context(question);
    for (const h of this.history) if (question.indexOf(h.text) !== -1) h.used = true;
    if (!this.answerer.ready) {
      if (this.now() - this.lastKeyWarning > 30000) {
        this.lastKeyWarning = this.now();
        this.emit('error', { code: 'no-key', message: 'Question heard, but no API key is set for the selected AI. Open Settings and add it.' });
      }
      return;
    }
    while (this.active.size >= MAX_PARALLEL_ANSWERS) { // only when too many are running at once
      const [oldestId, oldest] = this.active.entries().next().value;
      this.active.delete(oldestId);
      oldest.abort();
    }

    const previous = this._previous();   // taken now, so answers finishing meanwhile do not change this one
    if (parent && !previous.some(p => p.question === parent.question)) previous.push(parent);
    const startedAt = Date.now();
    let firstWordAt = 0;
    const id = this.nextId++;
    const controller = new AbortController();
    this.active.set(id, controller);
    this.emit('answer-start', { id, question, source });
    this._status();

    try {
      const result = await this.answerer.answer({
        question,
        context,
        previous,
        source,
        signal: controller.signal,
        onDelta: delta => {
          if (!firstWordAt) firstWordAt = Date.now();
          if (this.active.has(id)) this.emit('answer-delta', { id, delta });
        },
      });
      if (controller.signal.aborted) return;
      if (result.refused) this.emit('answer-error', { id, message: 'Claude declined to answer this question.' });
      else if (result.skipped) this.emit('answer-skip', { id });
      else {
        result.text = toReadingText(result.text);   // one statement per line, easy to read aloud
        this.emit('timing', { id, firstWordMs: firstWordAt ? firstWordAt - startedAt : -1, totalMs: Date.now() - startedAt });
        this.qa.push({ question, answer: result.text, at: this.now() });
        if (this.qa.length > 20) this.qa.shift();
        this.emit('answer-done', { id, text: result.text });
      }
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError' || /aborted/i.test(String(err.message))) {
        this.emit('answer-cancelled', { id });
      } else {
        this.emit('answer-error', { id, message: friendlyError(err) });
      }
    } finally {
      this.active.delete(id);
      this._status();
    }
  }
}

function friendlyError(err) {
  if (err.code === 'no-key') return 'No API key set for the selected AI. Open Settings and add it.';
  if (err.status === 401 || err.status === 403) return `The AI key was rejected (${err.status}). Check the key in Settings.`;
  if (err.status === 400 && /API key/i.test(String(err.message))) return 'The AI key was rejected. Check the key in Settings.';
  if (err.status === 429) return 'The free AI quota is used up for the moment (429). Wait about a minute, ask fewer questions at once, or switch model in Settings.';
  if (err.status >= 500) return `The AI service is having trouble (${err.status}). Try again.`;
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(String(err.message))) return 'Cannot reach the AI service. Check the internet connection.';
  return `Could not get an answer: ${err.message}`;
}

module.exports = { Pipeline, friendlyError };
