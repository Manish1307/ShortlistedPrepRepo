'use strict';
// Find jobs: companies' careers boards (Greenhouse, Lever, SmartRecruiters, Ashby, Workday) are synced into the
// database; candidates filter and page through the active jobs; the admin's Master Prompt scores them with the AI.
// A fake job board and a fake Gemini stand in for the real services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const aikeys = require('../admin/lib/aikeys');
const sources = require('../admin/lib/jobsources');
const { DEFAULT_MASTER_PROMPT } = require('../admin/lib/jobs');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

/** A fake of the five job-board APIs. greenhouse.jobs can be changed between syncs. */
async function fakeBoards() {
  const state = {
    greenhouse: [
      { id: 1, title: 'Senior .NET Developer', location: { name: 'Bengaluru, India' }, departments: [{ name: 'Engineering' }], first_published: daysAgo(1), absolute_url: 'https://boards.greenhouse.io/contoso/jobs/1', content: '&lt;p&gt;C#, ASP.NET Core, Azure&lt;/p&gt;' },
      { id: 2, title: 'Scrum Master', location: { name: 'Pune, India' }, first_published: daysAgo(10), absolute_url: 'https://boards.greenhouse.io/contoso/jobs/2', content: 'Agile, Jira' },
      { id: 3, title: 'Data Engineer', location: { name: 'London, UK' }, first_published: daysAgo(40), absolute_url: 'https://boards.greenhouse.io/contoso/jobs/3', content: 'Spark' },
      { id: 4, title: 'Sales Executive', location: { name: 'Remote' }, first_published: daysAgo(2), absolute_url: 'http://not-https.example/4', content: '' },
    ],
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const send = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
      if (u.pathname === '/gh/contoso/jobs') return send({ jobs: state.greenhouse });
      if (u.pathname === '/gh/missing/jobs') { res.statusCode = 404; return res.end('{}'); }
      if (u.pathname === '/lever/fabrikam') return send([{ id: 'l1', text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/fabrikam/l1', createdAt: Date.now() - 86400000, country: 'IN', categories: { location: 'Hyderabad', team: 'Platform', commitment: 'Full-time' }, descriptionPlain: 'Node.js' }]);
      if (u.pathname === '/sr/Northwind/postings') {
        const offset = Number(u.searchParams.get('offset'));
        const all = Array.from({ length: 150 }, (_, i) => ({ id: 's' + i, name: 'QA Engineer ' + i, releasedDate: daysAgo(3), location: { city: 'Chennai', country: 'in' }, department: { label: 'Quality' } }));
        return send({ totalFound: 150, content: all.slice(offset, offset + 100) });
      }
      if (u.pathname === '/ashby/tailspin') return send({ jobs: [{ id: 'a1', title: '  Product   Manager, Payments ', location: 'Singapore', publishedAt: daysAgo(5), jobUrl: 'https://jobs.ashbyhq.com/tailspin/a1', isListed: true, descriptionPlain: 'Roadmaps' }, { id: 'a2', title: 'Hidden role', isListed: false, jobUrl: 'https://jobs.ashbyhq.com/tailspin/a2' }] });
      if (u.pathname === '/wd/wday/cxs/woodgrove/External/jobs') {
        const body = JSON.parse(raw || '{}');
        const all = Array.from({ length: 25 }, (_, i) => ({ title: 'Cloud Engineer ' + i, externalPath: '/job/Pune/Cloud_' + i, locationsText: 'Pune, India', postedOn: i === 0 ? 'Posted Today' : i === 1 ? 'Posted Yesterday' : 'Posted 30+ Days Ago', bulletFields: ['R' + i] }));
        return send({ total: body.offset === 0 ? 25 : 0, jobPostings: all.slice(body.offset, body.offset + body.limit) });
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  const base = await listen(server);
  return { state, base, sourceBase: { greenhouse: base + '/gh', lever: base + '/lever', smartrecruiters: base + '/sr', ashby: base + '/ashby', workday: base + '/wd' }, close: () => new Promise(r => server.close(r)) };
}

/** Fake Gemini for the matching: scores every job id it is shown, plus one made-up id that must be ignored. */
async function fakeGemini() {
  const seen = [];
  let onlyMadeUp = false;   // answer with made-up ids only
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      const ids = [...body.contents[0].parts[0].text.matchAll(/"id":(\d+)/g)].map(m => Number(m[1]));
      const matches = onlyMadeUp ? [] : ids.map((id, i) => ({ id, score: [88, 62, 30][i % 3], bucket: ['high', 'medium', 'stretch'][i % 3], reason: 'Because ' + id, gap: i % 3 ? 'Kubernetes' : 'none' }));
      matches.push({ id: 999999, score: 99, bucket: 'high', reason: 'made up' });
      const out = { profile: { seniority: 'Mid-level (6 years)', targetRoles: ['.NET Developer', 'Scrum Master'], summary: 'Strong .NET engineer.' }, matches };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
    });
  });
  const base = await listen(server);
  return { base, seen, madeUpOnly: v => { onlyMadeUp = v; }, close: () => new Promise(r => server.close(r)) };
}

async function start() {
  const boards = await fakeBoards(), ai = await fakeGemini();
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jobs-')), aiUpstream: { gemini: ai.base }, jobSourceBase: boards.sourceBase });
  const base = await listen(app.server);
  aikeys.addKey(app.db, app.vault, { provider: 'gemini', label: 'Gemini', key: 'AIza' + 'g'.repeat(35) + 'GGGG', makeDefault: true });
  for (const [mail, role] of [['boss@example.com', 'owner'], ['help@example.com', 'support']]) {
    app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(mail, mail, role, hashPassword('correct-horse-battery'));
  }
  const cust = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('asha@example.com', 'Asha', datetime('now'))").run().lastInsertRowid;
  app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(cust, hashPassword('a-long-password'));
  const admin = async email => {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: r.status, json: await r.json() };
    };
    await call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' });
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), del: u => call('DELETE', u) };
  };
  const site = async () => {
    const { token } = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'a-long-password' }) }).then(r => r.json());
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
  };
  return { app, base, boards, ai, admin, site, stop: async () => { await app.close(); await boards.close(); await ai.close(); } };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('careers URLs are recognised for each job board', () => {
  assert.deepEqual(sources.parseBoardUrl('https://boards.greenhouse.io/contoso'), { provider: 'greenhouse', board: 'contoso' });
  assert.deepEqual(sources.parseBoardUrl('https://job-boards.greenhouse.io/contoso/jobs/123'), { provider: 'greenhouse', board: 'contoso' });
  assert.deepEqual(sources.parseBoardUrl('https://jobs.lever.co/fabrikam'), { provider: 'lever', board: 'fabrikam' });
  assert.deepEqual(sources.parseBoardUrl('https://careers.smartrecruiters.com/Northwind'), { provider: 'smartrecruiters', board: 'Northwind' });
  assert.deepEqual(sources.parseBoardUrl('https://jobs.ashbyhq.com/tailspin'), { provider: 'ashby', board: 'tailspin' });
  assert.deepEqual(sources.parseBoardUrl('https://woodgrove.wd5.myworkdayjobs.com/en-US/External'), { provider: 'workday', board: 'woodgrove/External', tenant: 'woodgrove', wd: 'wd5', site: 'External' });
  assert.equal(sources.parseBoardUrl('https://www.linkedin.com/jobs'), null);
  assert.equal(sources.parseBoardUrl('not a url'), null);
});

