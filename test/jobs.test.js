'use strict';
// AI Job search: candidates pick a resume and say what to look for; live jobs are read from the companies' careers
// boards (Greenhouse, Lever, SmartRecruiters, Ashby, Workday) and the admin's Master Prompt scores them with the AI.
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
const { DEFAULT_MASTER_PROMPT, maintain } = require('../admin/lib/jobs');

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

/** Fake Gemini: the analysis step returns a profile; the scoring step scores every job id it is shown, plus one made-up id that must be ignored. */
async function fakeGemini() {
  const seen = [];
  let onlyMadeUp = false, delay = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => setTimeout(() => {
      const body = JSON.parse(raw);
      seen.push(body);
      const system = body.systemInstruction.parts[0].text, user = body.contents[0].parts[0].text;
      let out;
      if (/expert career coach/.test(system)) {
        out = { summary: 'Close to a full fit.', matched: ['C#', '.NET'],
          requirements: [{ skill: 'C# / .NET', weight: 40, status: 'match', evidence: 'Contoso, 6 years' }, { skill: 'Azure DevOps', weight: 30, status: 'partial', evidence: 'Some pipelines' },
            { skill: 'Docker', weight: 20, status: 'missing', evidence: '' }, { skill: 'Agile', weight: 20, status: 'unknown' }],
          gaps: [{ skill: 'Docker', points: 6, importance: 'medium', why: 'Containers', howToClose: 'Build one app', hours: 10, searchQuery: 'Docker for .NET developers', provider: 'docker', certification: '' },
            { skill: 'Azure DevOps', points: 9, importance: 'high', why: 'CI/CD', howToClose: 'Set up a pipeline', hours: 12, searchQuery: 'Azure DevOps pipelines tutorial', provider: 'microsoft', certification: 'AZ-400' }],
          revise: [{ topic: 'ASP.NET Core middleware', searchQuery: 'ASP.NET Core middleware interview' }],
          plan: ['Week 1: Azure DevOps'], interviewQuestions: ['What is middleware?'], tips: ['Lead with your API work'] };
      } else if (/This step only analyses the candidate/.test(system)) {
        out = { level: 'Mid-level (6 years)', summary: 'Strong .NET engineer.', strengths: ['C#', 'Azure'], targetRoles: ['.NET Developer', 'Scrum Master'],
          searchTerms: ['.net', 'scrum master', 'backend engineer', 'qa engineer'], resumeFixes: ['Replace the [add number] markers'] };
      } else {
        const label = (/labels: ([^|)\n]+)/.exec(user) || [])[1];
        const ids = [...user.matchAll(/"id":(\d+)/g)].map(m => Number(m[1]));
        const matches = onlyMadeUp ? [] : ids.map((id, i) => ({ id, score: [88, 62, 30][i % 3], bucket: ['high', 'medium', 'stretch'][i % 3], why: 'Because ' + id, gap: i % 3 ? 'Kubernetes' : 'none', resume: (label || '').trim(),
          requirements: [{ skill: 'C#', weight: 50, status: 'match' }, { skill: 'Kubernetes', weight: 30, status: 'missing' }, { skill: 'Agile', weight: 20, status: 'partial' }] }));
        matches.push({ id: 999999, score: 99, bucket: 'high', why: 'made up' });
        out = { matches };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
    }, delay));
  });
  const base = await listen(server);
  return { base, seen, madeUpOnly: v => { onlyMadeUp = v; }, slow: ms => { delay = ms; }, close: () => new Promise(r => server.close(r)) };
}

