'use strict';
// Dashboard → Candidates: each customer's progress in the Career toolkit, their documents, job searches, AI use
// and activity log. The candidate's own actions on the website are recorded as activity.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const RESUME = { name: 'Asha Rao', headline: '.NET Developer', contact: {}, summary: 'Six years of .NET.', skills: [{ group: 'Languages', items: ['C#'] }],
  experience: [{ title: 'Engineer', company: 'Contoso', start: '2020', end: '2026', bullets: ['Built APIs.'] }], projects: [], education: [], certifications: [] };

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cand-')) });
  const base = await listen(app.server);
  const db = app.db;
  for (const [mail, role] of [['boss@example.com', 'owner'], ['help@example.com', 'support']]) {
    db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run(mail, mail, role, hashPassword('correct-horse-battery'));
  }
  const asha = Number(db.prepare("INSERT INTO customers (email, name, organisation, created_at) VALUES ('asha@example.com', 'Asha Rao', 'Contoso', datetime('now'))").run().lastInsertRowid);
  db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(asha, hashPassword('a-long-password'));
  db.prepare("INSERT INTO customers (email, name, created_at) VALUES ('buyer@example.com', 'Only a buyer', datetime('now'))").run();   // no login, no toolkit use: not a candidate
  const admin = async email => {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const type = r.headers.get('content-type') || '';
      return { status: r.status, headers: r.headers, json: type.includes('json') ? await r.json() : null, bytes: type.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
    };
    await call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' });
    return { get: u => call('GET', u) };
  };
  const site = async () => {
    const { token } = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'asha@example.com', password: 'a-long-password' }) }).then(r => r.json());
    return { post: (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(b || {}) }).then(r => r.json()) };
  };
  return { app, db, asha, admin, site, stop: () => app.close() };
}