test('countries and Workday dates are worked out', () => {
  assert.equal(sources.countryOf('Bengaluru, Karnataka'), 'India');
  assert.equal(sources.countryOf('', 'in'), 'India');
  assert.equal(sources.countryOf('London'), 'United Kingdom');
  assert.equal(sources.countryOf('Remote'), 'Remote');
  assert.equal(sources.countryOf('US, CA, Santa Clara'), 'United States');          // Workday: country code first
  assert.equal(sources.countryOf('Taiwan, Taipei'), 'Taiwan');                      // Workday: country name first
  assert.equal(sources.countryOf('2 Locations'), '');
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(sources.workdayDate('Posted Today', now).slice(0, 10), '2026-10-17');
  assert.equal(sources.workdayDate('Posted Yesterday', now).slice(0, 10), '2026-10-16');
  assert.equal(sources.workdayDate('Posted 30+ Days Ago', now).slice(0, 10), '2026-09-17');
});

test('all five job boards are read, with paging, hidden jobs skipped and HTML removed', async () => {
  const boards = await fakeBoards();
  try {
    const opts = { base: boards.sourceBase };
    const gh = await sources.fetchJobs({ provider: 'greenhouse', board: 'contoso' }, opts);
    assert.equal(gh[0].description, 'C#, ASP.NET Core, Azure');
    assert.equal(gh[0].country, 'India');
    const lever = await sources.fetchJobs({ provider: 'lever', board: 'fabrikam' }, opts);
    assert.deepEqual([lever[0].title, lever[0].country, lever[0].employmentType], ['Backend Engineer', 'India', 'Full-time']);
    assert.equal((await sources.fetchJobs({ provider: 'smartrecruiters', board: 'Northwind' }, opts)).length, 150);
    const ashby = await sources.fetchJobs({ provider: 'ashby', board: 'tailspin' }, opts);
    assert.deepEqual(ashby.map(j => [j.title, j.country]), [['Product Manager, Payments', 'Singapore']]);   // spaces tidied, letters kept
    const wd = await sources.fetchJobs({ provider: 'workday', board: 'woodgrove/External', wd: 'wd5' }, opts);
    assert.equal(wd.length, 25);                                                       // all pages, though only page 1 says the total
    assert.equal(wd[0].url, 'https://woodgrove.wd5.myworkdayjobs.com/External/job/Pune/Cloud_0');
    await assert.rejects(sources.fetchJobs({ provider: 'greenhouse', board: 'missing' }, opts), /404/);
  } finally { await boards.close(); }
});

