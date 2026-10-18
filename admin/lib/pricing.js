'use strict';
// Pricing: the plans master (every plan, with its price in INR, length, features and limits), which plans are active
// (shown on the website's pricing page, in the admin's order), price history, payment settings, and plan orders.
//
// Payments: until an online gateway is connected, customers pay by UPI or bank transfer, enter the payment reference,
// and the admin confirms the payment, which starts the plan. The gateway (Razorpay, Cashfree, PayU, PhonePe, Stripe),
// test/live mode, keys and payment methods are already settings; payments.js is where a gateway is plugged in later.
// Amounts are kept in paise (₹1 = 100 paise), as payment gateways expect.

const { ApiError, text } = require('./http');
const { now, transaction } = require('./db');
const { signedInCustomer } = require('./accounts');
const { logActivity } = require('./activity');
const payments = require('./payments');

const DAY = 86400000;
const parse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };
const rupeesToPaise = (v, field) => {
  const n = Number(String(v == null ? '' : v).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new ApiError(400, `${field} must be an amount in rupees from 0 to 1,00,00,000`);
  return Math.round(n * 100);
};
const int = (v, field, min, max) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, `${field} must be a number from ${min} to ${max}`);
  return n;
};
const LIMIT_KEYS = ['dailyTokens', 'jobSearches', 'preps', 'roleResumes', 'liveSessions'];   // per plan; dailyTokens is enforced (tokens.js)

const DEFAULT_PLANS = [
  { code: 'free', name: 'Free', tagline: 'Try ShortlistPrep', price: 0, mrp: 0, days: 30, active: 1, featured: 0, sort: 10, cta: 'Start free',
    features: ['1 ATS check and improved resume', '1 role-based resume', '2 AI job searches a month', 'Skill Gap Matrix on every job', '1 Prepare plan'],
    limits: { dailyTokens: 30000, jobSearches: 2, preps: 1, roleResumes: 1, liveSessions: 0 } },
  { code: 'shortlist-30', name: 'Shortlist Pass', tagline: 'Get more interview calls', price: 299, mrp: 0, days: 30, active: 1, featured: 0, sort: 20, cta: 'Get Shortlist Pass',
    features: ['Unlimited ATS checks and rewrites (fair use)', 'Up to 8 role-based resumes', 'Cover letters for every job', 'About 30 AI job searches', 'About 30 Prepare plans', 'Naukri and LinkedIn search links'],
    limits: { dailyTokens: 100000, jobSearches: 30, preps: 30, roleResumes: 8, liveSessions: 0 } },
  { code: 'interview-30', name: 'Interview Pass', tagline: 'For candidates with interviews coming', price: 599, mrp: 799, days: 30, active: 1, featured: 1, sort: 30, badge: 'Most popular', cta: 'Get Interview Pass',
    features: ['Everything in Shortlist Pass', 'Interview coaching (mock interviews)', 'Question bank and model answers', 'Introduction builder', 'Bigger daily AI allowance'],
    limits: { dailyTokens: 150000, jobSearches: 60, preps: 60, roleResumes: 8, liveSessions: 0 } },
  { code: 'offer-30', name: 'Offer Pass', tagline: 'For final rounds', price: 1199, mrp: 1499, days: 30, active: 0, featured: 0, sort: 40, cta: 'Get Offer Pass',
    features: ['Everything in Interview Pass', 'Live interview support in the desktop app (10 sessions)', 'Priority support'],
    limits: { dailyTokens: 250000, jobSearches: 100, preps: 100, roleResumes: 8, liveSessions: 10 } },
  { code: 'jobhunt-90', name: 'Job Hunt Pass (90 days)', tagline: 'Interview Pass for 3 months', price: 1499, mrp: 1797, days: 90, active: 0, featured: 0, sort: 50, cta: 'Get 90-day pass',
    features: ['Everything in Interview Pass, for 90 days', 'Save about 17%'],
    limits: { dailyTokens: 150000, jobSearches: 180, preps: 180, roleResumes: 8, liveSessions: 0 } },
];

