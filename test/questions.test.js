'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripLeadIn, countQuestions, looksLikeQuestion, extractQuestion, isHallucination, cleanTranscript, QuestionGate } = require('../src/ai/questions');
const { wer } = require('../src/eval/wer');

test('real questions are detected', () => {
  const yes = [
    'What is the discriminant of a quadratic equation?',
    'how do you factor x squared minus nine',
    "Why does the graph open downwards when a is negative?",
    'Can you explain the difference between mean and median',
    'Could you go over the last step again',
    "I don't understand how you got the second line",
    'So the roots are real if the discriminant is positive?',
    "What's the difference between a function and a relation",
    'Is the square root of two a rational number',
    'Do you know why the parabola is symmetric',
    'How many solutions does it have',
    'Tell me about the quadratic formula',
  ];
  for (const q of yes) assert.equal(looksLikeQuestion(q), true, q);
});

test('statements, logistics and tiny fragments are not answered', () => {
  const no = [
    'Today we are going to solve quadratic equations.',
    'Can you hear me?',
    'Can everyone see my screen',
    'Are you still there',
    'Any questions so far?',
    'Does that make sense?',
    'Okay?',
    'Right?',
    'Good morning everyone',
    'Let me share my screen first',
    'We will take a five minute break now.',
    'Do not forget to submit the homework',
    'Have a look at page forty two',
    'What I want you to notice is the sign',
  ];
  for (const t of no) assert.equal(looksLikeQuestion(t), false, t);
});

test('Whisper hallucinations are filtered', () => {
  const bad = ['[BLANK_AUDIO]', '(music)', 'Thank you.', 'Thanks for watching!', 'you', 'Subtitles by the Amara.org community',
    'the the the the the the the the', '...', '12 34 56 78 90'];
  for (const t of bad) assert.equal(isHallucination(t), true, t);
  const good = ['What is a prime number?', 'The answer is twelve.', 'We add three to both sides'];
  for (const t of good) assert.equal(isHallucination(t), false, t);
});

test('cleanTranscript removes tags and stray punctuation', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO]  What is x? '), 'What is x?');
  assert.equal(cleanTranscript('- Hello there'), 'Hello there');
});

test('QuestionGate joins a question that Whisper split at a pause, and waits for the speaker to finish', () => {
  const g = new QuestionGate({ quietMs: 1500 });
  g.push('What is the', 1000);
  assert.equal(g.poll(1500), null, 'still within the quiet window');
  g.push('discriminant of a quadratic equation?', 2200);
  assert.equal(g.poll(2500), null, 'a finished question still waits a moment (0.4 s) in case the speaker adds more');
  assert.equal(g.poll(2700), 'What is the discriminant of a quadratic equation?');
  assert.equal(g.hasPending(), false);
});

test('QuestionGate ignores statements and repeated questions', () => {
  const g = new QuestionGate({ quietMs: 1000, dedupeMs: 60000 });
  g.push('We will solve equations today.', 0);
  assert.equal(g.poll(2000), null);

  g.push('What is the quadratic formula?', 5000);
  assert.equal(g.poll(7000), 'What is the quadratic formula?');
  g.push('what is the quadratic formula', 20000);   // same question again (no punctuation)
  assert.equal(g.poll(22000), null, 'duplicate within the dedupe window');
  g.push('What is the quadratic formula?', 100000); // long after: allowed again
  assert.equal(g.poll(102000), 'What is the quadratic formula?');
});

test('word error rate / accuracy', () => {
  assert.equal(wer('what is the discriminant', 'what is the discriminant').accuracy, 1);
  const r = wer('what is the discriminant of a quadratic', 'what is the discriminate of quadratic');
  assert.equal(r.errors, 2);                 // 1 substitution + 1 deletion
  assert.ok(Math.abs(r.accuracy - (1 - 2 / 7)) < 1e-9);
  assert.equal(wer('Hello, World!', 'hello world').errors, 0, 'case and punctuation ignored');
  assert.equal(wer('factor x squared minus nine', 'factor x squared minus 9').errors, 0, 'digits equal number words');
  assert.equal(wer('chapter seven', 'Chapter 7').errors, 0);
  assert.equal(wer('a rational number', 'irrational number').errors, 2, 'a real mistake is still counted');
});

test('dots inside words (.NET, 3.5) do not split a question', () => {
  assert.equal(extractQuestion('What is web services in .NET? Can you tell me?'), 'What is web services in .NET? Can you tell me?');
  assert.equal(extractQuestion('Okay. What is the value of 3.5 times two?'), 'What is the value of 3.5 times two?');
});

test('extractQuestion keeps the question and drops the statements before it', () => {
  assert.equal(extractQuestion('Remember the degree is two. What is the discriminant for?'), 'What is the discriminant for?');
  assert.equal(extractQuestion("I don't understand. How did you get that?"), "I don't understand. How did you get that?");
  assert.equal(extractQuestion('What is the discriminant for?'), 'What is the discriminant for?');
  assert.equal(extractQuestion('What is a prime number? Okay. How do you factor a trinomial?'), 'How do you factor a trinomial?'); // the latest question wins
});

test('lead-in words are removed and the question is capitalised', () => {
  assert.equal(stripLeadIn('Okay, so tell me the steps of enabling API in Dataverse.'), 'Tell me the steps of enabling API in Dataverse.');
  assert.equal(stripLeadIn('And another question is, what is a prime number?'), 'What is a prime number?');
  assert.equal(stripLeadIn('My question is, who is the first president?'), 'Who is the first president?');
  assert.equal(stripLeadIn('What is a prime number?'), 'What is a prime number?');
});

test('one question with a "please explain" after it is still one question; two real questions are two', () => {
  assert.equal(countQuestions('What is difference between managed and unmanaged layer? Please explain with example.'), 1);
  assert.equal(countQuestions('Okay, so tell me the steps of enabling API in Dataverse and how you will call using jQuery. Could you please explain this to me?'), 1);
  assert.equal(countQuestions('What is a web service? What is the difference between API and web service?'), 2);
  assert.equal(countQuestions('What is a prime number? And another question is, why is two special?'), 2);
  assert.equal(countQuestions('Today we will look at primes.'), 0);
});
