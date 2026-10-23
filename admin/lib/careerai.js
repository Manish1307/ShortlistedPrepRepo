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
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];   // tried in this order when one is busy
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_OUTPUT = 32000;     // a reply cut off at its token limit is asked for again with up to this many tokens
const WAIT_LIMIT = 15000;     // when a model is briefly over its rate, Gemini says "retry in Ns": wait at most this long, once

const defaultKey = (db, provider) =>
  db.prepare('SELECT * FROM api_keys WHERE provider = ? AND is_default = 1 AND disabled = 0').get(provider);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
 * Thinking for a JSON answer: a little. Gemini counts thinking tokens against maxOutputTokens, so with the model's own
 * (high) default a long answer is cut off before its JSON is finished. Gemini 3 models take a level, 2.5 a budget.
 */
const thinkingFor = model => (/^gemini-2\.5/.test(model) ? { thinkingBudget: 1024 } : { thinkingLevel: 'low' });
/** How long a 429 asks us to wait ("retryDelay": "7s"), in ms, or null. */
function retryDelay(json) {
  const info = ((json && json.error && json.error.details) || []).find(d => d && d.retryDelay);
  const sec = info ? parseFloat(info.retryDelay) : NaN;
  return Number.isFinite(sec) ? sec * 1000 : null;
}
/** A 429 for the day's quota, not a short burst: waiting a minute will not help. */
const dailyQuota = json => /per ?day|PerDay/i.test(JSON.stringify((json && json.error) || ''));

/**
 * One Gemini model: { out, reply, tokens } on success, else { busy, quota } (try the next model) or { rejected } (a
 * refused key: go to Groq). A cut-off answer is asked for again with more room, a refused thinking option without it,
 * and a short rate limit after the wait Gemini asks for.
 */
async function askGemini(base, key, { system, user, maxTokens }, model) {
  let limit = maxTokens, thinking = true, waited = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const generationConfig = { temperature: 0.3, maxOutputTokens: limit, responseMimeType: 'application/json' };
    if (thinking) generationConfig.thinkingConfig = thinkingFor(model);
    const res = await post(`${base}/${model}:generateContent`, { 'x-goog-api-key': key }, {
      systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig,
    });
    if (!res) { console.warn(`Career AI: ${model} did not answer`); return { busy: true }; }
    const json = await res.json().catch(() => ({}));
    const why = String((json.error && json.error.message) || '').slice(0, 200);
    if (res.status === 400 && thinking) { thinking = false; continue; }   // this model does not take the thinking option
    if (res.status === 429) {
      const wait = retryDelay(json);
      if (!waited && !dailyQuota(json) && wait !== null && wait <= WAIT_LIMIT) { waited = true; await sleep(wait); continue; }
      console.warn(`Career AI: ${model} is over its limit (429)${why ? ': ' + why : ''}`);
      return { busy: true, quota: dailyQuota(json) };
    }
    if (res.status === 404 || res.status >= 500) { console.warn(`Career AI: ${model} answered ${res.status}${why ? ': ' + why : ''}`); return { busy: true }; }
    if (!res.ok) { console.warn(`Career AI: Gemini refused the request (${res.status})${why ? ': ' + why : ''}`); return { rejected: true }; }
    const candidate = (json.candidates || [])[0] || {};
    const reply = ((candidate.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    const out = parseJson(reply);
    if (out) return { out, reply, tokens: json.usageMetadata && json.usageMetadata.totalTokenCount };
    if (candidate.finishReason === 'MAX_TOKENS' && limit < MAX_OUTPUT) { limit = Math.min(MAX_OUTPUT, limit * 2); continue; }   // cut off: more room
    console.warn(`Career AI: ${model} gave no usable JSON (finish: ${candidate.finishReason || 'none'})`);
    return { busy: true };
  }
  return { busy: true };
}

/**
 * Ask the AI for a JSON object. ctx: { db, vault, upstream?, meter? } (meter(tokens): the customer's AI tokens, tokens.js). Throws ApiError when no key is set up or the
 * service fails, with a message that can be shown to the customer. Why a call failed is written to the server log.
 */
async function completeJson(ctx, { system, user, maxTokens = 6000 }) {
  const { db, vault } = ctx;
  const upstream = { ...UPSTREAM, ...(ctx.upstream || {}) };
  const gemini = defaultKey(db, 'gemini');
  const groq = defaultKey(db, 'groq');
  if (!gemini && !groq) throw new ApiError(503, 'The AI service is not set up yet. Please try again later.', 'no-key');
  let busy = false, quota = false;
  // the tokens the service reports, or about 4 characters a token when it does not
  const spend = (reported, reply) => { if (ctx.meter) ctx.meter(Number(reported) || Math.ceil((system.length + user.length + String(reply || '').length) / 4)); };

  if (gemini) {
    const key = vault.decrypt(gemini.key_enc);
    for (const model of GEMINI_MODELS) {
      const r = await askGemini(upstream.gemini, key, { system, user, maxTokens }, model);
      if (r.out) {
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), gemini.id);
        spend(r.tokens, r.reply);
        return r.out;
      }
      if (r.rejected) break;   // e.g. a rejected key: try Groq
      busy = true;
      quota = quota || !!r.quota;
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
      console.warn('Career AI: Groq gave no usable JSON');
    } else {
      console.warn(`Career AI: Groq answered ${res ? res.status : 'nothing'}${res && res.status === 413 ? ' (the request is larger than the Groq plan allows)' : ''}`);
    }
    busy = true;
  }
  if (quota) throw new ApiError(503, 'Today\'s AI limit has been reached. Please try again later today.', 'ai-quota');
  throw new ApiError(502, busy ? 'The AI service is busy right now. Please try again in a minute.' : 'The AI service could not complete this. Please try again.', 'ai');
}

module.exports = { completeJson, parseJson, UPSTREAM };
