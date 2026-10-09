'use strict';
// Voice-activity segmenter: turns a continuous 16 kHz mono PCM stream into separate spoken utterances.
// Pure and deterministic (time comes from the number of samples, never the wall clock), so it is unit-testable.
//
// Normally an utterance ends after a pause. Very long speech has to be cut anyway (the speech engine handles
// about 15 s at a time), so it is cut at a natural gap between words: first at the next short pause once the
// utterance is "long", and if there is none, at the quietest moment of the last few seconds. Never mid-word.

const { SAMPLE_RATE } = require('./wav');

const DEFAULTS = {
  sampleRate: SAMPLE_RATE,
  frameMs: 20,
  minSpeechMs: 350,      // ignore bursts shorter than this (clicks, keyboard)
  startFrames: 4,        // this many consecutive loud frames start an utterance (80 ms)
  hangMs: 800,           // this much trailing silence ends an utterance
  preRollMs: 300,        // audio kept from before the first loud frame (so first word is not clipped)
  tailMs: 200,           // trailing silence kept in the segment
  softMaxMs: 9000,       // after this long, the next short pause becomes a cut point
  softGapMs: 120,        // ...a pause this long counts as a natural gap between words
  maxUtteranceMs: 14000, // hard limit: cut at the quietest moment in the last `searchBackMs`
  searchBackMs: 4000,
  minThresholdDb: -48,   // never treat anything quieter than this as speech
  marginDb: 12,          // speech must be this far above the tracked noise floor
};

