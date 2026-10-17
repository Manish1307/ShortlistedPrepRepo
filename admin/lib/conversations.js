'use strict';
// Live Class conversations: when the teacher presses End, the app sends the whole class (what was heard, and every
// question with its answer) to POST /api/app/conversations, signed in with the same short-lived access token as the
// AI proxy. The dashboard lists them by date and time (Conversations).
// Sending the same conversation again (a retry after a lost connection) does not make a second copy: each one has
// an id made by the app (uid), unique per licence.

const { ApiError, text, likeTerm } = require('./http');
const { Limiter } = require('./auth');
const licences = require('./licence');
const { now, transaction } = require('./db');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_TRANSCRIPT = 3000;   // phrases
const MAX_ITEMS = 500;         // questions
const STATUSES = ['done', 'error', 'unanswered'];

/** An ISO date string from the app, or the fallback when it is missing or not a date. */
function isoDate(value, fallback) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/** The conversation the app sent, checked and trimmed to what is stored. */
function cleanConversation(body) {
  const uid = String(body.uid || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(uid)) throw new ApiError(400, 'Bad conversation id');
  const endedAt = isoDate(body.endedAt, now());
  let startedAt = isoDate(body.startedAt, endedAt);
  if (startedAt > endedAt) startedAt = endedAt;
  if (!Array.isArray(body.transcript || []) || !Array.isArray(body.items || [])) throw new ApiError(400, 'Transcript and questions must be lists');
  const transcript = (body.transcript || []).slice(0, MAX_TRANSCRIPT)
    .map(p => ({ at: isoDate(p && p.at, startedAt), text: String((p && p.text) || '').trim().slice(0, 2000) }))
    .filter(p => p.text);
  const items = (body.items || []).slice(0, MAX_ITEMS)
    .map(it => ({
      at: isoDate(it && it.at, startedAt),
      question: String((it && it.question) || '').trim().slice(0, 4000),
      answer: String((it && it.answer) || '').slice(0, 20000),
      status: STATUSES.includes(it && it.status) ? it.status : 'unanswered',
      error: String((it && it.error) || '').slice(0, 500),
      source: String((it && it.source) || '').replace(/[^\w-]/g, '').slice(0, 20),
      vote: [1, -1].includes(it && it.vote) ? it.vote : 0,
    }))
    .filter(it => it.question);
  return {
    uid, startedAt, endedAt, transcript, items,
    subject: text(body.subject, 200, { field: 'Subject' }),
    durationSec: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
  };
}

