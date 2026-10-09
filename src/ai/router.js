'use strict';
// One object for the pipeline to talk to; it forwards to whichever AI provider is selected in Settings.

class AnswerRouter {
  /** @param {{gemini: object, groq?: object, claude: object, provider?: 'gemini'|'groq'|'claude'}} o */
  constructor({ gemini, groq, claude, provider = 'gemini' }) {
    this.providers = { gemini, claude, ...(groq ? { groq } : {}) };
    this.provider = this.providers[provider] ? provider : 'gemini';
  }

  get active() { return this.providers[this.provider]; }
  get ready() { return this.active.ready; }

  setProvider(name) { if (this.providers[name]) this.provider = name; }
  setSubject(subject) { for (const p of Object.values(this.providers)) p.setSubject(subject); }
  setEffort(effort) { for (const p of Object.values(this.providers)) p.effort = effort; }
  answer(args) { return this.active.answer(args); }
  extractQuestions(args) { return this.active.extractQuestions(args); }
  diagnose() { return this.active.diagnose(); }
}

module.exports = { AnswerRouter };