async function start() {
  const boards = await fakeBoards(), ai = await fakeGemini();
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jobs-')), aiUpstream: { gemini: ai.base }, jobSourceBase: boards.sourceBase,
    jobCatalogue: [{ name: 'Contoso', url: 'https://boards.greenhouse.io/contoso' }, { name: 'Northwind', url: 'https://careers.smartrecruiters.com/Northwind' }] });
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
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
  };
  const site = async () => {
    const { token } = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'a-long-password' }) }).then(r => r.json());
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    const get = u => call('GET', u), post = (u, b) => call('POST', u, b || {});
    /** Start a search and wait for it to finish. */
    const search = async params => {
      const started = await post('/api/career/jobsearch', params);
      if (started.status !== 202) return started;
      for (let i = 0; i < 200; i++) {
        const r = await get('/api/career/jobsearch/' + started.json.search.id);
        if (r.json.search.status !== 'running') return r;
        await new Promise(res => setTimeout(res, 25));
      }
      throw new Error('search did not finish');
    };
    return { get, post, search };
  };
  const addResume = () => {
    app.db.prepare("INSERT INTO career_resumes (customer_id, file_name, source_text, uploaded_at) VALUES (?, 'cv', ?, datetime('now'))")
      .run(cust, 'Asha Rao. Senior .NET developer with C#, ASP.NET Core and Azure. Acting Scrum Master. '.repeat(5));
    app.db.prepare("INSERT INTO career_versions (customer_id, role, content_json, created_at) VALUES (?, 'Scrum Master', ?, datetime('now'))")
      .run(cust, JSON.stringify({ fitScore: 70, fitNote: '', resume: { name: 'Asha Rao', headline: 'Scrum Master', summary: 'Scrum Master for 3 years.', skills: [], experience: [], projects: [], education: [], certifications: [] } }));
  };
  return { app, base, boards, ai, admin, site, addResume, stop: async () => { await app.close(); await boards.close(); await ai.close(); } };
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

test('the Master Prompt can be changed and reset; the dashboard shows search stats', async () => {
  await withServer(async s => {
    const help = await s.admin('help@example.com');
    assert.equal((await help.post('/admin/api/jobs/prompt', { prompt: 'Act as a strict recruiter for senior Indian IT candidates. Score harshly.' })).status, 403);
    const boss = await s.admin('boss@example.com');
    assert.equal((await boss.post('/admin/api/jobs/prompt', { prompt: 'short' })).status, 400);
    const saved = await boss.post('/admin/api/jobs/prompt', { prompt: 'Act as a strict recruiter for senior Indian IT candidates. Score harshly.' });
    assert.equal(saved.json.prompt.isDefault, false);
    assert.equal(saved.json.prompt.updatedBy, 'boss@example.com');
    const reset = await boss.post('/admin/api/jobs/prompt', { reset: true });
    assert.equal(reset.json.prompt.prompt, DEFAULT_MASTER_PROMPT);
    const page = (await boss.get('/admin/api/jobs')).json;
    assert.deepEqual(page.builtInCompanies, ['Contoso', 'Northwind']);
    assert.equal(page.stats.searches, 0);
    assert.match(page.outputRules, /Never invent companies, jobs or links/);
    assert.equal((await boss.post('/admin/api/jobs/companies', { name: 'X', careersUrl: 'https://boards.greenhouse.io/x' })).status, 404);   // the admin no longer adds companies
  });
});

test('AI Job search: live jobs from the built-in companies, filtered by country and scored into groups with the Master Prompt', async () => {
  await withServer(async s => {
    const boss = await s.admin('boss@example.com');
    await boss.post('/admin/api/jobs/prompt', { prompt: 'CUSTOM MASTER PROMPT: act as a recruiter for Indian IT candidates and score every job.' });
    const web = await s.site();
    assert.equal((await web.post('/api/career/jobsearch', { country: 'India' })).status, 400);                // no resume yet
    s.addResume();

    const r = await web.search({ resume: 'all', country: 'India' });
    const search = r.json.search;
    assert.equal(search.status, 'done', search.error);
    const { profile, jobs, coverage } = search.result;
    assert.equal(profile.level, 'Mid-level (6 years)');
    assert.deepEqual(profile.resumeFixes, ['Replace the [add number] markers']);
    assert.equal(coverage.companies, 2);
    assert.equal(coverage.live, 152);                                            // Contoso's 2 India jobs + Northwind's 150; London and the http link are out
    assert.equal(coverage.considered, 60);                                       // the most relevant ones go to the AI
    assert.ok(jobs.length === 60 && jobs.every(j => j.url.startsWith('https://')));   // the made-up id is ignored
    assert.ok(jobs.some(j => j.title === 'Senior .NET Developer') && jobs.some(j => j.title === 'Scrum Master'));
    assert.ok(!jobs.some(j => j.title === 'Data Engineer'));
    assert.equal(jobs[0].score, 88);                                             // best first
    assert.deepEqual(search.counts, { high: 20, medium: 20, stretch: 20 });
    // every job has its Skill Gap Matrix from the same AI call
    assert.ok(jobs.every(j => j.matrix && j.matrix.rows.length === 3));
    assert.deepEqual([jobs[0].matrix.score, jobs[0].matrix.counts], [60, { match: 1, partial: 1, missing: 1 }]);
    assert.equal(jobs[0].resume, 'Uploaded resume');   // which resume to send, when searching with all of them
    assert.equal(search.params.resumeLabel, 'All my resumes (2)');
    assert.equal(r.json.usage.used, 1);

    const [analysis, scoring] = s.ai.seen;
    assert.match(analysis.systemInstruction.parts[0].text, /^CUSTOM MASTER PROMPT[\s\S]*This step only analyses/);
    assert.match(scoring.systemInstruction.parts[0].text, /^CUSTOM MASTER PROMPT[\s\S]*Never invent companies, jobs or links/);
    assert.match(scoring.contents[0].parts[0].text, /=== RESUME: Scrum Master ===/);
    assert.match(scoring.contents[0].parts[0].text, /Country: India/);

    const list = (await web.get('/api/career/jobsearch')).json;
    assert.equal(list.searches.length, 1);
    assert.equal(list.searches[0].result, undefined);                             // the list is light; open one for the jobs
    assert.equal((await boss.get('/admin/api/jobs')).json.stats.searches, 1);
  });
});

