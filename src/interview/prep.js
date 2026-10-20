'use strict';
// The Virtual Interview app's link to the licence server for personalised questions: which resumes the licence holder has,
// questions made from the one picked (saved on the server, so they also appear in My account and in the dashboard), and
// earlier sets. It signs in with the same short-lived access token as the AI proxy. No Electron code, so it can be
// tested with a real or fake server.

class InterviewPrepClient {
  /** @param {{serverUrl: string, getToken: (renew?: boolean) => Promise<string|null>, fetchImpl?: Function}} o */
  constructor(o) {
    this.serverUrl = String(o.serverUrl).replace(/\/+$/, '');
    this.getToken = o.getToken;
    this.fetch = o.fetchImpl || fetch;
  }

  /** One call with the token; an expired token (401) is renewed once. Throws an Error with a readable message. */
  async _call(method, path, body, timeoutMs = 20000) {
    for (const renew of [false, true]) {
      const token = await this.getToken(renew).catch(() => null);
      if (!token) throw Object.assign(new Error('No active licence. Activate your licence first.'), { code: 'licence' });
      let res;
      try {
        res = await this.fetch(this.serverUrl + path, {
          method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw Object.assign(new Error(err && err.name === 'TimeoutError' ? 'The server took too long to answer. Try again.' : 'Cannot reach the server. Check your internet connection and try again.'), { code: 'network' });
      }
      if (res.status === 401 && !renew) continue;
      let data = {};
      try { data = await res.json(); } catch (_) { /* not JSON */ }
      if (!res.ok) throw Object.assign(new Error(data.error || `The server answered ${res.status}.`), { code: data.code || 'server', status: res.status });
      return data;
    }
    throw Object.assign(new Error('Access was refused. Check the licence.'), { code: 'licence' });
  }

  /** The licence holder's resumes ({key, label}) and their latest question sets. */
  resumes() { return this._call('GET', '/api/app/interview/resumes'); }
  /** Personalised questions from one resume (one AI action; saved on the server). */
  makeSet({ resumeKey, role }) { return this._call('POST', '/api/app/interview/questions', { resumeKey: String(resumeKey || ''), role: String(role || '') }, 120000).then(d => d.set); }
  /** An earlier set, with its questions and answers. */
  getSet(id) { return this._call('GET', '/api/app/interview/sets/' + encodeURIComponent(id)).then(d => d.set); }
}

module.exports = { InterviewPrepClient };