test('the admin adds companies; syncing adds, refreshes and closes jobs', async () => {
  await withServer(async s => {
    const help = await s.admin('help@example.com');
    assert.equal((await help.post('/admin/api/jobs/companies', { name: 'Contoso', careersUrl: 'https://boards.greenhouse.io/contoso' })).status, 403);
    const boss = await s.admin('boss@example.com');
    assert.equal((await boss.post('/admin/api/jobs/companies', { name: 'X', careersUrl: 'https://www.naukri.com/x' })).status, 400);
    const added = await boss.post('/admin/api/jobs/companies', { name: 'Contoso', careersUrl: 'https://boards.greenhouse.io/contoso' });
    assert.equal(added.status, 201);
    assert.equal(added.json.sync.ok, true);
    assert.equal(added.json.company.jobCount, 3);                                              // the non-https link is skipped
    assert.equal((await boss.post('/admin/api/jobs/companies', { name: 'Again', careersUrl: 'https://boards.greenhouse.io/contoso' })).status, 409);
    const broken = await boss.post('/admin/api/jobs/companies', { name: 'Missing', careersUrl: 'https://boards.greenhouse.io/missing' });
    assert.equal(broken.json.sync.ok, false);
    assert.match(broken.json.company.lastError, /404/);

    s.boards.state.greenhouse = s.boards.state.greenhouse.filter(j => j.id !== 2);             // the Scrum Master job closes
    s.boards.state.greenhouse[0].title = 'Senior .NET Developer (C#)';
    const synced = await boss.post('/admin/api/jobs/sync');
    assert.equal(synced.json.results.length, 2);
    const rows = s.app.db.prepare('SELECT external_id, title, active FROM jobs ORDER BY external_id').all();
    assert.deepEqual(rows.map(r => [r.external_id, r.active]), [['1', 1], ['2', 0], ['3', 1]]);
    assert.equal(rows[0].title, 'Senior .NET Developer (C#)');

    const page = (await boss.get('/admin/api/jobs')).json;
    assert.equal(page.stats.active, 2);
    assert.equal(page.prompt.isDefault, true);
  });
});