test('AI Job search: companies typed by the candidate are found by name or careers link', async () => {
  await withServer(async s => {
    s.addResume();
    const web = await s.site();
    const r = await web.search({ resume: 'ats', country: '', companies: 'contoso, fabrikam\nhttps://www.naukri.com/x, Nonexistent Co' });
    const search = r.json.search;
    assert.equal(search.status, 'done', search.error);
    const { jobs, coverage } = search.result;
    assert.equal(coverage.companies, 2);                                          // Contoso (built in) and Fabrikam (found on Lever)
    assert.deepEqual(coverage.notFound, ['Nonexistent Co']);
    assert.deepEqual(coverage.notSupported, ['https://www.naukri.com/x']);
    assert.ok(jobs.some(j => j.company === 'fabrikam' && j.title === 'Backend Engineer'));
    assert.ok(jobs.every(j => j.resume === ''));                                  // one resume: nothing to choose
    assert.equal(s.app.db.prepare("SELECT provider FROM job_companies WHERE board = 'fabrikam'").get().provider, 'lever');

    const none = await web.search({ companies: 'Nonexistent Co' });
    assert.equal(none.json.search.status, 'failed');
    assert.match(none.json.search.error, /could be found/);
    assert.equal((await web.post('/api/career/jobsearch', { companies: Array.from({ length: 31 }, (_, i) => 'Co' + i).join(',') })).status, 400);
  });
});

test('AI Job search: failures say why and are not counted; one search at a time', async () => {
  await withServer(async s => {
    s.addResume();
    const web = await s.site();
    const empty = await web.search({ country: 'Japan' });
    assert.equal(empty.json.search.status, 'failed');
    assert.match(empty.json.search.error, /No live openings were found in Japan/);
    assert.equal(s.ai.seen.length, 0);                                            // no AI call when there are no jobs

    s.ai.madeUpOnly(true);
    const bad = await web.search({ country: 'India' });
    assert.equal(bad.json.search.status, 'failed');
    assert.match(bad.json.search.error, /could not score/);
    assert.equal(bad.json.usage.used, 0);

    s.ai.madeUpOnly(false); s.ai.slow(300);
    const first = await web.post('/api/career/jobsearch', { country: 'India' });
    assert.equal(first.status, 202);
    assert.equal((await web.post('/api/career/jobsearch', { country: 'India' })).status, 409);
    assert.equal((await web.post(`/api/career/jobsearch/${first.json.search.id}/delete`)).status, 409);
    let done;
    for (let i = 0; i < 200 && !done; i++) {
      const r = await web.get('/api/career/jobsearch/' + first.json.search.id);
      if (r.json.search.status !== 'running') done = r.json.search;
      else await new Promise(res => setTimeout(res, 25));
    }
    assert.equal(done.status, 'done');
    assert.equal((await web.post(`/api/career/jobsearch/${first.json.search.id}/delete`)).json.ok, true);
    assert.equal((await web.get('/api/career/jobsearch')).json.searches.length, 2);
  });
});

