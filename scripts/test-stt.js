#!/usr/bin/env node
'use strict';
// Measures the offline speech engine: accuracy (1 - word error rate) and speed on real audio.
//
//   npm run test:stt                              built-in classroom sentences spoken by Windows voices
//   npm run test:stt -- --wav my.wav --ref "the exact words that were spoken"
//   npm run test:stt -- --model medium.en-q5_0    compare another downloaded model
//   npm run test:stt -- --topic "Mathematics: quadratic equations, discriminant"   hint, like the class subject in Settings
//
// Windows voices are clean, so use your own recording (--wav) for a realistic number.

const fs = require('fs');
const path = require('path');
const { WhisperServer } = require('../src/stt/whisperServer');
const { readWav, resample, pcm16ToWav } = require('../src/audio/wav');
const { wer } = require('../src/eval/wer');
const { cleanTranscript } = require('../src/ai/questions');

const ROOT = path.join(__dirname, '..', 'whisper');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const SENTENCES = [
  'What is the discriminant of a quadratic equation?',
  'How do you factor x squared minus nine?',
  'Why does the parabola open downwards when a is negative?',
  'Can you explain the difference between the mean and the median?',
  'What is the derivative of sine x?',
  'Is the square root of two a rational number?',
  'How many solutions does the equation have if the discriminant is zero?',
  'Could you go over the quadratic formula one more time?',
  'The photosynthesis reaction takes place in the chloroplasts of the leaf.',
  'Please open your textbooks to chapter seven and read the first two pages.',
];

function wavFor(file) {
  const { samples, sampleRate } = readWav(fs.readFileSync(file));
  return pcm16ToWav(resample(samples, sampleRate, 16000));
}

(async () => {
  const model = option('--model', 'small.en-q5_1').replace(/^ggml-/, '').replace(/\.bin$/, '');
  const modelPath = path.join(ROOT, 'models', `ggml-${model}.bin`);
  const server = new WhisperServer({
    binDir: path.join(ROOT, 'bin'), modelPath, threads: Number(option('--threads', 8)), language: 'en',
    extraArgs: option('--args', '') ? option('--args', '').split(/\s+/).filter(Boolean) : undefined, // default: app settings
  });
  const problem = WhisperServer.problem(server.binDir, modelPath);
  if (problem) { console.error(problem + '\nRun: npm run setup:whisper'); process.exit(2); }

  const topic = option('--topic', '');
  console.log(`Model: ${model}   threads: ${server.threads}   topic hint: ${topic || '(none)'}`);
  const t0 = Date.now();
  await server.start();
  console.log(`Engine ready in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

  const cases = [];
  const wavFile = option('--wav', '');
  if (wavFile) {
    cases.push({ ref: option('--ref', ''), wav: wavFor(wavFile), label: path.basename(wavFile) });
  } else {
    if (process.platform !== 'win32') { console.error('Built-in test needs Windows voices; pass --wav and --ref instead.'); process.exit(2); }
    const { speakToWav, tempWav } = require('./tts');
    SENTENCES.forEach((text, i) => {
      const file = speakToWav(text, tempWav('stt'), { rate: i % 2 ? 1 : 0 });
      cases.push({ ref: text, wav: wavFor(file), label: `#${i + 1}` });
    });
  }

  let errors = 0, words = 0, audioSec = 0, procSec = 0;
  for (const c of cases) {
    const seconds = (c.wav.length - 44) / 2 / 16000;
    const start = Date.now();
    const hyp = cleanTranscript(await server.transcribe(c.wav, { prompt: topic ? `Topic: ${topic}.` : '', temperatureInc: option('--temp-inc', '0.2') }));
    const took = (Date.now() - start) / 1000;
    audioSec += seconds; procSec += took;
    if (c.ref) {
      const r = wer(c.ref, hyp);
      errors += r.errors; words += r.refWords;
      console.log(`${c.label.padEnd(6)} ${(r.accuracy * 100).toFixed(0).padStart(3)}%  ${seconds.toFixed(1)}s audio -> ${took.toFixed(1)}s`);
      if (r.errors) console.log(`        said: ${c.ref}\n        got : ${hyp}`);
    } else {
      console.log(`${c.label}: ${hyp}`);
    }
  }
  server.stop();

  if (words) {
    const acc = (1 - errors / words) * 100;
    console.log(`\nOverall word accuracy: ${acc.toFixed(1)}%  (${errors} errors in ${words} words)   target: 95%  ${acc >= 95 ? 'MET' : 'NOT MET'}`);
  }
  console.log(`Speed: ${audioSec.toFixed(1)} s of audio transcribed in ${procSec.toFixed(1)} s  (${(procSec / audioSec).toFixed(2)}x real time; below 1.0 keeps up with live speech)`);
  process.exit(0);
})().catch(err => { console.error('Test failed:', err.message); process.exit(1); });
