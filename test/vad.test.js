'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Segmenter } = require('../src/audio/vad');

const RATE = 16000;

/** Pseudo speech: a few tones with an amplitude wobble, plus a little noise. */
function speech(seconds, amp = 0.25) {
  const n = Math.round(seconds * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const v = amp * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 420 * t) + 0.1 * Math.sin(2 * Math.PI * 1100 * t))
      * (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t));
    out[i] = Math.round(v * 32767 + (Math.random() - 0.5) * 60);
  }
  return out;
}
function silence(seconds) {
  const n = Math.round(seconds * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() - 0.5) * 40); // faint room noise
  return out;
}
function concat(...parts) {
  const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0; parts.forEach(p => { out.set(p, pos); pos += p.length; });
  return out;
}
/** Push in uneven chunks, like real audio callbacks. */
function feed(seg, samples) {
  let pos = 0, sizes = [1600, 777, 2500, 160, 4000];
  for (let k = 0; pos < samples.length; k++) {
    const len = sizes[k % sizes.length];
    seg.push(samples.subarray(pos, pos + len));
    pos += len;
  }
}

test('splits two phrases separated by a pause and ignores a short click', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  feed(s, concat(silence(1), speech(1.2), silence(1.5), speech(0.15), silence(1.5), speech(2), silence(1.5)));
  assert.equal(found.length, 2, 'the 150 ms click must be ignored');
  const [a, b] = found;
  assert.ok(a.voicedMs >= 1000 && a.voicedMs <= 1300, `first voiced ~1.2 s, got ${a.voicedMs}`);
  assert.ok(b.voicedMs >= 1800 && b.voicedMs <= 2100, `second voiced ~2 s, got ${b.voicedMs}`);
  // the start of the phrase is not clipped: the segment begins at or just before the speech
  assert.ok(a.startMs <= 1000 && a.startMs >= 600, `first starts near 1 s, got ${a.startMs}`);
  assert.ok(b.startMs > a.endMs);
  assert.ok(a.pcm.length > 0 && a.pcm instanceof Int16Array);
});

test('a short pause inside a sentence does not split it', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  feed(s, concat(silence(0.5), speech(1), silence(0.5), speech(1), silence(1.5)));
  assert.equal(found.length, 1);
  assert.ok(found[0].voicedMs >= 1800);
});

test('pure silence and quiet noise produce nothing', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  feed(s, silence(10));
  s.flush();
  assert.equal(found.length, 0);
});

test('very long speech is cut at the maximum length and nothing is lost', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x), null, { maxUtteranceMs: 5000 });
  feed(s, concat(silence(0.5), speech(12), silence(1.5)));
  s.flush();
  assert.ok(found.length >= 2, `expected the 12 s of speech to be cut, got ${found.length}`);
  const total = found.reduce((sum, f) => sum + f.voicedMs, 0);
  assert.ok(total >= 10500, `most of the 12 s must be kept, got ${total} ms`);
});

test('flush() releases a phrase that was still being spoken', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  feed(s, concat(silence(0.5), speech(1.5)));
  assert.equal(found.length, 0);
  s.flush();
  assert.equal(found.length, 1);
});

test('speech after a loud phrase is still detected (noise floor does not run away)', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  feed(s, concat(silence(2), speech(1), silence(3), speech(1, 0.05), silence(1.5)));
  assert.equal(found.length, 2, 'a quieter second phrase (amp 0.05) must still be heard');
});

test('long speech is cut at a gap between words, not through a word', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  // 12 s of talking with a short 0.3 s breath at 10 s, then a real pause
  feed(s, concat(silence(0.5), speech(10), silence(0.3), speech(2), silence(1.5)));
  s.flush();
  assert.equal(found.length, 2, `expected a cut at the breath, got ${found.length} pieces`);
  assert.ok(found[0].voicedMs > 9500 && found[0].voicedMs < 10700, `first piece should end at the breath, got ${found[0].voicedMs} ms`);
  assert.ok(found[1].voicedMs > 1500, 'the rest follows as the next piece');
});

test('continuous speech with no gaps is cut at its quietest moment within the last seconds', () => {
  const found = [];
  const s = new Segmenter(x => found.push(x));
  // 16 s of solid speech with one quieter dip (still above the threshold) at 12 s
  const dip = speech(0.15, 0.03);
  feed(s, concat(silence(0.5), speech(12), dip, speech(4), silence(1.5)));
  s.flush();
  assert.ok(found.length >= 2, 'cut at least once');
  assert.ok(found.every(f => (f.endMs - f.startMs) <= 14500), 'no piece longer than the hard limit');
  const cutMs = found[0].endMs;
  assert.ok(cutMs > 11000 && cutMs < 13500, `the cut should land near the quiet dip (about 12 s), got ${cutMs} ms`);
});

test('isSpeaking() is true while talking and false after the pause', () => {
  const s = new Segmenter(() => {});
  assert.equal(s.isSpeaking(), false);
  feed(s, concat(silence(0.3), speech(1)));
  assert.equal(s.isSpeaking(), true);
  feed(s, silence(1.2));
  assert.equal(s.isSpeaking(), false);
});
