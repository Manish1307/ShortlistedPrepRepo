'use strict';
// AI service keys (Groq for answers, Gemini for reading screenshots) that the server hands to licensed computers.
// Each licence can have its own key per service; otherwise the service's default key is used.
// Keys are stored encrypted (AES-256-GCM) with a secret kept next to the database (or API_KEY_SECRET), and the
// dashboard only ever shows the last 4 characters.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { now, transaction } = require('./db');

const PROVIDERS = {
  groq: { label: 'Groq', use: 'Answers', pattern: /^gsk_\S{20,}$/, hint: 'Groq keys start with gsk_' },
  gemini: { label: 'Gemini', use: 'Screenshots (images)', pattern: /^\S{20,}$/, hint: 'Paste the whole Gemini key (it usually starts with AIza)' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL CHECK (provider IN ('groq','gemini')), label TEXT NOT NULL,
  key_enc TEXT NOT NULL, key_last4 TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS licence_api_keys (
  licence_id INTEGER NOT NULL REFERENCES licences(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('groq','gemini')),
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (licence_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);
CREATE INDEX IF NOT EXISTS idx_licence_api_keys_key ON licence_api_keys(api_key_id);
`;

/** Encrypts and decrypts keys with a 32-byte secret: API_KEY_SECRET (base64) or <dataDir>/api-keys.secret. */
class KeyVault {
  constructor(dataDir) {
    if (process.env.API_KEY_SECRET) {
      this.secret = Buffer.from(process.env.API_KEY_SECRET, 'base64');
      if (this.secret.length !== 32) throw new Error('API_KEY_SECRET must be 32 bytes, base64 encoded');
      return;
    }
    const file = path.join(dataDir, 'api-keys.secret');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    this.secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.secret, iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }
  decrypt(stored) {
    const [v, iv, tag, data] = String(stored).split(':');
    if (v !== 'v1') throw new Error('Unknown key format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.secret, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

function setup(db) { db.exec(SCHEMA); }

/** A key row as the dashboard sees it: never the key itself. */
const present = row => {
  if (!row) return row;
  const { key_enc: _hidden, ...rest } = row;
  return { ...rest, masked: '••••' + row.key_last4, provider_label: PROVIDERS[row.provider].label };
};

function listKeys(db) {
  return db.prepare(`SELECT k.*, (SELECT COUNT(*) FROM licence_api_keys a WHERE a.api_key_id = k.id) AS licence_count
                     FROM api_keys k ORDER BY CASE k.provider WHEN 'groq' THEN 0 ELSE 1 END, k.is_default DESC, k.id`).all().map(present);
}

function addKey(db, vault, { provider, label, key, makeDefault, by }) {
  return transaction(db, () => {
    const r = db.prepare('INSERT INTO api_keys (provider, label, key_enc, key_last4, created_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(provider, label, vault.encrypt(key), key.slice(-4), now(), by || '');
    const isFirst = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE provider = ?').get(provider).n === 1;
    if (makeDefault || isFirst) setDefault(db, r.lastInsertRowid);
    return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(r.lastInsertRowid);
  });
}

/** One default per service. */
function setDefault(db, id) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  db.prepare('UPDATE api_keys SET is_default = 0 WHERE provider = ?').run(row.provider);
  db.prepare('UPDATE api_keys SET is_default = 1 WHERE id = ?').run(id);
}

/** Which key each service would use for a licence, and why ('assigned' | 'default' | 'none'). Rows include key_enc. */
function resolveForLicence(db, licenceId) {
  const out = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const assigned = db.prepare(`SELECT k.* FROM licence_api_keys a JOIN api_keys k ON k.id = a.api_key_id
                                 WHERE a.licence_id = ? AND a.provider = ?`).get(licenceId, provider);
    if (assigned && !assigned.disabled) { out[provider] = { source: 'assigned', row: assigned }; continue; }
    const fallback = db.prepare('SELECT * FROM api_keys WHERE provider = ? AND is_default = 1 AND disabled = 0').get(provider);
    out[provider] = fallback ? { source: 'default', row: fallback, assignedDisabled: !!assigned } : { source: 'none', assignedDisabled: !!assigned };
  }
  return out;
}

/** Point a licence at a key for one service, or back to the default (apiKeyId null). */
function assign(db, { licenceId, provider, apiKeyId }) {
  if (apiKeyId === null) { db.prepare('DELETE FROM licence_api_keys WHERE licence_id = ? AND provider = ?').run(licenceId, provider); return; }
  db.prepare(`INSERT INTO licence_api_keys (licence_id, provider, api_key_id) VALUES (?,?,?)
              ON CONFLICT (licence_id, provider) DO UPDATE SET api_key_id = excluded.api_key_id`).run(licenceId, provider, apiKeyId);
}

/** The plain keys a licensed computer receives. Marks them as used. */
function keysForApp(db, vault, licenceId) {
  const resolved = resolveForLicence(db, licenceId);
  const ai = {};
  for (const [provider, r] of Object.entries(resolved)) {
    if (!r.row) continue;
    try { ai[provider] = { apiKey: vault.decrypt(r.row.key_enc), source: r.source, label: r.row.label }; } catch (_) { continue; }
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), r.row.id);
  }
  return ai;
}

module.exports = { PROVIDERS, KeyVault, setup, present, listKeys, addKey, setDefault, resolveForLicence, assign, keysForApp };
