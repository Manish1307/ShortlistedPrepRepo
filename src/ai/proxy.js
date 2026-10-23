'use strict';
// AI through the licence server: the same Groq (answers) and Gemini (screenshots) clients as groq.js / gemini.js,
// building the same prompts and request bodies, but every request goes to the licence server's AI proxy
// (admin/lib/aiproxy.js), which adds the key. No AI key is ever on this computer; the app only holds a short-lived
// access token from /api/app/config. Same contract as the other answerers: answer, extractQuestions, readScreen.

const groq = require('./groq');
const gemini = require('./gemini');

// a stand-in so the wrapped clients' "is there a key?" checks pass; it is removed before anything is sent
const NO_KEY = 'licence-server';

class ProxyAnswerer {
  /**
   * @param {{serverUrl: string, getToken: (renew?: boolean) => Promise<string|null>, model?: string,
   *          effort?: string, subject?: string, services?: {groq?: boolean, gemini?: boolean}, fetchImpl?: Function}} o
   */
  constructor({ serverUrl, getToken, model, effort = 'low', subject = '', services = {}, fetchImpl, retryDelayMs } = {}) {
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.getToken = getToken;
    this.services = { groq: false, gemini: false };
    this.fetchImpl = fetchImpl || ((url, init) => fetch(url, init));
    const viaServer = (url, init) => this._send(url, init);
    this.groq = new groq.GroqAnswerer({ apiKey: NO_KEY, model, effort, subject, fetchImpl: viaServer, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}) });
    this.gemini = new gemini.GeminiAnswerer({ apiKey: NO_KEY, effort, subject, fetchImpl: viaServer, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}) });
    this.setServices(services);
  }

  /** What the server can serve for this licence: {groq, gemini} (from /api/app/config). */
  setServices(services) { this.services = { groq: !!(services && services.groq), gemini: !!(services && services.gemini) }; }
  setSubject(subject) { this.groq.setSubject(subject); this.gemini.setSubject(subject); }
  setProfile(profile) { this.groq.setProfile(profile); this.gemini.setProfile(profile); }
  setModel(model) { this.groq.setModel(model); }
  get model() { return this.groq.model; }
  get effort() { return this.groq.effort; }
  set effort(value) { this.groq.effort = value; this.gemini.effort = value; }
  get ready() { return this.services.groq; }
  get screenReady() { return this.services.gemini || this.services.groq; }

  /** The licence-server address for a request the wrapped clients would have sent to Groq or Gemini. */
  _route(url) {
    if (url === groq.ENDPOINT) return this.serverUrl + '/api/ai/answer';
    if (url === groq.MODELS_ENDPOINT) return this.serverUrl + '/api/ai/models';
    const m = String(url).startsWith(gemini.ENDPOINT + '/') && /\/([^/:]+):generateContent$/.exec(url);
    if (m) return this.serverUrl + '/api/ai/read-screen?model=' + m[1];
    // streamed Gemini answers are not offered by the proxy: answers come from Groq
    throw Object.assign(new Error('The licence server does not provide this AI service.'), { status: 400 });
  }

  /** Send with the access token instead of a key; an expired token (401) is renewed once and the request repeated. */
  async _send(url, init = {}) {
    const target = this._route(url);
    const headers = { ...(init.headers || {}) };
    delete headers.Authorization;
    delete headers['x-goog-api-key'];
    const attempt = async renew => {
      const token = await this.getToken(renew);
      if (!token) throw Object.assign(new Error('ShortlistPrep.AI could not get AI access from the licence server. Check the licence and the internet connection.'), { code: 'no-key' });
      return this.fetchImpl(target, { ...init, headers: { ...headers, Authorization: 'Bearer ' + token } });
    };
    const res = await attempt(false);
    if (res.status !== 401) return res;
    try { await res.body?.cancel(); } catch (_) { /* nothing to discard */ }
    return attempt(true);
  }

  answer(args) { return this.groq.answer(args); }
  extractQuestions(args) { return this.groq.extractQuestions(args); }
  complete(args) { return this.groq.complete(args); }
  /** Screenshots: Gemini when the server has a Gemini key for this licence, else Groq's picture models. */
  readScreen(args) { return (this.services.gemini ? this.gemini : this.groq).readScreen(args); }
  async diagnose() { return this.ready ? ['AI is provided by the licence server.'] : ['The licence server has no AI key for this licence.']; }
}

module.exports = { ProxyAnswerer };