test('the dashboard shows each candidate\'s progress, documents, job searches and activity', async () => {
  const s = await start();
  try {
    const boss = await s.admin('boss@example.com');
    let list = (await boss.get('/admin/api/candidates')).json;
    assert.deepEqual(list.candidates.map(c => c.email), ['asha@example.com']);                  // has a login; the buyer does not show
    assert.equal(list.candidates[0].done, 0);
    assert.equal(list.candidates[0].resume, null);

    // the candidate signs in and uploads a resume on the website: both are recorded
    const web = await s.site();
    assert.equal((await web.post('/api/career/resume', { text: 'Asha Rao. Senior .NET developer with C#, ASP.NET Core and Azure. '.repeat(5), fileName: 'asha.docx' })).ok, true);

    // the rest of the toolkit, as the AI would have saved it
    s.db.prepare("UPDATE career_resumes SET ats_json = ?, ats_at = datetime('now') WHERE customer_id = ?")
      .run(JSON.stringify({ score: 81, verdict: 'Good', checks: [{ name: 'Headings', status: 'pass', detail: 'Standard' }], keywords: { present: ['C#'], missing: ['Docker'] }, fixes: [], suggestedRoles: ['.NET Developer'], resume: RESUME }), s.asha);
    const v = Number(s.db.prepare("INSERT INTO career_versions (customer_id, role, content_json, created_at) VALUES (?, 'Scrum Master', ?, datetime('now'))").run(s.asha, JSON.stringify({ fitScore: 68, fitNote: 'ok', resume: RESUME })).lastInsertRowid);
    const m = Number(s.db.prepare("INSERT INTO career_matches (customer_id, job_title, company, jd_text, result_json, created_at) VALUES (?, 'Backend Engineer', 'Northwind', 'jd', ?, datetime('now'))")
      .run(s.asha, JSON.stringify({ score: 74, verdict: 'Strong', coverLetter: 'Dear Hiring Manager,\n\nHello.' })).lastInsertRowid);
    const result = { profile: { level: 'Mid-level', summary: 'Strong', strengths: [], targetRoles: ['.NET Developer'], resumeFixes: ['Add numbers'] },
      jobs: [{ id: 1, title: 'Senior .NET Developer', company: 'Contoso', location: 'Pune', country: 'India', url: 'https://example.com/1', score: 88, bucket: 'high', why: 'C#', gap: 'none' },
        { id: 2, title: 'QA Engineer', company: 'Contoso', location: 'Pune', country: 'India', url: 'https://example.com/2', score: 40, bucket: 'stretch', why: 'Some', gap: 'Testing' }],
      coverage: { companies: 1, loading: 0, live: 2, considered: 2, notFound: [], notSupported: [], failed: [] } };
    const sid = Number(s.db.prepare("INSERT INTO career_job_searches (customer_id, params_json, status, result_json, created_at, finished_at) VALUES (?, ?, 'done', ?, datetime('now'), datetime('now'))")
      .run(s.asha, JSON.stringify({ resume: 'all', country: 'India', role: '.NET', resumeLabel: 'All my resumes (2)' }), JSON.stringify(result)).lastInsertRowid);
    s.db.prepare("INSERT INTO career_usage (customer_id, day, count) VALUES (?, ?, 3)").run(s.asha, new Date().toISOString().slice(0, 10));

    list = (await boss.get('/admin/api/candidates?filter=resume')).json;
    const c = list.candidates[0];
    assert.deepEqual([c.done, c.resume.atsScore, c.versions, c.matches, c.searches, c.aiActions], [5, 81, 1, 1, 1, 3]);
    assert.deepEqual(list.stats, { total: 1, withResume: 1, atsDone: 1, activeWeek: 1, searchesWeek: 1 });
    assert.equal((await boss.get('/admin/api/candidates?filter=noresume')).json.candidates.length, 0);
    assert.equal((await boss.get('/admin/api/candidates?q=nobody')).json.candidates.length, 0);

    const help = await s.admin('help@example.com');                                             // support may look too
    const d = (await help.get(`/admin/api/candidates/${s.asha}`)).json;
    assert.equal(d.resume.fileName, 'asha.docx');
    assert.equal(d.resume.ats.score, 81);
    assert.deepEqual([d.versions[0].role, d.matches[0].hasLetter, d.searches[0].counts], ['Scrum Master', true, { high: 1, medium: 0, stretch: 1 }]);
    assert.deepEqual(d.usage.map(u => u.count), [3]);
    assert.deepEqual(d.activity.map(a => a.action), ['resume.uploaded', 'login']);              // newest first
    assert.match(d.activity[0].detail, /asha\.docx/);

    const full = (await boss.get(`/admin/api/candidates/${s.asha}/searches/${sid}`)).json.search;
    assert.equal(full.result.jobs[0].title, 'Senior .NET Developer');
    assert.equal((await boss.get(`/admin/api/candidates/${s.asha}/searches/9999`)).status, 404);

    // downloads: the uploaded text and the Word documents, each one audited
    const original = await boss.get(`/admin/api/candidates/${s.asha}/download?kind=original`);
    assert.match(original.headers.get('content-disposition'), /asha\.txt/);
    assert.match(original.bytes.toString('utf8'), /^Asha Rao\. Senior \.NET/);
    for (const [kind, id] of [['ats', 0], ['version', v], ['letter', m]]) {
      const r = await boss.get(`/admin/api/candidates/${s.asha}/download?kind=${kind}${id ? '&id=' + id : ''}`);
      assert.equal(r.status, 200, kind);
      assert.equal(r.bytes.subarray(0, 2).toString(), 'PK');                                     // a Word (zip) file
    }
    assert.equal((await boss.get(`/admin/api/candidates/${s.asha}/download?kind=version&id=9999`)).status, 404);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'candidate.download'").get().n, 4);
  } finally { await s.stop(); }
});

test('the candidate pages need an admin sign-in', async () => {
  const s = await start();
  try {
    const base = `http://127.0.0.1:${s.app.server.address().port}`;
    assert.equal((await fetch(base + '/admin/api/candidates')).status, 401);
    assert.equal((await fetch(`${base}/admin/api/candidates/${s.asha}/download?kind=original`)).status, 401);
  } finally { await s.stop(); }
});
