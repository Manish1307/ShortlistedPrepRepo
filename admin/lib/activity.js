'use strict';
// What each candidate does on the website (sign-ins, resume, ATS check, role resumes, job matches, job searches,
// downloads), for the dashboard's Candidates page. Logging never gets in the way of the action itself.

const { now } = require('./db');

const KEEP = 500;   // newest entries kept per candidate

function logActivity(db, customerId, action, detail = '') {
  try {
    db.prepare('INSERT INTO career_activity (customer_id, at, action, detail) VALUES (?,?,?,?)').run(customerId, now(), action, String(detail || '').slice(0, 300));
    if (Math.random() < 0.05) {
      db.prepare(`DELETE FROM career_activity WHERE customer_id = ? AND id NOT IN (SELECT id FROM career_activity WHERE customer_id = ? ORDER BY id DESC LIMIT ${KEEP})`).run(customerId, customerId);
    }
  } catch (_) { /* never block the candidate */ }
}

module.exports = { logActivity };
