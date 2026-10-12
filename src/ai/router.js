'use strict';
// One object for the pipeline to talk to; it forwards to whichever AI provider is selected in Settings.
// Screen capture can use a different provider (for example Groq answers, Claude reads the pictures).

class AnswerRouter {
  /** @param {{gemini: object, groq?: object, claude: object, provider?: 'gemini'|'groq'|'claude', screenProvider?: string}} o */
  constructor({ gemini, groq, claude, provider = 'gemini', screenProvider = 'same' }) {
    this.providers = { gemini, claude, ...(groq ? { groq } : {}) };
    this.provider = this.providers[provider] ? provider : 'gemini';
    this.setScreenProvider(screenProvider);
  }

  get active() { return this.providers[this.provider]; }
  get ready() { return this.active.ready; }
  /** The provider that reads captured pictures. */
  get screen() { return this.providers[this.screenProvider] || this.active; }
  get screenReady() { return this.screen.ready; }

  setProvider(name) { if (this.providers[name]) this.provider = name; }
  setScreenProvider(name) { this.screenProvider = this.providers[name] ? name : 'same'; }
  setSubject(subject) { for (const p of Object.values(this.providers)) p.setSubject(subject); }
  setEffort(effort) { for (const p of Object.values(this.providers)) p.effort = effort; }
  answer(args) { return this.active.answer(args); }
  extractQuestions(args) { return this.active.extractQuestions(args); }
  readScreen(args) { return this.screen.readScreen(args); }
  diagnose() { return this.active.diagnose(); }
}

module.exports = { AnswerRouter };
