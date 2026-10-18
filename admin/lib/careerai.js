'use strict';
// AI for the career toolkit (career.js): one call that returns JSON. Uses the server's default Gemini key from the
// AI keys page (long resumes, JSON output), or the default Groq key when there is no Gemini key. The keys never
// leave the server.

const { ApiError } = require('./http');
const { now } = require('./db');

const UPSTREAM = {
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash'];   // tried in this order when one is busy
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const defaultKey = (db, provider) =>
  db.prepare('SELECT * FROM api_keys WHERE provider = ? AND is_default = 1 AND disabled = 0').get(provider);

/** The JSON object in a model reply (tolerates code fences and words around it). */
function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch (_) { /* try the outermost braces */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { /* unusable */ } }
  return null;
}

async function post(url, headers, body) {
  try {
    return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch (_) { return null; }
}

/**
 * Ask the AI for a JSON object. ctx: { db, vault, upstream?, meter? } (meter(tokens): the customer's AI tokens, tokens.js). Throws ApiError when no key is set up or the
 * service fails, with a message that can be shown to the customer.
 */
async function completeJson(ctx, { system, user, maxTokens = 6000 }) {
  const { db, vault } = ctx;
  const upstream = { ...UPSTREAM, ...(ctx.upstream || {}) };
  const gemini = defaultKey(db, 'gemini');
  const groq = defaultKey(db, 'groq');
  if (!gemini && !groq) throw new ApiError(503, 'The AI service is not set up yet. Please try again later.', 'no-key');
  let busy = false;
  // the tokens the service reports, or about 4 characters a token when it does not
  const spend = (reported, reply) => { if (ctx.meter) ctx.meter(Number(reported) || Math.ceil((system.length + user.length + String(reply || '').length) / 4)); };

  if (gemini) {
    const key = vault.decrypt(gemini.key_enc);
    for (const model of GEMINI_MODELS) {
      const res = await post(`${upstream.gemini}/${model}:generateContent`, { 'x-goog-api-key': key }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      });
      if (!res || res.status === 429 || res.status === 404 || res.status >= 500) { busy = true; continue; }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) break;   // e.g. a rejected key: try Groq
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), gemini.id);
      const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
      const reply = parts.map(p => p.text || '').join('');
      const out = parseJson(reply);
      if (out) { spend(json.usageMetadata && json.usageMetadata.totalTokenCount, reply); return out; }
      busy = true;
    }
  }

  if (groq) {
    const res = await post(`${upstream.groq}/chat/completions`, { Authorization: 'Bearer ' + vault.decrypt(groq.key_enc) }, {
      model: GROQ_MODEL, temperature: 0.3, max_tokens: Math.min(maxTokens, 8000), response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    if (res && res.ok) {
      const json = await res.json().catch(() => ({}));
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), groq.id);
      const reply = (((json.choices || [])[0] || {}).message || {}).content;
      const out = parseJson(reply);
      if (out) { spend(json.usage && json.usage.total_tokens, reply); return out; }
    }
    busy = true;
  }
  throw new ApiError(502, busy ? 'The AI service is busy right now. Please try again in a minute.' : 'The AI service could not complete this. Please try again.', 'ai');
}

module.exports = { completeJson, parseJson, UPSTREAM };
