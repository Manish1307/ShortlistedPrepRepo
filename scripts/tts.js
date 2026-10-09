'use strict';
// Test helper (Windows): turns text into a 16 kHz mono WAV with the built-in Windows voices (SAPI),
// so the speech pipeline can be tested without a microphone.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:TTS_VOICE) { try { $s.SelectVoice($env:TTS_VOICE) } catch {} }
$s.Rate = [int]$env:TTS_RATE
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:TTS_OUT, $fmt)
$s.Speak($env:TTS_TEXT)
$s.Dispose()
`;

function speakToWav(text, outPath, { voice = '', rate = 0 } = {}) {
  if (process.platform !== 'win32') throw new Error('tts.js needs Windows (System.Speech)');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], {
    env: { ...process.env, TTS_TEXT: text, TTS_OUT: outPath, TTS_VOICE: voice, TTS_RATE: String(rate) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return outPath;
}

function listVoices() {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }'],
  { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map(l => { const [name, culture] = l.split('|'); return { name, culture }; });
}

function tempWav(prefix = 'tna-tts') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')), 'speech.wav');
}

module.exports = { speakToWav, listVoices, tempWav };
