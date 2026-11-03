'use strict';
// The public Jobs page: anyone can browse the jobs the server holds, with filters; nothing private is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-board-')) });
  const base = await listen(app.server);
  const get = async url => { const r = await fetch(base + url); return { status: r.status, json: await r.json() }; };
  const co = (name, enabled = 1) => Number(app.db.prepare("INSERT INTO job_companies (name, careers_url, provider, board, enabled, created_at) VALUES (?,?,'greenhouse',?,?,datetime('now'))")
    .run(name, `https://boards.greenhouse.io/${name.toLowerCase()}`, name.toLowerCase(), enabled).lastInsertRowid);
  const acme = co('Acme'), beta = co('Beta'), gone = co('Gone', 0);
  const n = { v: 0 };
  const put = (company, title, o = {}) => app.db.prepare(`INSERT INTO jobs (company_id, external_id, title, location, country, department, employment_type, posted_at, url, description, active, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(company, 'x' + (++n.v), title, o.location === undefined ? 'Bengaluru, India' : o.location, o.country === undefined ? 'India' : o.country,
    o.department || '', o.type || 'Full time', o.postedAt === undefined ? daysAgo(2) : o.postedAt, 'https://jobs.example.com/' + n.v, o.description || 'SECRET DESCRIPTION TEXT', o.active === undefined ? 1 : o.active, o.firstSeen || daysAgo(30));
  put(acme, 'Java Backend Developer', { department: 'Engineering' });
  put(acme, 'Staff Nurse', { department: 'Care', location: 'Pune, India', postedAt: daysAgo(3) });
  put(beta, 'Senior Java Engineer', { location: 'Remote', country: 'India', postedAt: daysAgo(20), type: 'Contract' });
  put(beta, 'Java Developer', { location: 'Austin, TX', country: 'United States', postedAt: daysAgo(40) });
  put(beta, 'Closed Java Role', { active: 0 });
  put(gone, 'Java Developer at a switched-off company');
  put(beta, 'Data Analyst', { postedAt: null, firstSeen: daysAgo(1) });   // no posted date: the day we first saw it counts
  return { app, get, close: app.close, put, acme, beta };
}

test('browse: anyone can list jobs without signing in, and the description is never sent', async () => {
  const s = await start();
  try {
    const r = await s.get('/api/jobs');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 5, 'closed jobs and jobs of a switched-off company are left out');
    assert.deepEqual(Object.keys(r.json.jobs[0]).sort(), ['addedAt', 'company', 'country', 'department', 'domain', 'id', 'location', 'postedAt', 'title', 'type', 'url']);
    assert.ok(!JSON.stringify(r.json).includes('SECRET DESCRIPTION'));
    assert.deepEqual([r.json.page, r.json.pages, r.json.size], [1, 1, 20]);
    assert.deepEqual(r.json.jobs.map(j => j.title), ['Data Analyst', 'Java Backend Developer', 'Staff Nurse', 'Senior Java Engineer', 'Java Developer'],
      'the latest first: a job with no posted date counts from the day it was first seen, so it is not pushed to the end');
    assert.match(r.json.jobs[0].url, /^https:\/\/jobs\.example\.com\//);
  } finally { await s.close(); }
});

test('browse: every word of the search, the country, city, company, type, date, remote and sort filters', async () => {
  const s = await start();
  try {
    const titles = async q => (await s.get('/api/jobs' + q)).json.jobs.map(j => j.title).sort();
    assert.deepEqual(await titles('?q=java'), ['Java Backend Developer', 'Java Developer', 'Senior Java Engineer']);
    assert.deepEqual(await titles('?q=java%20backend'), ['Java Backend Developer'], 'every word must be there');
    assert.deepEqual(await titles('?q=engineering'), ['Java Backend Developer'], 'the team counts');
    assert.deepEqual(await titles('?q=beta'), ['Data Analyst', 'Java Developer', 'Senior Java Engineer'], 'the company name counts');
    assert.deepEqual(await titles('?q=JAVA'), ['Java Backend Developer', 'Java Developer', 'Senior Java Engineer'], 'any case');
    assert.deepEqual(await titles('?q=%25'), [], 'a percent sign is not a wildcard');
    assert.deepEqual(await titles('?country=United%20States'), ['Java Developer']);
    assert.deepEqual(await titles('?country=India'), ['Data Analyst', 'Java Backend Developer', 'Senior Java Engineer', 'Staff Nurse']);
    assert.deepEqual(await titles('?city=pune'), ['Staff Nurse']);
    assert.deepEqual(await titles('?company=Acme'), ['Java Backend Developer', 'Staff Nurse']);
    assert.deepEqual(await titles('?type=Contract'), ['Senior Java Engineer']);
    assert.deepEqual(await titles('?days=7'), ['Data Analyst', 'Java Backend Developer', 'Staff Nurse'], 'no posted date: first seen yesterday');
    assert.deepEqual(await titles('?days=30'), ['Data Analyst', 'Java Backend Developer', 'Senior Java Engineer', 'Staff Nurse']);
    assert.deepEqual(await titles('?remote=1'), ['Senior Java Engineer']);
    assert.deepEqual(await titles('?q=java&country=India&days=30&company=Beta'), ['Senior Java Engineer'], 'filters work together');
    const oldest = (await s.get('/api/jobs?sort=oldest')).json.jobs.map(j => j.title);
    assert.equal(oldest[0], 'Java Developer', 'the oldest first');
  } finally { await s.close(); }
});

test('browse: pages, and sizes kept within limits', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 60; i++) s.put(s.acme, 'Bulk Job ' + i, { postedAt: daysAgo(1) });
    const p1 = (await s.get('/api/jobs?q=bulk&size=25')).json;
    assert.deepEqual([p1.total, p1.pages, p1.page, p1.jobs.length], [60, 3, 1, 25]);
    const p3 = (await s.get('/api/jobs?q=bulk&size=25&page=3')).json;
    assert.equal(p3.jobs.length, 10);
    assert.equal((await s.get('/api/jobs?q=bulk&size=25&page=99')).json.page, 3, 'a page past the end is the last page');
    assert.equal((await s.get('/api/jobs?q=bulk&size=1000')).json.jobs.length, 50, 'at most 50 a page');
    const ids = new Set([...p1.jobs, ...p3.jobs, ...(await s.get('/api/jobs?q=bulk&size=25&page=2')).json.jobs].map(j => j.id));
    assert.equal(ids.size, 60, 'no job twice, none missing');
  } finally { await s.close(); }
});

test('filters list: countries, companies and job types with counts, for the filter menus', async () => {
  const s = await start();
  try {
    const f = (await s.get('/api/jobs/filters')).json;
    assert.equal(f.total, 5);
    assert.equal(f.companyCount, 2, 'the switched-off company is not counted');
    assert.deepEqual(f.countries[0], { name: 'India', count: 4 });
    assert.ok(f.countries.some(c => c.name === 'United States'));
    assert.deepEqual(f.companies.map(c => c.name).sort(), ['Acme', 'Beta']);
    assert.ok(f.types.some(t => t.name === 'Full time') && f.types.some(t => t.name === 'Contract'));
    assert.ok(f.updatedAt);
  } finally { await s.close(); }
});

test('browse: too many requests from one address are slowed down', async () => {
  const s = await start();
  try {
    let last;
    for (let i = 0; i < 125; i++) last = await s.get('/api/jobs?q=x' + i);
    assert.equal(last.status, 429);
  } finally { await s.close(); }
});

test('the website has a Jobs page in the menu, not hidden from search engines', () => {
  const layout = fs.readFileSync(path.join(__dirname, '..', 'website', 'layout.html'), 'utf8');
  assert.match(layout, /<nav id="menu"[\s\S]*<a href="jobs\.html" data-page="jobs">Jobs<\/a>/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'website', 'pages', 'jobs.html'), 'utf8');
  assert.ok(!/noindex/.test(page.split('\n')[0]), 'the Jobs page can be found by search engines');
  for (const id of ['jb-form', 'jb-results', 'jb-pager', 'jb-ai-actions', 'jb-for-you', 'jb-lead']) assert.ok(page.includes(`id="${id}"`), id);
});

test('browse: a job dated in the future is not put above the jobs of today', async () => {
  const s = await start();
  try {
    s.put(s.acme, 'Future Dated Job', { postedAt: new Date(Date.now() + 30 * 86400000).toISOString(), firstSeen: daysAgo(0) });
    const first = (await s.get('/api/jobs')).json.jobs.map(j => j.title);
    assert.ok(first.indexOf('Future Dated Job') <= 1, 'treated as today, not as a month from now');
    assert.equal(first[0] === 'Future Dated Job' || first[1] === 'Future Dated Job', true);
    // and a job posted today comes before one posted yesterday even when both are in the future-capped range
    s.put(s.acme, 'Posted Today', { postedAt: daysAgo(0) });
    const again = (await s.get('/api/jobs?size=3')).json.jobs.map(j => j.title);
    assert.ok(again.includes('Posted Today'));
  } finally { await s.close(); }
});

test('browse: a sector shows only the employers of that sector, and the filters count them', async () => {
  const s = await start();
  try {
    const co = name => Number(s.app.db.prepare("INSERT INTO job_companies (name, careers_url, provider, board, created_at) VALUES (?,?,'greenhouse',?,datetime('now'))").run(name, 'https://boards.greenhouse.io/' + name, name.toLowerCase()).lastInsertRowid);
    const stripe = co('Stripe'), pfizer = co('Pfizer'), unknown = co('Zeta Unknown Co');
    s.put(stripe, 'Payments Engineer');
    s.put(pfizer, 'Clinical Research Associate');
    s.put(pfizer, 'Quality Chemist');
    s.put(unknown, 'Odd Job');
    const titles = async q => (await s.get('/api/jobs' + q)).json.jobs.map(j => j.title).sort();
    assert.deepEqual(await titles('?sector=it&q=engineer'), ['Payments Engineer'], 'Stripe is in the IT list');
    assert.deepEqual(await titles('?sector=pharma'), ['Clinical Research Associate', 'Quality Chemist']);
    assert.ok(!(await titles('?sector=pharma')).includes('Payments Engineer'));
    const other = await titles('?sector=other');
    assert.ok(other.includes('Odd Job') && other.includes('Data Analyst') && !other.includes('Payments Engineer') && !other.includes('Quality Chemist'), 'other: the employers in no sector list');
    assert.equal((await s.get('/api/jobs?sector=nonsense')).json.total, (await s.get('/api/jobs')).json.total, 'an unknown sector is ignored');
    assert.deepEqual(await titles('?sector=pharma&q=chemist'), ['Quality Chemist'], 'with the other filters');
    const f = (await s.get('/api/jobs/filters')).json;
    const count = id => f.sectors.find(x => x.id === id).count;
    assert.equal(count('it'), 1);
    assert.equal(count('pharma'), 2);
    assert.equal(count('other'), f.total - 3, 'the rest');
    assert.deepEqual(f.sectors.map(x => x.id).sort(), ['agri', 'biotech', 'finance', 'fmcg', 'it', 'manufacturing', 'other', 'pharma']);
  } finally { await s.close(); }
});
