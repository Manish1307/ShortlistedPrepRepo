'use strict';
// Customer logins for the website's "My account" page. An admin creates the login in the dashboard (the customer's
// email + a generated password, shown once) and sends it to the customer, who must choose their own password at the
// first sign-in. The website is on another address than this server, so it signs in with a Bearer token (kept in
// the browser), not a cookie.

const crypto = require('crypto');
const auth = require('./auth');
const licences = require('./licence');
const profiles = require('./profiles');
const { ApiError } = require('./http');
const { now } = require('./db');
const { logActivity } = require('./activity');
const { SECTORS } = require('./jobcatalogue');

const SESSION_DAYS = 7;
const DUMMY_HASH = auth.hashPassword('not-a-real-password');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** An easy-to-type password like "Kp7m-Qx3r-Tn9w" (no 0/O, 1/l/I). About 70 bits. */
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  const s = [...bytes].map(b => chars[b % chars.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/**
 * The signed-in customer for the request's Bearer token (the website's My account pages), or an ApiError.
 * allowMustChange: the password page works before the first change. Also used by the career toolkit (career.js).
 */
function signedInCustomer(db, req, { allowMustChange = false } = {}) {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
  if (!m) throw new ApiError(401, 'Please sign in', 'signin');
  db.prepare('DELETE FROM customer_sessions WHERE expires_at < ?').run(now());
  const row = db.prepare(`SELECT c.*, a.must_change, a.last_login, a.password_set_at FROM customer_sessions s
                          JOIN customers c ON c.id = s.customer_id JOIN customer_accounts a ON a.customer_id = c.id
                          WHERE s.token_hash = ? AND a.disabled = 0`).get(sha256(m[1]));
  if (!row) throw new ApiError(401, 'Your session has ended. Please sign in again.', 'signin');
  if (row.must_change && !allowMustChange) throw new ApiError(403, 'Choose your own password first.', 'password_change');
  return { customer: row, token: m[1] };
}

function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;
  // failed sign-ins: 8 per email and address, 30 per address, in 15 minutes
  const loginLimiter = ctx.accountLimiter || new auth.Limiter({ max: 8, windowMs: 15 * 60 * 1000 });
  const ipLimiter = new auth.Limiter({ max: 30, windowMs: 15 * 60 * 1000 });
  const siteUrl = String(process.env.SITE_URL || '').replace(/\/+$/, '');

  const accountOf = customerId => {
    const a = one('SELECT * FROM customer_accounts WHERE customer_id = ?', customerId);
    return a ? { exists: true, disabled: !!a.disabled, mustChange: !!a.must_change, createdAt: a.created_at, createdBy: a.created_by, passwordSetAt: a.password_set_at, lastLogin: a.last_login }
      : { exists: false };
  };

  const customerOf = (req, opts) => signedInCustomer(db, req, opts);

  // ===================== dashboard: create / reset / turn off a customer's login =====================

  add('GET', '/admin/api/customers/:id/account', { admin: true }, (req, res, { params }) => {
    const c = one('SELECT id, email FROM customers WHERE id = ?', params.id);
    if (!c) throw new ApiError(404, 'Customer not found');
    return { account: accountOf(c.id), siteUrl };
  });

  add('POST', '/admin/api/customers/:id/account', { admin: true, perm: 'accounts.write' }, (req, res, { params, body, admin }) => {
    const c = one('SELECT id, email, name FROM customers WHERE id = ?', params.id);
    if (!c) throw new ApiError(404, 'Customer not found');
    const action = String(body.action || '');
    if (action === 'reset') {
      // a new generated password: the customer must change it at the next sign-in; every open session ends
      const password = generatePassword();
      const t = now();
      db.prepare(`INSERT INTO customer_accounts (customer_id, pass_hash, must_change, disabled, created_at, created_by, password_set_at) VALUES (?,?,1,0,?,?,?)
                  ON CONFLICT (customer_id) DO UPDATE SET pass_hash = excluded.pass_hash, must_change = 1, disabled = 0, password_set_at = excluded.password_set_at`)
        .run(c.id, auth.hashPassword(password), t, admin.email, t);
      db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?').run(c.id);
      audit(admin, 'account.password', c.email, 'new generated password');
      return { account: accountOf(c.id), email: c.email, password, siteUrl };
    }
    if (action === 'disable' || action === 'enable') {
      if (!one('SELECT customer_id FROM customer_accounts WHERE customer_id = ?', c.id)) throw new ApiError(400, 'This customer has no login yet');
      db.prepare('UPDATE customer_accounts SET disabled = ? WHERE customer_id = ?').run(action === 'disable' ? 1 : 0, c.id);
      if (action === 'disable') db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?').run(c.id);
      audit(admin, `account.${action}d`, c.email);
      return { account: accountOf(c.id) };
    }
    throw new ApiError(400, 'Unknown action');
  });

  // ===================== website: the customer's own account =====================

  add('POST', '/api/account/login', { public: true }, (req, res, { body, ip }) => {
    const mail = String(body.email || '').trim().toLowerCase();
    const key = `${ip}|${mail}`;
    if (loginLimiter.blocked(key) || ipLimiter.blocked(ip)) throw new ApiError(429, 'Too many attempts. Please try again in 15 minutes.');
    const row = mail ? one(`SELECT c.id, c.email, c.name, a.pass_hash, a.disabled, a.must_change FROM customers c
                            JOIN customer_accounts a ON a.customer_id = c.id WHERE c.email = ?`, mail) : null;
    const ok = auth.verifyPassword(String(body.password || ''), row ? row.pass_hash : DUMMY_HASH) && row && !row.disabled;
    if (!ok) { loginLimiter.hit(key); ipLimiter.hit(ip); throw new ApiError(401, 'Wrong email or password'); }
    loginLimiter.reset(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    db.prepare('INSERT INTO customer_sessions (token_hash, customer_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha256(token), row.id, now(), expiresAt);
    db.prepare('UPDATE customer_accounts SET last_login = ? WHERE customer_id = ?').run(now(), row.id);
    logActivity(db, row.id, 'login', 'Signed in on the website');
    return { body: { ok: true, token, expiresAt, mustChange: !!row.must_change, customer: { email: row.email, name: row.name } } };
  });

  add('POST', '/api/account/logout', { public: true }, req => {
    const { token } = customerOf(req, { allowMustChange: true });
    db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(sha256(token));
    return { ok: true };
  });

  // a new password; the customer's other sessions end (this one stays signed in)
  add('POST', '/api/account/password', { public: true }, (req, res, { body }) => {
    const { customer, token } = customerOf(req, { allowMustChange: true });
    const a = one('SELECT pass_hash FROM customer_accounts WHERE customer_id = ?', customer.id);
    if (!auth.verifyPassword(String(body.current || ''), a.pass_hash)) throw new ApiError(400, 'Your current password is not correct');
    const next = String(body.next || '');
    const weak = auth.checkPasswordStrength(next);
    if (weak) throw new ApiError(400, weak);
    if (next === String(body.current)) throw new ApiError(400, 'Choose a password different from the current one');
    db.prepare('UPDATE customer_accounts SET pass_hash = ?, must_change = 0, password_set_at = ? WHERE customer_id = ?').run(auth.hashPassword(next), now(), customer.id);
    db.prepare('DELETE FROM customer_sessions WHERE customer_id = ? AND token_hash <> ?').run(customer.id, sha256(token));
    return { ok: true };
  });

  // everything about the signed-in customer: profile, licences with their computers, orders, topics and resume, classes
  add('GET', '/api/account/me', { public: true }, req => {
    const { customer: c } = customerOf(req);
    const lics = all('SELECT * FROM licences WHERE customer_id = ? ORDER BY id DESC', c.id).map(l => ({
      key: l.key, plan: l.plan, kind: l.kind, status: licences.effectiveStatus(l), expiresAt: l.expires_at, maxDevices: l.max_devices, createdAt: l.created_at,
      devices: all('SELECT device_id, name, app_version, first_seen, last_seen FROM devices WHERE licence_id = ? ORDER BY last_seen DESC', l.id)
        .map(d => ({ machineId: d.device_id.slice(0, 8).toUpperCase(), name: d.name, appVersion: d.app_version, firstSeen: d.first_seen, lastSeen: d.last_seen })),
    }));
    const p = profiles.profileOf(db, c.id);
    return {
      customer: { email: c.email, name: c.name, organisation: c.organisation, country: c.country, sector: c.sector || '', since: c.created_at },
      sectors: SECTORS.map(x => ({ id: x.id, label: x.label })),
      account: { lastLogin: c.last_login, passwordSetAt: c.password_set_at },
      licences: lics,
      orders: all('SELECT id, plan, amount_cents, currency, status, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC', c.id),
      profile: { topics: p.topics, resume: p.resume, resumeName: p.resumeName, updatedAt: p.updatedAt },
      conversations: all(`SELECT v.id, v.started_at, v.duration_sec, v.question_count, v.device_name,
          (SELECT question FROM conversation_items i WHERE i.conversation_id = v.id ORDER BY position LIMIT 1) AS first_question
          FROM conversations v JOIN licences l ON l.id = v.licence_id WHERE l.customer_id = ? ORDER BY v.started_at DESC LIMIT 100`, c.id),
    };
  });

  // the candidate's sector: required, and the one AI Job search uses
  add('POST', '/api/account/profile', { public: true }, (req, res, { body }) => {
    const { customer } = customerOf(req);
    const sector = String(body.sector || '').trim();
    if (!SECTORS.some(x => x.id === sector)) throw new ApiError(400, 'Please choose your sector');
    db.prepare('UPDATE customers SET sector = ? WHERE id = ?').run(sector, customer.id);
    logActivity(db, customer.id, 'profile.sector', sector);
    return { ok: true, sector };
  });

  add('GET', '/api/account/conversations/:id', { public: true }, (req, res, { params }) => {
    const { customer: c } = customerOf(req);
    const v = one(`SELECT v.* FROM conversations v JOIN licences l ON l.id = v.licence_id WHERE v.id = ? AND l.customer_id = ?`, params.id, c.id);
    if (!v) throw new ApiError(404, 'Conversation not found');
    let transcript = [];
    try { transcript = JSON.parse(v.transcript); } catch (_) { /* older format */ }
    return {
      conversation: { id: v.id, startedAt: v.started_at, endedAt: v.ended_at, durationSec: v.duration_sec, deviceName: v.device_name, subject: v.subject, transcript },
      items: all('SELECT position, asked_at, question, answer, status FROM conversation_items WHERE conversation_id = ? ORDER BY position', v.id),
    };
  });

}

module.exports = { addRoutes, generatePassword, signedInCustomer, SESSION_DAYS };
