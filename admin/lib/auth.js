'use strict';
// Passwords, login sessions, login throttling and permissions for the admin dashboard.

const crypto = require('crypto');
const { now } = require('./db');

const SESSION_HOURS = 12;
const MIN_PASSWORD = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function checkPasswordStrength(password) {
  if (String(password).length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  return null;
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function createSession(db, adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha256(token), adminId, now(), expires);
  return { token, maxAgeSeconds: SESSION_HOURS * 3600 };
}

/** The signed-in admin for a session token, or null. Expired sessions are cleaned up. */
function getSession(db, token) {
  if (!token) return null;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  return db.prepare(`SELECT a.id, a.email, a.name, a.role FROM sessions s JOIN admins a ON a.id = s.admin_id
                     WHERE s.token_hash = ? AND a.disabled = 0`).get(sha256(token)) || null;
}

function deleteSession(db, token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); }
function deleteAdminSessions(db, adminId) { db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId); }

/** Counts failures per key within a time window; used for login attempts and the public forms. */
class Limiter {
  constructor({ max, windowMs, clock = Date.now }) { this.max = max; this.windowMs = windowMs; this.clock = clock; this.hits = new Map(); }
  _recent(key) {
    const cutoff = this.clock() - this.windowMs;
    const list = (this.hits.get(key) || []).filter(t => t > cutoff);
    this.hits.set(key, list);
    return list;
  }
  blocked(key) { return this._recent(key).length >= this.max; }
  hit(key) { this._recent(key).push(this.clock()); if (this.hits.size > 5000) this.hits.clear(); }
  reset(key) { this.hits.delete(key); }
}

// What each role may change. Everyone signed in may read everything except the team list.
const PERMISSIONS = {
  'messages.write': ['owner', 'admin', 'support'],
  'licence.minor': ['owner', 'admin', 'support'],   // extend, reset devices, note
  'licence.major': ['owner', 'admin'],              // create, revoke, reinstate, change device limit
  'customers.write': ['owner', 'admin'],
  'orders.write': ['owner', 'admin'],
  'releases.write': ['owner', 'admin'],
  'team.read': ['owner'],
  'team.write': ['owner'],
};
const can = (role, permission) => (PERMISSIONS[permission] || []).includes(role);

module.exports = { hashPassword, verifyPassword, checkPasswordStrength, createSession, getSession, deleteSession, deleteAdminSessions, Limiter, can, SESSION_HOURS, MIN_PASSWORD };
