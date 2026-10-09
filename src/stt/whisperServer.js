'use strict';
// Runs whisper.cpp's own `whisper-server` as a child process (fully offline, model stays loaded in memory)
// and sends it WAV audio over localhost. Works from Electron and from plain Node (tests / scripts).

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const IS_WIN = process.platform === 'win32';

function findServerExe(binDir) {
  const names = IS_WIN ? ['whisper-server.exe', 'server.exe'] : ['whisper-server', 'server'];
  for (const n of names) {
    const p = path.join(binDir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

class WhisperServer extends EventEmitter {
  /**
   * @param {{binDir: string, modelPath: string, threads?: number, language?: string, prompt?: string}} o
   */
  constructor(o) {
    super();
    this.binDir = o.binDir;
    this.modelPath = o.modelPath;
    this.threads = o.threads || 4;
    this.language = o.language || 'en';
    this.prompt = o.prompt || '';
    // -ac 768: encode only ~15 s of audio context instead of 30 s; about 4x faster here with the same accuracy
    this.extraArgs = o.extraArgs || ['-ac', '768'];
    this.proc = null;
    this.port = 0;
    this.ready = false;
    this.log = [];
  }

  /** Why this server cannot start (missing files), or null when it can. */
  static problem(binDir, modelPath) {
    if (!findServerExe(binDir)) return `whisper-server not found in ${binDir}`;
    if (!fs.existsSync(modelPath)) return `Whisper model not found: ${modelPath}`;
    return null;
  }

  async start(timeoutMs = 120000) {
    const problem = WhisperServer.problem(this.binDir, this.modelPath);
    if (problem) throw Object.assign(new Error(problem), { code: 'whisper-missing' });
    if (this.proc) return;

    this.port = await freePort();
    const exe = findServerExe(this.binDir);
    const args = [
      '-m', this.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-t', String(this.threads),
      '-l', this.language,
      '--suppress-nst',   // do not invent [music] / noise tokens
    ];
    if (this.prompt) args.push('--prompt', this.prompt);
    args.push(...this.extraArgs);

    this.proc = spawn(exe, args, { cwd: this.binDir, windowsHide: true });
    const keep = chunk => { this.log.push(String(chunk)); if (this.log.length > 200) this.log.shift(); };
    this.proc.stdout.on('data', keep);
    this.proc.stderr.on('data', keep);
    this.proc.on('exit', code => {
      this.ready = false; this.proc = null;
      this.emit('exit', code);
    });
    this.proc.on('error', err => this.emit('error', err));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error('whisper-server exited while starting:\n' + this.log.slice(-8).join(''));
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1500) });
        if (res.status < 500) { this.ready = true; this.emit('ready'); return; }
      } catch (_) { /* not up yet */ }
      await new Promise(r => setTimeout(r, 300));
    }
    this.stop();
    throw new Error('whisper-server did not start in time');
  }

  /** Transcribe a WAV buffer (16 kHz mono 16-bit). Returns plain text. */
  async transcribe(wavBuffer, { prompt, timeoutMs = 90000, temperatureInc = '0.2' } = {}) {
    if (!this.ready) throw new Error('whisper-server is not running');
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    form.append('temperature', '0.0');
    form.append('temperature_inc', String(temperatureInc));
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`whisper-server returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data && data.error) throw new Error('whisper-server: ' + data.error);
    return String((data && data.text) || '').trim();
  }

  /** Start again from scratch (used when a request got stuck). */
  async restart() {
    this.stop();
    this.log = [];
    await this.start();
  }

  stop() {
    this.ready = false;
    if (this.proc) { try { this.proc.kill(); } catch (_) { /* already gone */ } this.proc = null; }
  }
}

module.exports = { WhisperServer, findServerExe };
