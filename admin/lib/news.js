'use strict';
// News and trainings (website: News): recent highlights, free and paid trainings from employers, shown to everyone, and a
// "For you" list for a signed-in member that picks the items matching the skills in their resume and the companies they
// searched. Items are written by the team (admin: News) or suggested from the news and learning feeds (RSS or Atom) of
// the companies the team lists as sources. A suggested item is only a draft: nothing shows on the website until a person
// has read it, set free or paid, and published it.

const { ApiError, likeTerm } = require('./http');
const auth = require('./auth');
const { signedInCustomer } = require('./accounts');
const { companyDomain } = require('./jobcatalogue');
const { profileOf } = require('./recommended');

const KINDS = ['news', 'training', 'highlight'];
const COSTS = ['free', 'paid', 'unknown'];
const STATUSES = ['draft', 'pending', 'published', 'rejected'];
const PAGE = 20;
const FEED_BYTES = 1500000;
const FEED_MS = 9000;
const PER_FEED = 15;           // newest entries read from one feed each time
const HOUR = 3600000;
const now = () => new Date().toISOString();

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanUrl = s => { try { const u = new URL(String(s || '').trim()); return /^https?:$/.test(u.protocol) ? u.toString().slice(0, 600) : ''; } catch (_) { return ''; } };
const tagList = s => [...new Set((Array.isArray(s) ? s : String(s || '').split(',')).map(t => clean(t, 30).toLowerCase()).filter(Boolean))].slice(0, 12);

// ---------- reading a feed ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
const decode = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] || m);
const plain = s => clean(decode(decode(s)).replace(/<[^>]*>/g, ' '), 1200);

/** The newest entries of an RSS or Atom document: [{ title, url, summary, publishedAt }]. */
function parseFeed(xml) {
  const text = String(xml || '');
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const tag = (b, names) => { for (const n of names) { const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(b); if (m) return m[1]; } return ''; };
  const out = [];
  for (const b of blocks) {
    const title = plain(tag(b, ['title']));
    let link = plain(tag(b, ['link']));
    if (!link) { const m = /<link[^>]*?href=["']([^"']+)["']/i.exec(b); link = m ? decode(m[1]) : ''; }
    const url = cleanUrl(link);
    if (!title || !url) continue;
    const when = new Date(plain(tag(b, ['pubDate', 'published', 'updated', 'dc:date'])));
    out.push({ title: title.slice(0, 200), url, summary: plain(tag(b, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 500),
      publishedAt: Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86400000 ? now() : when.toISOString() });
  }
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, PER_FEED);
}

/** Addresses a feed may not be read from (this machine and private networks), unless the server is under test. */
function privateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '::1'
    || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

async function readFeed(url, { allowLocal = false } = {}) {
  const u = new URL(url);
  if (!allowLocal && privateHost(u.hostname)) throw new Error('Feeds on private addresses are not read');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FEED_MS);
  try {
    const r = await fetch(u, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'ShortlistPrepBot/1.0 (+https://shortlistprep.com)', Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' } });
    if (!r.ok) throw new Error('The feed answered ' + r.status);
    const body = (await r.text()).slice(0, FEED_BYTES);
    const items = parseFeed(body);
    if (!items.length) throw new Error('No entries were found in this feed');
    return items;
  } finally { clearTimeout(timer); }
}

// ---------- matching an item to a member ----------

const wordRe = w => new RegExp('(?:^|[^a-z0-9+#])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9+#])', 'i');

/**
 * How well an item fits a member: { score, reasons }. skills: from the resume; companies: the ones in their Live Search or
 * named on their resume. A skill in the title or tags counts more than one in the summary; the company counts most.
 */
function match(item, { skills = [], roles = [], companies = [] }) {
  const title = (item.title + ' ' + (item.tags || []).join(' ')).toLowerCase(), body = String(item.summary || '').toLowerCase();
  let score = 0; const reasons = [];
  const co = companies.find(c => c && item.company && c.toLowerCase() === item.company.toLowerCase());
  if (co) { score += 40; reasons.push('A company you searched or know: ' + item.company); }
  const got = [];
  for (const s of skills.slice(0, 40)) {
    const k = String(s).toLowerCase(); if (k.length < 2) continue;
    const re = wordRe(k);
    if (re.test(title)) { score += 14; got.push(s); } else if (re.test(body)) { score += 6; got.push(s); }
  }
  if (got.length) reasons.push('Matches your skills: ' + [...new Set(got)].slice(0, 4).join(', '));
  for (const r of roles.slice(0, 3)) {
    const main = String(r).toLowerCase().split(' ').filter(w => w.length > 3 && !/^(engineer|developer|manager|analyst|senior|junior)$/.test(w))[0];
    if (main && wordRe(main).test(title + ' ' + body)) { score += 8; reasons.push('Relevant to your role: ' + r); break; }
  }
  if (item.kind === 'training' && item.cost === 'free' && score > 0) score += 3;
  return { score: Math.min(100, score), reasons };
}

