'use strict';
// Same job as answerer.js / gemini.js, with Groq: open models served at very high speed (a short answer in about a
// second). Groq speaks the common "OpenAI chat" protocol, so this is plain HTTPS + server-sent events.
// Main process only; the key never reaches a web page.

const { systemPromptFor, buildUserMessage, cleanAnswer } = require('./answerer');
const { EXTRACT_PROMPT, parseQuestionList, buildExtractMessage } = require('./framing');

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';
const FALLBACK_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'];
const PREFERRED = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'];

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

class GroqAnswerer {
  constructor({ apiKey = '', model = DEFAULT_MODEL, effort = 'low', subject = '', retryDelayMs = 600 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort;
    this.subject = subject;
    this.retryDelayMs = retryDelayMs;
  }

  setApiKey(apiKey) { this.apiKey = apiKey || ''; }
  setModel(model) { this.model = model || DEFAULT_MODEL; }
  setSubject(subject) { this.subject = subject || ''; }
  get ready() { return !!this.apiKey; }

  async _post(body, signal) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    let detail = '';
    try { detail = (await res.json()).error.message; } catch (_) { /* not JSON */ }
    throw Object.assign(new Error(detail || `Groq returned ${res.status}`), { status: res.status });
  }

  /** True when the error means "this model name is not available to this account". */
  static modelMissing(err) {
    return err && (err.status === 404 || (err.status === 400 && /model/i.test(err.message))) ||
      /does not exist|do not have access|decommissioned|not found|no longer supported/i.test(String(err && err.message));
  }

  /** Ask Groq which chat models this key can use, best first. Model names change often, so we never rely on one. */
  async _availableModels(signal) {
    const res = await fetch(MODELS_ENDPOINT, { headers: { Authorization: 'Bearer ' + this.apiKey }, signal });
    if (!res.ok) return [];
    const ids = ((await res.json()).data || []).map(m => m.id);
    const chat = ids.filter(id => !/whisper|tts|guard|playai|embed|orpheus|moderation/i.test(id));
    const rank = id => {
      const i = PREFERRED.findIndex(p => id === p);
      if (i >= 0) return i;
      return /llama|gpt-oss|qwen|mixtral|gemma/i.test(id) ? 50 : 100;
    };
    return chat.sort((x, y) => rank(x) - rank(y));
  }

  /**
   * Try the selected model, then the usual fallbacks. A busy server is retried once; a rate limit or a model this
   * account cannot use moves on to the next model. If none of the known names work, ask Groq what is available.
   */
  async _open(makeBody, signal) {
    const tried = new Set();
    const attemptModels = async models => {
      let lastError;
      for (const model of models) {
        if (tried.has(model)) continue;
        tried.add(model);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await this._post(makeBody(model), signal);
            if (model !== this.model) this.model = model;        // remember what works for the next question
            return { res };
          } catch (err) {
            lastError = err;
            if (GroqAnswerer.modelMissing(err) || err.status === 429) break;     // next model
            if (![500, 502, 503, 504].includes(err.status)) throw err;             // wrong key, bad request...
            if (attempt === 0) await sleep(this.retryDelayMs, signal);
          }
        }
      }
      return { error: lastError };
    };

    let out = await attemptModels([this.model, ...FALLBACK_MODELS]);
    if (out.res) return out.res;
    const firstError = out.error;
    if (GroqAnswerer.modelMissing(out.error)) {
      const available = await this._availableModels(signal).catch(() => []);
      if (!available.length) throw Object.assign(new Error('Groq did not list any model this key can use. Check the key and your Groq account.'), { status: 403 });
      out = await attemptModels(available.slice(0, 4));
      if (out.res) return out.res;
    }
    throw out.error || firstError;
  }

  _reasoning(model) { return /^openai\/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}; }

  /** "Test connection": what this key can use, and whether a tiny question works. Returns lines of plain text. */
  async diagnose() {
    if (!this.apiKey) return ['No Groq key is saved yet. Paste it above and press Save first.'];
    const lines = [];
    let ids;
    try {
      const res = await fetch(MODELS_ENDPOINT, { headers: { Authorization: 'Bearer ' + this.apiKey }, signal: AbortSignal.timeout(15000) });
      if (res.status === 401) return ['Groq rejected the key (401). Check that it was copied completely (it starts with gsk_), or create a new one at console.groq.com/keys.'];
      if (!res.ok) return ['Groq answered with an error (' + res.status + ') when listing models. Try again in a minute.'];
      ids = ((await res.json()).data || []).map(m => m.id);
    } catch (err) { return ['Cannot reach Groq: ' + err.message + '. Check the internet connection.']; }
    lines.push('Key accepted. Models Groq lists for this key (' + ids.length + '): ' + (ids.slice(0, 14).join(', ') || 'none'));
    const candidates = await this._availableModels().catch(() => []);
    if (!candidates.length) { lines.push('No chat model is available to this key. Check the model permissions and limits for your account in the Groq console.'); return lines; }
    for (const model of candidates.slice(0, 4)) {
      try {
        const res = await this._post({ model, stream: false, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], ...this._reasoning(model) }, AbortSignal.timeout(20000));
        await res.json();
        lines.push('✓ ' + model + ' works. It will be used.');
        this.model = model;
        return lines;
      } catch (err) { lines.push('✗ ' + model + ': ' + err.message); }
    }
    lines.push('None of the listed models answered. See the messages above.');
    return lines;
  }

  /** Turn newly heard speech into a list of clear, standalone questions (may be empty). */
  async extractQuestions({ text, context = [], previous = [], signal } = {}) {
    if (!this.apiKey) throw Object.assign(new Error('No Groq API key set'), { code: 'no-key' });
    const res = await this._open(model => ({
      model, temperature: 0, max_tokens: 500, stream: false, ...this._reasoning(model),
      messages: [{ role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: buildExtractMessage({ subject: this.subject, context, text, previous }) }],
    }), signal);
    const data = await res.json();
    return parseQuestionList(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  }

  /** @returns {Promise<{text: string, skipped: boolean, refused: boolean}>} same contract as the other answerers */
  async answer({ question, context = [], previous = [], onDelta = () => {}, signal } = {}) {
    if (!this.apiKey) throw Object.assign(new Error('No Groq API key set'), { code: 'no-key' });
    const res = await this._open(model => ({
      model, stream: true, temperature: 0.4, max_tokens: this.effort === 'low' ? 500 : 900, ...this._reasoning(model),
      messages: [{ role: 'system', content: systemPromptFor(this.effort) },
        { role: 'user', content: buildUserMessage({ subject: this.subject, context, question, previous }) }],
    }), signal);

    let text = '', held = '', decided = false, skipped = false;
    const emit = chunk => { text += chunk; onDelta(chunk); };
    const onText = delta => {
      if (decided) { if (!skipped) emit(delta); return; }
      held += delta;
      if (held.trim().length >= 4) { decided = true; if (/^\s*SKIP/i.test(held)) skipped = true; else emit(held); }
    };

    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = line => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const piece = JSON.parse(payload).choices[0].delta.content;
        if (piece) onText(piece);
      } catch (_) { /* partial or non-text line */ }
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, nl).replace(/\r$/, '')); buffer = buffer.slice(nl + 1); }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer.replace(/\r$/, ''));

    if (!decided && held) { if (/^\s*SKIP\s*$/i.test(held)) skipped = true; else emit(held); }
    return { text: cleanAnswer(text), skipped, refused: false };
  }
}

module.exports = { GroqAnswerer, DEFAULT_MODEL };