test('career sites nobody searched for two weeks are dropped from the cache', async () => {
  await withServer(async s => {
    const db = s.app.db;
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    db.prepare("INSERT INTO job_companies (name, careers_url, provider, board, created_at, last_used) VALUES ('Old', 'https://boards.greenhouse.io/old', 'greenhouse', 'old', ?, ?)").run(old, old);
    db.prepare("INSERT INTO job_companies (name, careers_url, provider, board, created_at, last_used) VALUES ('Contoso', 'https://boards.greenhouse.io/contoso', 'greenhouse', 'contoso', ?, ?)").run(old, new Date().toISOString());
    assert.equal(await maintain(db, { base: s.boards.sourceBase }), 1);
    assert.deepEqual(db.prepare('SELECT name, job_count FROM job_companies').all().map(r => [r.name, r.job_count]), [['Contoso', 3]]);
  });
});

test('Prepare for this job: gaps to a full fit with search links, made once and kept with the search', async () => {
  await withServer(async s => {
    s.addResume();
    const web = await s.site();
    const search = (await web.search({ resume: 'ats', country: 'India' })).json.search;
    const job = search.result.jobs[0];
    const calls = s.ai.seen.length;
    const r = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id });
    assert.equal(r.status, 200);
    const prep = r.json.prep;
    assert.deepEqual(prep.gaps.map(g => [g.skill, g.points]), [['Azure DevOps', 9], ['Docker', 6]]);      // biggest gap first
    assert.equal(prep.gapPoints, 15);
    // the matrix: weights scaled to 100 (40/30/20/20 of 110), match = full weight, partial = half, missing or unknown = none
    assert.deepEqual(prep.matrix.rows.map(r => [r.skill, r.weight, r.status, r.earned, r.missing]),
      [['C# / .NET', 36, 'match', 36, 0], ['Azure DevOps', 27, 'partial', 13.5, 13.5], ['Agile', 19, 'missing', 0, 19], ['Docker', 18, 'missing', 0, 18]]);   // heaviest first
    assert.equal(prep.matrix.rows.reduce((n, r) => n + r.weight, 0), 100);
    assert.equal(prep.matrix.score, 50);
    assert.deepEqual(prep.matrix.counts, { match: 1, partial: 1, missing: 2 });
    assert.equal(prep.fit, job.score);
    const ado = prep.gaps[0];
    assert.equal(ado.links.find(l => l.kind === 'youtube').url, 'https://www.youtube.com/results?search_query=Azure%20DevOps%20pipelines%20tutorial');
    assert.match(ado.links.find(l => l.kind === 'udemy-free').url, /udemy\.com\/courses\/search\/\?q=Azure%20DevOps.*price-free/);
    assert.match(ado.links.find(l => l.kind === 'official').url, /^https:\/\/learn\.microsoft\.com\/en-us\/search\/\?terms=/);
    assert.equal(ado.certification.name, 'AZ-400');
    assert.equal(prep.gaps[1].provider, 'other');                                          // an unknown provider is not trusted
    assert.deepEqual(prep.revise[0].links.map(l => l.kind), ['youtube', 'articles']);
    assert.match(s.ai.seen[calls].contents[0].parts[0].text, /CURRENT FIT SCORE: \d+\/100/);
    // kept in its own table, for the dashboard
    const kept = s.app.db.prepare('SELECT * FROM career_job_preps WHERE search_id = ? AND job_id = ?').get(search.id, job.id);
    assert.deepEqual([kept.job_title, kept.company, kept.fit], [job.title, job.company, job.score]);
    assert.equal(JSON.parse(kept.prep_json).gapPoints, 15);

    // made once: opening it again uses no AI action
    const used = r.json.usage.used;
    const again = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id });
    assert.equal(again.json.usage.used, used);
    assert.equal(s.ai.seen.length, calls + 1);
    assert.ok((await web.get('/api/career/jobsearch/' + search.id)).json.search.result.jobs[0].prep);
    assert.equal((await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: 999999 })).status, 404);

    // refresh makes it again only for an older plan without the matrix
    assert.equal((await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id, refresh: true })).json.usage.used, used);
    const row = s.app.db.prepare('SELECT result_json FROM career_job_searches WHERE id = ?').get(search.id);
    const saved = JSON.parse(row.result_json); delete saved.jobs[0].prep.matrix;
    s.app.db.prepare('UPDATE career_job_searches SET result_json = ? WHERE id = ?').run(JSON.stringify(saved), search.id);
    const remade = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id, refresh: true });
    assert.ok(remade.json.prep.matrix);
    assert.equal(remade.json.usage.used, used + 1);
  });
});
