'use strict';
// The public Jobs page (website: Jobs): everyone can browse the jobs the server already holds from career sites, with
// filters, without signing in. Only what a job board shows is sent (title, company, place, date and the company's own
// apply link): never the description. The live Live Search and the recommendations from a resume need a sign-in (career.js,
// jobs.js, recommended.js).

const { ApiError, likeTerm } = require('./http');
const auth = require('./auth');
const { companyDomain, CATALOGUE, SECTORS } = require('./jobcatalogue');
const { descriptionOf } = require('./jobtext');
const { INDIA_COMPANIES } = require('./jobcatalogue-india');

const DAY = 86400000;
const MAX_SIZE = 50;
const MAX_PAGES = 200;
const FILTERS_FOR = 5 * 60000;
const MAX_TEXT = 15000;   // characters of a job description sent to the page

/** The employers of a sector (the same lists Live Search uses by default), and every employer that is in some sector. */
const sectorNames = id => (id === 'it' ? CATALOGUE.map(c => c.name) : ((SECTORS.find(x => x.id === id) || {}).companies || [])).concat(INDIA_COMPANIES.filter(c => c.sector === id).map(c => c.name));
const LISTED = [...new Set(SECTORS.filter(x => x.id !== 'other').flatMap(x => sectorNames(x.id)))];
/** A job's date for ordering and "posted within": when it was posted, else when we first saw it; never later than now. */
const WHEN = 'MIN(COALESCE(j.posted_at, j.first_seen), ?)';

