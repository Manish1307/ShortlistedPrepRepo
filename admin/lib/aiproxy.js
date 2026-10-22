'use strict';
// AI proxy: ShortlistPrep.AI sends its AI requests here and the server adds the licence's Groq / Gemini key, so the keys
// never reach the teacher's computer. The app gets a short-lived access token from /api/app/config; every call
// re-checks that the licence is still active and the computer still activated, and is rate-limited per licence.
// Requests are passed through almost as they are (the app builds the same prompts as with its own key), but only
// the fields the app uses are forwarded and the reply length is capped, so the proxy is not a general free AI API.

const crypto = require('crypto');
const { Readable } = require('stream');
const { ApiError } = require('./http');
const { Limiter } = require('./auth');
const licences = require('./licence');
const aikeys = require('./aikeys');
const { now } = require('./db');

const UPSTREAM = {
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};
const TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_BODY = 6 * 1024 * 1024;        // a screenshot is at most ~3.5 MB, ~4.7 MB as base64
const GROQ_FIELDS = ['model', 'messages', 'stream', 'temperature', 'max_tokens', 'reasoning_effort', 'response_format'];
const GROQ_MAX_TOKENS = 2000;
const GEMINI_MAX_TOKENS = 4096;

const b64url = buf => Buffer.from(buf).toString('base64url');

/** Short-lived access tokens: HMAC-signed {licence id, device id, expiry}. The secret never leaves the server. */
class TokenSigner {
  constructor(secret, { ttlMs = TOKEN_TTL_MS, clock = Date.now } = {}) {
    // the label keeps its old name: changing it would end every open AI token
    this.secret = crypto.createHmac('sha256', secret).update('classcue-ai-proxy-token').digest();
    this.ttlMs = ttlMs;
    this.clock = clock;
  }
  issue({ licenceId, deviceId }) {
    const expiresAt = this.clock() + this.ttlMs;
    const body = b64url(JSON.stringify({ l: licenceId, d: deviceId, e: expiresAt }));
    return { token: body + '.' + this._mac(body), expiresAt: new Date(expiresAt).toISOString() };
  }
  /** {licenceId, deviceId} or null when the token is forged, malformed or expired. */
  verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(this._mac(body)), got = Buffer.from(mac);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!(p.e > this.clock())) return null;
      return { licenceId: p.l, deviceId: p.d };
    } catch (_) { return null; }
  }
  _mac(body) { return b64url(crypto.createHmac('sha256', this.secret).update(body).digest()); }
}

/** Which services the proxy can serve for a licence (a key is assigned or there is a default). */
function services(db, licenceId) {
  const r = aikeys.resolveForLicence(db, licenceId);
  return { groq: !!r.groq.row, gemini: !!r.gemini.row };
}

