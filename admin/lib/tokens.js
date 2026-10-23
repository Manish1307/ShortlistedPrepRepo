'use strict';
// AI tokens for website customers (Career toolkit, AI Job search, Prepare for this job, reading PDFs).
// Every AI call records the tokens it really used (the AI services report them; estimated from the text when not).
// Each customer has a daily allowance (the admin's default, or a bigger one granted for some days) plus bonus tokens
// that are spent once the day's allowance is used up. Customers can ask for more tokens (a pack the admin defined,
// or a custom amount); the admin approves or rejects each request on the dashboard (AI tokens page).
// The day changes at midnight India time.

const { ApiError, text } = require('./http');
const { now, transaction } = require('./db');
const { signedInCustomer } = require('./accounts');
const { logActivity } = require('./activity');

const DEFAULT_DAILY = 100000;
const DEFAULT_WARN = 80;            // per cent of the day's allowance: warn the customer from here
const MAX_PENDING = 3;

/** Today's date in India (yyyy-mm-dd): the token day. */
const tokenDay = (ms = Date.now()) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
const setting = (db, key, fallback) => {
  const row = db.prepare('SELECT value FROM job_settings WHERE key = ?').get(key);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const settings = db => ({ dailyDefault: setting(db, 'token_daily_default', DEFAULT_DAILY), warnPct: setting(db, 'token_warn_pct', DEFAULT_WARN) });

function account(db, customerId) {
  return db.prepare('SELECT * FROM token_accounts WHERE customer_id = ?').get(customerId) || { customer_id: customerId, daily_quota: null, daily_until: null, bonus: 0 };
}
/** The customer's active plan (Pricing), or null. */
function planOf(db, customerId) {
  try {
    const p = db.prepare("SELECT plan_name, limits_json, ends_at FROM customer_plans WHERE customer_id = ? AND status = 'active' AND ends_at > ? ORDER BY ends_at DESC LIMIT 1").get(customerId, now());
    if (!p) return null;
    const limits = JSON.parse(p.limits_json || '{}');
    return { name: p.plan_name, endsAt: p.ends_at, dailyTokens: Number(limits.dailyTokens) > 0 ? Number(limits.dailyTokens) : null };
  } catch (_) { return null; }
}
/** The day's allowance: a bigger allowance the admin gave > the active plan's > the admin's default. */
function dailyFor(db, acc, day = tokenDay()) {
  if (acc.daily_quota != null && (!acc.daily_until || acc.daily_until >= day)) return acc.daily_quota;
  const plan = planOf(db, acc.customer_id);
  return plan && plan.dailyTokens ? plan.dailyTokens : settings(db).dailyDefault;
}
const usedOn = (db, customerId, day) => (db.prepare('SELECT tokens FROM token_usage WHERE customer_id = ? AND day = ?').get(customerId, day) || { tokens: 0 }).tokens;

/** {used, daily, bonus, left, pct, warnPct, level: ok|warn|out, day, dailyUntil} for one customer today. */
function status(db, customerId) {
  const day = tokenDay(), acc = account(db, customerId);
  const daily = dailyFor(db, acc, day), used = usedOn(db, customerId, day), bonus = Math.max(0, acc.bonus || 0);
  const left = Math.max(0, daily - used) + bonus;
  const pct = daily ? Math.min(100, Math.round((used / daily) * 100)) : 100;
  const { warnPct } = settings(db);
  const plan = planOf(db, customerId);
  return { day, used, daily, bonus, left, pct, warnPct, level: left <= 0 ? 'out' : (pct >= warnPct && bonus === 0) ? 'warn' : 'ok',
    plan: plan ? { name: plan.name, endsAt: plan.endsAt } : null,
    dailyUntil: acc.daily_quota != null && acc.daily_until && acc.daily_until >= day ? acc.daily_until : null };
}

/** Before an AI call: stop when the customer has no tokens left today. */
function check(db, customerId) {
  if (status(db, customerId).left <= 0) {
    throw new ApiError(429, "You have used today's AI tokens. Ask for more tokens (bottom of the page), or come back tomorrow.", 'tokens');
  }
}

/** After an AI call: add the tokens to today; what goes past the day's allowance comes out of the bonus. */
function record(db, customerId, tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (!n) return;
  const day = tokenDay(), acc = account(db, customerId), daily = dailyFor(db, acc, day);
  const before = usedOn(db, customerId, day);
  const overflow = Math.max(0, before + n - daily) - Math.max(0, before - daily);
  transaction(db, () => {
    db.prepare(`INSERT INTO token_usage (customer_id, day, tokens, calls) VALUES (?,?,?,1)
                ON CONFLICT (customer_id, day) DO UPDATE SET tokens = tokens + excluded.tokens, calls = calls + 1`).run(customerId, day, n);
    if (overflow > 0 && acc.bonus > 0) db.prepare('UPDATE token_accounts SET bonus = MAX(0, bonus - ?), updated_at = ? WHERE customer_id = ?').run(overflow, now(), customerId);
  });
}

/** A meter for completeJson / readPdf: (tokens) => record them for this customer. */
const meter = (db, customerId) => tokens => { try { record(db, customerId, tokens); } catch (_) { /* never fail the answer */ } };

function ensureAccount(db, customerId) {
  db.prepare('INSERT OR IGNORE INTO token_accounts (customer_id, bonus, updated_at) VALUES (?, 0, ?)').run(customerId, now());
}
/** Give tokens: kind "topup" adds bonus tokens; kind "daily" sets a bigger daily allowance for some days. */
function grant(db, customerId, { kind, tokens, days }) {
  ensureAccount(db, customerId);
  if (kind === 'daily') {
    const until = days > 0 ? tokenDay(Date.now() + (days - 1) * 86400000) : null;
    db.prepare('UPDATE token_accounts SET daily_quota = ?, daily_until = ?, updated_at = ? WHERE customer_id = ?').run(tokens, until, now(), customerId);
  } else {
    db.prepare('UPDATE token_accounts SET bonus = bonus + ?, updated_at = ? WHERE customer_id = ?').run(tokens, now(), customerId);
  }
}

const KINDS = ['topup', 'daily'];
const int = (v, field, { min = 0, max = 1e9 } = {}) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, `${field} must be a number from ${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}`);
  return n;
};
const presentPack = p => ({ id: p.id, name: p.name, kind: p.kind, tokens: p.tokens, days: p.days, price: p.price, currency: p.currency, description: p.description, active: !!p.active });
const presentClaim = c => ({ id: c.id, packId: c.pack_id, packName: c.pack_name, kind: c.kind, tokens: c.tokens, days: c.days, price: c.price, currency: c.currency,
  message: c.message, status: c.status, adminNote: c.admin_note, decidedBy: c.decided_by, decidedAt: c.decided_at, createdAt: c.created_at,
  ...(c.email ? { customer: { id: c.customer_id, email: c.email, name: c.name } } : {}) });