/** Adds the app's upload route and the dashboard's routes. ctx: { db, add, tokens, audit, one, all }. */
function addRoutes(ctx) {
  const { db, add, tokens, audit, one, all } = ctx;
  const limiter = ctx.conversationLimiter || new Limiter({ max: 30, windowMs: 60 * 60 * 1000 });

  /** The licence and computer behind the Bearer token, re-checked now (like the AI proxy). */
  function authorise(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const t = m && tokens && tokens.verify(m[1]);
    if (!t) throw new ApiError(401, 'Access has expired. Live Class will renew it.', 'token');
    const lic = one('SELECT * FROM licences WHERE id = ?', t.licenceId);
    if (!lic || licences.effectiveStatus(lic) !== 'active') throw new ApiError(403, 'The licence is not active.', 'licence');
    const device = one('SELECT * FROM devices WHERE licence_id = ? AND device_id = ?', lic.id, t.deviceId);
    if (!device) throw new ApiError(403, 'This computer is not activated for the licence.', 'licence');
    return { lic, device };
  }

  // ===== the app: save a finished class =====
  add('POST', '/api/app/conversations', { public: true, maxBody: MAX_BODY, before: authorise }, (req, res, { body }) => {
    const { lic, device } = authorise(req);
    const key = 'l' + lic.id;
    if (limiter.blocked(key)) throw new ApiError(429, 'Too many conversations saved for this licence. Please try again later.', 'rate');
    const c = cleanConversation(body);
    const existing = one('SELECT id FROM conversations WHERE licence_id = ? AND uid = ?', lic.id, c.uid);
    if (existing) return { body: { ok: true, id: existing.id, duplicate: true } };
    limiter.hit(key);
    const id = transaction(db, () => {
      const r = db.prepare(`INSERT INTO conversations (uid, licence_id, device_id, device_name, subject, started_at, ended_at, duration_sec, question_count, transcript, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(c.uid, lic.id, device.device_id, device.name, c.subject, c.startedAt, c.endedAt, c.durationSec, c.items.length, JSON.stringify(c.transcript), now());
      const insert = db.prepare('INSERT INTO conversation_items (conversation_id, position, asked_at, question, answer, status, error, source, vote) VALUES (?,?,?,?,?,?,?,?,?)');
      c.items.forEach((it, i) => insert.run(r.lastInsertRowid, i + 1, it.at, it.question, it.answer, it.status, it.error, it.source, it.vote));
      return Number(r.lastInsertRowid);
    });
    return { status: 201, body: { ok: true, id } };
  });

  // ===== dashboard =====
  const dayParam = (value, field) => {
    const s = String(value || '');
    if (!s) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError(400, `${field} must look like 2026-10-16`);
    return s;
  };

  // Newest first. q searches the customer, the computer, the subject, the questions and answers, and what was heard.
  // from / to are days (YYYY-MM-DD, inclusive) of when the class started, in UTC.
  add('GET', '/admin/api/conversations', { admin: true }, (req, res, { query }) => {
    const term = likeTerm(query.get('q'));
    const from = dayParam(query.get('from'), 'From');
    const to = dayParam(query.get('to'), 'To');
    const rows = all(`SELECT v.id, v.started_at, v.ended_at, v.duration_sec, v.question_count, v.subject, v.device_name,
        l.key AS licence_key, c.email AS customer_email, c.name AS customer_name,
        (SELECT question FROM conversation_items i WHERE i.conversation_id = v.id ORDER BY position LIMIT 1) AS first_question
        FROM conversations v JOIN licences l ON l.id = v.licence_id JOIN customers c ON c.id = l.customer_id
        WHERE (c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR v.device_name LIKE ? ESCAPE '\\' OR v.subject LIKE ? ESCAPE '\\'
               OR v.transcript LIKE ? ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM conversation_items i WHERE i.conversation_id = v.id AND (i.question LIKE ? ESCAPE '\\' OR i.answer LIKE ? ESCAPE '\\')))
        ${from ? 'AND v.started_at >= ?' : ''} ${to ? 'AND v.started_at < ?' : ''}
        ORDER BY v.started_at DESC LIMIT 500`,
    term, term, term, term, term, term, term, ...(from ? [from] : []), ...(to ? [nextDay(to)] : []));
    return { conversations: rows };
  });

  add('GET', '/admin/api/conversations/:id', { admin: true }, (req, res, { params }) => {
    const v = one(`SELECT v.*, l.key AS licence_key, c.email AS customer_email, c.name AS customer_name
                   FROM conversations v JOIN licences l ON l.id = v.licence_id JOIN customers c ON c.id = l.customer_id WHERE v.id = ?`, params.id);
    if (!v) throw new ApiError(404, 'Conversation not found');
    let transcript = [];
    try { transcript = JSON.parse(v.transcript); } catch (_) { /* stored by an older version */ }
    return { conversation: { ...v, transcript }, items: all('SELECT * FROM conversation_items WHERE conversation_id = ? ORDER BY position', v.id) };
  });

  add('DELETE', '/admin/api/conversations/:id', { admin: true, perm: 'conversations.delete' }, (req, res, { params, admin }) => {
    const v = one('SELECT id, started_at FROM conversations WHERE id = ?', params.id);
    if (!v) throw new ApiError(404, 'Conversation not found');
    db.prepare('DELETE FROM conversations WHERE id = ?').run(v.id);
    audit(admin, 'conversation.deleted', `#${v.id}`, v.started_at);
    return { ok: true };
  });
}

/** "2026-10-16" -> "2026-10-17" (the end of an inclusive "to" day). */
function nextDay(day) { return new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); }

module.exports = { addRoutes, cleanConversation, MAX_BODY };
