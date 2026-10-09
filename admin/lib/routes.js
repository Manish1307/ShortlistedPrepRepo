'use strict';
// Every API route. Public routes are for the website and the desktop app; /admin/api routes need a signed-in admin.

const { now, transaction } = require('./db');
const auth = require('./auth');
const licences = require('./licence');
const { ApiError, text, email, integer, likeTerm } = require('./http');

const TOPICS = ['Support', 'Schools and teams', 'AI-included plan', 'Billing', 'Feedback'];
const ROLES = ['owner', 'admin', 'support'];
const ORDER_STATUS = ['paid', 'refunded', 'failed'];
const DEFAULT_DAYS = { trial: 14, personal: 365, schools: 365 };
const DUMMY_HASH = auth.hashPassword('not-a-real-password');

function buildRoutes(ctx) {
  const { db, signer } = ctx;
  const routes = [];
  const add = (method, pattern, options, handler) => routes.push({ method, pattern, options, handler });

  const audit = (admin, action, target = '', detail = '') =>
    db.prepare('INSERT INTO audit (at, admin_email, action, target, detail) VALUES (?,?,?,?,?)').run(now(), admin ? admin.email : 'system', action, String(target), String(detail).slice(0, 500));
  const need = (admin, permission) => { if (!auth.can(admin.role, permission)) throw new ApiError(403, 'Your role is not allowed to do that'); };
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const present = l => ({ ...l, effective_status: licences.effectiveStatus(l) });

  // ===================== public: used by the desktop app and the website =====================

  add('GET', '/api/health', { public: true }, () => ({ ok: true }));
  add('GET', '/api/public-key', { public: true }, () => ({ publicKey: signer.publicKeyPem }));

  const licenceCall = register => (req, res, { body, ip }) => {
    ctx.limiters.licence.hit(ip);
    if (ctx.limiters.licence.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    const result = licences.checkLicence(db, signer, body, { register });
    return { status: result.ok ? 200 : 403, body: result };
  };
  add('POST', '/api/licence/activate', { public: true }, licenceCall(true));
  add('POST', '/api/licence/validate', { public: true }, licenceCall(false));
  add('POST', '/api/licence/deactivate', { public: true }, (req, res, { body, ip }) => {
    ctx.limiters.licence.hit(ip);
    if (ctx.limiters.licence.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    return { ok: licences.removeDevice(db, body) };
  });

  add('GET', '/api/releases/latest', { public: true }, (req, res, { query }) => {
    const channel = query.get('channel') === 'beta' ? 'beta' : 'stable';
    const rows = all('SELECT version, channel, notes, download_url, min_supported, published_at FROM releases WHERE channel = ?', channel);
    const newest = rows.sort((a, b) => compareVersions(b.version, a.version))[0];
    return newest ? { ok: true, release: newest } : { ok: false };
  });

  add('POST', '/api/contact', { public: true }, (req, res, { body, ip }) => {
    if (ctx.limiters.contact.blocked(ip)) throw new ApiError(429, 'You have sent several messages already. Please try again later.');
    const topic = TOPICS.includes(body.topic) ? body.topic : 'Support';
    db.prepare('INSERT INTO messages (name, email, topic, body, created_at) VALUES (?,?,?,?,?)')
      .run(text(body.name, 100, { required: true, field: 'Name' }), email(body.email), topic, text(body.message, 5000, { required: true, field: 'Message' }), now());
    ctx.limiters.contact.hit(ip);
    return { status: 201, body: { ok: true } };
  });

  // ===================== admin: sign in / out =====================

  add('POST', '/admin/api/login', { public: true, admin: true }, (req, res, { body, ip }) => {
    const mail = String(body.email || '').trim().toLowerCase();
    const key = `${ip}|${mail}`;
    if (ctx.limiters.login.blocked(key)) throw new ApiError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const admin = one('SELECT * FROM admins WHERE email = ?', mail);
    const ok = auth.verifyPassword(String(body.password || ''), admin ? admin.pass_hash : DUMMY_HASH) && admin && !admin.disabled;
    if (!ok) { ctx.limiters.login.hit(key); audit(null, 'login.failed', mail); throw new ApiError(401, 'Wrong email or password'); }
    ctx.limiters.login.reset(key);
    db.prepare('UPDATE admins SET last_login = ? WHERE id = ?').run(now(), admin.id);
    const session = auth.createSession(db, admin.id);
    audit(admin, 'login');
    return { body: { ok: true, admin: { email: admin.email, name: admin.name, role: admin.role } }, cookie: session };
  });

  add('POST', '/admin/api/logout', { admin: true }, (req, res, { token, admin }) => {
    auth.deleteSession(db, token);
    audit(admin, 'logout');
    return { body: { ok: true }, clearCookie: true };
  });

  add('GET', '/admin/api/me', { admin: true }, (req, res, { admin }) => ({ admin }));

  add('POST', '/admin/api/password', { admin: true }, (req, res, { body, admin }) => {
    const row = one('SELECT * FROM admins WHERE id = ?', admin.id);
    if (!auth.verifyPassword(String(body.current || ''), row.pass_hash)) throw new ApiError(400, 'Your current password is not correct');
    const weak = auth.checkPasswordStrength(body.next);
    if (weak) throw new ApiError(400, weak);
    db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(body.next), admin.id);
    audit(admin, 'password.changed');
    return { ok: true };
  });

  // ===================== admin: overview =====================

  add('GET', '/admin/api/overview', { admin: true }, () => {
    const at = new Date();
    const iso = d => d.toISOString();
    const day = 86400000;
    const lic = all('SELECT * FROM licences').map(present);
    const active = lic.filter(l => l.effective_status === 'active');
    const soon = active.filter(l => l.expires_at && new Date(l.expires_at) < new Date(at.getTime() + 7 * day));

    const revenue = (since) => all(`SELECT currency, SUM(amount_cents) AS cents FROM orders WHERE status = 'paid' ${since ? 'AND created_at >= ?' : ''} GROUP BY currency`, ...(since ? [since] : []));
    const signups = all('SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM customers WHERE created_at >= ? GROUP BY d', iso(new Date(at.getTime() - 29 * day)));
    const byDay = new Map(signups.map(r => [r.d, r.n]));
    const signupSeries = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(at.getTime() - (29 - i) * day).toISOString().slice(0, 10);
      return { date: d, count: byDay.get(d) || 0 };
    });

    const trialCustomers = one("SELECT COUNT(DISTINCT customer_id) AS n FROM licences WHERE kind = 'trial'").n;
    const converted = one(`SELECT COUNT(DISTINCT t.customer_id) AS n FROM licences t JOIN licences p ON p.customer_id = t.customer_id
                           WHERE t.kind = 'trial' AND p.kind = 'paid'`).n;
    return {
      customers: one('SELECT COUNT(*) AS n FROM customers').n,
      licences: { active: active.length, activeTrials: active.filter(l => l.kind === 'trial').length, activePaid: active.filter(l => l.kind === 'paid').length,
                  expired: lic.filter(l => l.effective_status === 'expired').length, revoked: lic.filter(l => l.effective_status === 'revoked').length,
                  expiringIn7Days: soon.length },
      devicesActive7Days: one('SELECT COUNT(*) AS n FROM devices WHERE last_seen >= ?', iso(new Date(at.getTime() - 7 * day))).n,
      revenue30Days: revenue(iso(new Date(at.getTime() - 30 * day))),
      revenueTotal: revenue(null),
      refundedTotal: all("SELECT currency, SUM(amount_cents) AS cents FROM orders WHERE status = 'refunded' GROUP BY currency"),
      trialConversion: { trialCustomers, converted, percent: trialCustomers ? Math.round((converted / trialCustomers) * 100) : 0 },
      openMessages: one("SELECT COUNT(*) AS n FROM messages WHERE status = 'open'").n,
      signupSeries,
      recentOrders: all('SELECT o.*, c.email AS customer_email FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC LIMIT 5'),
      recentMessages: all('SELECT id, name, email, topic, status, created_at FROM messages ORDER BY id DESC LIMIT 5'),
    };
  });

  // ===================== admin: customers =====================

  add('GET', '/admin/api/customers', { admin: true }, (req, res, { query }) => {
    const term = likeTerm(query.get('q'));
    return { customers: all(`SELECT c.*, (SELECT COUNT(*) FROM licences l WHERE l.customer_id = c.id) AS licence_count,
        (SELECT COALESCE(SUM(amount_cents),0) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS paid_cents
        FROM customers c WHERE c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.organisation LIKE ? ESCAPE '\\'
        ORDER BY c.id DESC LIMIT 500`, term, term, term) };
  });

  add('GET', '/admin/api/customers/:id', { admin: true }, (req, res, { params }) => {
    const customer = one('SELECT * FROM customers WHERE id = ?', params.id);
    if (!customer) throw new ApiError(404, 'Customer not found');
    return {
      customer,
      licences: all('SELECT * FROM licences WHERE customer_id = ? ORDER BY id DESC', customer.id).map(present),
      orders: all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', customer.id),
    };
  });

  const customerFields = body => ({
    email: email(body.email), name: text(body.name, 100, { field: 'Name' }), organisation: text(body.organisation, 150, { field: 'Organisation' }),
    country: text(body.country, 60, { field: 'Country' }), notes: text(body.notes, 2000, { field: 'Notes' }),
  });

  add('POST', '/admin/api/customers', { admin: true, perm: 'customers.write' }, (req, res, { body, admin }) => {
    const f = customerFields(body);
    if (one('SELECT id FROM customers WHERE email = ?', f.email)) throw new ApiError(409, 'A customer with that email already exists');
    const r = db.prepare('INSERT INTO customers (email, name, organisation, country, notes, created_at) VALUES (?,?,?,?,?,?)').run(f.email, f.name, f.organisation, f.country, f.notes, now());
    audit(admin, 'customer.created', f.email);
    return { status: 201, body: { customer: one('SELECT * FROM customers WHERE id = ?', r.lastInsertRowid) } };
  });

  add('PATCH', '/admin/api/customers/:id', { admin: true, perm: 'customers.write' }, (req, res, { params, body, admin }) => {
    const current = one('SELECT * FROM customers WHERE id = ?', params.id);
    if (!current) throw new ApiError(404, 'Customer not found');
    const f = customerFields({ ...current, ...body });
    const clash = one('SELECT id FROM customers WHERE email = ? AND id <> ?', f.email, current.id);
    if (clash) throw new ApiError(409, 'Another customer already uses that email');
    db.prepare('UPDATE customers SET email=?, name=?, organisation=?, country=?, notes=? WHERE id=?').run(f.email, f.name, f.organisation, f.country, f.notes, current.id);
    audit(admin, 'customer.updated', f.email);
    return { customer: one('SELECT * FROM customers WHERE id = ?', current.id) };
  });

  // ===================== admin: licences =====================

  add('GET', '/admin/api/licences', { admin: true }, (req, res, { query }) => {
    const term = likeTerm(query.get('q'));
    const wanted = query.get('status') || '';
    let rows = all(`SELECT l.*, c.email AS customer_email, c.name AS customer_name,
        (SELECT COUNT(*) FROM devices d WHERE d.licence_id = l.id) AS device_count
        FROM licences l JOIN customers c ON c.id = l.customer_id
        WHERE l.key LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' ORDER BY l.id DESC LIMIT 500`, term, term, term).map(present);
    if (wanted === 'trial') rows = rows.filter(l => l.kind === 'trial' && l.effective_status === 'active');
    else if (['active', 'expired', 'revoked'].includes(wanted)) rows = rows.filter(l => l.effective_status === wanted);
    return { licences: rows };
  });

  add('GET', '/admin/api/licences/:id', { admin: true }, (req, res, { params }) => {
    const l = one('SELECT l.*, c.email AS customer_email, c.name AS customer_name FROM licences l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?', params.id);
    if (!l) throw new ApiError(404, 'Licence not found');
    return { licence: present(l), devices: all('SELECT * FROM devices WHERE licence_id = ? ORDER BY last_seen DESC', l.id) };
  });

  add('POST', '/admin/api/licences', { admin: true, perm: 'licence.major' }, (req, res, { body, admin }) => {
    const customerId = integer(body.customerId, { min: 1, field: 'Customer' });
    if (!one('SELECT id FROM customers WHERE id = ?', customerId)) throw new ApiError(404, 'Customer not found');
    const plan = String(body.plan || '');
    if (!licences.PLANS[plan]) throw new ApiError(400, 'Choose a plan: trial, personal or schools');
    const lifetime = body.days === 'lifetime' || body.days === null;
    const days = lifetime ? null : integer(body.days === undefined || body.days === '' ? DEFAULT_DAYS[plan] : body.days, { min: 1, max: 3650, field: 'Days' });
    const maxDevices = body.maxDevices ? integer(body.maxDevices, { min: 1, max: 100, field: 'Device limit' }) : undefined;
    const lic = licences.createLicence(db, { customerId, plan, days, maxDevices, note: text(body.note, 500, { field: 'Note' }) });
    audit(admin, 'licence.created', lic.key, `${plan}, ${days === null ? 'lifetime' : days + ' days'}`);
    return { status: 201, body: { licence: present(lic) } };
  });

  add('PATCH', '/admin/api/licences/:id', { admin: true }, (req, res, { params, body, admin }) => {
    const lic = one('SELECT * FROM licences WHERE id = ?', params.id);
    if (!lic) throw new ApiError(404, 'Licence not found');
    const action = String(body.action || '');
    const major = ['revoke', 'reinstate', 'setMaxDevices'];
    const minor = ['extend', 'resetDevices', 'removeDevice', 'note'];
    if (!major.includes(action) && !minor.includes(action)) throw new ApiError(400, 'Unknown action');
    need(admin, major.includes(action) ? 'licence.major' : 'licence.minor');

    if (action === 'revoke') db.prepare("UPDATE licences SET status = 'revoked' WHERE id = ?").run(lic.id);
    else if (action === 'reinstate') db.prepare("UPDATE licences SET status = 'active' WHERE id = ?").run(lic.id);
    else if (action === 'setMaxDevices') db.prepare('UPDATE licences SET max_devices = ? WHERE id = ?').run(integer(body.maxDevices, { min: 1, max: 100, field: 'Device limit' }), lic.id);
    else if (action === 'extend') {
      if (!lic.expires_at) throw new ApiError(400, 'This licence never expires, so there is nothing to extend');
      const days = integer(body.days, { min: 1, max: 3650, field: 'Days' });
      const base = new Date(lic.expires_at) > new Date() ? lic.expires_at : now();
      db.prepare('UPDATE licences SET expires_at = ? WHERE id = ?').run(licences.addDays(base, days), lic.id);
    } else if (action === 'resetDevices') db.prepare('DELETE FROM devices WHERE licence_id = ?').run(lic.id);
    else if (action === 'removeDevice') db.prepare('DELETE FROM devices WHERE licence_id = ? AND device_id = ?').run(lic.id, text(body.deviceId, 100, { required: true, field: 'Device' }));
    else if (action === 'note') db.prepare('UPDATE licences SET note = ? WHERE id = ?').run(text(body.note, 500, { field: 'Note' }), lic.id);

    audit(admin, `licence.${action}`, lic.key, body.days ? `${body.days} days` : '');
    return { licence: present(one('SELECT * FROM licences WHERE id = ?', lic.id)) };
  });

  // ===================== admin: orders =====================

  add('GET', '/admin/api/orders', { admin: true }, (req, res, { query }) => {
    const term = likeTerm(query.get('q'));
    return { orders: all(`SELECT o.*, c.email AS customer_email FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.email LIKE ? ESCAPE '\\' OR o.provider_ref LIKE ? ESCAPE '\\' ORDER BY o.id DESC LIMIT 500`, term, term) };
  });

  add('POST', '/admin/api/orders', { admin: true, perm: 'orders.write' }, (req, res, { body, admin }) => {
    const customerId = integer(body.customerId, { min: 1, field: 'Customer' });
    if (!one('SELECT id FROM customers WHERE id = ?', customerId)) throw new ApiError(404, 'Customer not found');
    const plan = String(body.plan || '');
    if (!licences.PLANS[plan] || plan === 'trial') throw new ApiError(400, 'Choose a paid plan: personal or schools');
    const status = ORDER_STATUS.includes(body.status) ? body.status : 'paid';
    const cents = integer(body.amountCents, { min: 0, max: 100000000, field: 'Amount' });
    const currency = text(body.currency || 'USD', 3, { required: true, field: 'Currency' }).toUpperCase();
    const days = body.days ? integer(body.days, { min: 1, max: 3650, field: 'Days' }) : DEFAULT_DAYS[plan];

    const result = transaction(db, () => {
      const r = db.prepare('INSERT INTO orders (customer_id, plan, amount_cents, currency, status, provider, provider_ref, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(customerId, plan, cents, currency, status, text(body.provider || 'manual', 40, { field: 'Provider' }), text(body.providerRef, 100, { field: 'Reference' }), now());
      const order = one('SELECT * FROM orders WHERE id = ?', r.lastInsertRowid);
      const lic = body.issueLicence && status === 'paid' ? licences.createLicence(db, { customerId, plan, days, orderId: order.id }) : null;
      return { order, licence: lic && present(lic) };
    });
    audit(admin, 'order.created', `#${result.order.id}`, `${plan} ${(cents / 100).toFixed(2)} ${currency}${result.licence ? ', licence ' + result.licence.key : ''}`);
    return { status: 201, body: result };
  });

  add('POST', '/admin/api/orders/:id/refund', { admin: true, perm: 'orders.write' }, (req, res, { params, body, admin }) => {
    const order = one('SELECT * FROM orders WHERE id = ?', params.id);
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.status !== 'paid') throw new ApiError(400, 'Only paid orders can be refunded');
    transaction(db, () => {
      db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
      if (body.revokeLicences) db.prepare("UPDATE licences SET status = 'revoked' WHERE order_id = ?").run(order.id);
    });
    audit(admin, 'order.refunded', `#${order.id}`, body.revokeLicences ? 'licences revoked' : '');
    return { order: one('SELECT * FROM orders WHERE id = ?', order.id) };
  });

  // ===================== admin: releases =====================

  add('GET', '/admin/api/releases', { admin: true }, () => ({
    releases: all('SELECT * FROM releases').sort((a, b) => compareVersions(b.version, a.version)),
  }));

  add('POST', '/admin/api/releases', { admin: true, perm: 'releases.write' }, (req, res, { body, admin }) => {
    const version = text(body.version, 30, { required: true, field: 'Version' });
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new ApiError(400, 'Version must look like 1.2.3');
    const minSupported = text(body.minSupported, 30, { field: 'Minimum supported version' });
    if (minSupported && !/^\d+\.\d+\.\d+$/.test(minSupported)) throw new ApiError(400, 'Minimum supported version must look like 1.0.0');
    const url = text(body.downloadUrl, 500, { field: 'Download link' });
    if (url && !/^https:\/\//i.test(url)) throw new ApiError(400, 'The download link must start with https://');
    if (one('SELECT id FROM releases WHERE version = ?', version)) throw new ApiError(409, 'That version already exists');
    const channel = body.channel === 'beta' ? 'beta' : 'stable';
    db.prepare('INSERT INTO releases (version, channel, notes, download_url, min_supported, published_at, published_by) VALUES (?,?,?,?,?,?,?)')
      .run(version, channel, text(body.notes, 5000, { field: 'Notes' }), url, minSupported, now(), admin.email);
    audit(admin, 'release.published', version, channel);
    return { status: 201, body: { release: one('SELECT * FROM releases WHERE version = ?', version) } };
  });

  add('DELETE', '/admin/api/releases/:id', { admin: true, perm: 'releases.write' }, (req, res, { params, admin }) => {
    const r = one('SELECT * FROM releases WHERE id = ?', params.id);
    if (!r) throw new ApiError(404, 'Release not found');
    db.prepare('DELETE FROM releases WHERE id = ?').run(r.id);
    audit(admin, 'release.deleted', r.version);
    return { ok: true };
  });

  // ===================== admin: support messages =====================

  add('GET', '/admin/api/messages', { admin: true }, (req, res, { query }) => {
    const status = ['open', 'closed'].includes(query.get('status')) ? query.get('status') : null;
    return { messages: status ? all('SELECT * FROM messages WHERE status = ? ORDER BY id DESC LIMIT 500', status) : all('SELECT * FROM messages ORDER BY id DESC LIMIT 500') };
  });

  add('PATCH', '/admin/api/messages/:id', { admin: true, perm: 'messages.write' }, (req, res, { params, body, admin }) => {
    const m = one('SELECT * FROM messages WHERE id = ?', params.id);
    if (!m) throw new ApiError(404, 'Message not found');
    const status = body.status === undefined ? m.status : (['open', 'closed'].includes(body.status) ? body.status : (() => { throw new ApiError(400, 'Status must be open or closed'); })());
    const note = body.note === undefined ? m.note : text(body.note, 2000, { field: 'Note' });
    db.prepare('UPDATE messages SET status = ?, note = ? WHERE id = ?').run(status, note, m.id);
    audit(admin, 'message.updated', `#${m.id}`, status);
    return { message: one('SELECT * FROM messages WHERE id = ?', m.id) };
  });

  // ===================== admin: audit log and team =====================

  add('GET', '/admin/api/audit', { admin: true }, (req, res, { query }) => {
    const term = likeTerm(query.get('q'));
    return { entries: all(`SELECT * FROM audit WHERE action LIKE ? ESCAPE '\\' OR admin_email LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 300`, term, term, term) };
  });

  add('GET', '/admin/api/team', { admin: true, perm: 'team.read' }, () => ({
    admins: all('SELECT id, email, name, role, disabled, created_at, last_login FROM admins ORDER BY id'),
  }));

  add('POST', '/admin/api/team', { admin: true, perm: 'team.write' }, (req, res, { body, admin }) => {
    const mail = email(body.email);
    const role = ROLES.includes(body.role) ? body.role : 'support';
    const weak = auth.checkPasswordStrength(body.password);
    if (weak) throw new ApiError(400, weak);
    if (one('SELECT id FROM admins WHERE email = ?', mail)) throw new ApiError(409, 'That email already has access');
    db.prepare('INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,?)').run(mail, text(body.name, 100, { field: 'Name' }), role, auth.hashPassword(body.password), now());
    audit(admin, 'team.added', mail, role);
    return { status: 201, body: { ok: true } };
  });

  add('PATCH', '/admin/api/team/:id', { admin: true, perm: 'team.write' }, (req, res, { params, body, admin }) => {
    const target = one('SELECT * FROM admins WHERE id = ?', params.id);
    if (!target) throw new ApiError(404, 'Team member not found');
    const role = body.role === undefined ? target.role : (ROLES.includes(body.role) ? body.role : (() => { throw new ApiError(400, 'Unknown role'); })());
    const disabled = body.disabled === undefined ? target.disabled : (body.disabled ? 1 : 0);
    const losesOwner = target.role === 'owner' && (role !== 'owner' || disabled);
    if (losesOwner && one("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND disabled = 0").n <= 1) throw new ApiError(400, 'There must always be at least one active owner');
    if (target.id === admin.id && (disabled || role !== target.role)) throw new ApiError(400, 'You cannot lock yourself out or change your own role');
    db.prepare('UPDATE admins SET role = ?, disabled = ? WHERE id = ?').run(role, disabled, target.id);
    if (body.password) {
      const weak = auth.checkPasswordStrength(body.password);
      if (weak) throw new ApiError(400, weak);
      db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), target.id);
    }
    if (disabled || body.password) auth.deleteAdminSessions(db, target.id);
    audit(admin, 'team.updated', target.email, `${role}${disabled ? ', disabled' : ''}${body.password ? ', password reset' : ''}`);
    return { ok: true };
  });

  return routes;
}

/** "1.10.0" is newer than "1.9.0". */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

module.exports = { buildRoutes, compareVersions, TOPICS };
