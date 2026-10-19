'use strict';
// Every API route. Public routes are for the website and the desktop app; /admin/api routes need a signed-in admin.

const { now, transaction } = require('./db');
const auth = require('./auth');
const licences = require('./licence');
const aikeys = require('./aikeys');
const aiproxy = require('./aiproxy');
const conversations = require('./conversations');
const profiles = require('./profiles');
const accounts = require('./accounts');
const career = require('./career');
const jobs = require('./jobs');
const logos = require('./logos');
const candidates = require('./candidates');
const aiTokens = require('./tokens');
const pricing = require('./pricing');
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
  // "Start free trial" in the app (TRIAL_DAYS, default 7). Trials are limited per address as well as per computer and email.
  add('POST', '/api/licence/trial', { public: true }, (req, res, { body, ip }) => {
    if (ctx.limiters.trial.blocked(ip)) throw new ApiError(429, 'Too many trial requests. Please try again later.');
    ctx.limiters.trial.hit(ip);
    const days = Math.max(1, Math.min(60, Number(process.env.TRIAL_DAYS) || 7));
    const result = transaction(db, () => licences.startTrial(db, signer, body, { days }));
    if (result.ok) audit(null, 'trial.started', String(body.email || '').trim().toLowerCase(), String(body.deviceName || '').slice(0, 100));
    return { status: result.ok ? 200 : 403, body: result };
  });
  // The app's start-up call: the licence check (signed, as for /validate) plus the AI keys this licence should use
  // (its own key per service, or the service's default). Only an active licence on an activated computer gets keys.
  add('POST', '/api/app/config', { public: true }, (req, res, { body, ip }) => {
    ctx.limiters.licence.hit(ip);
    if (ctx.limiters.licence.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    const result = licences.checkLicence(db, signer, body, { register: false });
    if (!result.ok) return { status: 403, body: result };
    const lic = one('SELECT id FROM licences WHERE key = ?', String(body.key || '').trim().toUpperCase());
    const profile = profiles.profileForLicence(db, lic.id);   // the customer's topics and resume, for the AI
    // An app that can use the AI proxy (body.proxy) gets an access token instead of the keys, which stay here.
    // AI_KEY_HANDOUT=off stops sending keys to older apps too.
    if (body.proxy === true && ctx.tokens) {
      const grant = ctx.tokens.issue({ licenceId: lic.id, deviceId: String(body.deviceId || '').trim().slice(0, 100) });
      return { body: { ...result, ai: {}, aiProxy: { ...grant, services: aiproxy.services(db, lic.id) }, profile } };
    }
    const handout = process.env.AI_KEY_HANDOUT !== 'off';
    return { body: { ...result, ai: handout ? aikeys.keysForApp(db, ctx.vault, lic.id) : {}, profile } };
  });
  if (ctx.tokens) aiproxy.addRoutes({ ...ctx, add });
  conversations.addRoutes({ ...ctx, add, audit, one, all });   // Live Class conversations (saved by the app, read in the dashboard)
  profiles.addRoutes({ ...ctx, add, audit, one, all });        // topics and resume per customer (sent to the app above)
  accounts.addRoutes({ ...ctx, add, audit, one, all });        // customer logins for the website's My account page
  career.addRoutes({ ...ctx, add, one, all });                 // career toolkit for signed-in customers (resume, ATS, job match)
  jobs.addRoutes({ ...ctx, add, audit, one, all });            // AI Job search: live openings from career sites, scored by the AI
  logos.addRoutes({ ...ctx, add });                            // company logos next to the jobs
  candidates.addRoutes({ ...ctx, add, audit, one, all });      // Candidates: progress, documents and activity in the Career toolkit
  aiTokens.addRoutes({ ...ctx, add, audit, one, all });
  pricing.addRoutes({ ...ctx, add, audit, one, all });          // Pricing: plans master, active plans, payment settings, plan orders          // AI tokens: daily allowance per customer, packs and requests for more
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

  // ---- website visits (no cookies, no IP address stored: only a random id the browser keeps) ----
  const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|axios|headless|lighthouse|facebookexternalhit/i;
  const deviceOf = ua => (/ipad|tablet/i.test(ua) ? 'tablet' : /mobi|android|iphone/i.test(ua) ? 'mobile' : 'desktop');
  const hostOnly = s => { try { return new URL(String(s)).hostname.replace(/^www\./, '').slice(0, 100); } catch (_) { return ''; } };
  add('POST', '/api/track', { public: true }, (req, res, { body, ip }) => {
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || BOT.test(ua)) return { body: { ok: true } };
    if (ctx.limiters.track.blocked(ip)) return { body: { ok: true } };
    ctx.limiters.track.hit(ip);
    const visitor = String(body.visitor || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(visitor)) throw new ApiError(400, 'Bad visitor id');
    const pagePath = String(body.path || '/').split(/[?#]/)[0].slice(0, 200) || '/';
    const referrer = hostOnly(body.referrer);
    const at = now();
    db.prepare('INSERT INTO visits (at, day, visitor, path, referrer, source, device) VALUES (?,?,?,?,?,?,?)')
      .run(at, at.slice(0, 10), visitor, pagePath, referrer, String(body.source || '').replace(/[^\w.-]/g, '').slice(0, 40), deviceOf(ua));
    return { body: { ok: true } };
  });

  // ---- "Watch demo", "Get early access", contact: every one becomes an opportunity in the admin portal ----
  const KINDS = ['demo', 'interest', 'signup', 'contact'];
  const KIND_RANK = { signup: 1, interest: 1, contact: 2, demo: 3 };
  add('POST', '/api/opportunity', { public: true }, (req, res, { body, ip }) => {
    if (ctx.limiters.opportunity.blocked(ip)) throw new ApiError(429, 'You have sent several requests already. Please try again later.');
    if (body.website) return { status: 201, body: { ok: true } };   // hidden field that only bots fill in
    const kind = KINDS.includes(body.kind) ? body.kind : 'interest';
    const f = {
      name: text(body.name, 100, { field: 'Name' }), email: email(body.email), phone: text(body.phone, 40, { field: 'Phone' }),
      company: text(body.company, 150, { field: 'Company or college' }), role: text(body.role, 100, { field: 'Role' }),
      message: text(body.message, 2000, { field: 'Message' }), page: text(String(body.page || '').split(/[?#]/)[0], 200, { field: 'Page' }),
      visitor: /^[A-Za-z0-9-]{8,64}$/.test(String(body.visitor || '')) ? String(body.visitor) : '',
    };
    if (kind === 'demo' && !f.name) throw new ApiError(400, 'Please tell us your name');
    ctx.limiters.opportunity.hit(ip);
    const stamp = now();
    const existing = one("SELECT * FROM opportunities WHERE email = ? AND status NOT IN ('won','lost') ORDER BY id DESC LIMIT 1", f.email);
    if (existing) {
      // the same person asking again is one opportunity with a longer history, not a second row
      transaction(db, () => {
        const upgrade = (KIND_RANK[kind] || 0) > (KIND_RANK[existing.kind] || 0) ? kind : existing.kind;
        db.prepare('UPDATE opportunities SET kind = ?, name = ?, phone = ?, company = ?, role_interest = ?, updated_at = ? WHERE id = ?')
          .run(upgrade, existing.name || f.name, existing.phone || f.phone, existing.company || f.company, existing.role_interest || f.role, stamp, existing.id);
        db.prepare('INSERT INTO opportunity_notes (opportunity_id, author, body, created_at) VALUES (?,?,?,?)')
          .run(existing.id, 'website', `Asked again (${kind}) from ${f.page || 'the website'}${f.message ? ': ' + f.message : ''}`, stamp);
      });
      return { status: 201, body: { ok: true } };
    }
    db.prepare(`INSERT INTO opportunities (kind, name, email, phone, company, role_interest, message, source_page, visitor, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(kind, f.name, f.email, f.phone, f.company, f.role, f.message, f.page, f.visitor, stamp, stamp);
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
      website: {
        today: one('SELECT COUNT(DISTINCT visitor) AS n FROM visits WHERE day = ?', iso(at).slice(0, 10)).n,
        visitors7Days: one('SELECT COUNT(DISTINCT visitor) AS n FROM visits WHERE day >= ?', iso(new Date(at.getTime() - 6 * day)).slice(0, 10)).n,
        visitors30Days: one('SELECT COUNT(DISTINCT visitor) AS n FROM visits WHERE day >= ?', iso(new Date(at.getTime() - 29 * day)).slice(0, 10)).n,
        newOpportunities: one("SELECT COUNT(*) AS n FROM opportunities WHERE status = 'new'").n,
        demoRequests30Days: one("SELECT COUNT(*) AS n FROM opportunities WHERE kind = 'demo' AND created_at >= ?", iso(new Date(at.getTime() - 29 * day))).n,
      },
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
    return { licence: present(l), devices: all('SELECT * FROM devices WHERE licence_id = ? ORDER BY last_seen DESC', l.id), aiKeys: aiKeysOf(l.id) };
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

  // ===================== admin: AI keys (Groq for answers, Gemini for screenshots) =====================

  const aiKeysOf = licenceId => {
    const assigned = Object.fromEntries(all('SELECT provider, api_key_id FROM licence_api_keys WHERE licence_id = ?', licenceId).map(r => [r.provider, r.api_key_id]));
    return Object.fromEntries(Object.entries(aikeys.resolveForLicence(db, licenceId)).map(([provider, r]) =>
      [provider, { source: r.source, assignedId: assigned[provider] || null, assignedDisabled: !!r.assignedDisabled, key: r.row ? aikeys.present(r.row) : null }]));
  };
  const providerOf = value => {
    if (!aikeys.PROVIDERS[value]) throw new ApiError(400, 'Choose a service: groq or gemini');
    return value;
  };
  const keyText = (provider, value) => {
    const key = String(value || '').trim();
    if (!aikeys.PROVIDERS[provider].pattern.test(key) || key.length > 300) throw new ApiError(400, `That does not look like a ${aikeys.PROVIDERS[provider].label} key. ${aikeys.PROVIDERS[provider].hint}.`);
    return key;
  };

  add('GET', '/admin/api/ai-keys', { admin: true }, () => ({
    keys: aikeys.listKeys(db),
    providers: Object.entries(aikeys.PROVIDERS).map(([id, p]) => ({ id, label: p.label, use: p.use })),
  }));

  add('POST', '/admin/api/ai-keys', { admin: true, perm: 'aikeys.write' }, (req, res, { body, admin }) => {
    const provider = providerOf(body.provider);
    const label = text(body.label, 80, { required: true, field: 'Name' });
    const row = aikeys.addKey(db, ctx.vault, { provider, label, key: keyText(provider, body.key), makeDefault: !!body.makeDefault, by: admin.email });
    audit(admin, 'aikey.added', `${provider}: ${label}`, '••••' + row.key_last4);
    return { status: 201, body: { key: aikeys.present(one('SELECT * FROM api_keys WHERE id = ?', row.id)) } };
  });

  add('PATCH', '/admin/api/ai-keys/:id', { admin: true, perm: 'aikeys.write' }, (req, res, { params, body, admin }) => {
    const row = one('SELECT * FROM api_keys WHERE id = ?', params.id);
    if (!row) throw new ApiError(404, 'Key not found');
    const action = String(body.action || '');
    if (action === 'default') {
      if (row.disabled) throw new ApiError(400, 'Turn the key on before making it the default');
      transaction(db, () => aikeys.setDefault(db, row.id));
    } else if (action === 'disable') db.prepare('UPDATE api_keys SET disabled = 1, is_default = 0 WHERE id = ?').run(row.id);
    else if (action === 'enable') db.prepare('UPDATE api_keys SET disabled = 0 WHERE id = ?').run(row.id);
    else if (action === 'rename') db.prepare('UPDATE api_keys SET label = ? WHERE id = ?').run(text(body.label, 80, { required: true, field: 'Name' }), row.id);
    else if (action === 'replace') {
      const key = keyText(row.provider, body.key);
      db.prepare('UPDATE api_keys SET key_enc = ?, key_last4 = ? WHERE id = ?').run(ctx.vault.encrypt(key), key.slice(-4), row.id);
    } else throw new ApiError(400, 'Unknown action');
    audit(admin, `aikey.${action}`, `${row.provider}: ${row.label}`);
    return { key: aikeys.present(one('SELECT * FROM api_keys WHERE id = ?', row.id)) };
  });

  // Licences that used this key go back to the service's default.
  add('DELETE', '/admin/api/ai-keys/:id', { admin: true, perm: 'aikeys.write' }, (req, res, { params, admin }) => {
    const row = one('SELECT * FROM api_keys WHERE id = ?', params.id);
    if (!row) throw new ApiError(404, 'Key not found');
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(row.id);
    audit(admin, 'aikey.deleted', `${row.provider}: ${row.label}`);
    return { ok: true };
  });

  // Give a licence its own key for one service, or apiKeyId null to use the default again.
  add('POST', '/admin/api/licences/:id/ai-keys', { admin: true, perm: 'aikeys.write' }, (req, res, { params, body, admin }) => {
    const lic = one('SELECT * FROM licences WHERE id = ?', params.id);
    if (!lic) throw new ApiError(404, 'Licence not found');
    const provider = providerOf(body.provider);
    const apiKeyId = body.apiKeyId === null || body.apiKeyId === '' || body.apiKeyId === undefined ? null : integer(body.apiKeyId, { min: 1, field: 'Key' });
    if (apiKeyId !== null) {
      const k = one('SELECT * FROM api_keys WHERE id = ?', apiKeyId);
      if (!k || k.provider !== provider) throw new ApiError(400, `Choose a ${aikeys.PROVIDERS[provider].label} key`);
    }
    aikeys.assign(db, { licenceId: lic.id, provider, apiKeyId });
    audit(admin, 'licence.aikey', lic.key, `${provider}: ${apiKeyId === null ? 'default' : 'key #' + apiKeyId}`);
    return { aiKeys: aiKeysOf(lic.id) };
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

  // ===================== admin: website visits =====================

  add('GET', '/admin/api/analytics', { admin: true }, (req, res, { query }) => {
    const days = Math.max(1, Math.min(365, Number(query.get('days')) || 30));
    const day = 86400000;
    const dayStr = offset => new Date(Date.now() - offset * day).toISOString().slice(0, 10);
    const since = dayStr(days - 1);
    const total = one('SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ?', since);
    const rows = all('SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? GROUP BY day', since);
    const byDay = new Map(rows.map(r => [r.day, r]));
    const series = Array.from({ length: days }, (_, i) => { const d = dayStr(days - 1 - i); const r = byDay.get(d); return { date: d, views: r ? r.views : 0, visitors: r ? r.visitors : 0 }; });
    const people = d => one('SELECT COUNT(DISTINCT visitor) AS n FROM visits WHERE day >= ?', d).n;
    const leads = one('SELECT COUNT(*) AS n FROM opportunities WHERE created_at >= ?', since + 'T00:00:00').n;
    return {
      days, views: total.views, visitors: total.visitors,
      today: { views: one('SELECT COUNT(*) AS n FROM visits WHERE day = ?', dayStr(0)).n, visitors: people(dayStr(0)) },
      last7Visitors: people(dayStr(6)),
      opportunities: leads, conversionPercent: total.visitors ? Math.round((leads / total.visitors) * 1000) / 10 : 0,
      series,
      topPages: all('SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 12', since),
      referrers: all("SELECT CASE WHEN referrer = '' THEN '(direct or unknown)' ELSE referrer END AS name, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? GROUP BY name ORDER BY visitors DESC LIMIT 10", since),
      sources: all("SELECT source AS name, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? AND source <> '' GROUP BY source ORDER BY visitors DESC LIMIT 10", since),
      devices: all('SELECT device AS name, COUNT(DISTINCT visitor) AS visitors FROM visits WHERE day >= ? GROUP BY device ORDER BY visitors DESC', since),
      returning: one('SELECT COUNT(*) AS n FROM (SELECT visitor FROM visits WHERE day >= ? GROUP BY visitor HAVING COUNT(DISTINCT day) > 1)', since).n,
    };
  });

  // ===================== admin: opportunities (demo requests and interest) =====================

  const STAGES = ['new', 'contacted', 'qualified', 'won', 'lost'];
  add('GET', '/admin/api/opportunities', { admin: true }, (req, res, { query }) => {
    const term = likeTerm(query.get('q'));
    const status = STAGES.includes(query.get('status')) ? query.get('status') : null;
    const kind = KINDS.includes(query.get('kind')) ? query.get('kind') : null;
    const rows = all(`SELECT o.*, (SELECT COUNT(*) FROM opportunity_notes n WHERE n.opportunity_id = o.id) AS note_count FROM opportunities o
        WHERE (o.email LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR o.company LIKE ? ESCAPE '\\')
        ${status ? 'AND o.status = ?' : ''} ${kind ? 'AND o.kind = ?' : ''} ORDER BY o.id DESC LIMIT 500`,
      term, term, term, ...(status ? [status] : []), ...(kind ? [kind] : []));
    const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
    for (const r of all('SELECT status, COUNT(*) AS n FROM opportunities GROUP BY status')) counts[r.status] = r.n;
    return { opportunities: rows, counts };
  });

  add('GET', '/admin/api/opportunities/:id', { admin: true }, (req, res, { params }) => {
    const opportunity = one('SELECT * FROM opportunities WHERE id = ?', params.id);
    if (!opportunity) throw new ApiError(404, 'Opportunity not found');
    const pages = opportunity.visitor ? all('SELECT at, path, referrer, source FROM visits WHERE visitor = ? ORDER BY id DESC LIMIT 30', opportunity.visitor) : [];
    return { opportunity, notes: all('SELECT * FROM opportunity_notes WHERE opportunity_id = ? ORDER BY id DESC', opportunity.id), pages };
  });

  add('PATCH', '/admin/api/opportunities/:id', { admin: true, perm: 'opportunities.write' }, (req, res, { params, body, admin }) => {
    const o = one('SELECT * FROM opportunities WHERE id = ?', params.id);
    if (!o) throw new ApiError(404, 'Opportunity not found');
    const status = body.status === undefined ? o.status : (STAGES.includes(body.status) ? body.status : (() => { throw new ApiError(400, 'Unknown stage'); })());
    const owner = body.owner === undefined ? o.owner : text(body.owner, 100, { field: 'Owner' });
    const followUp = body.followUp === undefined ? o.follow_up : text(body.followUp, 10, { field: 'Follow-up date' });
    if (followUp && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) throw new ApiError(400, 'Follow-up date must look like 2026-11-30');
    const value = body.valueCents === undefined ? o.value_cents : integer(body.valueCents, { min: 0, max: 100000000, field: 'Value' });
    transaction(db, () => {
      db.prepare('UPDATE opportunities SET status = ?, owner = ?, follow_up = ?, value_cents = ?, updated_at = ? WHERE id = ?').run(status, owner, followUp, value, now(), o.id);
      const note = body.note === undefined ? '' : text(body.note, 2000, { field: 'Note' });
      if (note) db.prepare('INSERT INTO opportunity_notes (opportunity_id, author, body, created_at) VALUES (?,?,?,?)').run(o.id, admin.email, note, now());
      if (status !== o.status) db.prepare('INSERT INTO opportunity_notes (opportunity_id, author, body, created_at) VALUES (?,?,?,?)').run(o.id, admin.email, `Stage changed: ${o.status} → ${status}`, now());
    });
    audit(admin, 'opportunity.updated', `#${o.id} ${o.email}`, status);
    return { opportunity: one('SELECT * FROM opportunities WHERE id = ?', o.id) };
  });

  add('POST', '/admin/api/opportunities/:id/customer', { admin: true, perm: 'customers.write' }, (req, res, { params, admin }) => {
    const o = one('SELECT * FROM opportunities WHERE id = ?', params.id);
    if (!o) throw new ApiError(404, 'Opportunity not found');
    let customer = one('SELECT * FROM customers WHERE email = ?', o.email);
    if (!customer) {
      const r = db.prepare('INSERT INTO customers (email, name, organisation, country, notes, created_at) VALUES (?,?,?,?,?,?)').run(o.email, o.name, o.company, '', `From a ${o.kind} request on the website`, now());
      customer = one('SELECT * FROM customers WHERE id = ?', r.lastInsertRowid);
    }
    db.prepare('UPDATE opportunities SET customer_id = ?, updated_at = ? WHERE id = ?').run(customer.id, now(), o.id);
    audit(admin, 'opportunity.customer', `#${o.id}`, o.email);
    return { customer };
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
