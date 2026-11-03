'use strict';
// The public Jobs page (website: Jobs): everyone can browse the jobs the server already holds from career sites, with
// filters, without signing in. Only what a job board shows is sent (title, company, place, date and the company's own
// apply link): never the description. The live AI search and the recommendations from a resume need a sign-in (career.js,
// jobs.js, recommended.js).

const { ApiError, likeTerm } = require('./http');
const auth = require('./auth');
const { companyDomain } = require('./jobcatalogue');

const DAY = 86400000;
const MAX_SIZE = 50;
const MAX_PAGES = 200;
const FILTERS_FOR = 5 * 60000;

function addRoutes(ctx) {
  const { db, add, one, all } = ctx;
  const limiter = new auth.Limiter({ max: 120, windowMs: 60000 });   // per address: a person browsing, not a scraper
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
    filtersAt = Date.now();
    return filtersData;
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
    const days = [7, 14, 30].includes(Number(query.get('days'))) ? Number(query.get('days')) : 0;
    if (days) { where.push('j.posted_at >= ?'); params.push(new Date(Date.now() - days * DAY).toISOString()); }
    if (query.get('remote') === '1') where.push("(j.location LIKE '%remote%' OR j.country = 'Remote')");

    const from = `FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE ${where.join(' AND ')}`;
    const size = intIn(query.get('size'), 1, MAX_SIZE, 20);
    const total = one(`SELECT COUNT(*) AS n ${from}`, ...params).n;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = intIn(query.get('page'), 1, Math.min(pages, MAX_PAGES), 1);
    const order = query.get('sort') === 'oldest' ? 'j.posted_at IS NULL, j.posted_at ASC' : 'j.posted_at IS NULL, j.posted_at DESC';
    const rows = all(`SELECT j.id, j.title, j.location, j.country, j.department, j.employment_type, j.posted_at, j.url, c.name AS company, c.careers_url
                      ${from} ORDER BY ${order}, j.id DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
    return {
      total, page, pages, size,
      jobs: rows.map(r => ({ id: r.id, title: r.title, company: r.company, location: r.location, country: r.country, department: r.department, type: r.employment_type,
        postedAt: r.posted_at, url: r.url, domain: companyDomain(r.company, r.careers_url) })),
    };
  });
}

module.exports = { addRoutes };