function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;
  const me = req => signedInCustomer(db, req).customer;
  const packs = (activeOnly) => all(`SELECT * FROM token_packs ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, price, id`).map(presentPack);

  // ===================== website =====================
  add('GET', '/api/account/tokens', { public: true }, req => {
    const c = me(req);
    return { tokens: status(db, c.id), packs: packs(true),
      claims: all('SELECT * FROM token_claims WHERE customer_id = ? ORDER BY id DESC LIMIT 10', c.id).map(presentClaim) };
  });

  add('POST', '/api/account/tokens/claim', { public: true }, (req, res, { body }) => {
    const c = me(req);
    if (one("SELECT COUNT(*) AS n FROM token_claims WHERE customer_id = ? AND status = 'pending'", c.id).n >= MAX_PENDING) {
      throw new ApiError(400, `You already have ${MAX_PENDING} requests waiting. We will answer them soon.`);
    }
    const message = text(body.message, 1000, { field: 'Message' });
    let pack = null, kind = 'topup', tokens, days = 0, price = 0, currency = 'INR';
    if (body.packId) {
      pack = one('SELECT * FROM token_packs WHERE id = ? AND active = 1', Number(body.packId));
      if (!pack) throw new ApiError(404, 'That token pack is no longer offered');
      ({ kind, tokens, days, price, currency } = pack);
    } else {
      tokens = int(body.tokens, 'Tokens', { min: 10000, max: 10000000 });
      if (!message) throw new ApiError(400, 'Tell us briefly what you need the tokens for');
    }
    const id = Number(db.prepare(`INSERT INTO token_claims (customer_id, pack_id, pack_name, kind, tokens, days, price, currency, message, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`).run(c.id, pack ? pack.id : null, pack ? pack.name : 'Custom request', kind, tokens, days || 0, price || 0, currency, message, now()).lastInsertRowid);
    logActivity(db, c.id, 'tokens.claimed', `${pack ? pack.name : 'Custom request'} · ${tokens.toLocaleString('en-IN')} tokens`);
    return { status: 201, body: { claim: presentClaim(one('SELECT * FROM token_claims WHERE id = ?', id)) } };
  });

  // ===================== dashboard =====================
  add('GET', '/admin/api/tokens', { admin: true }, () => {
    const day = tokenDay(), week = tokenDay(Date.now() - 6 * 86400000);
    const s = settings(db);
    return {
      settings: s, day,
      packs: packs(false),
      claims: all(`SELECT k.*, c.email, c.name FROM token_claims k JOIN customers c ON c.id = k.customer_id
                   ORDER BY k.status = 'pending' DESC, k.id DESC LIMIT 100`).map(presentClaim),
      totals: {
        today: one('SELECT COALESCE(SUM(tokens), 0) AS t, COALESCE(SUM(calls), 0) AS c, COUNT(*) AS n FROM token_usage WHERE day = ?', day),
        week: one('SELECT COALESCE(SUM(tokens), 0) AS t, COALESCE(SUM(calls), 0) AS c FROM token_usage WHERE day >= ?', week),
        pending: one("SELECT COUNT(*) AS n FROM token_claims WHERE status = 'pending'").n,
      },
      customers: all(`SELECT c.id, c.email, c.name, COALESCE(u.tokens, 0) AS today, COALESCE(u.calls, 0) AS calls,
                             (SELECT COALESCE(SUM(tokens), 0) FROM token_usage w WHERE w.customer_id = c.id AND w.day >= ?) AS week
                      FROM customers c LEFT JOIN token_usage u ON u.customer_id = c.id AND u.day = ?
                      WHERE EXISTS (SELECT 1 FROM token_usage x WHERE x.customer_id = c.id) OR EXISTS (SELECT 1 FROM token_accounts a WHERE a.customer_id = c.id)
                      ORDER BY today DESC, week DESC LIMIT 200`, week, day)
        .map(r => ({ id: r.id, email: r.email, name: r.name, today: r.today, calls: r.calls, week: r.week, ...status(db, r.id) })),
    };
  });

  add('POST', '/admin/api/tokens/settings', { admin: true, perm: 'tokens.write' }, (req, res, { body, admin }) => {
    const dailyDefault = int(body.dailyDefault, 'Daily tokens', { min: 0, max: 100000000 });
    const warnPct = int(body.warnPct, 'Warning level', { min: 10, max: 99 });
    const save = db.prepare(`INSERT INTO job_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
                             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
    save.run('token_daily_default', String(dailyDefault), now(), admin.email);
    save.run('token_warn_pct', String(warnPct), now(), admin.email);
    audit(admin, 'tokens.settings', '', `${dailyDefault} a day, warn at ${warnPct}%`);
    return { settings: settings(db) };
  });

  const packValues = body => {
    const kind = KINDS.includes(body.kind) ? body.kind : 'topup';
    return {
      name: text(body.name, 80, { required: true, field: 'Pack name' }), kind,
      tokens: int(body.tokens, 'Tokens', { min: 1000, max: 100000000 }),
      days: kind === 'daily' ? int(body.days, 'Days', { min: 1, max: 366 }) : 0,
      price: int(body.price, 'Price', { min: 0, max: 10000000 }), currency: text(body.currency || 'INR', 8, { field: 'Currency' }).toUpperCase(),
      description: text(body.description, 300, { field: 'Description' }), active: body.active === false ? 0 : 1, sort: int(body.sort || 0, 'Order', { min: 0, max: 1000 }),
    };
  };
  add('POST', '/admin/api/tokens/packs', { admin: true, perm: 'tokens.write' }, (req, res, { body, admin }) => {
    const v = packValues(body);
    if (body.id) {
      const r = db.prepare('UPDATE token_packs SET name = ?, kind = ?, tokens = ?, days = ?, price = ?, currency = ?, description = ?, active = ?, sort = ? WHERE id = ?')
        .run(v.name, v.kind, v.tokens, v.days, v.price, v.currency, v.description, v.active, v.sort, Number(body.id));
      if (!r.changes) throw new ApiError(404, 'Pack not found');
    } else {
      db.prepare('INSERT INTO token_packs (name, kind, tokens, days, price, currency, description, active, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(v.name, v.kind, v.tokens, v.days, v.price, v.currency, v.description, v.active, v.sort, now());
    }
    audit(admin, body.id ? 'tokens.pack.updated' : 'tokens.pack.added', v.name, `${v.tokens} tokens, ${v.currency} ${v.price}`);
    return { packs: packs(false) };
  });

  add('DELETE', '/admin/api/tokens/packs/:id', { admin: true, perm: 'tokens.write' }, (req, res, { params, admin }) => {
    const p = one('SELECT * FROM token_packs WHERE id = ?', params.id);
    if (!p) throw new ApiError(404, 'Pack not found');
    db.prepare('DELETE FROM token_packs WHERE id = ?').run(p.id);
    audit(admin, 'tokens.pack.deleted', p.name);
    return { packs: packs(false) };
  });

  add('POST', '/admin/api/tokens/claims/:id', { admin: true, perm: 'tokens.write' }, (req, res, { params, body, admin }) => {
    const k = one('SELECT * FROM token_claims WHERE id = ?', params.id);
    if (!k) throw new ApiError(404, 'Request not found');
    if (k.status !== 'pending') throw new ApiError(409, 'This request was already answered');
    const note = text(body.note, 500, { field: 'Note' });
    if (body.action === 'approve') {
      const kind = KINDS.includes(body.kind) ? body.kind : k.kind;
      const tokens = int(body.tokens == null ? k.tokens : body.tokens, 'Tokens', { min: 1000, max: 100000000 });
      const days = kind === 'daily' ? int(body.days == null ? (k.days || 30) : body.days, 'Days', { min: 1, max: 366 }) : 0;
      const price = int(body.price == null ? k.price : body.price, 'Price', { min: 0, max: 10000000 });
      transaction(db, () => {
        grant(db, k.customer_id, { kind, tokens, days });
        db.prepare("UPDATE token_claims SET status = 'approved', kind = ?, tokens = ?, days = ?, price = ?, admin_note = ?, decided_by = ?, decided_at = ? WHERE id = ?")
          .run(kind, tokens, days, price, note, admin.email, now(), k.id);
      });
      logActivity(db, k.customer_id, 'tokens.granted', `${tokens.toLocaleString('en-IN')} tokens${kind === 'daily' ? ` a day for ${days} days` : ''} (request approved)`);
    } else if (body.action === 'reject') {
      db.prepare("UPDATE token_claims SET status = 'rejected', admin_note = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(note, admin.email, now(), k.id);
    } else throw new ApiError(400, 'Unknown action');
    const c = one('SELECT email FROM customers WHERE id = ?', k.customer_id);
    audit(admin, `tokens.claim.${body.action}d`, c ? c.email : String(k.customer_id), note);
    return { claim: presentClaim(one('SELECT k.*, c.email, c.name FROM token_claims k JOIN customers c ON c.id = k.customer_id WHERE k.id = ?', k.id)) };
  });

  // a direct grant from the dashboard (no request needed), or back to the default daily allowance
  add('POST', '/admin/api/tokens/customers/:id', { admin: true, perm: 'tokens.write' }, (req, res, { params, body, admin }) => {
    const c = one('SELECT id, email FROM customers WHERE id = ?', params.id);
    if (!c) throw new ApiError(404, 'Customer not found');
    if (body.action === 'reset-daily') {
      ensureAccount(db, c.id);
      db.prepare('UPDATE token_accounts SET daily_quota = NULL, daily_until = NULL, updated_at = ? WHERE customer_id = ?').run(now(), c.id);
    } else {
      const kind = KINDS.includes(body.kind) ? body.kind : 'topup';
      const tokens = int(body.tokens, 'Tokens', { min: 1000, max: 100000000 });
      grant(db, c.id, { kind, tokens, days: kind === 'daily' ? int(body.days, 'Days', { min: 1, max: 366 }) : 0 });
      logActivity(db, c.id, 'tokens.granted', `${tokens.toLocaleString('en-IN')} tokens${kind === 'daily' ? ' a day' : ''} (from the team)`);
    }
    audit(admin, 'tokens.granted', c.email, JSON.stringify(body).slice(0, 200));
    return { tokens: status(db, c.id) };
  });
}

module.exports = { addRoutes, status, check, record, meter, grant, tokenDay, settings, DEFAULT_DAILY };
