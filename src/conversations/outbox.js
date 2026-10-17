'use strict';
// Finished Live Class conversations on their way to the licence server (POST /api/app/conversations).
// Each one is written to a file first, then uploaded; the file is removed once the server has it. If the computer is
// offline or the server is down, the files wait and are sent at the next start or the next class end.
// No Electron code here, so it can be tested with a fake server.

const fs = require('fs');
const path = require('path');

class ConversationOutbox {
  /**
   * @param {{dir: string, serverUrl: string, getToken: (renew?: boolean) => Promise<string|null>, fetchImpl?: Function}} o
   *   getToken: the AI proxy access token (null without an active licence); renew=true asks for a new one.
   */
  constructor(o) {
    this.dir = o.dir;
    this.serverUrl = String(o.serverUrl).replace(/\/+$/, '');
    this.getToken = o.getToken;
    this.fetch = o.fetchImpl || fetch;
    this.flushing = null;
  }

  _file(uid) { return path.join(this.dir, uid + '.json'); }

  /** Keep a finished conversation on this computer until it is uploaded. */
  add(conversation) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(conversation.uid || ''))) throw new Error('Bad conversation id');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._file(conversation.uid), JSON.stringify(conversation));
  }

  /** The conversations still waiting, oldest first. */
  pending() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => n.endsWith('.json')); } catch (_) { return []; }
    return names.map(n => path.join(this.dir, n))
      .map(file => ({ file, at: fs.statSync(file).mtimeMs }))
      .sort((a, b) => a.at - b.at).map(f => f.file);
  }

  /**
   * Upload everything waiting. Returns { sent, waiting, error }: error is why the rest is still waiting
   * ('' when nothing is left). Only one upload runs at a time; a second call waits for it.
   */
  flush() {
    if (!this.flushing) this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flush() {
    let sent = 0;
    for (const file of this.pending()) {
      let body;
      try { body = fs.readFileSync(file, 'utf8'); JSON.parse(body); } catch (_) {
        try { fs.unlinkSync(file); } catch (__) { /* already gone */ }   // a damaged file would block the others forever
        continue;
      }
      const result = await this._send(body);
      if (result.ok || result.drop) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } if (result.ok) sent++; continue; }
      return { sent, waiting: this.pending().length, error: result.error };
    }
    return { sent, waiting: 0, error: '' };
  }

  /** {ok} | {drop} (the server will never take it) | {error} (try again later). */
  async _send(body) {
    for (const renew of [false, true]) {
      const token = await this.getToken(renew).catch(() => null);
      if (!token) return { error: 'No active licence: the conversation is kept on this computer.' };
      let res;
      try {
        res = await this.fetch(this.serverUrl + '/api/app/conversations', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body, signal: AbortSignal.timeout(30000),
        });
      } catch (_) { return { error: 'Cannot reach the server: the conversation is kept on this computer and sent later.' }; }
      if (res.ok) return { ok: true };
      if (res.status === 401 && !renew) continue;   // the token expired: get a new one and try once more
      let data = {};
      try { data = await res.json(); } catch (_) { /* not JSON */ }
      if (res.status === 400 || res.status === 413) return { drop: true, error: data.error || 'The server did not accept the conversation.' };
      return { error: (data.error || `The server answered ${res.status}.`) + ' The conversation is kept on this computer.' };
    }
    return { error: 'Access was refused. The conversation is kept on this computer.' };
  }
}

module.exports = { ConversationOutbox };
