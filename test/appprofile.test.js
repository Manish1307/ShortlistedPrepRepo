'use strict';
// Apply: the application profile (jobs and education as lists with exact dates), its checks, the AI fill from the
// resume, and the application tracker. A fake Gemini answers, so no AI key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const aikeys = require('../admin/lib/aikeys');
const { cleanProfile, problems } = require('../admin/lib/appprofile');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const RESUME = 'Priya Sharma | priya@example.com | +91 98765 00021 | Hyderabad. Research Scientist, GreenSeed Labs, Mar 2021 to Present: doubled haploid lines. '.repeat(4);

const AI_PROFILE = {
  personal: { fullName: 'Priya Sharma', email: '', phone: '+91 98765 00021', city: 'Hyderabad', country: 'India' },
  work: [
    { company: 'GreenSeed Labs', title: 'Research Scientist', startMonth: 3, startYear: 2021, current: true, endYear: 2024, responsibilities: '- Doubled haploid lines\n- Tissue culture' },
    { company: 'AgriGen Institute', title: 'Research Associate', startMonth: 7, startYear: 2018, endMonth: 2, endYear: 2021, responsibilities: '- Plant tissue culture' },
  ],
  education: [{ school: 'University of Hyderabad', degree: 'M.Sc.', field: 'Plant Biotechnology', startYear: 2016, endYear: 2018 }, { school: 'Osmania University', degree: 'B.Sc.', field: 'Botany', startYear: 2013, endYear: 2016 }],
  skills: ['Tissue culture', 'Doubled haploid'], preferences: { noticePeriod: '60 days' },
};

async function start() {
  const seen = [];
  const ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(AI_PROFILE) }] } }], usageMetadata: { totalTokenCount: 4000 } }));
    });
  });
  const aiBase = await listen(ai);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-apply-')), aiUpstream: { gemini: aiBase + '/gemini' } });
  const base = await listen(app.server);
  aikeys.addKey(app.db, app.vault, { provider: 'gemini', label: 'Gemini', key: 'AIza' + 'g'.repeat(35) + 'GGGG', makeDefault: true });
  for (const email of ['priya@example.com', 'ravi@example.com']) {
    const id = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES (?, ?, datetime('now'))").run(email, '').lastInsertRowid;
    app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(id, hashPassword('a-long-password'));
  }
  const site = async email => {
    const login = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-password' }) }).then(r => r.json());
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b) };
  };
  return { app, seen, site, stop: async () => { await app.close(); await new Promise(r => ai.close(r)); } };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('a profile is cleaned to one exact shape: jobs and education are lists, dates are numbers', () => {
  const p = cleanProfile({
    personal: { fullName: '  Priya   Sharma ', email: 'p@x.com' },
    work: [{ company: 'A', startMonth: 13, startYear: 2020, current: true, endYear: 2022 }, { company: '', title: '' }, null],
    education: [{ school: 'U', startYear: 'abc', endYear: 2018 }],
    skills: ['a', '', 'b'],
  });
  assert.equal(p.personal.firstName, 'Priya');
  assert.equal(p.personal.lastName, 'Sharma');
  assert.equal(p.work.length, 1);                                                   // empty rows are dropped
  assert.deepEqual([p.work[0].startMonth, p.work[0].endYear, p.work[0].current], [0, 0, true]);   // bad month → 0; a current job has no end date
  assert.deepEqual([p.education[0].startYear, p.education[0].endYear], [0, 2018]);
  assert.deepEqual(p.skills, ['a', 'b']);
  assert.deepEqual(cleanProfile(null).work, []);
});

test('the checks list what is missing before the candidate applies', () => {
  const p = cleanProfile({
    personal: { fullName: 'Priya', email: 'p@x.com' },
    work: [{ company: 'A', startYear: 2022, endYear: 2020 }, { company: 'B', startYear: 2019 }],
    education: [{ school: 'U', startYear: 2018, endYear: 2016 }, { school: 'V' }],
  });
  const out = problems(p).join('\n');
  assert.match(out, /phone number is missing/);
  assert.match(out, /A: the end date is before the start date/);
  assert.match(out, /B: end date is missing/);
  assert.match(out, /U: the end year is before the start year/);
  assert.match(out, /V: end year is missing/);
});

test('the AI fills the profile from the resume; the candidate edits and confirms it', async () => {
  await withServer(async s => {
    const priya = await s.site('priya@example.com');
    assert.equal((await priya.get('/api/career/app-profile')).json.profile, null);          // nothing yet
    assert.equal((await priya.post('/api/career/app-profile/generate')).status, 400);       // no resume yet

    assert.equal((await priya.post('/api/career/resume', { text: RESUME, fileName: 'priya.docx' })).status, 200);
    const gen = await priya.post('/api/career/app-profile/generate');
    assert.equal(gen.status, 200);
    const p = gen.json.profile;
    assert.deepEqual([p.work.length, p.education.length], [2, 2]);
    assert.equal(p.personal.email, 'priya@example.com');                                    // filled from the account when the resume gave none
    assert.deepEqual([p.work[0].current, p.work[0].endYear], [true, 0]);                    // current job: no end date
    assert.deepEqual([p.work[1].startMonth, p.work[1].startYear, p.work[1].endMonth, p.work[1].endYear], [7, 2018, 2, 2021]);
    assert.equal(gen.json.confirmedAt, null);
    assert.equal(gen.json.usage.used, 1);                                                   // one AI action

    // edits keep every row and are confirmed on request
    const edited = { ...p, work: [...p.work, { company: 'Third Co', title: 'Intern', startMonth: 1, startYear: 2017, endMonth: 6, endYear: 2017 }] };
    const saved = await priya.post('/api/career/app-profile', { profile: edited, confirm: true });
    assert.equal(saved.json.profile.work.length, 3);
    assert.ok(saved.json.confirmedAt);
    assert.equal((await priya.get('/api/career/app-profile')).json.profile.work[2].company, 'Third Co');
    // another candidate cannot see it
    const ravi = await s.site('ravi@example.com');
    assert.equal((await ravi.get('/api/career/app-profile')).json.profile, null);
  });
});

test('the application tracker keeps one row per job link', async () => {
  await withServer(async s => {
    const priya = await s.site('priya@example.com');
    const job = { title: 'Scientist, Doubled Haploid', company: 'Corteva', url: 'https://careers.example.com/job/1' };
    assert.equal((await priya.post('/api/career/applications', { ...job, url: 'http://insecure.example.com' })).status, 400);
    assert.equal((await priya.post('/api/career/applications', job)).json.application.status, 'applied');
    assert.equal((await priya.post('/api/career/applications', { ...job, status: 'interview' })).json.application.status, 'interview');
    const list = (await priya.get('/api/career/applications')).json.applications;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'interview');
    const ravi = await s.site('ravi@example.com');
    assert.equal((await ravi.get('/api/career/applications')).json.applications.length, 0);
    assert.equal((await ravi.post(`/api/career/applications/${list[0].id}/delete`)).status, 200);   // not his: nothing deleted
    assert.equal((await priya.get('/api/career/applications')).json.applications.length, 1);
    assert.equal((await priya.post(`/api/career/applications/${list[0].id}/delete`)).status, 200);
    assert.equal((await priya.get('/api/career/applications')).json.applications.length, 0);
  });
});