function seedPlans(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM pricing_plans').get().n) return;
  const add = db.prepare(`INSERT INTO pricing_plans (code, name, tagline, description, price_paise, mrp_paise, duration_days, billing, features_json, limits_json, badge, cta, active, featured, sort, created_at, updated_at, updated_by)
    VALUES (?,?,?,'',?,?,?,'one_time',?,?,?,?,?,?,?,?,?,'setup')`);
  for (const p of DEFAULT_PLANS) add.run(p.code, p.name, p.tagline, p.price * 100, p.mrp * 100, p.days, JSON.stringify(p.features), JSON.stringify(p.limits), p.badge || '', p.cta, p.active, p.featured, p.sort, now(), now());
}

const presentPlan = p => ({
  id: p.id, code: p.code, name: p.name, tagline: p.tagline, description: p.description, price: p.price_paise / 100, mrp: p.mrp_paise / 100,
  durationDays: p.duration_days, billing: p.billing, features: parse(p.features_json, []), limits: parse(p.limits_json, {}), badge: p.badge, cta: p.cta,
  active: !!p.active, featured: !!p.featured, sort: p.sort, archived: !!p.archived, updatedAt: p.updated_at, updatedBy: p.updated_by,
});
/** What the website shows for a plan (no internal fields). */
const publicPlan = p => { const x = presentPlan(p); return { id: x.id, code: x.code, name: x.name, tagline: x.tagline, description: x.description, price: x.price, mrp: x.mrp,
  durationDays: x.durationDays, billing: x.billing, features: x.features, badge: x.badge, cta: x.cta, featured: x.featured, dailyTokens: x.limits.dailyTokens || null }; };

/** GST split of a price: prices are shown including GST by default. */
function gstSplit(amountPaise, cfg) {
  const rate = Number(cfg.gstRate) || 0;
  if (!rate) return { total: amountPaise, base: amountPaise, gst: 0, rate };
  if (cfg.pricesIncludeGst !== false) { const base = Math.round(amountPaise / (1 + rate / 100)); return { total: amountPaise, base, gst: amountPaise - base, rate }; }
  const gst = Math.round(amountPaise * rate / 100);
  return { total: amountPaise + gst, base: amountPaise, gst, rate };
}

const presentOrder = o => ({
  id: o.id, number: o.number, planId: o.plan_id, planName: o.plan_name, planCode: o.plan_code, amount: o.amount_paise / 100, base: o.base_paise / 100, gst: o.gst_paise / 100,
  gstRate: o.gst_rate, currency: o.currency, status: o.status, paymentMode: o.payment_mode, gateway: o.gateway, gatewayOrderId: o.gateway_order_id,
  gatewayPaymentId: o.gateway_payment_id, reference: o.reference, note: o.note, createdAt: o.created_at, paidAt: o.paid_at, startsAt: o.starts_at, endsAt: o.ends_at,
  decidedBy: o.decided_by, ...(o.email ? { customer: { id: o.customer_id, email: o.email, name: o.name } } : {}),
});

/** The customer's plan right now (an active, unexpired row), or null. */
function activePlan(db, customerId) {
  const p = db.prepare("SELECT * FROM customer_plans WHERE customer_id = ? AND status = 'active' AND ends_at > ? ORDER BY ends_at DESC LIMIT 1").get(customerId, now());
  return p ? { id: p.id, planId: p.plan_id, code: p.plan_code, name: p.plan_name, limits: parse(p.limits_json, {}), startsAt: p.starts_at, endsAt: p.ends_at, orderId: p.order_id } : null;
}

/** Start (or extend) a plan for a customer: the same plan extends from its end date; another plan replaces it from now. */
function activate(db, customerId, plan, orderId) {
  const cur = activePlan(db, customerId);
  const sameAsCurrent = cur && cur.planId === plan.id;
  const start = sameAsCurrent ? cur.endsAt : now();
  const end = new Date(Date.parse(start) + plan.durationDays * DAY).toISOString();
  transaction(db, () => {
    if (cur && !sameAsCurrent) db.prepare("UPDATE customer_plans SET status = 'replaced' WHERE id = ?").run(cur.id);
    if (sameAsCurrent) db.prepare('UPDATE customer_plans SET ends_at = ?, order_id = ? WHERE id = ?').run(end, orderId, cur.id);
    else db.prepare(`INSERT INTO customer_plans (customer_id, plan_id, order_id, plan_code, plan_name, limits_json, starts_at, ends_at, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?)`)
      .run(customerId, plan.id, orderId, plan.code, plan.name, JSON.stringify(plan.limits || {}), start, end, now());
  });
  return { startsAt: sameAsCurrent ? cur.startsAt : start, endsAt: end };
}

