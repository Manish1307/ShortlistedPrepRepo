'use strict';
// Recommended jobs: the best cached jobs for a resume, found without the AI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const rec = require('../admin/lib/recommended');

const JAVA_RESUME = `AARAV MEHTA
Java Backend Developer | 4 years of experience | Bengaluru, India
Email: aarav@example.com

PROFESSIONAL SUMMARY
Java Backend Developer with 4 years of experience building payment services.

SKILLS
Java 17, Spring Boot, Hibernate, Microservices, Kafka, PostgreSQL, Docker, REST APIs, JUnit, AWS

EXPERIENCE
Java Backend Developer, Example Technologies (2020 - Present)
- Built payment microservices in Spring Boot handling 2 million requests a day
- Cut API latency by 38% with Redis caching

EDUCATION
B.Tech Computer Science, VIT Vellore, 2020`;

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

test('profile: the roles, skills and years come from the resume text', () => {
  const p = rec.profileOf(JAVA_RESUME);
  assert.deepEqual(p.roles, ['java backend developer']);
  assert.equal(p.years, 4);
  for (const s of ['java', 'spring boot', 'kafka', 'postgresql', 'docker', 'junit', 'aws']) assert.ok(p.skills.includes(s), 'skill: ' + s);
  assert.ok(!p.skills.includes('communication'));
  // a skill the keyword list does not know is read from the Skills section
  assert.ok(rec.skillsOf('SKILLS\nHAZOP, Aspen HYSYS, Heat exchangers\n\nEXPERIENCE\nx').includes('hazop'));
  assert.equal(rec.yearsOf('Over 6+ years of experience in sales'), 6);
  assert.equal(rec.yearsOf('A fresher with no experience'), null);
});

const job = (id, title, over = {}) => ({ id, title, department: '', description: '', location: 'Bengaluru, India', country: 'India', posted_at: daysAgo(3), company: 'Acme', ...over });

test('ranking: the job that fits the role and skills first, jobs from another field left out', () => {
  const profile = rec.profileOf(JAVA_RESUME);
  const ranked = rec.rank(profile, [
    job(1, 'Staff Nurse', { description: 'Care for patients on the ward.' }),
    job(2, 'Senior Java Developer', { description: 'Spring Boot, Kafka, PostgreSQL and Docker microservices on AWS.' }),
    job(3, 'Java Backend Developer', { description: 'Build REST APIs with Spring Boot and Hibernate. JUnit tests.', company: 'Beta' }),
    job(4, 'Sales Executive', { description: 'Sell software to banks.' }),
    job(5, 'Civil Site Engineer', { description: 'AutoCAD and site supervision.' }),
  ]);
  assert.deepEqual(ranked.map(x => x.job.id), [3, 2], 'only the two Java jobs, the exact title first');
  assert.equal(ranked[0].role, 'java backend developer');
  assert.ok(ranked[0].skills.includes('spring boot'));
  assert.ok(ranked[0].score > ranked[1].score && ranked[0].score <= 100);
});

test('ranking: newer postings, the candidate\'s city, and the level of the job count', () => {
  const profile = rec.profileOf(JAVA_RESUME);   // 4 years
  const base = { description: 'Java, Spring Boot, Kafka and Docker.' };
  const [fresh, old] = rec.rank(profile, [job(1, 'Java Developer', { ...base, posted_at: daysAgo(60), company: 'A' }), job(2, 'Java Developer', { ...base, posted_at: daysAgo(2), company: 'B' })]);
  assert.equal(fresh.job.id, 2, 'the fresher posting ranks higher');
  assert.ok(fresh.score > old.score);
  const city = rec.rank(profile, [job(1, 'Java Developer', { ...base, location: 'Pune, India', company: 'A' }), job(2, 'Java Developer', { ...base, location: 'Bengaluru, India', company: 'B' })], { city: 'Bengaluru' });
  assert.equal(city[0].job.id, 2, 'the city of the candidate first');
  // a fresher is not shown a director's job above a normal one
  const fresher = rec.profileOf(JAVA_RESUME.replace('4 years', '1 year'));
  const lvl = rec.rank(fresher, [job(1, 'Senior Java Developer', { ...base, company: 'A' }), job(2, 'Java Developer', { ...base, company: 'B' })]);
  assert.equal(lvl[0].job.id, 2);
});

test('ranking: one company cannot fill the list', () => {
  const profile = rec.profileOf(JAVA_RESUME);
  const many = Array.from({ length: 12 }, (_, i) => job(i + 1, 'Java Developer ' + i, { description: 'Spring Boot Kafka Docker', company: 'Big Co' }));
  assert.equal(rec.rank(profile, many).length, 4);
});

