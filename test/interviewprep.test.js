'use strict';
// Interview prep: personalised questions from the candidate's resume, for the Virtual Interview app (licence token) and
// My account (sign-in), kept per customer and shown in the dashboard. A fake Gemini answers, so no key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const aikeys = require('../admin/lib/aikeys');
const licences = require('../admin/lib/licence');
const { cleanQuestions } = require('../admin/lib/interviewprep');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const RESUME = 'Priya Sharma, Research Scientist at GreenSeed Labs (2021 to present). Developed doubled haploid lines in maize and reduced the breeding cycle by two seasons. ' +
  'Ran plant tissue culture protocols for callus induction and regeneration. Trained four lab technicians. M.Sc. Plant Biotechnology, University of Hyderabad, 2018. '.repeat(2);

const makeSet = () => ({
  personalised: Array.from({ length: 11 }, (_, i) => ({ question: `You wrote that you reduced the breeding cycle: how did you do it (${i})?`, topic: 'Doubled haploid', resumeRef: i === 0 ? 'reduced the breeding cycle by two seasons' : 'a line that is not in the resume', answer: 'I used doubled haploid induction so that homozygous lines were ready in one generation instead of six, which saved two seasons.', points: ['Induction', 'Chromosome doubling', 'Validation'] })),
  scenario: Array.from({ length: 5 }, (_, i) => ({ question: `Callus contamination is rising in the lab: what do you do (${i})?`, topic: 'Tissue culture', resumeRef: '', answer: 'I would isolate the affected batches, check the sterilisation steps and media, and repeat with a control to find the cause.', points: ['Isolate', 'Check media'] })),
});

