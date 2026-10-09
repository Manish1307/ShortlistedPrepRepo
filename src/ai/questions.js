'use strict';
// Decides which parts of the live transcript are real, answerable questions.
// Pure functions + a small time-based gate; no Electron, no network.

const WH_WORDS = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which']);
const AUX_WORDS = new Set([
  'is', 'are', 'am', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'have', 'has', 'had', "isn't", "aren't", "doesn't", "don't",
  "didn't", "can't", "won't", "wouldn't", "shouldn't", "couldn't",
]);

// "Can you explain...", "I don't understand...", "what's the difference..." etc.
const REQUEST_RE = new RegExp([
  String.raw`\b(can|could|would|will) (you|someone|anyone|somebody) (please )?(explain|tell|show|help|clarify|repeat|go over|walk|give|solve|define|describe)\b`,
  String.raw`\b(explain|clarify|define|describe|elaborate on)\b`,
  String.raw`\btell me (about|how|why|what)\b`,
  String.raw`\b(i don'?t|i do not) (understand|get)\b`,
  String.raw`\bwhat'?s the (difference|meaning|formula|answer|reason|point)\b`,
  String.raw`\bhow (do|does|did|can|could|should|would|to)\b`,
  String.raw`\bwhat (is|are|does|do|was|were|about|if)\b`,
  String.raw`\bwhy (is|are|does|do|did|can|would|should)\b`,
].join('|'), 'i');

// Classroom logistics / small talk: questions, but nothing to look up.
const LOGISTICS_RE = new RegExp([
  String.raw`\b(can|could) (you|everyone|everybody|anyone) (all )?(hear|see) (me|my screen|the screen|this|it)\b`,
  String.raw`\bcan you (all )?(hear|see)\b`,
  String.raw`\bare you (there|still there|with me|ready|muted|back)\b`,
  String.raw`\bis (everyone|everybody|anyone) (here|there|ready|able to|back)\b`,
  String.raw`\bany(one)? (other |more )?questions\b`,
  String.raw`\bdoes (that|this|it) make sense\b`,
  String.raw`\bis (that|this) (clear|ok|okay|fine|better)\b`,
  String.raw`\b(am i|are we) (audible|visible|sharing|live|recording)\b`,
  String.raw`\b(unmute|mute yourself|mute your)\b`,
  String.raw`\bhow('s| is| are) (everyone|everybody|you all|you guys)\b`,
  String.raw`\bscreen (share|sharing)\b`,
  String.raw`\b(good morning|good afternoon|hello everyone|hi everyone)\b`,
].join('|'), 'i');

// Things Whisper invents on silence / noise / music.
const HALLUCINATION_RE = new RegExp([
  String.raw`^\s*[\[(][^\])]*[\])]\s*$`,                      // [BLANK_AUDIO], (music), [Music]
  String.raw`^\s*(thank you|thanks|thank you very much|thanks for watching|thank you for watching|bye|bye-bye|you|okay|ok|so|yeah|uh|um|hmm|mm-hmm)[.!\s]*$`,
  String.raw`subtitles? (by|from)|amara\.org|captioned by|transcribed by|www\.[a-z0-9-]+\.[a-z]{2,}`,
  String.raw`please (like|subscribe)|see you (in the )?next (video|time)`,
].join('|'), 'i');

function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Lower-case, no punctuation: used to compare two questions. */
function normalizeForCompare(text) {
  return collapse(text).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Remove non-speech tags and stray formatting from a Whisper result. */
function cleanTranscript(text) {
  return collapse(
    String(text || '')
      .replace(/\[[^\]]*\]/g, ' ')      // [BLANK_AUDIO] [Music] ...
      .replace(/\((?:music|laughter|applause|silence|noise)[^)]*\)/gi, ' ')
      .replace(/^[-–—\s"']+/, '')
  );
}

/** True when the text is almost certainly not speech (Whisper hallucination). */
function isHallucination(text) {
  const t = collapse(text);
  if (!t) return true;
  if (HALLUCINATION_RE.test(t)) return true;
  const words = t.toLowerCase().split(' ');
  if (words.length >= 5) {
    // the same word over and over ("the the the the the")
    const counts = {};
    words.forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    if (Math.max(...Object.values(counts)) / words.length >= 0.7) return true;
  }
  const letters = (t.match(/[a-z]/gi) || []).length;
  return letters / t.length < 0.5; // mostly symbols / digits
}

/** Spoken lead-in that is not part of the question: "Okay, so my question is, ...". */
function stripLeadIn(text) {
  let t = collapse(text);
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/^(okay|ok|so|well|right|alright|now|and|hello|hi|hey)\b[,.!]?\s+/i, '')
      .replace(/^(my|the|one|another|a|next|second|first)( (next|another|follow[- ]?up))? question (is|was)[,:]?\s+/i, '')
      .replace(/^i (want|would like|wanted) to (ask|know)( that)?[,:]?\s+/i, '');
    if (next === t) break;
    t = next;
  }
  t = t || collapse(text);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** How many separate questions does this stretch of speech seem to contain? */
function countQuestions(text) {
  const sentences = splitSentences(text);
  let n = sentences.filter(s => sentenceLooksLikeQuestion(s)).length;
  // "Could you please explain this?" after the real question is the same question, not a second one
  const polite = sentences.filter(s => /^(could|can|would|will) you (please )?(explain|tell|describe|show|elaborate|help)\b|^please (explain|tell|describe|show|elaborate|give)\b|^(explain|describe|elaborate)( (this|that|it|with|me|to me))/i.test(s)).length;
  if (n > 1 && polite) n -= Math.min(polite, n - 1);
  const another = /\b(another|second|next|one more|also) (question|thing)\b/i.test(text) ? 1 : 0;
  return Math.max(n, another ? 2 : 0, n ? 1 : 0);
}