// ---------------------------------------------------------------- API

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rec-')) });
  const base = await listen(app.server);
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const signup = await call('POST', '/api/account/signup', { name: 'Asha', email: 'asha@example.com', password: 'Correct-Horse-9', terms: true });
  const token = signup.json.token;
  // jobs the server already holds
  const co = (name, url) => Number(app.db.prepare("INSERT INTO job_companies (name, careers_url, provider, board, created_at) VALUES (?,?,'greenhouse',?,datetime('now'))").run(name, url, name.toLowerCase()).lastInsertRowid);
  const acme = co('Acme', 'https://boards.greenhouse.io/acme'), beta = co('Beta', 'https://boards.greenhouse.io/beta');
  const put = (companyId, ext, title, over = {}) => app.db.prepare(`INSERT INTO jobs (company_id, external_id, title, location, country, posted_at, url, description, active, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`).run(companyId, ext, title, over.location || 'Bengaluru, India', over.country === undefined ? 'India' : over.country, over.postedAt === undefined ? daysAgo(3) : over.postedAt,
    'https://jobs.example.com/' + ext, over.description || '', over.active === undefined ? 1 : over.active);
  put(acme, 'a1', 'Java Backend Developer', { description: 'Spring Boot, Kafka, PostgreSQL and Docker.' });
  put(acme, 'a2', 'Staff Nurse', { description: 'Ward care.' });
  put(beta, 'b1', 'Senior Software Engineer - Java', { description: 'Java, Spring, Hibernate, microservices on AWS.', location: 'Remote', country: 'India' });
  put(beta, 'b2', 'Java Developer', { description: 'Java, Spring Boot and Kafka.', country: 'United States', location: 'Austin, TX' });
  put(beta, 'b3', 'Java Developer (closed)', { description: 'Java, Spring Boot and Kafka.', active: 0 });
  put(beta, 'b4', 'Java Developer (old)', { description: 'Java, Spring Boot and Kafka.', postedAt: daysAgo(90) });
  return { app, call, token, close: app.close };
}

test('API: sign-in and a resume are needed, and the AI is not used', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/api/career/recommended')).status, 401, 'sign in first');
    const none = await s.call('GET', '/api/career/recommended', undefined, s.token);
    assert.equal(none.status, 400);
    assert.equal(none.json.code, 'no-resume');
    assert.equal((await s.call('POST', '/api/career/resume', { text: JAVA_RESUME, fileName: 'cv.txt' }, s.token)).status, 200);
    const used = () => s.app.db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM career_usage').get().n;
    const before = used();
    const r = await s.call('GET', '/api/career/recommended?country=India', undefined, s.token);
    assert.equal(r.status, 200);
    assert.equal(used(), before, 'no AI action is counted');
    assert.deepEqual(r.json.basedOn.roles, ['java backend developer']);
    assert.ok(r.json.held >= 5, 'the number of jobs the server holds');
  } finally { await s.close(); }
});

test('API: recommends the matching cached jobs, in the country and date range asked for', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/career/resume', { text: JAVA_RESUME, fileName: 'cv.txt' }, s.token);
    const ask = q => s.call('GET', '/api/career/recommended' + q, undefined, s.token).then(r => r.json);
    const india = await ask('?country=India');
    const titles = india.recommended.map(j => j.title);
    assert.deepEqual(titles.slice(0, 2).sort(), ['Java Backend Developer', 'Senior Software Engineer - Java'].sort());
    assert.ok(!titles.includes('Staff Nurse'), 'another field');
    assert.ok(!titles.includes('Java Developer (closed)'), 'a closed job');
    assert.ok(!titles.includes('Java Developer'), 'a job in another country');
    const first = india.recommended[0];
    assert.equal(first.title, 'Java Backend Developer', 'the exact role first');
    assert.deepEqual(Object.keys(first).sort(), ['company', 'country', 'domain', 'id', 'location', 'postedAt', 'role', 'score', 'skills', 'title', 'url']);
    assert.match(first.url, /^https:\/\//);
    assert.ok(first.skills.includes('kafka'));
    assert.equal(first.company, 'Acme');

    assert.ok((await ask('?country=United%20States')).recommended.some(j => j.title === 'Java Developer'), 'the other country');
    const recent = (await ask('?country=India&days=30')).recommended.map(j => j.title);
    assert.ok(!recent.includes('Java Developer (old)'), 'posted 90 days ago');
    assert.ok((await ask('?country=India')).recommended.map(j => j.title).includes('Java Developer (old)'), 'any time');
    const nowhere = await ask('?country=Narnia');
    assert.deepEqual(nowhere.recommended, []);
    assert.match(nowhere.message, /no jobs for that location/);
  } finally { await s.close(); }
});

test('API: a resume with no role or skills says so, and roles from the candidate\'s role resumes count', async () => {
  const s = await start();
  try {
    await s.call('POST', '/api/career/resume', { text: 'Hello. '.repeat(60), fileName: 'cv.txt' }, s.token);
    const empty = await s.call('GET', '/api/career/recommended?country=India', undefined, s.token);
    assert.deepEqual(empty.json.recommended, []);
    assert.match(empty.json.message, /job title or skills/);
    // a role-based resume names a role the main resume does not
    const id = s.app.db.prepare("SELECT id FROM customers WHERE email = 'asha@example.com'").get().id;
    s.app.db.prepare("INSERT INTO career_versions (customer_id, role, content_json, created_at) VALUES (?, 'Java Developer', '{}', datetime('now'))").run(id);
    const withRole = await s.call('GET', '/api/career/recommended?country=India&days=0', undefined, s.token);
    assert.ok(withRole.json.basedOn.roles.includes('java developer'));
    assert.ok(withRole.json.recommended.length > 0);
  } finally { await s.close(); }
});
