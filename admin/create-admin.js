#!/usr/bin/env node
'use strict';
// Creates (or resets) an admin account from the command line. The password is generated and shown once,
// never typed on the command line, so it does not end up in shell history.
//   npm run admin:create -- you@example.com [owner|admin|support] ["Your Name"]
//   npm run admin:create -- you@example.com --reset      (new password for an existing account)

const crypto = require('crypto');
const path = require('path');
const { open, now } = require('./lib/db');
const { hashPassword } = require('./lib/auth');

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const [mail, roleArg, name = ''] = args.filter(a => a !== '--reset');
if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
  console.error('Usage: npm run admin:create -- you@example.com [owner|admin|support] ["Your Name"] [--reset]');
  process.exit(2);
}
const role = ['owner', 'admin', 'support'].includes(roleArg) ? roleArg : 'owner';
const dataDir = process.env.ADMIN_DATA_DIR || path.join(__dirname, 'data');
const db = open(path.join(dataDir, 'admin.db'));

const password = crypto.randomBytes(12).toString('base64url'); // 16 characters
const email = mail.toLowerCase();
const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);

if (existing && !reset) {
  console.error(`${email} already exists. Add --reset to give it a new password.`);
  process.exit(1);
}
if (existing) {
  db.prepare('UPDATE admins SET pass_hash = ?, disabled = 0 WHERE id = ?').run(hashPassword(password), existing.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(existing.id);
} else {
  db.prepare('INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,?)').run(email, name, role, hashPassword(password), now());
}
db.prepare('INSERT INTO audit (at, admin_email, action, target, detail) VALUES (?,?,?,?,?)').run(now(), 'system', existing ? 'admin.password.reset' : 'admin.created', email, role);

console.log(`\n${existing ? 'Password reset for' : 'Created'} ${email} (${role}).`);
console.log(`Password (shown only now, change it after signing in):  ${password}\n`);
