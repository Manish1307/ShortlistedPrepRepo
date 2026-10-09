'use strict';
// Licence keys, trial/paid rules, device activation, and the signed answer the desktop app receives.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { now } = require('./db');

const PLANS = {
  trial: { maxDevices: 1, kind: 'trial' },
  personal: { maxDevices: 2, kind: 'paid' },
  schools: { maxDevices: 5, kind: 'paid' },
};
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to avoid misreading a key

function generateKey() {
  const group = () => Array.from(crypto.randomBytes(4), b => ALPHABET[b % ALPHABET.length]).join('');
  return `CC-${group()}-${group()}-${group()}`;
}

/** 'active' | 'expired' | 'revoked' for a licence row at a moment in time. */
function effectiveStatus(licence, at = new Date()) {
  if (licence.status === 'revoked') return 'revoked';
  if (licence.expires_at && new Date(licence.expires_at) < at) return 'expired';
  return 'active';
}

const addDays = (from, days) => new Date(new Date(from).getTime() + days * 86400000).toISOString();

/** Creates a licence. `days` of null/undefined means it never expires (lifetime). */
function createLicence(db, { customerId, plan, days, maxDevices, note = '', orderId = null }) {
  const spec = PLANS[plan];
  if (!spec) throw Object.assign(new Error(`Unknown plan "${plan}"`), { status: 400 });
  const expires = days === null || days === undefined || days === '' ? null : addDays(new Date(), Number(days));
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = generateKey();
    try {
      const r = db.prepare(`INSERT INTO licences (key, customer_id, plan, kind, max_devices, expires_at, note, order_id, created_at)
                            VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(key, customerId, plan, spec.kind, Number(maxDevices) || spec.maxDevices, expires, String(note).slice(0, 500), orderId, now());
      return db.prepare('SELECT * FROM licences WHERE id = ?').get(r.lastInsertRowid);
    } catch (err) { if (!/UNIQUE/.test(String(err.message))) throw err; }
  }
  throw new Error('Could not generate a unique licence key');
}

/** Signs what the app is told, so a customer cannot fake an "all OK" answer. The app holds the public key. */
class Signer {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'signing-key.pem');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.privateKey = crypto.createPrivateKey(fs.readFileSync(this.file));
    } else {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(this.file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      this.privateKey = privateKey;
    }
    this.publicKeyPem = crypto.createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' });
  }
  sign(payload) {
    const text = JSON.stringify(payload);
    return { payload: text, signature: crypto.sign(null, Buffer.from(text), this.privateKey).toString('base64') };
  }
}

function verifySigned(publicKeyPem, { payload, signature }) {
  return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
}

const fail = (code, message) => ({ ok: false, code, message });

/**
 * The app calls this to activate on a computer (register: true) or to re-check (register: false).
 * Returns { ok, ... }; on success the answer is signed.
 */
function checkLicence(db, signer, { key, deviceId, deviceName = '', appVersion = '' }, { register }) {
  const cleanKey = String(key || '').trim().toUpperCase();
  const device = String(deviceId || '').trim().slice(0, 100);
  if (!/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleanKey) || !device) return fail('invalid_key', 'That licence key is not valid.');

  const licence = db.prepare('SELECT * FROM licences WHERE key = ?').get(cleanKey);
  if (!licence) return fail('invalid_key', 'That licence key is not valid.');
  const status = effectiveStatus(licence);
  if (status === 'revoked') return fail('revoked', 'This licence has been cancelled. Please contact support.');
  if (status === 'expired') return fail('expired', 'This licence has expired.');

  const t = now();
  const known = db.prepare('SELECT id FROM devices WHERE licence_id = ? AND device_id = ?').get(licence.id, device);
  if (known) {
    db.prepare('UPDATE devices SET last_seen = ?, name = ?, app_version = ? WHERE id = ?')
      .run(t, String(deviceName).slice(0, 100), String(appVersion).slice(0, 30), known.id);
  } else if (!register) {
    return fail('not_activated', 'This computer is not activated for that licence.');
  } else {
    const used = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE licence_id = ?').get(licence.id).n;
    if (used >= licence.max_devices) return fail('device_limit', `This licence is already used on ${licence.max_devices} computer(s). Remove one in your account or contact support.`);
    db.prepare('INSERT INTO devices (licence_id, device_id, name, app_version, first_seen, last_seen) VALUES (?,?,?,?,?,?)')
      .run(licence.id, device, String(deviceName).slice(0, 100), String(appVersion).slice(0, 30), t, t);
  }

  const answer = signer.sign({
    key: licence.key, deviceId: device, plan: licence.plan, kind: licence.kind,
    expiresAt: licence.expires_at, issuedAt: t,
  });
  return { ok: true, plan: licence.plan, kind: licence.kind, expiresAt: licence.expires_at, ...answer };
}

function removeDevice(db, { key, deviceId }) {
  const licence = db.prepare('SELECT id FROM licences WHERE key = ?').get(String(key || '').trim().toUpperCase());
  if (!licence) return false;
  return db.prepare('DELETE FROM devices WHERE licence_id = ? AND device_id = ?').run(licence.id, String(deviceId || '')).changes > 0;
}

module.exports = { PLANS, generateKey, effectiveStatus, createLicence, Signer, verifySigned, checkLicence, removeDevice, addDays };