function looksLikeQuestion(text) {
  const t = collapse(text);
  if (sentenceLooksLikeQuestion(t)) return true;
  return splitSentences(t).some(sentenceLooksLikeQuestion);
}

// Auxiliaries that start a question without being an imperative ("Do not forget", "Have a look" are not).
const AUX_SAFE = new Set(['is', 'are', 'am', 'was', 'were', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall']);
const PRONOUNS = new Set(['you', 'we', 'i', 'they', 'he', 'she', 'it', 'these', 'those', 'students', 'anyone', 'everyone']);

function sentenceLooksLikeQuestion(sentence) {
  const t = collapse(sentence);
  const words = t.split(' ').filter(Boolean);
  if (words.length < 3) return false;
  if (LOGISTICS_RE.test(t)) return false;
  if (t.endsWith('?')) return true;                       // Whisper puts a question mark on real questions
  const w = words.map(x => x.toLowerCase().replace(/[^a-z']/g, ''));
  const first = w[0], second = w[1];
  if (WH_WORDS.has(first) && (AUX_WORDS.has(second) || /^(many|much|long|far|often|old|come|about)$/.test(second))) return true;
  if (AUX_SAFE.has(first)) return true;                   // "Is the square root of two a rational number"
  if (/^(do|have|has)$/.test(first) && PRONOUNS.has(second)) return true;   // "Do you know why..."
  return REQUEST_RE.test(t);                              // "explain...", "I don't understand..."
}

function splitSentences(text) {
  // split after . ! ? only when a space follows, so ".NET", "3.5" and "e.g." stay inside their sentence
  return collapse(text).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * From a stretch of speech keep the LATEST group of question sentences and what follows it;
 * earlier sentences (statements, older questions) become context.
 */
function extractQuestion(text) {
  const sentences = splitSentences(text);
  let last = -1;
  sentences.forEach((s, n) => { if (sentenceLooksLikeQuestion(s)) last = n; });
  if (last <= 0) return collapse(text);
  let start = last;
  while (start > 0 && sentenceLooksLikeQuestion(sentences[start - 1])) start--; // "I don't understand. How did you get that?"
  return sentences.slice(start).join(' ');
}

/**
 * Collects transcribed utterances and releases them as one question once the speaker has been quiet
 * for `quietMs` (people pause mid-question, and Whisper splits at pauses).
 */
class QuestionGate {
  constructor({ quietMs = 1500, dedupeMs = 90000, maxChars = 700 } = {}) {
    this.quietMs = quietMs;
    this.dedupeMs = dedupeMs;
    this.maxChars = maxChars;
    this.pending = [];
    this.lastAt = 0;
    this.seen = new Map(); // normalized question -> time
  }

  push(text, nowMs) {
    const t = collapse(text);
    if (!t) return;
    this.pending.push(t);
    this.lastAt = nowMs;
    this.endsWithQuestion = t.endsWith('?'); // a finished question needs a shorter wait than a sentence that may continue
  }

  hasPending() { return this.pending.length > 0; }

  /** Milliseconds until poll() may release the pending text (0 = ready now). */
  dueIn(nowMs) {
    const wait = this.endsWithQuestion ? Math.min(this.quietMs, 400) : this.quietMs;
    return this.pending.length ? Math.max(0, this.lastAt + wait - nowMs) : Infinity;
  }

  /** The newly heard speech once the speaker has been quiet and it contains something question-like, else null. */
  release(nowMs) {
    if (!this.pending.length || this.dueIn(nowMs) > 0) return null;
    let text = collapse(this.pending.join(' '));
    this.pending = [];
    if (text.length > this.maxChars) text = text.slice(-this.maxChars);
    if (!looksLikeQuestion(text)) { this.lastDecision = { text, decision: 'not-a-question' }; return null; }
    this.lastDecision = { text, decision: 'sent-to-ai' };
    return text;
  }

  /** True the first time a question is seen (within dedupeMs); false for a repeat. */
  claim(question, nowMs) {
    const key = normalizeForCompare(question);
    for (const [k, at] of this.seen) if (nowMs - at > this.dedupeMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs);
    return true;
  }

  /** Returns the question text when ready and worth answering, otherwise null. */
  poll(nowMs) {
    if (!this.pending.length || this.dueIn(nowMs) > 0) return null;
    let text = collapse(this.pending.join(' '));
    this.pending = [];
    if (text.length > this.maxChars) text = text.slice(-this.maxChars);
    this.lastDecision = { text, decision: 'not-a-question' };
    if (!looksLikeQuestion(text)) return null;
    text = extractQuestion(text);

    const key = normalizeForCompare(text);
    for (const [k, at] of this.seen) if (nowMs - at > this.dedupeMs) this.seen.delete(k);
    if (this.seen.has(key)) { this.lastDecision = { text, decision: 'repeat-of-earlier-question' }; return null; }
    this.seen.set(key, nowMs);
    this.lastDecision = { text, decision: 'question' };
    return text;
  }
}

module.exports = { stripLeadIn, countQuestions, looksLikeQuestion, extractQuestion, isHallucination, cleanTranscript, normalizeForCompare, QuestionGate };