async function start() {
  const seen = [];
  let bad = false;
  const ai = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(bad ? { personalised: [{ question: 'x' }] } : makeSet()) }] } }], usageMetadata: { totalTokenCount: 6000 } }));
    });
  });
  const aiBase = await listen(ai);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ivprep-')), aiUpstream: { gemini: aiBase + '/gemini' } });
  const base = await listen(app.server);
  aikeys.addKey(app.db, app.vault, { provider: 'gemini', label: 'Gemini', key: 'AIza' + 'g'.repeat(35) + 'GGGG', makeDefault: true });
  const addCustomer = (email, resume) => {
    const id = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES (?, ?, datetime('now'))").run(email, email).lastInsertRowid;
    app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(id, hashPassword('a-long-password'));
    if (resume) app.db.prepare("INSERT INTO career_resumes (customer_id, source_text, file_name, uploaded_at) VALUES (?, ?, 'cv.docx', datetime('now'))").run(id, resume);
    return id;
  };
  const priya = addCustomer('priya@example.com', RESUME), ravi = addCustomer('ravi@example.com', '');
  app.db.prepare("INSERT INTO career_versions (customer_id, role, content_json, created_at) VALUES (?, 'Seed Breeder', ?, datetime('now'))")
    .run(priya, JSON.stringify({ resume: { name: 'Priya Sharma', headline: 'Seed Breeder', summary: RESUME.slice(0, 200), experience: [{ title: 'Scientist', company: 'GreenSeed Labs', start: '2021', end: 'Present', bullets: ['Doubled haploid lines'] }] } }));
  const lic = licences.createLicence(app.db, { customerId: priya, plan: 'personal', days: 365 });
  const lic2 = licences.createLicence(app.db, { customerId: ravi, plan: 'personal', days: 365 });
  const deviceId = crypto.randomBytes(16).toString('hex');
  const activate = async (l, device) => { await fetch(base + '/api/licence/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: l.key, deviceId: device, deviceName: 'PC' }) }); };
  await activate(lic, deviceId);
  const token = async (l = lic, device = deviceId) => (await (await fetch(base + '/api/app/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: l.key, deviceId: device, deviceName: 'PC', proxy: true }) })).json()).aiProxy.token;
  const appCall = async (method, url, tok, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const site = async email => {
    const login = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-password' }) }).then(r => r.json());
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b) };
  };
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?,?,?,?,datetime('now'))").run('boss@example.com', 'Boss', 'owner', hashPassword('correct-horse-battery'));
  const admin = async () => {
    let cookie = '';
    const call = async (method, url) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin', ...(cookie ? { Cookie: cookie } : {}) }, body: method === 'POST' ? JSON.stringify({ email: 'boss@example.com', password: 'correct-horse-battery' }) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, json: await res.json() };
    };
    await call('POST', '/admin/api/login');
    return { get: u => call('GET', u) };
  };
  return { app, seen, priya, ravi, lic, lic2, token, appCall, site, admin, activate, badAi: v => { bad = v; }, stop: async () => { await app.close(); await new Promise(r => ai.close(r)); } };
}
async function withServer(fn) { const s = await start(); try { await fn(s); } finally { await s.stop(); } }

test('questions are cleaned: counts are capped, empty ones dropped, a quote that is not in the resume is blanked', () => {
  const out = cleanQuestions(makeSet(), RESUME);
  assert.deepEqual([out.filter(q => q.kind === 'personal').length, out.filter(q => q.kind === 'scenario').length], [10, 5]);   // 11 → 10
  assert.equal(out[0].resumeRef, 'reduced the breeding cycle by two seasons');
  assert.equal(out[1].resumeRef, '');
  assert.deepEqual(cleanQuestions({ personalised: [{ question: 'x', answer: 'y' }, null] }, RESUME), []);
  assert.deepEqual(cleanQuestions(null, RESUME), []);
});

test('the app lists the resumes of the licence holder and makes personalised questions from the one picked', async () => {
  await withServer(async s => {
    assert.equal((await s.appCall('GET', '/api/app/interview/resumes')).status, 401);               // no token
    const tok = await s.token();
    const list = (await s.appCall('GET', '/api/app/interview/resumes', tok)).json;
    assert.deepEqual(list.resumes.map(r => r.key), ['main', list.resumes[1].key]);                    // the uploaded resume, then the role version
    assert.match(list.resumes[1].label, /Seed Breeder/);

    const made = await s.appCall('POST', '/api/app/interview/questions', tok, { resumeKey: list.resumes[1].key, role: 'Seed Breeder' });
    assert.equal(made.status, 200);
    const set = made.json.set;
    assert.equal(set.questions.length, 15);
    assert.equal(set.source, 'app');
    assert.equal(set.role, 'Seed Breeder');
    assert.ok(set.questions.every(q => q.question && q.answer));
    // the AI was given only that resume
    const prompt = s.seen[s.seen.length - 1].contents[0].parts[0].text;
    assert.match(prompt, /Resume for Seed Breeder/);
    assert.match(prompt, /TARGET ROLE: Seed Breeder/);

    const again = (await s.appCall('GET', '/api/app/interview/sets/' + set.id, tok)).json.set;
    assert.equal(again.questions.length, 15);
    assert.equal((await s.appCall('GET', '/api/app/interview/resumes', tok)).json.sets.length, 1);
  });
});

test('a licence without a resume asks for one; another customer cannot read the set; a bad AI reply is an error', async () => {
  await withServer(async s => {
    const devB = crypto.randomBytes(16).toString('hex');
    await s.activate(s.lic2, devB);
    const tokB = await s.token(s.lic2, devB);
    const none = await s.appCall('POST', '/api/app/interview/questions', tokB, {});
    assert.equal(none.status, 400);
    assert.equal(none.json.code, 'no-resume');

    const tok = await s.token();
    const set = (await s.appCall('POST', '/api/app/interview/questions', tok, {})).json.set;       // no resumeKey: the first resume
    assert.equal((await s.appCall('GET', '/api/app/interview/sets/' + set.id, tokB)).status, 404);

    s.badAi(true);
    const bad = await s.appCall('POST', '/api/app/interview/questions', tok, {});
    assert.equal(bad.status, 502);
    s.badAi(false);
  });
});

test('the same sets are in My account and in the dashboard; one AI action is counted for each set', async () => {
  await withServer(async s => {
    const tok = await s.token();
    await s.appCall('POST', '/api/app/interview/questions', tok, { resumeKey: 'main' });           // made in the app
    const priya = await s.site('priya@example.com');
    const web = await priya.post('/api/account/interview', { resumeKey: 'main', role: 'Scientist' });   // made on the website
    assert.equal(web.status, 200);
    assert.equal(web.json.set.source, 'web');
    assert.equal(web.json.usage.used, 2);

    const mine = (await priya.get('/api/account/interview')).json;
    assert.deepEqual(mine.sets.map(x => x.source), ['web', 'app']);                                 // both, newest first
    assert.equal(mine.sets[1].questions.length, 15);

    const boss = await s.admin();
    const seen = (await boss.get(`/admin/api/customers/${s.priya}/interview`)).json;
    assert.equal(seen.sets.length, 2);
    assert.equal(seen.resumes.length, 2);
    assert.equal((await boss.get('/admin/api/customers/999999/interview')).status, 404);

    const ravi = await s.site('ravi@example.com');
    assert.equal((await ravi.get('/api/account/interview')).json.sets.length, 0);                 // not his
    assert.equal((await ravi.post(`/api/account/interview/${mine.sets[0].id}/delete`)).status, 200);
    assert.equal((await priya.get('/api/account/interview')).json.sets.length, 2);                // nothing deleted
    assert.equal((await priya.post(`/api/account/interview/${mine.sets[0].id}/delete`)).status, 200);
    assert.equal((await priya.get('/api/account/interview')).json.sets.length, 1);
  });
});

test('the app client lists resumes, makes personalised questions, renews an expired token and explains a missing licence', async () => {
  const { InterviewPrepClient } = require('../src/interview/prep');
  await withServer(async s => {
    const base = `http://127.0.0.1:${s.app.server.address().port}`;
    let renewed = 0;
    const good = await s.token();
    const client = new InterviewPrepClient({ serverUrl: base, getToken: async renew => { if (renew) renewed++; return renew ? good : 'expired-token'; } });
    const list = await client.resumes();                                       // the first call is refused (401), the token is renewed once
    assert.equal(renewed, 1);
    assert.equal(list.resumes[0].key, 'main');
    const set = await client.makeSet({ resumeKey: 'main', role: 'Scientist' });
    assert.equal(set.questions.length, 15);
    assert.equal((await client.getSet(set.id)).id, set.id);
    await assert.rejects(() => client.getSet(999999), /not found/i);
    const none = new InterviewPrepClient({ serverUrl: base, getToken: async () => null });
    await assert.rejects(() => none.resumes(), err => err.code === 'licence' && /Activate your licence/.test(err.message));
    const offline = new InterviewPrepClient({ serverUrl: 'http://127.0.0.1:1', getToken: async () => good });
    await assert.rejects(() => offline.resumes(), err => err.code === 'network');
  });
});

test('the interviewer is given the resume-based model answer when scoring', async () => {
  const coach = require('../src/interview/coach');
  const seen = [];
  const ai = { complete: async ({ user }) => { seen.push(user); return JSON.stringify({ score: 7, verdict: 'Good', strengths: [], missing: [], betterAnswer: '', followUp: '' }); } };
  await coach.evaluateAnswer(ai, { company: 'Any', role: 'Scientist', round: 'hr', level: 'mid', question: 'q?', answer: 'my answer', reference: 'I used doubled haploid induction.' });
  await coach.evaluateAnswer(ai, { company: 'Any', role: 'Scientist', round: 'hr', level: 'mid', question: 'q?', answer: 'my answer' });
  assert.match(seen[0], /own resume.*\nI used doubled haploid induction\./);
  assert.doesNotMatch(seen[1], /own resume/);
});
