'use strict';
// The licence inside the desktop app: free trial, key activation, re-check at start-up, offline grace period.
// The server signs every answer (Ed25519); the app trusts an answer only if the signature matches the public key
// built into the app, the answer is for THIS computer, and it has not expired. No Electron code here, so it can be
// tested with a fake server.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DAY = 86400000;
const REJECTED = { expired: 'expired', revoked: 'revoked', not_activated: 'removed', invalid_key: 'removed' };

/**
 * One id per computer, the same after a reinstall: a hash of the Windows machine id (never sent as is).
 * Falls back to a random id kept in the app's data folder.
 */
function computerId(dir) {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i);
    // the label keeps its old name: changing it would make every registered computer look new
    if (m) return crypto.createHash('sha256').update('classcue-device:' + m[1].toLowerCase()).digest('hex').slice(0, 32);
  } catch (_) { /* not Windows, or not readable */ }
  const file = path.join(dir, 'device-id');
  try { const saved = fs.readFileSync(file, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(saved)) return saved; } catch (_) { /* first run */ }
  const id = crypto.randomBytes(16).toString('hex');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, id); } catch (_) { /* keep it for this run only */ }
  return id;
}

/** The customer's topics and resume from /api/app/config (set in the admin dashboard), or null when none is set. */
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const topics = Array.isArray(p.topics) ? p.topics.map(t => String(t).trim()).filter(Boolean).slice(0, 30) : [];
  const resume = typeof p.resume === 'string' ? p.resume.slice(0, 20000) : '';
  return topics.length || resume ? { topics, resume } : null;
}

class LicenceClient {
  /**
   * @param {{serverUrl: string, publicKeyPem: string, dir: string, deviceId: string, deviceName?: string,
   *          appVersion?: string, graceDays?: number, fetchImpl?: Function, now?: () => number}} o
   */
  constructor(o) {
    this.serverUrl = String(o.serverUrl).replace(/\/+$/, '');
    this.publicKey = crypto.createPublicKey(o.publicKeyPem);
    this.file = path.join(o.dir, 'licence.json');
    this.dir = o.dir;
    this.deviceId = o.deviceId;
    this.deviceName = o.deviceName || '';
    this.appVersion = o.appVersion || '';
    this.graceDays = o.graceDays || 7;
    this.fetch = o.fetchImpl || fetch;
    this.now = o.now || Date.now;
    this.lastError = '';
  }

