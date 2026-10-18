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
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, visitor TEXT NOT NULL, path TEXT NOT NULL,
  referrer TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT 'desktop'
);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('demo','interest','signup','contact')),
  name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
  role_interest TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', source_page TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','won','lost')),
  owner TEXT NOT NULL DEFAULT '', value_cents INTEGER NOT NULL DEFAULT 0, follow_up TEXT NOT NULL DEFAULT '',
  customer_id INTEGER REFERENCES customers(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunity_notes (
  id INTEGER PRIMARY KEY, opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL, licence_id INTEGER NOT NULL REFERENCES licences(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, device_name TEXT NOT NULL DEFAULT '', app TEXT NOT NULL DEFAULT 'liveclass', subject TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_sec INTEGER NOT NULL DEFAULT 0, question_count INTEGER NOT NULL DEFAULT 0,
  transcript TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE (licence_id, uid)
);
CREATE TABLE IF NOT EXISTS conversation_items (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, asked_at TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','error','unanswered')), error TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', vote INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  topics TEXT NOT NULL DEFAULT '[]', resume_text TEXT NOT NULL DEFAULT '', resume_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customer_accounts (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  pass_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', password_set_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions ON customer_sessions(customer_id);
CREATE TABLE IF NOT EXISTS career_resumes (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL,
  ats_json TEXT, ats_at TEXT, uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS career_versions (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS career_matches (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_title TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', jd_text TEXT NOT NULL,
  version_id INTEGER, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS career_usage (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (customer_id, day)
);
CREATE TABLE IF NOT EXISTS job_companies (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, careers_url TEXT NOT NULL, provider TEXT NOT NULL, board TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}', default_country TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  last_sync TEXT, last_error TEXT NOT NULL DEFAULT '', job_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE (provider, board)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES job_companies(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '', employment_type TEXT NOT NULL DEFAULT '', posted_at TEXT, url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  UNIQUE (company_id, external_id)
);
CREATE TABLE IF NOT EXISTS job_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS career_job_scores (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, resume_key TEXT NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, score INTEGER NOT NULL, bucket TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '', gap TEXT NOT NULL DEFAULT '', scored_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, resume_key, job_id)
);
CREATE TABLE IF NOT EXISTS career_job_searches (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  params_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', progress TEXT NOT NULL DEFAULT '',
  result_json TEXT, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_career_job_searches ON career_job_searches(customer_id);
CREATE TABLE IF NOT EXISTS career_activity (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_career_activity ON career_activity(customer_id, id);
CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs(active, company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at);
CREATE INDEX IF NOT EXISTS idx_career_versions ON career_versions(customer_id);
CREATE INDEX IF NOT EXISTS idx_career_matches ON career_matches(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_started ON conversations(started_at);
CREATE INDEX IF NOT EXISTS idx_conversations_licence ON conversations(licence_id);
CREATE INDEX IF NOT EXISTS idx_conversation_items ON conversation_items(conversation_id);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
CREATE INDEX IF NOT EXISTS idx_visits_visitor ON visits(visitor);
CREATE INDEX IF NOT EXISTS idx_opps_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opps_email ON opportunities(email);
CREATE INDEX IF NOT EXISTS idx_opp_notes ON opportunity_notes(opportunity_id);
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
  addColumn(db, 'job_companies', 'last_used', 'TEXT');   // AI Job search: boards nobody searched lately are dropped
  return db;
}

/** Add a column to a table made by an older version (CREATE TABLE IF NOT EXISTS keeps the old shape). */
function addColumn(db, table, column, type) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Run several statements as one all-or-nothing step. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; }
}

const now = () => new Date().toISOString();

module.exports = { open, transaction, now };