// ---------- the routes ----------

let fetcher = null;   // set when the routes are added: reads the listed feeds

function addRoutes(ctx) {
  const { db, add, one, all, audit } = ctx;
  const limiter = new auth.Limiter({ max: 120, windowMs: 60000 });
  const me = req => signedInCustomer(db, req).customer;
  const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
  const intIn = (v, min, max, fb) => { const n = v === null || v === undefined || v === '' ? NaN : Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb; };

  const publicItem = r => ({ id: r.id, title: r.title, summary: r.summary, url: r.url, company: r.company, kind: r.kind, cost: r.cost, priceNote: r.price_note,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [], publishedAt: r.published_at, domain: r.company ? companyDomain(r.company, '') : '' });
  const adminItem = r => ({ ...publicItem(r), state: r.status, sourceId: r.source_id, sourceName: r.source_name || '', createdAt: r.created_at, updatedAt: r.updated_at });

  /** The fields of an item from a request body; throws a message the admin page shows. */
  function itemFields(body, partial = false) {
    const f = {};
    const has = k => body[k] !== undefined;
    if (!partial || has('title')) { f.title = clean(body.title, 200); if (!f.title) throw new ApiError(400, 'Give the item a title.'); }
    if (!partial || has('url')) { f.url = cleanUrl(body.url); if (!f.url) throw new ApiError(400, 'The link must start with http:// or https://.'); }
    if (!partial || has('summary')) f.summary = clean(body.summary, 500);
    if (!partial || has('company')) f.company = clean(body.company, 80);
    if (!partial || has('kind')) { f.kind = KINDS.includes(body.kind) ? body.kind : 'news'; }
    if (!partial || has('cost')) { f.cost = COSTS.includes(body.cost) ? body.cost : 'unknown'; }
    if (!partial || has('priceNote')) f.price_note = clean(body.priceNote, 80);
    if (!partial || has('tags')) f.tags = tagList(body.tags).join(',');
    if (!partial || has('publishedAt')) { const d = new Date(body.publishedAt || Date.now()); f.published_at = Number.isNaN(d.getTime()) ? now() : d.toISOString(); }
    return f;
  }

  // ----- public: the News page -----
  add('GET', '/api/news', { public: true }, (req, res, { ip, query }) => {
    if (limiter.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    limiter.hit(ip);
    const where = ["status = 'published'"], params = [];
    const kind = String(query.get('kind') || ''), cost = String(query.get('cost') || ''), company = clean(query.get('company'), 80), q = clean(query.get('q'), 80);
    if (KINDS.includes(kind)) { where.push('kind = ?'); params.push(kind); }
    if (['free', 'paid'].includes(cost)) { where.push('cost = ?'); params.push(cost); }
    if (company) { where.push('company = ? COLLATE NOCASE'); params.push(company); }
    if (q) { where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')"); const t = likeTerm(q); params.push(t, t, t, t); }
    const total = one(`SELECT COUNT(*) AS n FROM news_items WHERE ${where.join(' AND ')}`, ...params).n;
    const page = intIn(query.get('page'), 1, 500, 1);
    const rows = all(`SELECT * FROM news_items WHERE ${where.join(' AND ')} ORDER BY published_at DESC, id DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, ...params);
    return {
      total, page, pages: Math.max(1, Math.ceil(total / PAGE)), items: rows.map(publicItem),
      companies: all("SELECT company AS name, COUNT(*) AS n FROM news_items WHERE status = 'published' AND company <> '' GROUP BY company COLLATE NOCASE ORDER BY n DESC, company LIMIT 60").map(r => ({ name: r.name, count: r.n })),
    };
  });

  // ----- a member: items that fit their resume and the companies they searched -----
  add('GET', '/api/news/for-you', { public: true }, (req) => {
    const c = me(req);
    const r = one('SELECT source_text FROM career_resumes WHERE customer_id = ?', c.id);
    if (!r) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1) to see news and trainings picked for you.', 'no-resume');
    const extra = all('SELECT role FROM career_versions WHERE customer_id = ?', c.id).map(v => v.role);
    const profile = profileOf(r.source_text, extra);
    const companies = new Set();
    for (const s of all("SELECT result_json FROM career_job_searches WHERE customer_id = ? AND status = 'done' ORDER BY id DESC LIMIT 3", c.id)) {
      const res = parse(s.result_json);
      for (const j of (res && res.jobs) || []) if (j && j.company) companies.add(String(j.company));
    }
    const known = all("SELECT DISTINCT company FROM news_items WHERE status = 'published' AND company <> ''").map(x => x.company).filter(n => n.length > 2 && wordRe(n).test(r.source_text));
    known.forEach(n => companies.add(n));
    const pool = all("SELECT * FROM news_items WHERE status = 'published' ORDER BY published_at DESC LIMIT 400");
    const ranked = pool.map(row => { const it = publicItem(row); const m = match(it, { skills: profile.skills, roles: profile.roles, companies: [...companies] }); return { it, ...m }; })
      .filter(x => x.score >= 10).sort((a, b) => b.score - a.score || b.it.publishedAt.localeCompare(a.it.publishedAt)).slice(0, 30);
    return {
      items: ranked.map(x => ({ ...x.it, score: x.score, reasons: x.reasons })),
      basedOn: { skills: profile.skills.slice(0, 12), roles: profile.roles.slice(0, 3), companies: [...companies].slice(0, 12) },
      message: ranked.length ? '' : (pool.length ? 'Nothing published matches your resume yet. Check the latest items, or add skills to your resume.' : 'No items are published yet.'),
    };
  });

  // ----- admin: items -----
  add('GET', '/admin/api/news', { admin: true }, (req, res, { query }) => {
    const status = String(query.get('status') || '');
    const rows = all(`SELECT n.*, s.name AS source_name FROM news_items n LEFT JOIN news_sources s ON s.id = n.source_id ${STATUSES.includes(status) ? 'WHERE n.status = ?' : ''} ORDER BY n.published_at DESC, n.id DESC LIMIT 300`, ...(STATUSES.includes(status) ? [status] : []));
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM news_items GROUP BY status').map(r => [r.status, r.n]));
    return { items: rows.map(adminItem), counts, sources: sourceRows() };
  });

  add('POST', '/admin/api/news', { admin: true, perm: 'news.write' }, (req, res, { body, admin }) => {
    const f = itemFields(body);
    const status = body.publish === false ? 'draft' : 'published';
    if (one('SELECT id FROM news_items WHERE url = ?', f.url)) throw new ApiError(409, 'An item with this link already exists.');
    const info = db.prepare(`INSERT INTO news_items (title, summary, url, company, kind, cost, price_note, tags, published_at, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(f.title, f.summary, f.url, f.company, f.kind, f.cost, f.price_note, f.tags, f.published_at, status, now(), now());
    audit(admin, 'news.created', f.title, status);
    return adminItem(one('SELECT * FROM news_items WHERE id = ?', info.lastInsertRowid));
  });

  add('PATCH', '/admin/api/news/:id', { admin: true, perm: 'news.write' }, (req, res, { params, body, admin }) => {
    const row = one('SELECT * FROM news_items WHERE id = ?', params.id);
    if (!row) throw new ApiError(404, 'Item not found');
    const f = itemFields(body, true);
    if (f.url && f.url !== row.url && one('SELECT id FROM news_items WHERE url = ? AND id <> ?', f.url, row.id)) throw new ApiError(409, 'Another item has this link.');
    if (body.status !== undefined) { if (!STATUSES.includes(body.status)) throw new ApiError(400, 'Unknown status'); f.status = body.status; }
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE news_items SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => f[k]), now(), row.id);
    audit(admin, 'news.updated', row.title, f.status || '');
    return adminItem(one('SELECT * FROM news_items WHERE id = ?', row.id));
  });

  add('DELETE', '/admin/api/news/:id', { admin: true, perm: 'news.write' }, (req, res, { params, admin }) => {
    const row = one('SELECT * FROM news_items WHERE id = ?', params.id);
    if (!row) throw new ApiError(404, 'Item not found');
    db.prepare('DELETE FROM news_items WHERE id = ?').run(row.id);
    audit(admin, 'news.deleted', row.title);
    return { ok: true };
  });

  // ----- admin: the feeds that suggest items -----
  const sourceRows = () => all('SELECT * FROM news_sources ORDER BY name').map(s => ({ id: s.id, name: s.name, company: s.company, feedUrl: s.feed_url, kind: s.kind, cost: s.cost, enabled: !!s.enabled, lastFetchAt: s.last_fetch_at, lastError: s.last_error, lastAdded: s.last_added }));

  add('POST', '/admin/api/news-sources', { admin: true, perm: 'news.write' }, (req, res, { body, admin }) => {
    const feedUrl = cleanUrl(body.feedUrl), name = clean(body.name, 80) || clean(body.company, 80);
    if (!feedUrl) throw new ApiError(400, 'The feed address must start with http:// or https://.');
    if (!name) throw new ApiError(400, 'Give the source a name.');
    if (!ctx.newsAllowLocal && privateHost(new URL(feedUrl).hostname)) throw new ApiError(400, 'Feeds on private addresses are not read.');
    if (one('SELECT id FROM news_sources WHERE feed_url = ?', feedUrl)) throw new ApiError(409, 'This feed is already listed.');
    const info = db.prepare('INSERT INTO news_sources (name, company, feed_url, kind, cost, enabled, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(name, clean(body.company, 80) || name, feedUrl, KINDS.includes(body.kind) ? body.kind : 'news', COSTS.includes(body.cost) ? body.cost : 'unknown', now());
    audit(admin, 'news.source.added', name, feedUrl);
    return sourceRows().find(s => s.id === Number(info.lastInsertRowid));
  });

  add('PATCH', '/admin/api/news-sources/:id', { admin: true, perm: 'news.write' }, (req, res, { params, body, admin }) => {
    const s = one('SELECT * FROM news_sources WHERE id = ?', params.id);
    if (!s) throw new ApiError(404, 'Source not found');
    db.prepare('UPDATE news_sources SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, s.id);
    audit(admin, 'news.source.updated', s.name, body.enabled ? 'on' : 'off');
    return { ok: true };
  });

  add('DELETE', '/admin/api/news-sources/:id', { admin: true, perm: 'news.write' }, (req, res, { params, admin }) => {
    const s = one('SELECT * FROM news_sources WHERE id = ?', params.id);
    if (!s) throw new ApiError(404, 'Source not found');
    db.prepare('DELETE FROM news_sources WHERE id = ?').run(s.id);
    audit(admin, 'news.source.deleted', s.name);
    return { ok: true };
  });

  /** Reads one source: new entries become pending drafts (never published). Returns how many were added. */
  async function fetchSource(s) {
    let added = 0, error = '';
    try {
      for (const e of await readFeed(s.feed_url, { allowLocal: !!ctx.newsAllowLocal })) {
        if (one('SELECT id FROM news_items WHERE url = ?', e.url)) continue;
        db.prepare(`INSERT INTO news_items (title, summary, url, company, kind, cost, price_note, tags, published_at, status, source_id, created_at, updated_at) VALUES (?,?,?,?,?,?,'','',?,'pending',?,?,?)`)
          .run(e.title, e.summary, e.url, s.company, s.kind, s.cost, e.publishedAt, s.id, now(), now());
        added++;
      }
    } catch (err) { error = clean(err && err.message, 200) || 'The feed could not be read'; }
    db.prepare('UPDATE news_sources SET last_fetch_at = ?, last_error = ?, last_added = ? WHERE id = ?').run(now(), error, added, s.id);
    return { added, error };
  }
  /** Reads every enabled source; one that fails does not stop the others. */
  async function fetchAll() {
    let added = 0, failed = 0;
    for (const s of all('SELECT * FROM news_sources WHERE enabled = 1 ORDER BY id')) { const r = await fetchSource(s); added += r.added; if (r.error) failed++; }
    return { added, failed };
  }
  fetcher = { fetchAll, fetchSource };

  add('POST', '/admin/api/news-sources/fetch', { admin: true, perm: 'news.write' }, async (req, res, { admin }) => {
    const r = await fetchAll();
    audit(admin, 'news.fetched', '', r.added + ' new, ' + r.failed + ' failed');
    return { ...r, sources: sourceRows() };
  });
}

/** Every NEWS_FETCH_HOURS (default 12; 0 turns it off) read the listed feeds, so there are new drafts to look at. */
function scheduleFetch() {
  const hours = process.env.NEWS_FETCH_HOURS === undefined ? 12 : Number(process.env.NEWS_FETCH_HOURS);
  if (!(hours > 0) || !fetcher) return null;
  const run = () => fetcher.fetchAll().catch(err => console.error('News fetch failed:', err));
  setTimeout(run, 2 * 60 * 1000).unref();
  return setInterval(run, hours * HOUR).unref();
}

module.exports = { addRoutes, scheduleFetch, parseFeed, match, readFeed, privateHost };