  // ---- what is saved on this computer --------------------------------------------------------------

  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return null; } }
  _write(data) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(data, null, 2)); }
  _clear() { try { fs.unlinkSync(this.file); } catch (_) { /* nothing saved */ } }

  /** The signed payload, if the signature is genuine and it was issued for this computer; otherwise null. */
  _verified(saved) {
    if (!saved || typeof saved.payload !== 'string' || typeof saved.signature !== 'string') return null;
    try {
      if (!crypto.verify(null, Buffer.from(saved.payload), this.publicKey, Buffer.from(saved.signature, 'base64'))) return null;
      const p = JSON.parse(saved.payload);
      return p && p.deviceId === this.deviceId && typeof p.key === 'string' ? p : null;
    } catch (_) { return null; }
  }

  /**
   * Where the licence stands right now, from what is saved (no network).
   * state: 'none' (no licence yet) | 'active' | 'expired' | 'revoked' | 'removed' (this PC was removed) | 'check-needed'
   */
  status() {
    const saved = this._read();
    if (!saved) return { state: 'none' };
    const p = this._verified(saved);
    if (!p) return { state: 'none', problem: 'The saved licence is not valid on this computer. Activate again.' };
    const t = this.now();
    const info = {
      key: p.key, maskedKey: p.key.replace(/^(CC-....)-....-(....)$/, '$1-••••-$2'), plan: p.plan, kind: p.kind,
      expiresAt: p.expiresAt, checkedAt: p.issuedAt, deviceName: this.deviceName,
      name: typeof p.name === 'string' ? p.name : '', email: typeof p.email === 'string' ? p.email : '',
      daysLeft: p.expiresAt ? Math.max(0, Math.ceil((Date.parse(p.expiresAt) - t) / DAY)) : null,
      lastError: this.lastError,
    };
    if (saved.rejected) return { ...info, state: REJECTED[saved.rejected.code] || 'revoked', message: saved.rejected.message };
    if (p.expiresAt && Date.parse(p.expiresAt) <= t) return { ...info, state: 'expired', message: p.kind === 'trial' ? 'Your free trial has ended.' : 'Your licence has expired.' };
    const offlineDays = (t - Date.parse(p.issuedAt)) / DAY;
    if (offlineDays > this.graceDays) {
      return { ...info, state: 'check-needed', message: `The licence has not been checked for ${Math.floor(offlineDays)} days. Connect to the internet and press "Check again".` };
    }
    return { ...info, state: 'active' };
  }

  get licensed() { return this.status().state === 'active'; }

  // ---- talking to the server -----------------------------------------------------------------------

  async _post(pathname, body) {
    let res;
    try {
      res = await this.fetch(this.serverUrl + pathname, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
    } catch (_) {
      throw Object.assign(new Error('Cannot reach the licence server. Check the internet connection and try again.'), { offline: true });
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (res.status === 429) throw new Error(data.error || 'Too many attempts. Please wait a minute and try again.');
    if (res.status >= 500) throw Object.assign(new Error('The licence server is having trouble. Try again in a few minutes.'), { offline: true });
    return data;
  }

  /** A signed "ok" answer: check it, then keep it. Returns the new status, or an error. */
  _accept(data) {
    const saved = { payload: data.payload, signature: data.signature };
    if (!this._verified(saved)) return { ok: false, code: 'bad_signature', message: 'The licence server\'s answer could not be verified. Make sure the app is up to date.' };
    this._write(saved);
    this.lastError = '';
    return { ok: true, status: this.status() };
  }

  /** Activate a licence key on this computer. */
  async activate(key) {
    const clean = String(key || '').trim().toUpperCase();
    if (!/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clean)) return { ok: false, code: 'invalid_key', message: 'A licence key looks like CC-XXXX-XXXX-XXXX.' };
    try {
      const data = await this._post('/api/licence/activate', { key: clean, deviceId: this.deviceId, deviceName: this.deviceName, appVersion: this.appVersion });
      return data.ok ? this._accept(data) : { ok: false, code: data.code, message: data.message || 'The key was not accepted.' };
    } catch (err) { return { ok: false, code: 'network', message: err.message }; }
  }

  /** Start the free trial (one per computer and per email). */
  async startTrial(email) {
    try {
      const data = await this._post('/api/licence/trial', { email: String(email || '').trim(), deviceId: this.deviceId, deviceName: this.deviceName, appVersion: this.appVersion });
      return data.ok ? this._accept(data) : { ok: false, code: data.code, message: data.message || 'The trial could not be started.' };
    } catch (err) { return { ok: false, code: 'network', message: err.message }; }
  }

  /**
   * Re-check with the server (at start-up and every few hours). Offline: nothing changes, the grace period applies.
   * A cancelled, expired or removed licence is remembered, so the app locks even without a new signed answer.
   */
  async refresh() {
    const saved = this._read();
    const p = this._verified(saved);
    if (!p) return this.status();
    try {
      const data = await this._post('/api/licence/validate', { key: p.key, deviceId: this.deviceId, deviceName: this.deviceName, appVersion: this.appVersion });
      if (data.ok) this._accept(data);
      else if (REJECTED[data.code]) this._write({ ...saved, rejected: { code: data.code, message: data.message || '', at: new Date(this.now()).toISOString() } });
    } catch (err) {
      this.lastError = err.message;
    }
    return this.status();
  }

  /**
   * Re-check the licence (like refresh) and get the AI keys this licence should use (/api/app/config).
   * Returns { status, ai: { groq?: {apiKey, source, label}, gemini?: {...} }, proxy, profile } (profile: the customer's
   * topics and resume, null when none is set, undefined when the server was not reached). The keys are only returned, never
   * saved on this computer. Offline, or with an older server, ai is empty and the grace period applies as usual.
   */
  async appConfig({ proxy = false } = {}) {
    const saved = this._read();
    const p = this._verified(saved);
    if (!p) return { status: this.status(), ai: {}, proxy: null, profile: null };
    try {
      // proxy: ask for an AI proxy access token instead of the keys; a server without the proxy sends keys as before
      const data = await this._post('/api/app/config', { key: p.key, deviceId: this.deviceId, deviceName: this.deviceName, appVersion: this.appVersion, ...(proxy ? { proxy: true } : {}) });
      if (data.ok) {
        const accepted = this._accept(data);
        const grant = data.aiProxy;
        return {
          status: this.status(),
          ai: accepted.ok && data.ai && typeof data.ai === 'object' ? data.ai : {},
          proxy: accepted.ok && grant && typeof grant.token === 'string' ? { token: grant.token, expiresAt: Date.parse(grant.expiresAt) || 0, services: grant.services || {} } : null,
          profile: accepted.ok ? cleanProfile(data.profile) : null,
        };
      }
      if (REJECTED[data.code]) this._write({ ...saved, rejected: { code: data.code, message: data.message || '', at: new Date(this.now()).toISOString() } });
      else this.lastError = data.error || data.message || 'The licence server did not send the app settings.';
    } catch (err) {
      this.lastError = err.message;
    }
    return { status: this.status(), ai: {}, proxy: null, profile: undefined };   // undefined: unknown (offline), keep what was there
  }

  /**
   * Log out: free this computer's place on the licence when the server can be reached, and in any case forget the
   * licence here, so the next person has to enter their own key. Offline, the place stays used until it is removed
   * in My account; "freed" says which one happened.
   */
  async signOut() {
    const p = this._verified(this._read());
    let freed = !p;
    if (p) {
      try { await this._post('/api/licence/deactivate', { key: p.key, deviceId: this.deviceId }); freed = true; } catch (_) { /* offline */ }
    }
    this._clear();
    this.lastError = '';
    return { ok: true, freed, status: this.status() };
  }

  /** Free this computer's place on the licence (moving to a new PC), then forget the licence here. */
  async deactivate() {
    const p = this._verified(this._read());
    if (p) {
      try { await this._post('/api/licence/deactivate', { key: p.key, deviceId: this.deviceId }); } catch (err) {
        return { ok: false, message: err.message + ' The licence was kept on this computer.' };
      }
    }
    this._clear();
    return { ok: true, status: this.status() };
  }
}

module.exports = { LicenceClient, computerId, cleanProfile };