function addRoutes(ctx) {
  const { db, add, audit, one, all, vault } = ctx;
  seedPlans(db);
  const me = req => signedInCustomer(db, req).customer;
  const planRow = id => one('SELECT * FROM pricing_plans WHERE id = ?', id);
  const config = () => payments.config(db);
  const activePlans = () => all('SELECT * FROM pricing_plans WHERE active = 1 AND archived = 0 ORDER BY sort, price_paise, id');

  // ===================== website =====================
  add('GET', '/api/pricing', { public: true }, () => {
    const cfg = config();
    return { currency: 'INR', plans: activePlans().map(publicPlan), gst: { rate: cfg.gstRate, included: cfg.pricesIncludeGst !== false },
      payment: { provider: cfg.provider, methods: payments.enabledMethods(cfg), online: payments.isOnline(cfg) } };
  });

  add('GET', '/api/account/plan', { public: true }, req => {
    const c = me(req);
    return { plan: activePlan(db, c.id), orders: all('SELECT * FROM plan_orders WHERE customer_id = ? ORDER BY id DESC LIMIT 10', c.id).map(presentOrder) };
  });

  // start buying a plan: an order, and how to pay for it (UPI / bank transfer now; an online gateway later)
  add('POST', '/api/account/plans/checkout', { public: true }, async (req, res, { body }) => {
    const c = me(req);
    const row = planRow(Number(body.planId));
    if (!row || !row.active || row.archived) throw new ApiError(404, 'That plan is not offered any more. Please refresh the page.');
    const plan = presentPlan(row);
    if (!plan.price) {
      const dates = activate(db, c.id, plan, null);
      logActivity(db, c.id, 'plan.started', `${plan.name} (free) until ${dates.endsAt.slice(0, 10)}`);
      return { status: 201, body: { free: true, plan: activePlan(db, c.id) } };
    }
    if (one("SELECT COUNT(*) AS n FROM plan_orders WHERE customer_id = ? AND status IN ('created','pending') AND created_at > ?", c.id, new Date(Date.now() - DAY).toISOString()).n >= 5) {
      throw new ApiError(429, 'You have several unpaid orders. Please finish or cancel one first.');
    }
    const cfg = config();
    const split = gstSplit(row.price_paise, cfg);
    const id = Number(db.prepare(`INSERT INTO plan_orders (customer_id, plan_id, plan_code, plan_name, snapshot_json, amount_paise, base_paise, gst_paise, gst_rate, currency, status, gateway, payment_mode, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'INR', 'created', ?, '', ?, ?)`).run(c.id, plan.id, plan.code, plan.name, JSON.stringify(plan), split.total, split.base, split.gst, split.rate, cfg.provider, now(), now()).lastInsertRowid);
    const number = `${cfg.invoicePrefix || 'SP'}-${String(id).padStart(6, '0')}`;
    db.prepare('UPDATE plan_orders SET number = ? WHERE id = ?').run(number, id);
    const order = one('SELECT * FROM plan_orders WHERE id = ?', id);
    const payment = await payments.startPayment({ db, vault, cfg, order, customer: c });
    if (payment.gatewayOrderId) db.prepare('UPDATE plan_orders SET gateway_order_id = ? WHERE id = ?').run(payment.gatewayOrderId, id);
    logActivity(db, c.id, 'plan.order', `${plan.name} · ₹${(split.total / 100).toLocaleString('en-IN')} · ${number}`);
    return { status: 201, body: { order: presentOrder(one('SELECT * FROM plan_orders WHERE id = ?', id)), payment } };
  });

  const myOrder = (id, customerId) => { const o = one('SELECT * FROM plan_orders WHERE id = ? AND customer_id = ?', id, customerId); if (!o) throw new ApiError(404, 'Order not found'); return o; };

  // the customer paid by UPI / bank transfer and gives the reference (UTR); the admin then confirms it
  add('POST', '/api/account/orders/:id/paid', { public: true }, (req, res, { params, body }) => {
    const c = me(req);
    const o = myOrder(params.id, c.id);
    if (!['created', 'pending'].includes(o.status)) throw new ApiError(409, 'This order is already closed');
    const reference = text(body.reference, 80, { required: true, field: 'Payment reference (UTR / transaction ID)' });
    const method = payments.METHODS.includes(body.method) ? body.method : 'upi';
    db.prepare("UPDATE plan_orders SET status = 'pending', reference = ?, payment_mode = ?, updated_at = ? WHERE id = ?").run(reference, method, now(), o.id);
    logActivity(db, c.id, 'plan.paid_reported', `${o.number} · ${method.toUpperCase()} ${reference}`);
    return { order: presentOrder(one('SELECT * FROM plan_orders WHERE id = ?', o.id)) };
  });

  add('POST', '/api/account/orders/:id/cancel', { public: true }, (req, res, { params }) => {
    const c = me(req);
    const o = myOrder(params.id, c.id);
    if (o.status !== 'created') throw new ApiError(409, 'Only an unpaid order can be cancelled');
    db.prepare("UPDATE plan_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), o.id);
    return { order: presentOrder(one('SELECT * FROM plan_orders WHERE id = ?', o.id)) };
  });

  // a gateway's server-to-server notice (wired when a gateway is connected; see payments.js)
  add('POST', '/api/payments/webhook/:provider', { public: true }, (req, res, { params, body }) => payments.webhook({ db, vault, cfg: config(), provider: params.provider, body, req }));

  // ===================== dashboard =====================
  add('GET', '/admin/api/pricing', { admin: true }, () => {
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
    return {
      plans: all('SELECT * FROM pricing_plans ORDER BY archived, sort, price_paise, id').map(presentPlan),
      history: all(`SELECT h.*, p.name FROM pricing_price_history h JOIN pricing_plans p ON p.id = h.plan_id ORDER BY h.id DESC LIMIT 50`)
        .map(h => ({ planName: h.name, oldPrice: h.old_paise / 100, newPrice: h.new_paise / 100, oldMrp: h.old_mrp_paise / 100, newMrp: h.new_mrp_paise / 100, by: h.changed_by, at: h.changed_at })),
      config: payments.presentConfig(config(), db),
      gateways: payments.GATEWAYS, methods: payments.METHODS,
      orders: all(`SELECT o.*, c.email, c.name FROM plan_orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.status = 'pending' DESC, o.id DESC LIMIT 100`).map(presentOrder),
      stats: {
        activePlans: one('SELECT COUNT(*) AS n FROM pricing_plans WHERE active = 1 AND archived = 0').n,
        pending: one("SELECT COUNT(*) AS n FROM plan_orders WHERE status = 'pending'").n,
        paidMonth: one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS t FROM plan_orders WHERE status = 'paid' AND paid_at >= ?", month.toISOString()),
        subscribers: one("SELECT COUNT(DISTINCT customer_id) AS n FROM customer_plans WHERE status = 'active' AND ends_at > ?", now()).n,
      },
    };
  });

  const planValues = body => {
    const limits = {};
    for (const k of LIMIT_KEYS) if (body.limits && body.limits[k] !== '' && body.limits[k] != null) limits[k] = int(body.limits[k], k, 0, 100000000);
    const features = (Array.isArray(body.features) ? body.features : String(body.features || '').split('\n')).map(f => String(f).trim()).filter(Boolean).slice(0, 15);
    if (features.some(f => f.length > 140)) throw new ApiError(400, 'Each feature line can be at most 140 characters');
    const code = String(body.code || body.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!code) throw new ApiError(400, 'Plan code is required');
    return {
      code, name: text(body.name, 60, { required: true, field: 'Plan name' }), tagline: text(body.tagline, 120, { field: 'Tagline' }),
      description: text(body.description, 500, { field: 'Description' }), price: rupeesToPaise(body.price, 'Price'), mrp: rupeesToPaise(body.mrp || 0, 'Strike-through price'),
      days: int(body.durationDays, 'Duration (days)', 1, 3650), billing: body.billing === 'subscription' ? 'subscription' : 'one_time',
      features, limits, badge: text(body.badge, 30, { field: 'Badge' }), cta: text(body.cta, 40, { field: 'Button text' }), sort: int(body.sort || 0, 'Order', 0, 10000),
    };
  };

  add('POST', '/admin/api/pricing/plans', { admin: true, perm: 'pricing.write' }, (req, res, { body, admin }) => {
    const v = planValues(body);
    if (v.mrp && v.mrp <= v.price) throw new ApiError(400, 'The strike-through price must be higher than the price (or 0 for none)');
    const clash = one('SELECT id FROM pricing_plans WHERE code = ?', v.code);
    if (clash && clash.id !== Number(body.id)) throw new ApiError(409, 'Another plan already uses that code');
    if (body.id) {
      const old = planRow(Number(body.id));
      if (!old) throw new ApiError(404, 'Plan not found');
      transaction(db, () => {
        db.prepare(`UPDATE pricing_plans SET code = ?, name = ?, tagline = ?, description = ?, price_paise = ?, mrp_paise = ?, duration_days = ?, billing = ?, features_json = ?, limits_json = ?,
                    badge = ?, cta = ?, sort = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
          .run(v.code, v.name, v.tagline, v.description, v.price, v.mrp, v.days, v.billing, JSON.stringify(v.features), JSON.stringify(v.limits), v.badge, v.cta, v.sort, now(), admin.email, old.id);
        if (old.price_paise !== v.price || old.mrp_paise !== v.mrp) {
          db.prepare('INSERT INTO pricing_price_history (plan_id, old_paise, new_paise, old_mrp_paise, new_mrp_paise, changed_by, changed_at) VALUES (?,?,?,?,?,?,?)')
            .run(old.id, old.price_paise, v.price, old.mrp_paise, v.mrp, admin.email, now());
        }
      });
      audit(admin, 'pricing.plan.updated', v.name, `₹${old.price_paise / 100} → ₹${v.price / 100}`);
    } else {
      db.prepare(`INSERT INTO pricing_plans (code, name, tagline, description, price_paise, mrp_paise, duration_days, billing, features_json, limits_json, badge, cta, active, featured, sort, created_at, updated_at, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)`).run(v.code, v.name, v.tagline, v.description, v.price, v.mrp, v.days, v.billing, JSON.stringify(v.features), JSON.stringify(v.limits), v.badge, v.cta, v.sort, now(), now(), admin.email);
      audit(admin, 'pricing.plan.added', v.name, `₹${v.price / 100}`);
    }
    return { plans: all('SELECT * FROM pricing_plans ORDER BY archived, sort, price_paise, id').map(presentPlan) };
  });

  // active pricing: show / hide on the website, mark as featured, move up or down, archive
  add('POST', '/admin/api/pricing/plans/:id/action', { admin: true, perm: 'pricing.write' }, (req, res, { params, body, admin }) => {
    const p = planRow(params.id);
    if (!p) throw new ApiError(404, 'Plan not found');
    const a = String(body.action || '');
    if (a === 'activate') { if (p.archived) throw new ApiError(409, 'Restore the plan first'); db.prepare('UPDATE pricing_plans SET active = 1 WHERE id = ?').run(p.id); }
    else if (a === 'deactivate') db.prepare('UPDATE pricing_plans SET active = 0 WHERE id = ?').run(p.id);
    else if (a === 'feature') transaction(db, () => { db.prepare('UPDATE pricing_plans SET featured = 0').run(); db.prepare('UPDATE pricing_plans SET featured = 1 WHERE id = ?').run(p.id); });
    else if (a === 'unfeature') db.prepare('UPDATE pricing_plans SET featured = 0 WHERE id = ?').run(p.id);
    else if (a === 'up' || a === 'down') {
      const list = all('SELECT id FROM pricing_plans WHERE archived = 0 ORDER BY sort, price_paise, id').map(r => r.id);
      const i = list.indexOf(p.id), j = a === 'up' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; transaction(db, () => list.forEach((id, n) => db.prepare('UPDATE pricing_plans SET sort = ? WHERE id = ?').run((n + 1) * 10, id))); }
    } else if (a === 'archive') db.prepare('UPDATE pricing_plans SET archived = 1, active = 0, featured = 0 WHERE id = ?').run(p.id);
    else if (a === 'restore') db.prepare('UPDATE pricing_plans SET archived = 0 WHERE id = ?').run(p.id);
    else throw new ApiError(400, 'Unknown action');
    db.prepare('UPDATE pricing_plans SET updated_at = ?, updated_by = ? WHERE id = ?').run(now(), admin.email, p.id);
    audit(admin, `pricing.plan.${a}`, p.name);
    return { plans: all('SELECT * FROM pricing_plans ORDER BY archived, sort, price_paise, id').map(presentPlan) };
  });

  add('POST', '/admin/api/pricing/config', { admin: true, perm: 'pricing.write' }, (req, res, { body, admin }) => {
    const cfg = payments.saveConfig(db, vault, body, admin.email);
    audit(admin, 'pricing.payment.settings', cfg.provider, `${cfg.mode} · ${payments.enabledMethods(cfg).join(', ')}`);
    return { config: payments.presentConfig(cfg, db) };
  });

  // orders: confirm a UPI / bank payment (starts the plan), reject it, cancel, or mark refunded
  add('POST', '/admin/api/pricing/orders/:id', { admin: true, perm: 'pricing.write' }, (req, res, { params, body, admin }) => {
    const o = one('SELECT * FROM plan_orders WHERE id = ?', params.id);
    if (!o) throw new ApiError(404, 'Order not found');
    const note = text(body.note, 300, { field: 'Note' });
    const a = String(body.action || '');
    if (a === 'mark-paid') {
      if (!['created', 'pending', 'failed'].includes(o.status)) throw new ApiError(409, `This order is ${o.status}`);
      const plan = parse(o.snapshot_json, null);
      const dates = activate(db, o.customer_id, plan, o.id);
      db.prepare("UPDATE plan_orders SET status = 'paid', paid_at = ?, starts_at = ?, ends_at = ?, payment_mode = COALESCE(NULLIF(payment_mode, ''), ?), reference = COALESCE(NULLIF(?, ''), reference), note = ?, decided_by = ?, updated_at = ? WHERE id = ?")
        .run(now(), dates.startsAt, dates.endsAt, payments.METHODS.includes(body.method) ? body.method : 'upi', text(body.reference, 80, { field: 'Reference' }), note, admin.email, now(), o.id);
      logActivity(db, o.customer_id, 'plan.started', `${o.plan_name} until ${dates.endsAt.slice(0, 10)} (${o.number})`);
    } else if (a === 'reject') {
      if (!['created', 'pending'].includes(o.status)) throw new ApiError(409, `This order is ${o.status}`);
      db.prepare("UPDATE plan_orders SET status = 'failed', note = ?, decided_by = ?, updated_at = ? WHERE id = ?").run(note || 'Payment not received', admin.email, now(), o.id);
    } else if (a === 'cancel') {
      if (!['created', 'pending'].includes(o.status)) throw new ApiError(409, `This order is ${o.status}`);
      db.prepare("UPDATE plan_orders SET status = 'cancelled', note = ?, decided_by = ?, updated_at = ? WHERE id = ?").run(note, admin.email, now(), o.id);
    } else if (a === 'refund') {
      if (o.status !== 'paid') throw new ApiError(409, 'Only a paid order can be refunded');
      transaction(db, () => {
        db.prepare("UPDATE plan_orders SET status = 'refunded', note = ?, decided_by = ?, updated_at = ? WHERE id = ?").run(note, admin.email, now(), o.id);
        db.prepare("UPDATE customer_plans SET status = 'cancelled' WHERE order_id = ? AND status = 'active'").run(o.id);
      });
    } else throw new ApiError(400, 'Unknown action');
    const c = one('SELECT email FROM customers WHERE id = ?', o.customer_id);
    audit(admin, `pricing.order.${a}`, o.number, `${c ? c.email : o.customer_id} · ₹${o.amount_paise / 100}`);
    return { order: presentOrder(one('SELECT o.*, c.email, c.name FROM plan_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', o.id)) };
  });
}

module.exports = { addRoutes, activePlan, activate, gstSplit, seedPlans, DEFAULT_PLANS, LIMIT_KEYS };