test('the Master Prompt can be changed and reset', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    assert.equal((await boss.post('/admin/api/jobs/prompt', { prompt: 'short' })).status, 400);
    const saved = await boss.post('/admin/api/jobs/prompt', { prompt: 'Act as a strict recruiter for senior Indian IT candidates. Score harshly.' });
    assert.equal(saved.json.prompt.isDefault, false);
    assert.equal(saved.json.prompt.updatedBy, 'boss@example.com');
    const reset = await boss.post('/admin/api/jobs/prompt', { reset: true });
    assert.equal(reset.json.prompt.prompt, DEFAULT_MASTER_PROMPT);
  });
});

test('candidates filter and page through active jobs, and the AI scores them with the Master Prompt', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    const contoso = (await boss.post('/admin/api/jobs/companies', { name: 'Contoso', careersUrl: 'https://boards.greenhouse.io/contoso' })).json.company;
    await boss.post('/admin/api/jobs/companies', { name: 'Northwind', careersUrl: 'https://careers.smartrecruiters.com/Northwind' });
    await boss.post('/admin/api/jobs/prompt', { prompt: 'CUSTOM MASTER PROMPT: act as a recruiter for Indian IT candidates and score every job.' });
    const web = await s.site();

    let r = (await web.get('/api/career/jobs?pageSize=20&page=2')).json;
    assert.equal(r.total, 153);
    assert.deepEqual([r.page, r.pages, r.jobs.length], [2, 8, 20]);
    assert.deepEqual(r.countries.map(c => c.name).slice(0, 2), ['India', 'United Kingdom']);
    assert.equal((await web.get('/api/career/jobs?country=United%20Kingdom')).json.jobs[0].title, 'Data Engineer');
    assert.equal((await web.get('/api/career/jobs?q=scrum')).json.total, 1);
    assert.equal((await web.get(`/api/career/jobs?companies=${contoso.id}`)).json.total, 3);
    assert.equal((await web.get('/api/career/jobs?days=7&companies=' + contoso.id)).json.total, 1);   // only the 1-day-old job
    assert.equal((await web.get('/api/career/jobs?location=pune')).json.jobs[0].title, 'Scrum Master');
    assert.ok((await web.get('/api/career/jobs')).json.jobs[0].url.startsWith('https://'));

    assert.equal((await web.post('/api/career/jobs/match', {})).status, 400);                  // no resume yet
    s.app.db.prepare("INSERT INTO career_resumes (customer_id, file_name, source_text, uploaded_at) VALUES (1, 'cv', ?, datetime('now'))")
      .run('Asha Rao. Senior .NET developer with C#, ASP.NET Core and Azure. Acting Scrum Master. '.repeat(5));
    const m = await web.post('/api/career/jobs/match', { resume: 'ats', companies: [contoso.id] });
    assert.equal(m.status, 200);
    assert.equal(m.json.scored, 3);                                                             // the made-up id is ignored
    assert.equal(m.json.profile.seniority, 'Mid-level (6 years)');
    assert.equal(m.json.usage.used, 1);
    const prompt = s.ai.seen[0].systemInstruction.parts[0].text;
    assert.match(prompt, /^CUSTOM MASTER PROMPT/);
    assert.match(prompt, /Never invent companies, jobs or links/);                              // the locked rules are always added
    assert.match(s.ai.seen[0].contents[0].parts[0].text, /"title":"Senior .NET Developer"/);

    r = (await web.get(`/api/career/jobs?companies=${contoso.id}&sort=match`)).json;
    assert.equal(r.jobs[0].match.score, 88);
    assert.deepEqual(r.counts, { high: 1, medium: 1, stretch: 1 });
    assert.equal((await web.get(`/api/career/jobs?companies=${contoso.id}&bucket=stretch`)).json.total, 1);
    assert.equal((await web.get('/api/career/jobs?resume=v99')).json.jobs.every(j => j.match === null), true);   // scores belong to one resume

    // an answer with only made-up ids is an error, and is not counted against the daily limit
    s.ai.madeUpOnly(true);
    const none = await web.post('/api/career/jobs/match', { resume: 'ats', companies: [contoso.id] });
    assert.equal(none.status, 502);
    assert.match(none.json.error, /could not score/);
    assert.equal((await web.get('/api/career')).json.usage.used, 1);
  });
});
