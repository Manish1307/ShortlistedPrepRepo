'use strict';
// Turns the session (questions, answers, response times, what was heard) into a text, CSV or JSON file.
// Pure functions, no Electron: the main process only decides where to save.

const secs = ms => (ms === null || ms === undefined || ms < 0 ? '–' : (ms / 1000).toFixed(1) + ' s');
const stamp = iso => (iso ? new Date(iso).toLocaleString() : '–');

/** wait + first words = how long the teacher waited after the last words were heard */
const heardToFirstWords = e => (e.waitMs === null || e.waitMs === undefined || e.firstWordMs === null || e.firstWordMs < 0 ? null : e.waitMs + e.firstWordMs);

function summary(entries) {
  const done = entries.filter(e => e.status === 'done');
  const avg = list => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
  return {
    questions: entries.length,
    answered: done.length,
    failed: entries.filter(e => e.status === 'error').length,
    avgFirstWordMs: avg(done.map(e => e.firstWordMs).filter(n => n >= 0)),
    avgTotalMs: avg(done.map(e => e.totalMs).filter(n => n !== null && n >= 0)),
    avgHeardToFirstMs: avg(done.map(heardToFirstWords).filter(n => n !== null)),
  };
}

function formatText(data) {
  const s = summary(data.entries);
  const out = [];
  out.push('CLASS SESSION: QUESTIONS, ANSWERS AND RESPONSE TIMES');
  out.push('='.repeat(60));
  out.push(`Started : ${stamp(data.startedAt)}`);
  out.push(`Exported: ${stamp(data.exportedAt)}`);
  if (data.subject) out.push(`Subject : ${data.subject}`);
  if (data.provider) out.push(`AI      : ${data.provider}${data.model ? ' (' + data.model + ')' : ''}`);
  out.push('');
  out.push(`Questions: ${s.questions}   Answered: ${s.answered}   Failed: ${s.failed}`);
  out.push(`Average first words after the answer started: ${secs(s.avgFirstWordMs)}`);
  out.push(`Average time until the answer was finished   : ${secs(s.avgTotalMs)}`);
  out.push(`Average from the end of speaking to first words: ${secs(s.avgHeardToFirstMs)}`);
  out.push('');
  data.entries.forEach((e, i) => {
    out.push('-'.repeat(60));
    out.push(`#${i + 1}  ${stamp(e.askedAt)}${e.status === 'error' ? '   (FAILED)' : ''}`);
    out.push(`Question: ${e.question}`);
    out.push(`Times   : waited ${secs(e.waitMs)} after the last words, first words after ${secs(e.firstWordMs)}, finished after ${secs(e.totalMs)}` +
      (heardToFirstWords(e) !== null ? `  (end of speaking to first words: ${secs(heardToFirstWords(e))})` : ''));
    if (e.provider) out.push(`AI      : ${e.provider}${e.model ? ' (' + e.model + ')' : ''}`);
    out.push('');
    out.push(e.status === 'error' ? `Error: ${e.error || e.answer}` : (e.answer || '(no answer yet)'));
    out.push('');
  });
  if (data.transcript.length) {
    out.push('='.repeat(60));
    out.push('EVERYTHING THAT WAS HEARD (speech to text)');
    out.push('='.repeat(60));
    data.transcript.forEach(t => out.push(`[${new Date(t.at).toLocaleTimeString()}] ${t.text}`));
  }
  return out.join('\n') + '\n';
}

/** A spreadsheet must never run a cell as a formula: text that starts with = + - @ is made safe. */
const safeCell = value => {
  let s = String(value === null || value === undefined ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function formatCsv(data) {
  const header = ['number', 'asked_at', 'question', 'answer', 'status', 'wait_after_last_words_s', 'first_words_s', 'finished_s', 'end_of_speaking_to_first_words_s', 'ai', 'model', 'error'];
  const num = ms => (ms === null || ms === undefined || ms < 0 ? '' : (ms / 1000).toFixed(2));
  const rows = data.entries.map((e, i) => [
    i + 1, e.askedAt, e.question, e.status === 'error' ? '' : e.answer, e.status,
    num(e.waitMs), num(e.firstWordMs), num(e.totalMs), num(heardToFirstWords(e)), e.provider || '', e.model || '', e.error || '',
  ]);
  return [header, ...rows].map(r => r.map(safeCell).join(',')).join('\r\n') + '\r\n';
}

function formatJson(data) {
  return JSON.stringify({ ...data, summary: summary(data.entries) }, null, 2) + '\n';
}

module.exports = { formatText, formatCsv, formatJson, summary, safeCell, heardToFirstWords };
