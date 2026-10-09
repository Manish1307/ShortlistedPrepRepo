'use strict';
// Same job as answerer.js (Claude), but with Google Gemini, which has a free tier.
// Plain HTTPS + server-sent events: no extra dependency. Main process only; the key never reaches a web page.

const { systemPromptFor, buildUserMessage, cleanAnswer } = require('./answerer');
const { EXTRACT_PROMPT, parseQuestionList, buildExtractMessage } = require('./framing');

const DEFAULT_MODEL = 'gemini-3.8-flash';
// Tried in this order when the selected model is overloaded.
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * "Thinking time" setting -> Gemini thinking config. Gemini 3 models take a level, 2.5 models a token budget.
 * If a model rejects it, answer() retries once without it.
 */
function thinkingConfig(model, effort) {
  if (/^gemini-2\.5/.test(model)) {
    const budget = { low: /pro/.test(model) ? 128 : 0, medium: 1024, high: -1 }[effort];
    return budget === undefined ? undefined : { thinkingBudget: budget };
  }
  const level = { low: 'minimal', medium: 'low', high: 'high' }[effort];   // Quick = almost no thinking: the first words come sooner
  return level ? { thinkingLevel: level } : undefined;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

class GeminiAnswerer {
  constructor({ apiKey = '', model = DEFAULT_MODEL, effort = 'low', subject = '', retryDelayMs = 1000 } = {}) {
    this.retryDelayMs = retryDelayMs;
    this.model = model;
    this.effort = effort;
    this.subject = subject;
    this.apiKey = apiKey;
  }

  setApiKey(apiKey) { this.apiKey = apiKey || ''; }
  setModel(model) { this.model = model || DEFAULT_MODEL; }
  setSubject(subject) { this.subject = subject || ''; }
  get ready() { return !!this.apiKey; }

  _body(model, question, context, previous, withThinking = true) {
    const generationConfig = { maxOutputTokens: this.effort === 'low' ? 700 : 2048, temperature: 0.4 };
    const thinking = thinkingConfig(model, this.effort);
    if (thinking && withThinking) generationConfig.thinkingConfig = thinking;
    const body = {
      systemInstruction: { parts: [{ text: systemPromptFor(this.effort) }] },
      contents: [{ role: 'user', parts: [{ text: buildUserMessage({ subject: this.subject, context, question, previous }) }] }],
      generationConfig,
    };
    // Google Search grounding: the model can look facts up instead of relying on memory (more accurate answers)
    if (withThinking && this.effort === 'high') body.tools = [{ google_search: {} }]; // web lookups take extra seconds: Thorough only
    return body;
  }

  /** Open the answer stream for one model; returns the OK response or throws an error with .status. */
  async _open(model, question, context, previous, signal) {
    const request = withThinking => fetch(`${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(this._body(model, question, context, previous, withThinking)),
      signal,
    });
    let res = await request(true);
    if (res.status === 400 || res.status === 429) {
      // a model may reject the thinking or search option, and search has its own (smaller) free quota:
      // ask again once with plain defaults
      const retry = await request(false);
      if (retry.ok) res = retry;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (_) { /* not JSON */ }
      throw Object.assign(new Error(detail || `Gemini returned ${res.status}`), { status: res.status });
    }
    return res;
  }

  /** Busy (503) or rate-limited (429) answers are retried, then the next model is tried. */
  async _openWithFallback(question, context, previous, signal) {
    const models = [this.model, ...FALLBACK_MODELS.filter(m => m !== this.model)];
    let lastError;
    for (const model of models) {
      // a rate limit (429) is not retried on the same model, that only uses more quota: go to the next model
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this._open(model, question, context, previous, signal);
        } catch (err) {
          lastError = err;
          if (![429, 500, 502, 503, 504].includes(err.status)) throw err; // wrong key, bad request...: do not retry
          if (err.status === 429) break;
          if (attempt === 0) await sleep(this.retryDelayMs, signal);
        }
      }
    }
    throw lastError;
  }

  /** "Test connection": does a tiny question work with the selected model? */
  async diagnose() {
    if (!this.apiKey) return ['No Gemini key is saved yet. Paste it above and press Save first.'];
    const lines = [];
    for (const model of [this.model, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i)) {
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', signal: AbortSignal.timeout(20000),
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 20 } }),
        });
        if (res.ok) { lines.push('✓ ' + model + ' works.'); return lines; }
        let detail = ''; try { detail = (await res.json()).error.message; } catch (_) { /* not JSON */ }
        lines.push('✗ ' + model + ' (' + res.status + '): ' + (detail || 'failed'));
        if (res.status === 400 && /API key/i.test(detail)) return lines.concat('The key looks wrong. Create a new one at aistudio.google.com/apikey.');
        if (res.status === 401 || res.status === 403) return lines.concat('Google rejected the key. Create a new one at aistudio.google.com/apikey.');
      } catch (err) { lines.push('✗ ' + model + ': ' + err.message); }
    }
    return lines;
  }

  /** Turn newly heard speech into a list of clear, standalone questions (may be empty). One quick JSON request. */
  async extractQuestions({ text, context = [], previous = [], signal } = {}) {
    if (!this.apiKey) throw Object.assign(new Error('No Gemini API key set'), { code: 'no-key' });
    // tidying a question is a small job: the fastest model goes first, then the selected one
    const models = ['gemini-3.5-flash-lite', this.model, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);
    let lastError;
    for (const model of models) {
      const post = withThinking => {
        const generationConfig = {
          maxOutputTokens: 600, temperature: 0, responseMimeType: 'application/json',
          responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
        };
        const thinking = thinkingConfig(model, 'low');
        if (thinking && withThinking) generationConfig.thinkingConfig = thinking;
        return fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: EXTRACT_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: buildExtractMessage({ subject: this.subject, context, text, previous }) }] }],
            generationConfig,
          }),
          signal,
        });
      };
      let res = await post(true);
      if (res.status === 400) { const retry = await post(false); if (retry.ok) res = retry; }
      if (res.ok) {
        const data = await res.json();
        const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
        return parseQuestionList(parts.filter(p => p.text && !p.thought).map(p => p.text).join(''));
      }
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (_) { /* not JSON */ }
      lastError = Object.assign(new Error(detail || `Gemini returned ${res.status}`), { status: res.status });
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    }
    throw lastError;
  }

  /** @returns {Promise<{text: string, skipped: boolean, refused: boolean}>} same contract as Answerer.answer */
  async answer({ question, context = [], previous = [], onDelta = () => {}, signal } = {}) {
    if (!this.apiKey) throw Object.assign(new Error('No Gemini API key set'), { code: 'no-key' });
    const res = await this._openWithFallback(question, context, previous, signal);

    let text = '';
    let held = '';       // first few characters are held back until we know the reply is not "SKIP"
    let decided = false;
    let skipped = false;
    let blocked = false;
    const emit = chunk => { text += chunk; onDelta(chunk); };
    const onText = delta => {
      if (decided) { if (!skipped) emit(delta); return; }
      held += delta;
      if (held.trim().length >= 4) {
        decided = true;
        if (/^\s*SKIP/i.test(held)) skipped = true; else emit(held);
      }
    };
    const onEvent = data => {
      if (data.promptFeedback && data.promptFeedback.blockReason) blocked = true;
      const cand = data.candidates && data.candidates[0];
      if (!cand) return;
      if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') blocked = true;
      for (const part of (cand.content && cand.content.parts) || []) {
        if (part.text && !part.thought) onText(part.text);
      }
    };

    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = line => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try { onEvent(JSON.parse(payload)); } catch (_) { /* partial or non-JSON line */ }
    };
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, nl).replace(/\r$/, '')); buffer = buffer.slice(nl + 1); }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer.replace(/\r$/, ''));

    if (!decided && held) {
      if (/^\s*SKIP\s*$/i.test(held)) skipped = true; else emit(held);
    }
    if (blocked && !text) return { text: '', skipped: false, refused: true };
    return { text: cleanAnswer(text), skipped, refused: false };
  }
}

module.exports = { GeminiAnswerer, DEFAULT_MODEL, thinkingConfig };