function frameDb(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

class Segmenter {
  /**
   * @param {(segment: {pcm: Int16Array, startMs: number, endMs: number, voicedMs: number, peakDb: number}) => void} onSegment
   * @param {(info: {db: number, speaking: boolean, noiseDb: number}) => void} [onLevel]
   */
  constructor(onSegment, onLevel, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.onSegment = onSegment;
    this.onLevel = onLevel || null;
    this.frameLen = Math.round((this.o.sampleRate * this.o.frameMs) / 1000);
    this.carry = new Int16Array(0);
    this.frameIndex = 0;
    this.noiseDb = -60;
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.preRoll = [];     // recent frames while idle
    this.loudRun = 0;
    this.frames = [];      // frames of the current utterance
    this.loud = [];        // per frame: was it speech-loud
    this.dbs = [];         // per frame: its level
    this.silenceRun = 0;
    this.peakDb = -100;
    this.startFrame = 0;
  }

  /** True while someone is talking (the utterance has not ended yet). */
  isSpeaking() { return this.state === 'speech'; }

  /** Feed any amount of 16 kHz mono Int16 samples. */
  push(samples) {
    let data = samples;
    if (this.carry.length) {
      data = new Int16Array(this.carry.length + samples.length);
      data.set(this.carry, 0);
      data.set(samples, this.carry.length);
    }
    let pos = 0;
    while (pos + this.frameLen <= data.length) {
      this._frame(data.subarray(pos, pos + this.frameLen));
      pos += this.frameLen;
    }
    this.carry = data.slice(pos);
  }

  /** Call at the end of a stream / when listening stops, so a half-finished utterance is not lost. */
  flush() {
    if (this.state === 'speech') this._emit(this.frames.length, this.silenceRun);
    this.reset();
  }

  _frame(f) {
    const o = this.o;
    const db = frameDb(f);
    const threshold = Math.max(o.minThresholdDb, this.noiseDb + o.marginDb);
    const loud = db > threshold;
    const idx = this.frameIndex++;

    // track the noise floor only while nobody is talking
    if (!loud && this.state === 'idle') {
      this.noiseDb = Math.min(-35, Math.max(-75, 0.97 * this.noiseDb + 0.03 * db));
    }
    if (this.onLevel && idx % 5 === 0) this.onLevel({ db, speaking: this.state === 'speech', noiseDb: this.noiseDb });

    const frame = f.slice(); // own copy: the caller's buffer may be reused

    if (this.state === 'idle') {
      this.preRoll.push({ frame, db });
      const keep = Math.ceil(o.preRollMs / o.frameMs) + o.startFrames;
      if (this.preRoll.length > keep) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= o.startFrames) {
        this.state = 'speech';
        const pre = this.preRoll;
        this.frames = pre.map(p => p.frame);
        this.dbs = pre.map(p => p.db);
        this.loud = pre.map((_, i) => i >= pre.length - this.loudRun);
        this.startFrame = idx - this.frames.length + 1;
        this.silenceRun = 0;
        this.peakDb = db;
        this.preRoll = [];
      }
      return;
    }

    // state === 'speech'
    this.frames.push(frame);
    this.dbs.push(db);
    this.loud.push(loud);
    if (loud) { this.silenceRun = 0; this.peakDb = Math.max(this.peakDb, db); }
    else this.silenceRun++;

    const hangFrames = Math.ceil(o.hangMs / o.frameMs);
    const softFrames = Math.ceil(o.softMaxMs / o.frameMs);
    const gapFrames = Math.ceil(o.softGapMs / o.frameMs);
    const maxFrames = Math.ceil(o.maxUtteranceMs / o.frameMs);
    const n = this.frames.length;

    if (this.silenceRun >= hangFrames) {
      this._emit(n, this.silenceRun);                       // the speaker paused: the utterance is over
      this.reset();
    } else if (n >= softFrames && this.silenceRun >= gapFrames) {
      this._splitAt(n);                                     // long speech, and a natural gap: cut here, keep going
    } else if (n >= maxFrames) {
      this._splitAt(this._quietestPoint());                 // no gap found: cut where it is quietest
    }
  }

  /** Index (in this.frames) of the quietest short stretch within the last `searchBackMs`. */
  _quietestPoint() {
    const o = this.o;
    const n = this.frames.length;
    const from = Math.max(Math.ceil(o.minSpeechMs / o.frameMs) + 1, n - Math.ceil(o.searchBackMs / o.frameMs));
    let best = n, bestScore = Infinity;
    for (let i = from; i < n - 2; i++) {
      const score = (this.dbs[i - 1] + this.dbs[i] + this.dbs[i + 1]) / 3;   // smoothed, so one dip is not luck
      if (score < bestScore) { bestScore = score; best = i + 1; }
    }
    return best;
  }

  /** Emit frames[0..at) as one utterance and carry on with the rest (a little overlap so no word is clipped). */
  _splitAt(at) {
    this._emit(at, 0);
    const overlap = Math.min(at, Math.ceil(this.o.preRollMs / this.o.frameMs));
    const keepFrom = at - overlap;
    this.startFrame += keepFrom;
    this.frames = this.frames.slice(keepFrom);
    this.dbs = this.dbs.slice(keepFrom);
    this.loud = this.loud.slice(keepFrom);
    this.silenceRun = Math.min(this.silenceRun, this.frames.length);
  }

  /** Hand frames[0..at) to the listener (dropping most of any trailing silence). */
  _emit(at, trailingSilence) {
    const o = this.o;
    const trim = Math.max(0, Math.min(trailingSilence, at) - Math.ceil(o.tailMs / o.frameMs));
    const end = at - trim;
    let voiced = 0;
    for (let i = 0; i < end; i++) if (this.loud[i]) voiced++;
    const voicedMs = voiced * o.frameMs;
    if (voicedMs < o.minSpeechMs) return;
    const pcm = new Int16Array(end * this.frameLen);
    for (let i = 0; i < end; i++) pcm.set(this.frames[i], i * this.frameLen);
    this.onSegment({
      pcm,
      startMs: this.startFrame * o.frameMs,
      endMs: (this.startFrame + end) * o.frameMs,
      voicedMs,
      peakDb: this.peakDb,
    });
  }
}

module.exports = { Segmenter, frameDb, DEFAULTS };
