'use strict';
// Reading format: an answer is shown as separate short lines, one statement per line, so the teacher can read a
// line, pause, then read the next, instead of reading a paragraph without a break.
// Works in Node (the main process, tests) and in the web page (loaded with a <script> tag as window.ReadFormat).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReadFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // a full stop after one of these does not end a sentence
  const ABBREVIATION = /(?:\b(?:e\.g|i\.e|vs|etc|dr|mr|mrs|ms|prof|inc|ltd|no|st|approx|fig)\.)$/i;
  const LIST_ITEM = /^([-•*–]|\d{1,2}[.)])\s+/;
  // end of a sentence (. ! ? …, maybe followed by a closing quote or bracket), a space, then a new sentence starting
  const BOUNDARY = /(?<=[.!?…]["”')\]]*)\s+(?=["“‘(]?[A-Z0-9])/;
  const LONG_WORDS = 26;

  function splitSentences(line) {
    const pieces = line.split(BOUNDARY);
    const merged = [];
    for (const piece of pieces) {
      if (merged.length && ABBREVIATION.test(merged[merged.length - 1])) merged[merged.length - 1] += ' ' + piece;
      else merged.push(piece);
    }
    // a very long sentence is cut at a semicolon, which is already a natural stop
    const out = [];
    for (const sentence of merged) {
      if (sentence.split(/\s+/).length > LONG_WORDS && sentence.includes('; ')) {
        sentence.split(/;\s+/).forEach((part, i, all) => {
          const clean = part.charAt(0).toUpperCase() + part.slice(1);
          out.push(i < all.length - 1 && !/[.!?]$/.test(clean) ? clean + '.' : clean);
        });
      } else out.push(sentence);
    }
    return out.map(s => s.trim()).filter(Boolean);
  }

  /** The lines to show, one statement each. List items (- ..., 1. ...) stay as they are. Safe to apply twice. */
  function toLines(text) {
    const lines = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (LIST_ITEM.test(line)) lines.push(line);
      else lines.push(...splitSentences(line));
    }
    return lines;
  }

  /** The same, as text: one line per statement. */
  function toReadingText(text) { return toLines(text).join('\n'); }

  return { toLines, toReadingText, splitSentences };
});