function cleanGroqBody(body) {
  const out = {};
  for (const f of GROQ_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  if (typeof out.model !== 'string' || !/^\w[\w.:/-]{0,99}$/.test(out.model) || out.model.includes('..')) throw new ApiError(400, 'Unknown model');
  if (!Array.isArray(out.messages) || !out.messages.length || out.messages.length > 6) throw new ApiError(400, 'Messages are missing');
  for (const m of out.messages) if (!m || !['system', 'user', 'assistant'].includes(m.role)) throw new ApiError(400, 'Bad message');
  out.max_tokens = Math.min(Number(out.max_tokens) || GROQ_MAX_TOKENS, GROQ_MAX_TOKENS);
  out.stream = out.stream === true;
  return out;
}

function cleanGeminiBody(body) {
  const { systemInstruction, contents, generationConfig = {} } = body;
  if (!Array.isArray(contents) || !contents.length || contents.length > 4) throw new ApiError(400, 'Contents are missing');
  const config = { ...generationConfig, maxOutputTokens: Math.min(Number(generationConfig.maxOutputTokens) || GEMINI_MAX_TOKENS, GEMINI_MAX_TOKENS) };
  return { ...(systemInstruction ? { systemInstruction } : {}), contents, generationConfig: config };
}

/**
 * Adds the proxy routes. ctx: { db, vault, add, upstream? }.
 * Limits per licence: answers (and question lists) 40 a minute and 1500 a day; screenshots 10 a minute and 300 a day.
 */
function addRoutes(ctx) {
  const { db, vault, add } = ctx;
  const upstream = { ...UPSTREAM, ...(ctx.upstream || {}) };
  const tokens = ctx.tokens;
  const limits = ctx.proxyLimiters || {
    answer: [new Limiter({ max: 40, windowMs: 60 * 1000 }), new Limiter({ max: 1500, windowMs: 86400000 })],
    screen: [new Limiter({ max: 10, windowMs: 60 * 1000 }), new Limiter({ max: 300, windowMs: 86400000 })],
    models: [new Limiter({ max: 20, windowMs: 60 * 1000 })],
  };

  /** The token's {licenceId, deviceId}; also checked before a (large) request body is read. */
  function tokenOf(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const t = m && tokens.verify(m[1]);
    if (!t) throw new ApiError(401, 'AI access has expired. ShortlistPrep.AI will renew it.', 'token');
    return t;
  }

  /** The licence behind the Bearer token, re-checked now (a revoked licence or removed computer stops at once). */
  function authorise(req, kind) {
    const t = tokenOf(req);
    const lic = db.prepare('SELECT * FROM licences WHERE id = ?').get(t.licenceId);
    if (!lic || licences.effectiveStatus(lic) !== 'active') throw new ApiError(403, 'The licence is not active.', 'licence');
    if (!db.prepare('SELECT id FROM devices WHERE licence_id = ? AND device_id = ?').get(lic.id, t.deviceId)) {
      throw new ApiError(403, 'This computer is not activated for the licence.', 'licence');
    }
    const key = 'l' + lic.id;
    if (limits[kind].some(l => l.blocked(key))) throw new ApiError(429, 'Too many AI requests for this licence. Please wait a minute.', 'rate');
    for (const l of limits[kind]) l.hit(key);
    return lic;
  }

  function keyFor(licenceId, provider) {
    const r = aikeys.resolveForLicence(db, licenceId)[provider];
    if (!r.row) throw new ApiError(503, `No ${aikeys.PROVIDERS[provider].label} key is set up for this licence on the server.`, 'no-key');
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), r.row.id);
    return vault.decrypt(r.row.key_enc);
  }

  /**
   * Sends the request upstream and streams the reply straight back (status, content type and body), so the app
   * reads it exactly as if it came from Groq / Gemini. A rejected server key becomes 502: 401 here means "renew the token".
   */
  async function relay(req, res, url, init) {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let up;
    try { up = await fetch(url, { ...init, signal: abort.signal }); } catch (err) {
      throw new ApiError(502, 'The AI service could not be reached from the server.', 'upstream');
    }
    let status = up.status;
    if (status === 401 || status === 403) status = 502;
    res.writeHead(status, {
      'Content-Type': up.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    if (res.socket) res.socket.setNoDelay(true);
    if (!up.body) return res.end();
    try {
      for await (const chunk of Readable.fromWeb(up.body)) res.write(chunk);
    } catch (_) { /* the app went away or the service dropped the stream */ }
    res.end();
  }

  const json = key => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key });

  // Groq chat completions (answers stream as SSE; question lists and the Groq picture models are plain JSON)
  add('POST', '/api/ai/answer', { public: true, maxBody: MAX_BODY, before: tokenOf }, async (req, res, { body }) => {
    const lic = authorise(req, Array.isArray(body.messages) && JSON.stringify(body.messages).includes('"image_url"') ? 'screen' : 'answer');
    const clean = cleanGroqBody(body);
    await relay(req, res, upstream.groq + '/chat/completions', { method: 'POST', headers: json(keyFor(lic.id, 'groq')), body: JSON.stringify(clean) });
  });

  // Gemini reads a screenshot: the model goes in ?model=, the body is Gemini's generateContent request
  add('POST', '/api/ai/read-screen', { public: true, maxBody: MAX_BODY, before: tokenOf }, async (req, res, { body, query }) => {
    const lic = authorise(req, 'screen');
    const model = String(query.get('model') || '');
    if (!/^gemini-[\w.-]{1,60}$/.test(model)) throw new ApiError(400, 'Unknown model');
    const clean = cleanGeminiBody(body);
    await relay(req, res, `${upstream.gemini}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyFor(lic.id, 'gemini') }, body: JSON.stringify(clean),
    });
  });

  // Groq's model list (only the names), used when a model name has been retired
  add('GET', '/api/ai/models', { public: true }, async req => {
    const lic = authorise(req, 'models');
    const up = await fetch(upstream.groq + '/models', { headers: { Authorization: 'Bearer ' + keyFor(lic.id, 'groq') } }).catch(() => null);
    if (!up || !up.ok) return { data: [] };
    const data = ((await up.json()).data || []).map(m => ({ id: String(m.id) }));
    return { object: 'list', data };
  });
}

module.exports = { TokenSigner, services, addRoutes, cleanGroqBody, cleanGeminiBody, UPSTREAM, TOKEN_TTL_MS };
