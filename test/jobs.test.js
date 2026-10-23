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

/** The whole description of Contoso's job 1 (its job list has only the first line). */
const FULL_JD = '&lt;p&gt;We need a Senior .NET Developer.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;5+ years of C# and .NET experience&lt;/li&gt;&lt;li&gt;Hands-on Azure DevOps pipelines&lt;/li&gt;' +
  '&lt;li&gt;Docker containers&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Nice to have: Agile ways of working&lt;/p&gt;' +
  '&lt;p&gt;You will build and run the payment APIs used by our customers, review code, and keep the services fast and reliable in production, working closely with product and QA.&lt;/p&gt;';

const ICON = Buffer.alloc(100, 7);   // a small picture

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
      if (u.pathname === '/gh/contoso/jobs/1') return send({ id: 1, content: FULL_JD });
      if (u.pathname === '/icons/stripe.com.ico') { res.setHeader('Content-Type', 'image/x-icon'); return res.end(ICON); }
      if (u.pathname === '/icons/adobe.com.ico') { res.setHeader('Content-Type', 'text/plain'); return res.end(''); }             // the first source answers with nothing...
      if (u.pathname === '/icons2/adobe.com.ico') { res.setHeader('Content-Type', 'image/png'); return res.end(ICON); }           // ...the second has it
      if (u.pathname === '/home/acme.com') { res.setHeader('Content-Type', 'text/html'); return res.end('<title>Acme | Home</title><link rel="icon" href="brand/acme.png">'); }
      if (u.pathname === '/home/brand/acme.png') { res.setHeader('Content-Type', 'image/png'); return res.end(ICON); }            // named by the home page
      if (u.pathname === '/home/zeta.com') { res.setHeader('Content-Type', 'text/html'); return res.end('<title>Domain for sale</title>'); }   // a site that is not the company
      if (u.pathname === '/icons/unknown-co.com.ico') { res.statusCode = 404; res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from('globe')); }   // a placeholder picture with a 404
      if (u.pathname === '/sfc/careers.example.com/job/Technical-Manager/172654-en_US') {   // SuccessFactors: the company, then the job, with spans inside
        res.setHeader('Content-Type', 'text/html');
        return res.end('<html><span itemprop="description"><p>About us</p></span><div class="job"><span xml:lang="en-US" itemprop="description" class="x"><div><h2>Skill Requirements</h2>' +
          '<ul><li><span style="font-family:aptos">Strong hands-on expertise in Java 17, Spring Boot</span></li><li>Hands-on AWS experience with EC2, S3, SQS</li></ul></div></span></div><span>footer</span></html>');
      }
      if (u.pathname === '/orc/fa-x.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails') {
        return send({ items: [{ ExternalDescriptionStr: '<p>Tax consulting role</p>', ExternalResponsibilitiesStr: '<ul><li>Prepare returns</li></ul>', ExternalQualificationsStr: '<p>CA qualified</p>' }] });
      }
      if (u.pathname === '/lever/fabrikam/l1') return send({ descriptionPlain: 'Build APIs', lists: [{ text: 'Requirements', content: '<li>Node.js</li><li>PostgreSQL</li>' }], additionalPlain: 'Hybrid' });
      if (u.pathname === '/sr/Northwind/postings/s1') return send({ jobAd: { sections: { jobDescription: { title: 'Job', text: '<p>Test our apps</p>' }, qualifications: { title: 'Qualifications', text: '<ul><li>Selenium</li></ul>' } } } });
      if (u.pathname === '/wd/wday/cxs/woodgrove/External/job/Pune/Cloud_0') return send({ jobPostingInfo: { jobDescription: '<p>Terraform and AWS</p>' } });
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
        const india = body.appliedFacets && body.appliedFacets.locationCountry && body.appliedFacets.locationCountry[0] === 'IN1';
        const list = india ? all.slice(0, 3) : all;
        return send({ total: body.offset === 0 ? list.length : 0, jobPostings: list.slice(body.offset, body.offset + body.limit),
          facets: [{ facetParameter: 'locationMainGroup', values: [{ descriptor: 'Country', facetParameter: 'locationCountry', values: [{ descriptor: 'India', id: 'IN1', count: 3 }] }] }] });
      }
      if (u.pathname === '/sf/careers.example.com/services/recruiting/v1/jobs') {
        const body = JSON.parse(raw || '{}');
        const all = Array.from({ length: 23 }, (_, i) => ({ response: { id: String(500 + i), unifiedStandardTitle: 'Data Analyst ' + i, urlTitle: 'Data-Analyst-' + i,
          unifiedStandardStart: '10/1' + (i % 9) + '/26', custprimecity: 'Noida', custCountryRegion: ['India'] } }));
        const list = body.facetFilters && body.facetFilters.custCountryRegion ? all : [];
        return send({ totalJobs: list.length, jobSearchResult: list.slice(body.pageNumber * 10, body.pageNumber * 10 + 10) });
      }
      if (u.pathname === '/sfc/careers.example.com/ey/search/') {
        const start = Number(u.searchParams.get('startrow'));
        const rows = Array.from({ length: 30 }, (_, i) => i).slice(start, start + 25).map(i =>
          `<tr class="data-row"><td><span class="jobTitle"><a href="/ey/job/Pune-Consultant-${i}/90${i}/" class="jobTitle-link">Consultant &amp; Analyst ${i}</a></span>
           <a class="jobTitle-link" href="/ey/job/Pune-Consultant-${i}/90${i}/">Consultant &amp; Analyst ${i}</a></td>
           <td><span class="jobLocation"> Pune, MH, IN, 411001 <small>+2 more&hellip;</small></span></td><td><span class="jobDate">Oct 1${i % 9}, 2026</span></td></tr>`).join('');
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<p>Results <b>${start + 1} – ${Math.min(start + 25, 30)}</b> of <b>30</b></p><table>${rows}</table>`);
      }
      if (u.pathname === '/orc/fa-x.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions') {
        const offset = Number((/offset=(\d+)/.exec(u.search) || [])[1]);
        const all = Array.from({ length: 30 }, (_, i) => ({ Id: 'R' + i, Title: 'Tax Consultant ' + i, PostedDate: '2026-10-1' + (i % 9), PrimaryLocation: 'Gurugram, Haryana, India', PrimaryLocationCountry: 'IN' }));
        return send({ items: [{ TotalJobsCount: 30, requisitionList: all.slice(offset, offset + 25) }] });
      }
      if (u.pathname === '/amazon/en/search.json') {
        const offset = Number(u.searchParams.get('offset'));
        const all = Array.from({ length: 120 }, (_, i) => ({ id_icims: String(1000 + i), title: 'SDE ' + i, location: 'IN, KA, Bengaluru', posted_date: 'October 16, 2026', job_path: '/en/jobs/' + (1000 + i) + '/sde', description_short: 'Build things' }));
        return send({ hits: 120, jobs: u.searchParams.get('country') === 'IND' ? all.slice(offset, offset + 100) : [] });
      }
      if (u.pathname === '/cg/api/job-search') {
        const page = Number(u.searchParams.get('page'));
        const all = Array.from({ length: 130 }, (_, i) => ({ id: 'C' + i, title: 'SAP Consultant ' + i, location: 'Pune, Mumbai', updated_at: '2026-10-18T10:00:00Z',
          apply_job_url: 'https://careers.capgemini.com/job/Pune-SAP/' + i + '/?feedId=1&utm_source=CareerSite&tcsource=apply', description_stripped: 'SAP FICO' }));
        return send({ total: 130, data: all.slice((page - 1) * 100, page * 100) });
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  const base = await listen(server);
  return { state, base, sourceBase: { greenhouse: base + '/gh', lever: base + '/lever', smartrecruiters: base + '/sr', ashby: base + '/ashby', workday: base + '/wd', sfunified: base + '/sf', sfclassic: base + '/sfc', oraclehcm: base + '/orc', amazon: base + '/amazon', capgemini: base + '/cg' }, close: () => new Promise(r => server.close(r)) };
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
        out = { summary: 'Close to a full fit.', matched: ['C#', '.NET', 'Presales and RFP writing'],
          requirements: [
            { skill: 'C# / .NET', type: 'technical', priority: 'must', quote: '5+ years of C# and .NET experience', weight: 40, status: 'match', evidence: 'Contoso, 6 years' },
            { skill: 'Azure DevOps', type: 'technical', priority: 'must', quote: 'Hands-on  Azure DevOps pipelines.', weight: 30, status: 'partial', evidence: 'Some pipelines' },
            { skill: 'Docker', type: 'technical', priority: 'must', quote: 'Docker container skills', weight: 20, status: 'missing', evidence: '' },   // quote not word for word: kept by its name
            { skill: 'Agile', type: 'functional', priority: 'nice', quote: 'Agile ways of working', weight: 20, status: 'unknown' },
            { skill: 'Kubernetes', type: 'technical', priority: 'must', quote: 'Kubernetes clusters', weight: 25, status: 'missing' }],                // not in the description: dropped
          gaps: [{ skill: 'Docker', points: 6, importance: 'medium', why: 'Containers', howToClose: 'Build one app', hours: 10, searchQuery: 'Docker for .NET developers', provider: 'docker', certification: '' },
            { skill: 'Azure DevOps pipelines', points: 9, importance: 'high', why: 'CI/CD', howToClose: 'Set up a pipeline', hours: 12, searchQuery: 'Azure DevOps pipelines tutorial', provider: 'microsoft', certification: 'AZ-400' },
            { skill: 'Presales & Account Mining', points: 5, importance: 'medium', why: 'Usual for managers', howToClose: 'Write an RFP', hours: 10, searchQuery: 'RFP', provider: 'other', certification: '' },   // not in the description: dropped
            { skill: 'Kubernetes', points: 4, importance: 'low', why: 'Containers', howToClose: 'Learn it', hours: 10, searchQuery: 'k8s', provider: 'other', certification: '' }],             // its row was dropped: so is the gap
          revise: [{ topic: 'C# and .NET', searchQuery: 'C# .NET interview questions' }, { topic: 'Cloud migration and FinOps', searchQuery: 'FinOps' }],
          plan: ['Week 1: Azure DevOps'], tips: ['Lead with your API work'] };
      } else if (/expert interviewer/.test(system)) {
        out = {
          mcq: Array.from({ length: 5 }, (_, i) => ({ question: 'MCQ ' + i, options: ['a', 'b', 'c', 'd'], correct: i % 4, explanation: 'Because ' + i })).concat([{ question: 'Bad: three options', options: ['a', 'b', 'c'], correct: 0 }]),
          short: Array.from({ length: 11 }, (_, i) => ({ question: 'What is ' + i + '?', answer: 'It is ' + i })),
          scenario: Array.from({ length: 5 }, (_, i) => ({ question: 'Scenario ' + i, answer: 'Do ' + i })) };
      } else if (/This step only analyses the candidate/.test(system)) {
        out = { level: 'Mid-level (6 years)', summary: 'Strong .NET engineer.', strengths: ['C#', 'Azure'], targetRoles: ['.NET Developer', 'Scrum Master'],
          searchTerms: ['.net', 'scrum master', 'backend engineer', 'qa engineer'], resumeFixes: ['Replace the [add number] markers'] };
      } else {
        const label = (/labels: ([^|)\n]+)/.exec(user) || [])[1];
        const ids = [...user.matchAll(/"id":(\d+)/g)].map(m => Number(m[1]));
        const matches = onlyMadeUp ? [] : ids.map((id, i) => ({ id, score: [88, 62, 30][i % 3], bucket: ['high', 'medium', 'stretch'][i % 3], why: 'Because ' + id, gap: i % 3 ? 'Kubernetes' : 'none', resume: (label || '').trim() }));
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
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jobs-')), aiUpstream: { gemini: ai.base }, jobSourceBase: boards.sourceBase, logoSources: [boards.base + '/icons/{domain}.ico', boards.base + '/icons2/{domain}.ico'], logoHome: boards.base + '/home/{domain}',
    jobCatalogue: [{ name: 'Contoso', url: 'https://boards.greenhouse.io/contoso' }, { name: 'Northwind', url: 'https://careers.smartrecruiters.com/Northwind' }] });
  app.db.prepare("UPDATE pricing_plans SET limits_json = '{}' WHERE code = 'free'").run();   // these tests are not about plan limits
  const base = await listen(app.server);
  aikeys.addKey(app.db, app.vault, { provider: 'gemini', label: 'Gemini', key: 'AIza' + 'g'.repeat(35) + 'GGGG', makeDefault: true });
  for (const [mail, role] of [['boss@example.com', 'owner'], ['help@example.com', 'support']]) {
    app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(mail, mail, role, hashPassword('correct-horse-battery'));
  }
  const cust = app.db.prepare("INSERT INTO customers (email, name, sector, created_at) VALUES ('asha@example.com', 'Asha', 'it', datetime('now'))").run().lastInsertRowid;
  app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(cust, hashPassword('a-long-password'));
  const admin = async email => {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: r.status, json: await r.json() };
    };
    await call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' });
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b || {}) };
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
    /** Every job of a finished search, read one page of one group at a time. */
    const jobsOf = async search => {
      const out = [];
      for (const bucket of ['high', 'medium', 'stretch']) {
        for (let page = 1; ; page++) {
          const r = (await get(`/api/career/jobsearch/${search.id}/jobs?bucket=${bucket}&page=${page}&size=20`)).json;
          out.push(...r.jobs);
          if (page >= r.pages) break;
        }
      }
      return out;
    };
    return { get, post, search, jobsOf };
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
  assert.deepEqual(sources.parseBoardUrl('https://ejgk.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs'), { provider: 'oraclehcm', board: 'ejgk.fa.em2.oraclecloud.com/CX' });
  assert.deepEqual(sources.parseBoardUrl('https://www.amazon.jobs/en/search'), { provider: 'amazon', board: 'IND' });
  assert.deepEqual(sources.parseBoardUrl('https://careers.capgemini.com/job/x'), { provider: 'capgemini', board: 'in-en' });
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
    const { profile, coverage, groups } = search.result;
    const jobs = await web.jobsOf(search);
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
    // the search sends only the first page of each group (5 jobs); the other pages are asked for one at a time
    assert.equal(search.result.jobs, undefined);
    assert.equal(search.result.total, 60);
    assert.deepEqual([groups.high.total, groups.high.page, groups.high.pages, groups.high.jobs.length], [20, 1, 4, 5]);
    const page4 = (await web.get(`/api/career/jobsearch/${search.id}/jobs?bucket=medium&page=4`)).json;
    assert.deepEqual([page4.page, page4.jobs.length, page4.size], [4, 5, 5]);
    assert.equal((await web.get(`/api/career/jobsearch/${search.id}/jobs?bucket=medium&page=99`)).json.page, 4);   // past the end: the last page
    assert.equal((await web.get(`/api/career/jobsearch/${search.id}/jobs?bucket=other`)).status, 400);
    assert.equal(new Set(jobs.map(j => j.id)).size, 60);                          // no job on two pages
    assert.ok(jobs.every(j => j.matrix === undefined && j.insight === false));   // the matrix is made from the job's own description, in Insight
    assert.ok(jobs.every(j => j.domain === ''));                                  // test companies: no web address known
    assert.equal(jobs[0].resume, 'Uploaded resume');   // which resume to send, when searching with all of them
    assert.equal(search.params.resumeLabel, 'All my resumes (2)');
    assert.equal(r.json.usage.used, 1);

    const [analysis, scoring] = s.ai.seen;
    assert.match(analysis.systemInstruction.parts[0].text, /^CUSTOM MASTER PROMPT[\s\S]*This step only analyses/);
    assert.match(scoring.systemInstruction.parts[0].text, /^CUSTOM MASTER PROMPT[\s\S]*Never invent companies, jobs or links/);
    assert.match(scoring.contents[0].parts[0].text, /=== RESUME: Scrum Master ===/);
    assert.match(scoring.contents[0].parts[0].text, /Country: India/);
    // a job listed without a usable description is scored with the one read from its own page
    assert.match(scoring.contents[0].parts[0].text, /Hands-on Azure DevOps pipelines/);
    assert.match(scoring.contents[0].parts[0].text, /none given: score from the title only/);   // Northwind's jobs have no page we can read

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
    const { coverage } = search.result;
    const jobs = await web.jobsOf(search);
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
    assert.equal(s.ai.seen.length, 1);                                            // only the resume analysis: no jobs are scored when there are none

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

test('Insight: the skill matrix from the job\'s whole description, gaps to a full fit with search links, made once and kept with the search', async () => {
  await withServer(async s => {
    s.addResume();
    const web = await s.site();
    const search = (await web.search({ resume: 'ats', country: 'India' })).json.search;
    const job = (await web.jobsOf(search)).find(j => j.title === 'Senior .NET Developer');
    const calls = s.ai.seen.length;
    const r = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id });
    assert.equal(r.status, 200);
    const prep = r.json.prep;
    // gaps are requirements of the matrix (named as in it), biggest first; "Presales & Account Mining" is not in the
    // description and Kubernetes' row was dropped, so neither is a gap
    assert.deepEqual(prep.gaps.map(g => [g.skill, g.points]), [['Azure DevOps', 9], ['Docker', 6]]);
    assert.equal(prep.gapPoints, 15);
    assert.deepEqual(prep.matched, ['C#', '.NET']);                                          // "Presales and RFP writing" is not in the description
    assert.deepEqual(prep.revise.map(x => x.topic), ['C# and .NET']);                        // "Cloud migration and FinOps" is not either
    assert.match(s.ai.seen[calls].systemInstruction.parts[0].text, /no RFPs, presales/);
    // the AI was given the job's whole description, read from its own page on the board, and it is kept for a week
    const asked = s.ai.seen[calls].contents[0].parts[0].text;
    assert.match(asked, /Nice to have: Agile ways of working/);
    assert.match(s.app.db.prepare('SELECT full_description FROM jobs WHERE id = ?').get(job.id).full_description, /Hands-on Azure DevOps pipelines/);
    // the matrix keeps only what the description states (Kubernetes is dropped); weights scaled to 100 (40/30/20/20 of 110),
    // match = full weight, partial = half, missing or unknown = none
    assert.deepEqual(prep.matrix.rows.map(r => [r.skill, r.type, r.priority, r.weight, r.status, r.earned, r.missing]),
      [['C# / .NET', 'technical', 'must', 36, 'match', 36, 0], ['Azure DevOps', 'technical', 'must', 27, 'partial', 13.5, 13.5],
        ['Agile', 'functional', 'nice', 19, 'missing', 0, 19], ['Docker', 'technical', 'must', 18, 'missing', 0, 18]]);   // heaviest first
    assert.deepEqual([prep.matrix.checked, prep.matrix.dropped, prep.matrix.types], [true, 1, { technical: 3, functional: 1 }]);
    assert.equal(prep.matrix.rows.find(r => r.skill === 'Azure DevOps').quote, 'Hands-on  Azure DevOps pipelines.');   // found whatever the spacing
    assert.equal(prep.matrix.rows.find(r => r.skill === 'Docker').quote, '');                                         // not word for word: no quote shown
    assert.deepEqual([prep.version, prep.description], [4, 'full']);
    // 20 practice questions: 5 multiple choice (4 options, a correct one), 10 short, 5 scenarios, each with an answer
    const byType = t => prep.interviewQuestions.filter(q => q.type === t);
    assert.deepEqual(['mcq', 'short', 'scenario'].map(t => byType(t).length), [5, 10, 5]);
    assert.ok(byType('mcq').every(q => q.options.length === 4 && q.correct >= 0 && q.correct <= 3 && q.answer));
    assert.ok(prep.interviewQuestions.every(q => q.question && q.answer));
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
    assert.equal(s.ai.seen.length, calls + 2);   // the Insight and its 20 practice questions are two AI calls (one action)
    assert.ok((await web.jobsOf(search)).find(j => j.id === job.id).insight);
    assert.equal((await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: 999999 })).status, 404);

    // refresh makes it again only for an older Insight, made before the matrix came from the job description
    assert.equal((await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id, refresh: true })).json.usage.used, used);
    const row = s.app.db.prepare('SELECT result_json FROM career_job_searches WHERE id = ?').get(search.id);
    const saved = JSON.parse(row.result_json); delete saved.jobs.find(j => j.id === job.id).prep.version;
    s.app.db.prepare('UPDATE career_job_searches SET result_json = ? WHERE id = ?').run(JSON.stringify(saved), search.id);
    const remade = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: job.id, refresh: true });
    assert.ok(remade.json.prep.matrix);
    assert.equal(remade.json.usage.used, used + 1);

    // a job whose careers site gives no description we can read: no guessing from its title, and no AI action used;
    // the candidate pastes the description instead
    const scrum = (await web.jobsOf(search)).find(j => j.title === 'Scrum Master');
    const calls2 = s.ai.seen.length;
    const none = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: scrum.id });
    assert.deepEqual([none.status, none.json.code], [422, 'no-description']);
    assert.match(none.json.error, /paste it here/);
    assert.equal(s.ai.seen.length, calls2);
    assert.equal((await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: scrum.id, description: 'Too short' })).status, 400);
    const pastedJd = 'Scrum Master for our payments teams. You will facilitate Agile ways of working, coach teams on Scrum, and keep Jira boards healthy. ' +
      'Requirements: 5+ years of C# and .NET experience, hands-on Azure DevOps pipelines, Docker containers. Nice to have: Agile ways of working at scale, and experience with payments products.';
    const fromPaste = await web.post(`/api/career/jobsearch/${search.id}/prep`, { jobId: scrum.id, description: pastedJd });
    assert.equal(fromPaste.status, 200);
    assert.equal(fromPaste.json.prep.description, 'pasted');
    assert.match(s.ai.seen[calls2].contents[0].parts[0].text, /Scrum Master for our payments teams/);
  });
});

test('Indian employers: SuccessFactors (new and classic), Oracle Recruiting Cloud, Amazon, Capgemini, and a Workday country filter', async () => {
  const boards = await fakeBoards();
  try {
    const opts = { base: boards.sourceBase };
    const hcl = await sources.fetchJobs({ provider: 'sfunified', board: 'careers.example.com', facets: { custCountryRegion: ['India'] } }, opts);
    assert.equal(hcl.length, 23);                                                                     // three pages of 10
    assert.deepEqual([hcl[0].title, hcl[0].location, hcl[0].country, hcl[0].postedAt.slice(0, 10)], ['Data Analyst 0', 'Noida', 'India', '2026-10-10']);
    assert.equal(hcl[0].url, 'https://careers.example.com/job/Data-Analyst-0/500-en_US');
    const ey = await sources.fetchJobs({ provider: 'sfclassic', board: 'careers.example.com/ey', location: 'India' }, opts);
    assert.equal(ey.length, 30);                                                                      // two pages, each job listed once
    assert.deepEqual([ey[0].title, ey[0].location, ey[0].country], ['Consultant & Analyst 0', 'Pune, MH, IN', 'India']);
    assert.equal(ey[0].url, 'https://careers.example.com/ey/job/Pune-Consultant-0/900/');
    const kpmg = await sources.fetchJobs({ provider: 'oraclehcm', board: 'fa-x.oraclecloud.com/CX' }, opts);
    assert.equal(kpmg.length, 30);
    assert.deepEqual([kpmg[0].country, kpmg[0].url], ['India', 'https://fa-x.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/R0']);
    const amazon = await sources.fetchJobs({ provider: 'amazon', board: 'IND' }, opts);
    assert.deepEqual([amazon.length, amazon[0].country, amazon[0].url], [120, 'India', 'https://www.amazon.jobs/en/jobs/1000/sde']);
    const cg = await sources.fetchJobs({ provider: 'capgemini', board: 'in-en' }, opts);
    assert.equal(cg.length, 130);
    assert.deepEqual([cg[0].country, cg[0].url], ['India', 'https://careers.capgemini.com/job/Pune-SAP/0/']);   // tracking parameters removed
    const acn = await sources.fetchJobs({ provider: 'workday', board: 'woodgrove/External', wd: 'wd5', country: 'India' }, opts);
    assert.deepEqual([acn.length, acn[0].country], [3, 'India']);                                    // the site's own India filter
  } finally { await boards.close(); }
});

test('the built-in list includes Indian IT employers, and links to search the ones that cannot be read', () => {
  const { CATALOGUE, SEARCH_ELSEWHERE } = require('../admin/lib/jobcatalogue');
  const names = CATALOGUE.map(c => c.name);
  for (const n of ['Accenture', 'HCLTech', 'Wipro', 'Capgemini', 'EY', 'KPMG India', 'Amazon']) assert.ok(names.includes(n), n);
  for (const c of CATALOGUE) assert.ok(c.board || sources.parseBoardUrl(c.url), c.name + ' has a readable board');
  assert.ok(SEARCH_ELSEWHERE.some(c => c.name === 'TCS') && SEARCH_ELSEWHERE.every(c => c.url.startsWith('https://')));
});

test('a job\'s whole description is read from its own page on Greenhouse, Lever, SmartRecruiters, Ashby and Workday', async () => {
  const boards = await fakeBoards();
  try {
    const opts = { base: boards.sourceBase };
    assert.match(await sources.fetchDescription({ provider: 'greenhouse', board: 'contoso' }, { externalId: '1' }, opts), /^We need a Senior \.NET Developer\.\n ?5\+ years of C# and \.NET experience/);
    assert.equal(await sources.fetchDescription({ provider: 'lever', board: 'fabrikam' }, { externalId: 'l1' }, opts), 'Build APIs\nRequirements\nNode.js\n PostgreSQL\nHybrid');
    assert.equal(await sources.fetchDescription({ provider: 'smartrecruiters', board: 'Northwind' }, { externalId: 's1' }, opts), 'Job\nTest our apps\nQualifications\nSelenium');
    assert.equal(await sources.fetchDescription({ provider: 'ashby', board: 'tailspin' }, { externalId: 'a1' }, opts), 'Roadmaps');
    assert.equal(await sources.fetchDescription({ provider: 'workday', board: 'woodgrove/External', wd: 'wd5' },
      { externalId: 'R0', url: 'https://woodgrove.wd5.myworkdayjobs.com/External/job/Pune/Cloud_0' }, opts), 'Terraform and AWS');
    assert.equal(await sources.fetchDescription({ provider: 'sfclassic', board: 'careers.example.com' },
      { externalId: '172654', url: 'https://careers.example.com/job/Technical-Manager/172654-en_US' }, opts),
    'About us\nSkill Requirements\n Strong hands-on expertise in Java 17, Spring Boot \n Hands-on AWS experience with EC2, S3, SQS');
    assert.equal(await sources.fetchDescription({ provider: 'oraclehcm', board: 'fa-x.oraclecloud.com/CX' }, { externalId: 'R1' }, opts), 'Tax consulting role\nPrepare returns\nCA qualified');
    assert.equal(await sources.fetchDescription({ provider: 'amazon', board: 'IND' }, { externalId: '1' }, opts), null);   // no single-job page: the list's text is used
    await assert.rejects(sources.fetchDescription({ provider: 'greenhouse', board: 'contoso' }, { externalId: '404' }, opts));
  } finally { await boards.close(); }
});

test('company logos: the built-in companies\' web addresses, else the host of their own careers site', () => {
  const { companyDomain, DOMAINS, CATALOGUE } = require('../admin/lib/jobcatalogue');
  assert.ok(CATALOGUE.every(c => DOMAINS[c.name]), 'every built-in company has a web address');
  assert.equal(companyDomain('stripe'), 'stripe.com');
  assert.equal(companyDomain('CRED', 'https://jobs.lever.co/cred'), 'cred.club');
  assert.equal(companyDomain('Acme', 'https://careers.acme.co.in/jobs'), 'acme.co.in');
  assert.equal(companyDomain('Acme', 'https://boards.greenhouse.io/acme'), '');   // a job board says nothing about the company
  assert.equal(companyDomain('Acme', ''), '');
});

test('company logos come through our own server: the next source when one misses, the home page icon, found from the name, else a 404', async () => {
  await withServer(async s => {
    const logo = q => fetch(s.base + '/api/logo?' + q);
    const real = await logo('domain=stripe.com');
    assert.equal(real.status, 200);
    assert.equal(real.headers.get('content-type'), 'image/x-icon');
    assert.match(real.headers.get('cache-control'), /max-age=604800/);
    assert.equal(Buffer.from(await real.arrayBuffer()).length, 100);
    assert.equal((await logo('domain=adobe.com')).status, 200);                    // empty from the first source: the second one's
    assert.equal((await logo('domain=unknown-co.com')).status, 404);               // a placeholder picture with a 404 is not passed on
    assert.equal((await logo('name=Acme%20Technologies%20Pvt%20Ltd')).status, 200); // acme.com names Acme in its title; its icon is on its home page
    assert.equal((await logo('name=Zeta')).status, 404);                           // zeta.com is not about Zeta: not used
    for (const bad of ['domain=169.254.169.254', 'domain=metadata.google.internal', 'domain=localhost', 'domain=a%20b.com', '']) assert.equal((await logo(bad)).status, 400, bad);
  });
});

test('the results can be narrowed to one company, still read a page at a time', async () => {
  await withServer(async s => {
    s.addResume();
    const web = await s.site();
    const search = (await web.search({ resume: 'ats', country: 'India' })).json.search;
    const companies = search.result.companies;
    assert.deepEqual(companies.map(c => [c.name, c.count]), [['Northwind', 58], ['Contoso', 2]]);   // most jobs first
    const only = (await web.get(`/api/career/jobsearch/${search.id}?company=Contoso`)).json.search.result;
    assert.equal(only.company, 'Contoso');
    const shown = Object.values(only.groups).flatMap(g => g.jobs);
    assert.ok(shown.length === 2 && shown.every(j => j.company === 'Contoso'));
    const page = (await web.get(`/api/career/jobsearch/${search.id}/jobs?bucket=high&page=1&company=Northwind`)).json;
    assert.ok(page.jobs.every(j => j.company === 'Northwind') && page.company === 'Northwind');
    assert.equal((await web.get(`/api/career/jobsearch/${search.id}?company=Nobody`)).json.search.result.company, '');   // not in the results: all companies
  });
});

test('Sector: the candidate sets it in My account, the admin can set it, and AI Job search needs it', async () => {
  await withServer(async s => {
    s.addResume();
    s.app.db.prepare("UPDATE customers SET sector = '' WHERE email = 'asha@example.com'").run();
    const web = await s.site();
    // no sector yet: the search is refused
    const refused = await web.post('/api/career/jobsearch', { country: 'India' });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, 'no-sector');
    assert.equal((await web.get('/api/career/jobsearch')).json.sector, '');
    // an unknown sector is refused, a real one is saved and shown in My account
    assert.equal((await web.post('/api/account/profile', { sector: 'nonsense' })).status, 400);
    assert.equal((await web.post('/api/account/profile', {})).status, 400);
    assert.equal((await web.post('/api/account/profile', { sector: 'agri' })).status, 200);
    const me = (await web.get('/api/account/me')).json;
    assert.equal(me.customer.sector, 'agri');
    assert.ok(me.sectors.some(x => x.id === 'agri'));
    assert.equal((await web.get('/api/career/jobsearch')).json.sector, 'agri');
    // the admin can change it
    const admin = await s.admin('boss@example.com');
    const id = s.app.db.prepare("SELECT id FROM customers WHERE email = 'asha@example.com'").get().id;
    assert.equal((await admin.patch(`/admin/api/customers/${id}`, { sector: 'pharma' })).status, 200);
    assert.equal((await web.get('/api/account/me')).json.customer.sector, 'pharma');
    assert.equal((await admin.patch(`/admin/api/customers/${id}`, { sector: 'nonsense' })).status, 400);
  });
});
