'use strict';
// Word error rate, used by the accuracy test: accuracy = 1 - WER.
// Numbers are compared as words ("9" and "nine" are the same word), as speech-recognition scoring normally does.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '');
  return String(n);
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(w => (/^\d{1,3}$/.test(w) ? numberToWords(Number(w)).split(' ') : [w]));
}

/** Levenshtein distance over word arrays, returning edit counts. */
function wer(reference, hypothesis) {
  const r = words(reference), h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  const errors = d[r.length][h.length];
  return {
    errors,
    refWords: r.length,
    wer: r.length ? errors / r.length : (h.length ? 1 : 0),
    accuracy: r.length ? Math.max(0, 1 - errors / r.length) : (h.length ? 0 : 1),
  };
}

module.exports = { wer, words, numberToWords };
