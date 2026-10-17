'use strict';
// One object for the pipeline to talk to; it forwards to whichever AI provider is selected in Settings.
// Screen capture can use a different provider (for example Groq answers, Claude reads the pictures).

class AnswerRouter {
  /** @param {{gemini: object, groq?: object, claude: object, proxy?: object, provider?: 'gemini'|'groq'|'claude'|'proxy', screenProvider?: string}} o */
  constructor({ gemini, groq, claude, proxy, provider = 'gemini', screenProvider = 'same' }) {
    this.providers = { gemini, claude, ...(groq ? { groq } : {}), ...(proxy ? { proxy } : {}) };   // proxy: AI through the licence server
    this.provider = this.providers[provider] ? provider : 'gemini';
    this.setScreenProvider(screenProvider);
  }

  get active() { return this.providers[this.provider]; }
  get ready() { return this.active.ready; }
  /** The provider that reads captured pictures. */
  get screen() { return this.providers[this.screenProvider] || this.active; }
  get screenReady() { const s = this.screen; return 'screenReady' in s ? s.screenReady : s.ready; }

  setProvider(name) { if (this.providers[name]) this.provider = name; }
  setScreenProvider(name) { this.screenProvider = this.providers[name] ? name : 'same'; }
  setSubject(subject) { for (const p of Object.values(this.providers)) p.setSubject(subject); }
  setProfile(profile) { for (const p of Object.values(this.providers)) p.setProfile(profile); }
  setEffort(effort) { for (const p of Object.values(this.providers)) p.effort = effort; }
  answer(args) { return this.active.answer(args); }
  extractQuestions(args) { return this.active.extractQuestions(args); }
  readScreen(args) { return this.screen.readScreen(args); }
  complete(args) { return this.active.complete(args); }
  diagnose() { return this.active.diagnose(); }
}

module.exports = { AnswerRouter };
