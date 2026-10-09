'use strict';
// The admin database: one SQLite file (Node's built-in sqlite, no extra packages).

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('owner','admin','support')),
  pass_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
  organisation TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  plan TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('paid','refunded','failed')),
  provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS licences (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  plan TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('trial','paid')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  max_devices INTEGER NOT NULL DEFAULT 2, expires_at TEXT, note TEXT NOT NULL DEFAULT '',
  order_id INTEGER REFERENCES orders(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY, licence_id INTEGER NOT NULL REFERENCES licences(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', app_version TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE (licence_id, device_id)
);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY, version TEXT UNIQUE NOT NULL, channel TEXT NOT NULL DEFAULT 'stable',
  notes TEXT NOT NULL DEFAULT '', download_url TEXT NOT NULL DEFAULT '', min_supported TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL, published_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL DEFAULT 'Support',
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, admin_email TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_licences_customer ON licences(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_devices_licence ON devices(licence_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Run several statements as one all-or-nothing step. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; }
}

const now = () => new Date().toISOString();

module.exports = { open, transaction, now };
