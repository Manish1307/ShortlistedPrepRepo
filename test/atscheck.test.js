'use strict';
// The free ATS check: the rules-based score, the contact details read from the resume, and the opportunity it creates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const { extractContact, scoreResume } = require('../admin/lib/atscheck');

const GOOD = `NEHA SHARMA
neha.sharma@example.com | +91 98765 43210 | Noida, India | linkedin.com/in/neha

Summary
Junior Java developer with two years of experience building REST API services with Spring Boot and MySQL.

Skills
Java, Spring Boot, SQL, MySQL, Docker, Git, JUnit, Agile, Jenkins, REST API

Experience
Software Engineer, Acme Technologies, Noida   Jan 2023 – Present
- Built 12 REST API endpoints used by 40,000 customers, cutting response time by 35%
- Reduced deployment time from 2 hours to 20 minutes by automating Jenkins pipelines
- Led a team of 4 interns and delivered 3 projects ahead of schedule
- Improved test coverage from 40% to 85% with JUnit

Projects
- Developed an order tracking app with Spring Boot and MySQL for 500 users
- Designed a Docker based test setup that saved 6 hours a week

Education
B.Tech Computer Science, ABC University, 2018 – 2022
`;

const WEAK = `resume
I am a hard working person. I did many things in my previous job and I am responsible for tasks. Please give me a job. I like learning and my team likes me. I am good at everything and my work is good.`.repeat(2);

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ats-')) });
  const base = await listen(app.server);
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES ('boss@example.com', 'Boss', 'owner', ?, datetime('now'))").run(hashPassword('correct-horse-battery'));
  let cookie = '';
  const call = async (method, url, body, admin) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Requested-With': 'admin', Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  await call('POST', '/admin/api/login', { email: 'boss@example.com', password: 'correct-horse-battery' }, true);
  return { app, call, close: app.close };
}

test('name, email and mobile are read from the resume', () => {
  assert.deepEqual(extractContact(GOOD), { name: 'Neha Sharma', email: 'neha.sharma@example.com', phone: '+91 98765 43210' });
  assert.equal(extractContact('Rahul K Verma\nMobile: 9876543210\nrahul@mail.in\n').phone, '9876543210');
  assert.equal(extractContact('Rahul K Verma\nrahul@mail.in').name, 'Rahul K Verma');
  assert.deepEqual(extractContact('Summary\nNo details here at all'), { name: '', email: '', phone: '' });
});

test('a well-built resume scores high and a weak one low', () => {
  const good = scoreResume(GOOD), weak = scoreResume(WEAK);
  assert.ok(good.score >= 80, 'good scored ' + good.score);
  assert.ok(weak.score <= 40, 'weak scored ' + weak.score);
  assert.equal(good.checks.reduce((n, c) => n + c.weight, 0), 100);
  assert.ok(good.skills.includes('java') && good.skills.includes('rest api'));
  assert.ok(weak.fixFirst.length > 0);
});

test('checking a resume shows the score and makes an opportunity with the contact details', async () => {
  const { app, call, close } = await start();
  try {
    assert.equal((await call('POST', '/api/ats-check', { text: GOOD })).status, 400);                      // consent is required
    const r = await call('POST', '/api/ats-check', { text: GOOD, consent: true, fileName: 'neha.pdf', page: '/ats-checker.html' });
    assert.equal(r.status, 200);
    assert.ok(r.json.score >= 80);
    assert.equal(r.json.saved, true);
    const opp = app.db.prepare("SELECT * FROM opportunities WHERE email = 'neha.sharma@example.com'").get();
    assert.equal(opp.name, 'Neha Sharma');
    assert.equal(opp.phone, '+91 98765 43210');
    assert.match(opp.message, /Free ATS check: \d+\/100/);
    const list = (await call('GET', '/admin/api/ats-checks', undefined, true)).json;
    assert.equal(list.total, 1);
    assert.equal((await call('GET', '/admin/api/ats-checks/' + list.checks[0].id, undefined, true)).json.check.result.checks.length, 11);
    // the whole resume text is not kept
    assert.ok(!JSON.stringify(app.db.prepare('SELECT * FROM ats_checks').all()).includes('Acme Technologies'));
  } finally { await close(); }
});

test('a resume with no email shows the score but saves nothing until an email is given', async () => {
  const { app, call, close } = await start();
  try {
    const noEmail = GOOD.replace('neha.sharma@example.com | ', '');
    const first = await call('POST', '/api/ats-check', { text: noEmail, consent: true });
    assert.equal(first.json.needEmail, true);
    assert.ok(first.json.score > 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 0);
    const second = await call('POST', '/api/ats-check', { text: noEmail, consent: true, email: 'neha@home.example' });
    assert.equal(second.json.saved, true);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n, 1);
    assert.equal((await call('POST', '/api/ats-check', { text: noEmail, consent: true, email: 'not an email' })).status, 400);
    assert.equal((await call('GET', '/admin/api/ats-checks')).status, 401);
  } finally { await close(); }
});
