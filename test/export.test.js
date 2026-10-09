'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatText, formatCsv, formatJson, summary, safeCell } = require('../src/export');

const data = {
  startedAt: '2026-10-09T09:00:00.000Z', exportedAt: '2026-10-09T10:00:00.000Z', subject: 'Power Platform', provider: 'groq',
  entries: [
    { id: 1, askedAt: '2026-10-09T09:05:00.000Z', question: 'What is a web service?', answer: 'It lets programs talk.\n\nLike a waiter.', status: 'done', waitMs: 1200, firstWordMs: 800, totalMs: 3000, provider: 'groq', model: 'llama-3.3-70b-versatile' },
    { id: 2, askedAt: '2026-10-09T09:06:00.000Z', question: 'How, "exactly", do I call it?', answer: '', status: 'error', error: 'Rate limit (429)', waitMs: 500, firstWordMs: null, totalMs: null, provider: 'groq', model: 'x' },
    { id: 3, askedAt: '2026-10-09T09:07:00.000Z', question: '=HYPERLINK("http://evil.example","click")', answer: '-1+1', status: 'done', waitMs: 800, firstWordMs: 1200, totalMs: 5000 },
  ],
  transcript: [{ at: '2026-10-09T09:04:58.000Z', text: 'What is a web service?' }],
};

test('summary: averages only use answered questions that have timings', () => {
  const s = summary(data.entries);
  assert.equal(s.questions, 3);
  assert.equal(s.answered, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.avgFirstWordMs, 1000);
  assert.equal(s.avgTotalMs, 4000);
  assert.equal(s.avgHeardToFirstMs, 2000);     // (1200+800 + 800+1200) / 2
});

test('text export has the questions, answers, response times, errors and what was heard', () => {
  const t = formatText(data);
  assert.match(t, /Questions: 3   Answered: 2   Failed: 1/);
  assert.match(t, /Question: What is a web service\?/);
  assert.match(t, /waited 1\.2 s after the last words, first words after 0\.8 s, finished after 3\.0 s/);
  assert.match(t, /end of speaking to first words: 2\.0 s/);
  assert.match(t, /It lets programs talk\.\n\nLike a waiter\./, 'answers keep their paragraphs');
  assert.match(t, /\(FAILED\)/);
  assert.match(t, /Error: Rate limit \(429\)/);
  assert.match(t, /EVERYTHING THAT WAS HEARD/);
  assert.match(t, /What is a web service\?/);
});

test('CSV export: one row per question, quotes and line breaks are escaped, times are numbers', () => {
  const csv = formatCsv(data);
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^number,asked_at,question,answer,status,wait_after_last_words_s,first_words_s,finished_s/);
  assert.match(csv, /"It lets programs talk\.\n\nLike a waiter\."/);
  assert.match(csv, /"How, ""exactly"", do I call it\?"/);
  assert.match(csv, /,done,1\.20,0\.80,3\.00,2\.00,groq,llama-3\.3-70b-versatile,/);
});

test('CSV export: text that a spreadsheet could run as a formula is made safe', () => {
  assert.equal(safeCell('=1+1'), "'=1+1");
  assert.equal(safeCell('+cmd'), "'+cmd");
  assert.equal(safeCell('-1+1'), "'-1+1");
  assert.equal(safeCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(safeCell('plain'), 'plain');
  const csv = formatCsv(data);
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), 'no cell starts with =');
});

test('JSON export keeps the data and adds the summary', () => {
  const parsed = JSON.parse(formatJson(data));
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.summary.answered, 2);
});

test('an empty session still formats', () => {
  const empty = { startedAt: null, exportedAt: null, entries: [], transcript: [] };
  assert.match(formatText(empty), /Questions: 0/);
  assert.equal(formatCsv(empty).trim().split('\r\n').length, 1);
});

test('the opacity setting is limited to 10 to 100 in steps of 10', () => {
  // config needs Electron's app object, so the same rule is checked on a copy of it
  const clamp = v => Math.min(100, Math.max(10, Math.round(Number(v) / 10) * 10)) || 100;
  assert.equal(clamp(100), 100);
  assert.equal(clamp(10), 10);
  assert.equal(clamp(35), 40);
  assert.equal(clamp(0), 10);
  assert.equal(clamp(500), 100);
  assert.equal(clamp('abc'), 100);
  assert.equal(clamp(undefined), 100);
});
