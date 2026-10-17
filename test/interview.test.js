'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const coach = require('../src/interview/coach');

const fakeAI = reply => ({ calls: [], async complete(args) { this.calls.push(args); return typeof reply === 'function' ? reply(args) : reply; } });

test('there are 50 companies to practise for, no duplicates', () => {
  assert.equal(coach.COMPANIES.length, 50);
  assert.equal(new Set(coach.COMPANIES).size, 50);
});

test('questions: company, role, round and level go to the AI; the JSON reply is cleaned', async () => {
  const ai = fakeAI('```json\n{"questions":[{"question":"Explain how a HashMap works in Java.","topic":"Collections","points":["hashing","buckets","resize"]},{"question":"Hi"}]}\n```');
  const qs = await coach.generateQuestions(ai, { company: 'Infosys', role: 'Java developer', round: 'technical', level: 'fresher', count: 3, avoid: ['What is OOP?'] });
  assert.deepEqual(qs, [{ question: 'Explain how a HashMap works in Java.', topic: 'Collections', points: ['hashing', 'buckets', 'resize'] }]);
  const u = ai.calls[0].user;
  assert.match(u, /Infosys/); assert.match(u, /Java developer/); assert.match(u, /Fresher/); assert.match(u, /What is OOP\?/);
  assert.equal(ai.calls[0].json, true);
  assert.match(ai.calls[0].system, /Never claim a question is a real or leaked question/);
});

test('questions: a plain array of strings is accepted too; an unusable reply is an error', async () => {
  assert.equal((await coach.generateQuestions(fakeAI('["What is a deadlock and how do you avoid it?"]'), {}))[0].topic, 'General');
  await assert.rejects(coach.generateQuestions(fakeAI('Sorry, I cannot.'), {}), /expected form/);
});

test('evaluation: score is clamped to 0-10 and the lists are trimmed', async () => {
  const ai = fakeAI(JSON.stringify({ score: 14, verdict: 'Strong answer.', strengths: ['a', 'b', 'c', 'd'], missing: ['x'], betterAnswer: 'I would say...', followUp: 'What about collisions?' }));
  const f = await coach.evaluateAnswer(ai, { question: 'HashMap?', answer: 'It uses hashing.', points: ['buckets'] });
  assert.equal(f.score, 10);
  assert.equal(f.strengths.length, 3);
  assert.equal(f.followUp, 'What about collisions?');
  assert.match(ai.calls[0].user, /Candidate's answer:\nIt uses hashing\./);
  assert.match(ai.calls[0].user, /- buckets/);
});

test('evaluation: an empty answer scores 0 without asking the AI', async () => {
  const ai = fakeAI('{}');
  const f = await coach.evaluateAnswer(ai, { question: 'q', answer: '   ' });
  assert.equal(f.score, 0);
  assert.equal(ai.calls.length, 0);
});

test('summary and report: average of answered questions, weak and strong topics', () => {
  const items = [
    { question: 'Q1', topic: 'SQL', score: 8, answer: 'a', verdict: 'Good.' },
    { question: 'Q2', topic: 'Java', score: 4, answer: 'b', verdict: 'Weak.', missing: ['say more'] },
    { question: 'Q3', topic: 'Java', skipped: true, score: null },
  ];
  const s = coach.summarize(items);
  assert.deepEqual([s.average, s.answered, s.skipped, s.readiness], [6, 2, 1, 'Nearly there']);
  assert.deepEqual(s.strongTopics, ['SQL']);
  assert.deepEqual(s.weakTopics, ['Java']);
  const text = coach.formatReport({ company: 'TCS', role: 'Java developer', round: 'technical', level: 'fresher', items });
  assert.match(text, /Overall score: 6 \/ 10/);
  assert.match(text, /Q3\. \[Java\] Q3\nSkipped\./);
  assert.match(text, /  - say more/);
});