function addRoutes(ctx) {
  const { db, add, one, all } = ctx;
  const limiter = new auth.Limiter({ max: 120, windowMs: 60000 });   // per address: a person browsing, not a scraper
  const readLimiter = new auth.Limiter({ max: 40, windowMs: 60000 });   // reading a description can ask the career site, so it is limited more
  const fetchOpts = { base: ctx.jobSourceBase || {} };
  let filtersAt = 0, filtersData = null;

  // (a missing value is the fallback: Number(null) would be 0)
  const intIn = (v, min, max, fallback) => { const n = v === null || v === undefined || v === '' ? NaN : Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };

  /** What the filters offer: the countries, companies and job types of the jobs held, with their counts. */
  add('GET', '/api/jobs/filters', { public: true }, (req, res, { ip }) => {
    if (limiter.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    limiter.hit(ip);
    if (filtersData && Date.now() - filtersAt < FILTERS_FOR) return filtersData;
    const live = "FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE j.active = 1 AND c.enabled = 1";
    filtersData = {
      total: one(`SELECT COUNT(*) AS n ${live}`).n,
      companyCount: one(`SELECT COUNT(DISTINCT j.company_id) AS n ${live}`).n,
      updatedAt: (one(`SELECT MAX(j.last_seen) AS t ${live}`) || {}).t || null,
      countries: all(`SELECT j.country AS name, COUNT(*) AS n ${live} AND j.country <> '' GROUP BY j.country ORDER BY n DESC LIMIT 40`).map(r => ({ name: r.name, count: r.n })),
      companies: all(`SELECT c.name AS name, COUNT(*) AS n ${live} GROUP BY c.id ORDER BY n DESC, c.name LIMIT 150`).map(r => ({ name: r.name, count: r.n })),
      types: all(`SELECT j.employment_type AS name, COUNT(*) AS n ${live} AND j.employment_type <> '' GROUP BY j.employment_type ORDER BY n DESC LIMIT 12`).map(r => ({ name: r.name, count: r.n })),
    };
    const perCompany = new Map(all(`SELECT c.name AS name, COUNT(*) AS n ${live} GROUP BY c.id`).map(r => [r.name, r.n]));
    const sum = names => [...new Set(names)].reduce((n, name) => n + (perCompany.get(name) || 0), 0);
    filtersData.sectors = SECTORS.map(x => ({ id: x.id, label: x.label,
      count: x.id === 'other' ? filtersData.total - sum(LISTED) : sum(sectorNames(x.id)) }));
    filtersAt = Date.now();
    return filtersData;
  });

  /**
   * "Show job details": the description of one job, read from the company's own career page the first time (and kept for a
   * week), else the start of it that the job list gave. Plain text. source: 'full', 'snippet' (only the start) or 'none'.
   */
  add('GET', '/api/jobs/:id/description', { public: true }, async (req, res, { params, ip }) => {
    if (readLimiter.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    readLimiter.hit(ip);
    const id = Number(params.id);
    const job = Number.isInteger(id) && one(`SELECT j.id, j.title, j.url, c.name AS company FROM jobs j JOIN job_companies c ON c.id = j.company_id
                                                WHERE j.id = ? AND j.active = 1 AND c.enabled = 1`, id);
    if (!job) throw new ApiError(404, 'This job is no longer listed.');
    const text = String(await descriptionOf(db, id, fetchOpts) || '')
      .replace(/&nbsp;|&#160;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')   // entities some boards leave in
      .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();   // shown as plain text by the page, never as HTML
    const row = one('SELECT description, full_description, full_fetched_at FROM jobs WHERE id = ?', id);
    const full = !!(row && row.full_fetched_at && String(row.full_description || '').length > String(row.description || '').length);
    return { id: job.id, title: job.title, company: job.company, url: job.url, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, source: !text ? 'none' : full ? 'full' : 'snippet' };
  });

  /**
   * One page of jobs: ?q=java developer&country=India&city=Pune&company=Adobe&type=Full time&days=7|14|30&remote=1&sort=new|oldest&page=1&size=20
   * Every word of q must be in the title, team or company name.
   */
  add('GET', '/api/jobs', { public: true }, (req, res, { query, ip }) => {
    if (limiter.blocked(ip)) throw new ApiError(429, 'Too many requests. Please try again in a minute.');
    limiter.hit(ip);
    const where = ['j.active = 1', 'c.enabled = 1'], params = [];
    const words = String(query.get('q') || '').toLowerCase().split(/[\s,]+/).map(w => w.trim().slice(0, 40)).filter(Boolean).slice(0, 5);
    for (const w of words) {
      where.push("(lower(j.title) LIKE ? ESCAPE '\\' OR lower(j.department) LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\')");
      const t = likeTerm(w); params.push(t, t, t);
    }
    const country = String(query.get('country') || '').trim().slice(0, 80);
    if (country) { where.push("(j.country = ? OR j.location LIKE ? ESCAPE '\\')"); params.push(country, likeTerm(country)); }
    const city = String(query.get('city') || '').trim().slice(0, 80);
    if (city) { where.push("j.location LIKE ? ESCAPE '\\'"); params.push(likeTerm(city)); }
    const company = String(query.get('company') || '').trim().slice(0, 100);
    if (company) { where.push('c.name = ?'); params.push(company); }
    const type = String(query.get('type') || '').trim().slice(0, 40);
    if (type) { where.push('j.employment_type = ?'); params.push(type); }
    const sector = String(query.get('sector') || '').trim();
    if (sector && SECTORS.some(x => x.id === sector)) {
      const names = sector === 'other' ? LISTED : sectorNames(sector);
      if (names.length) { where.push(`c.name ${sector === 'other' ? 'NOT IN' : 'IN'} (${names.map(() => '?').join(',')})`); params.push(...names); }
    }
    const nowIso = new Date().toISOString();
    const days = [7, 14, 30].includes(Number(query.get('days'))) ? Number(query.get('days')) : 0;
    if (days) { where.push(`${WHEN} >= ?`); params.push(nowIso, new Date(Date.now() - days * DAY).toISOString()); }
    if (query.get('remote') === '1') where.push("(j.location LIKE '%remote%' OR j.country = 'Remote')");

    const from = `FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE ${where.join(' AND ')}`;
    const size = intIn(query.get('size'), 1, MAX_SIZE, 20);
    const total = one(`SELECT COUNT(*) AS n ${from}`, ...params).n;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = intIn(query.get('page'), 1, Math.min(pages, MAX_PAGES), 1);
    const order = `${WHEN} ${query.get('sort') === 'oldest' ? 'ASC' : 'DESC'}`;   // the latest first
    const rows = all(`SELECT j.id, j.title, j.location, j.country, j.department, j.employment_type, j.posted_at, j.first_seen, j.url, c.name AS company, c.careers_url
                      ${from} ORDER BY ${order}, j.id DESC LIMIT ? OFFSET ?`, ...params, nowIso, size, (page - 1) * size);
    return {
      total, page, pages, size,
      jobs: rows.map(r => ({ id: r.id, title: r.title, company: r.company, location: r.location, country: r.country, department: r.department, type: r.employment_type,
        postedAt: r.posted_at, addedAt: r.first_seen, url: r.url, domain: companyDomain(r.company, r.careers_url) })),
    };
  });
}

module.exports = { addRoutes };
