'use strict';
// Several whisper-server processes behind one transcribe(): phrases are converted at the same time instead of one
// after another, and live previews get an engine of their own, so they never hold up the real text.
// Same surface as WhisperServer (ready, start, transcribe, restart, stop, on), so the pipeline cannot tell the difference.

const { EventEmitter } = require('events');
const { WhisperServer } = require('./whisperServer');

class WhisperPool extends EventEmitter {
  /** @param {WhisperServer[]} servers one per worker (they share the same model and settings) */
  constructor(servers) {
    super();
    if (!servers || !servers.length) throw new Error('WhisperPool needs at least one server');
    this.servers = servers.map(server => ({ server, busy: false }));
    this.waiting = [];   // requests waiting for a free engine
    this.starting = null;
    for (const w of this.servers) w.server.on('exit', code => this.emit('exit', code));
  }

  /** How many phrases can be converted at once. */
  get size() { return this.servers.length; }
  get ready() { return this.servers.every(w => w.server.ready); }

  static problem(binDir, modelPath) { return WhisperServer.problem(binDir, modelPath); }

  async start(timeoutMs) {
    // one after the other: loading the same model twice at once is slow on a small computer
    for (const w of this.servers) await w.server.start(timeoutMs);
    this.emit('ready');
  }

  /**
   * Convert a WAV buffer. A normal request waits for a free engine. With onlyIfIdle (a live preview) it is refused
   * at once unless one engine stays free for the real phrases.
   */
  async transcribe(wav, opts = {}) {
    if (opts.onlyIfIdle) {
      const idle = this.servers.filter(w => !w.busy);
      if (idle.length < 2 && this.servers.length > 1) throw Object.assign(new Error('busy'), { code: 'busy' });
      if (this.servers.length === 1 && idle.length < 1) throw Object.assign(new Error('busy'), { code: 'busy' });
    }
    const worker = await this._take();
    try { return await worker.server.transcribe(wav, opts); } finally { this._give(worker); }
  }

  _take() {
    const free = this.servers.find(w => !w.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    return new Promise(resolve => this.waiting.push(resolve));
  }

  _give(worker) {
    const next = this.waiting.shift();
    if (next) next(worker); else worker.busy = false;
  }

  async restart() {
    await Promise.all(this.servers.map(w => w.server.restart()));
  }

  stop() { for (const w of this.servers) w.server.stop(); }
}

module.exports = { WhisperPool };
