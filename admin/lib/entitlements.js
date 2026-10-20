'use strict';
// What a candidate's plan (Pricing) allows, and how much of it they have used. One place, so the website's My account page,
// the admin dashboard and the checks on AI actions all agree. A candidate with no paid plan gets the Free plan's limits.

const { ApiError } = require('./http');
const { now } = require('./db');

const DAY = 86400000;
const parse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

const LABELS = { dailyTokens: 'AI tokens a day', jobSearches: 'AI job searches', preps: 'Insight plans', roleResumes: 'Role-based resumes', liveSessions: 'Live interview sessions' };
// the limits counted here (dailyTokens is enforced by tokens.js; liveSessions by the desktop app's licence)
const COUNTED = ['jobSearches', 'preps', 'roleResumes'];

/** The plan row the candidate is on now: an active paid/granted plan, else the Free plan from the plans master. */
function planOf(db, customerId) {
  const p = db.prepare("SELECT * FROM customer_plans WHERE customer_id = ? AND status = 'active' AND ends_at > ? ORDER BY ends_at DESC LIMIT 1").get(customerId, now());
  if (p) return { code: p.plan_code, name: p.plan_name, limits: parse(p.limits_json, {}), startsAt: p.starts_at, endsAt: p.ends_at, free: false };
  const f = db.prepare("SELECT * FROM pricing_plans WHERE code = 'free' AND archived = 0").get();
  return { code: 'free', name: f ? f.name : 'Free', limits: f ? parse(f.limits_json, {}) : {}, startsAt: null, endsAt: null, free: true };
}

/** How much was used in the plan's period (a paid plan: since it started; Free: the last 30 days). Role resumes are the number kept. */
function usageOf(db, customerId, plan) {
  const since = plan.startsAt || new Date(Date.now() - 30 * DAY).toISOString();
  const n = (sql, ...a) => db.prepare(sql).get(customerId, ...a).n;
  const sessions = db.prepare(`SELECT COUNT(*) AS n FROM conversations v JOIN licences l ON l.id = v.licence_id WHERE l.customer_id = ? AND v.created_at >= ?`).get(customerId, since).n;
  return {
    jobSearches: n("SELECT COUNT(*) AS n FROM career_job_searches WHERE customer_id = ? AND status != 'failed' AND created_at >= ?", since),
    preps: n('SELECT COUNT(*) AS n FROM career_job_preps WHERE customer_id = ? AND created_at >= ?', since),
    roleResumes: n('SELECT COUNT(*) AS n FROM career_versions WHERE customer_id = ?'),
    liveSessions: sessions,
  };
}

/** {plan, limits[], periodStart} where each limit is {key, label, limit (null = no limit set), used, left, pct}. */
function forCustomer(db, customerId) {
  const plan = planOf(db, customerId);
  const used = usageOf(db, customerId, plan);
  const limits = Object.keys(LABELS).filter(k => k !== 'dailyTokens' && (k in plan.limits) && !(k === 'liveSessions' && !Number(plan.limits[k]))).map(k => {
    const limit = Number(plan.limits[k]);
    const u = used[k] || 0;
    return { key: k, label: LABELS[k], limit: Number.isFinite(limit) ? limit : null, used: u, left: Number.isFinite(limit) ? Math.max(0, limit - u) : null,
      pct: limit > 0 ? Math.min(100, Math.round((u / limit) * 100)) : (limit === 0 ? 100 : 0) };
  });
  return { plan: { code: plan.code, name: plan.name, free: plan.free, startsAt: plan.startsAt, endsAt: plan.endsAt, dailyTokens: Number(plan.limits.dailyTokens) || null }, limits };
}

/** Stop an action that is past the plan's limit, with a message that says what to do. */
function check(db, customerId, key) {
  if (!COUNTED.includes(key)) return;
  const plan = planOf(db, customerId);
  if (!(key in plan.limits)) return;
  const limit = Number(plan.limits[key]);
  if (!Number.isFinite(limit)) return;
  const used = usageOf(db, customerId, plan)[key];
  if (used >= limit) {
    const when = plan.free ? 'in the last 30 days' : 'in your plan period';
    throw new ApiError(402, `Your ${plan.name} plan includes ${limit} ${LABELS[key].toLowerCase()} ${key === 'roleResumes' ? '' : when}`.trim() + `. You have used ${used}. Upgrade your plan at pricing.html to continue.`, 'plan-limit');
  }
}

module.exports = { forCustomer, check, planOf, LABELS };
