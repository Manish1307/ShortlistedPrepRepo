'use strict';
// Minimal WAV helpers: 16-bit PCM only. Used to hand audio to whisper.cpp and to read test files.

const SAMPLE_RATE = 16000;

/** Wrap Int16 PCM samples (mono) in a WAV container. */
function pcm16ToWav(samples, sampleRate = SAMPLE_RATE) {
  const pcm = samples instanceof Int16Array
    ? Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
    : Buffer.from(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);             // fmt chunk size
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(1, 22);              // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);              // block align
  header.writeUInt16LE(16, 34);             // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Read a 16-bit PCM WAV file. Returns mono Int16Array at the file's sample rate
 * (stereo is averaged to mono). Throws on anything it cannot read.
 */
function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');

  const frames = Math.floor(data.length / (2 * fmt.channels));
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    out[i] = Math.round(sum / fmt.channels);
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

/** Linear-interpolation resampler (good enough for speech going to Whisper). */
function resample(samples, fromRate, toRate = SAMPLE_RATE) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const n = Math.floor(samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, samples.length - 1);
    const f = p - i0;
    out[i] = Math.round(samples[i0] * (1 - f) + samples[i1] * f);
  }
  return out;
}

module.exports = { SAMPLE_RATE, pcm16ToWav, readWav, resample };
