'use strict';
// Career toolkit: resume upload, ATS check and fix, role-based resumes, job match with a cover letter, Word downloads.
// A fake Gemini / Groq answers like the real services, so no AI key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const aikeys = require('../admin/lib/aikeys');
const { cleanResume, resumeText } = require('../admin/lib/career');
const { parseJson } = require('../admin/lib/careerai');

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const RESUME = `Asha Rao | asha@example.com | +91 98765 43210 | Pune
Senior Software Engineer at Contoso (2021 - Present): built REST APIs in C# and .NET 8, led a team of 4, ran Scrum ceremonies as acting Scrum Master.
Software Engineer at Fabrikam (2018 - 2021): SQL Server, Azure Functions, Angular front ends. Migrated a monolith to microservices.
B.Tech Computer Science, NIT Trichy, 2018. Certified ScrumMaster (CSM). AZ-204.`.repeat(2);

const RESUME_JSON = {
  name: 'Asha Rao', headline: 'Senior .NET Engineer', contact: { email: 'asha@example.com', phone: '+91 98765 43210', location: 'Pune' },
  summary: 'Six years building .NET services.', skills: [{ group: 'Languages', items: ['C#', 'SQL'] }],
  experience: [{ title: 'Senior Software Engineer', company: 'Contoso', start: '2021', end: 'Present', bullets: ['Built REST APIs serving [add number] requests a day'] }],
  education: [{ degree: 'B.Tech Computer Science', institution: 'NIT Trichy', year: '2018' }], certifications: ['CSM', 'AZ-204'],
};

/** Fake Gemini + Groq: picks the reply from the instructions it receives. */
async function fakeAi() {
  const seen = [];
  let failGemini = false;
  const reply = system => {
    if (/ATS \(applicant tracking system\)/.test(system)) return { score: 61, verdict: 'Solid experience, weak keywords.', checks: [{ name: 'Contact details', status: 'pass', detail: 'Email and phone present.' }, { name: 'Quantified results', status: 'fail', detail: 'No numbers.' }, { name: 'Bad', status: 'oops', detail: 'x' }], keywords: { present: ['C#', '.NET'], missing: ['CI/CD'] }, fixes: ['Added a summary'], suggestedRoles: ['.NET Developer', 'Scrum Master'], resume: RESUME_JSON };
    if (/targeted at ONE role/.test(system)) return { role: 'Scrum Master', fitScore: 72, fitNote: 'Strong Scrum experience.', resume: { ...RESUME_JSON, headline: 'Scrum Master' } };
    if (/expert IT recruiter/.test(system)) return { score: 78, verdict: 'Good match.', matched: ['C#', 'Azure'], missing: ['Kubernetes'], suggestions: ['Mention Azure Functions'], bestVersionId: 99999, coverLetter: 'Dear Hiring Manager,\n\nI am applying for the role.\n\nAsha Rao' };
    return null;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/gemini/')) {
        if (failGemini) { res.statusCode = 503; return res.end('{}'); }
        const parts = body.contents[0].parts;
        if (parts[0].inline_data) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: RESUME }] } }] }));   // PDF -> text
        const out = reply(body.systemInstruction.parts[0].text);
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(out) + '\n```' }] } }], usageMetadata: { totalTokenCount: 5000 } }));
      }
      if (req.url === '/groq/chat/completions') {
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(body.messages[0].content)) } }] }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  const base = await listen(server);
  return { base, seen, failGemini: v => { failGemini = v; }, close: () => new Promise(r => server.close(r)) };
}

async function start({ keys = ['gemini'] } = {}) {
  const ai = await fakeAi();
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-career-')), aiUpstream: { gemini: ai.base + '/gemini', groq: ai.base + '/groq' } });
  const base = await listen(app.server);
  if (keys.includes('gemini')) aikeys.addKey(app.db, app.vault, { provider: 'gemini', label: 'Gemini', key: 'AIza' + 'g'.repeat(35) + 'GGGG', makeDefault: true });
  if (keys.includes('groq')) aikeys.addKey(app.db, app.vault, { provider: 'groq', label: 'Groq', key: 'gsk_' + 'q'.repeat(40) + 'QQQQ', makeDefault: true });
  const addCustomer = email => {
    const id = app.db.prepare("INSERT INTO customers (email, name, created_at) VALUES (?, ?, datetime('now'))").run(email, email).lastInsertRowid;
    app.db.prepare("INSERT INTO customer_accounts (customer_id, pass_hash, must_change, created_at, password_set_at) VALUES (?, ?, 0, datetime('now'), datetime('now'))").run(id, hashPassword('a-long-password'));
    return id;
  };
  addCustomer('asha@example.com'); addCustomer('ravi@example.com');
  const site = async email => {
    const login = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-password' }) }).then(r => r.json());
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      const type = r.headers.get('content-type') || '';
      return { status: r.status, headers: r.headers, json: type.includes('json') ? await r.json() : null, buf: type.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
    };
    return { get: u => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b) };
  };
  return { app, base, ai, site, stop: async () => { await app.close(); await ai.close(); } };
}
async function withServer(opts, fn) { if (!fn) { fn = opts; opts = {}; } const s = await start(opts); try { await fn(s); } finally { await s.stop(); } }

/** The text of word/document.xml inside a .docx buffer. */
function docxXml(buf) {
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    const size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === 'word/document.xml') {
      const startAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      return zlib.inflateRawSync(buf.subarray(startAt, startAt + size)).toString('utf8');
    }
    at += 46 + nameLen + extra + comment;
  }
  return null;
}

test('the toolkit needs a signed-in customer', async () => {
  await withServer(async s => {
    const r = await fetch(s.base + '/api/career');
    assert.equal(r.status, 401);
  });
});

test('upload, ATS check, role resume, job match, and Word downloads', async () => {
  await withServer(async s => {
    const asha = await s.site('asha@example.com');
    assert.equal((await asha.post('/api/career/ats')).status, 400);                         // no resume yet
    assert.equal((await asha.post('/api/career/resume', { text: 'too short' })).status, 400);
    assert.equal((await asha.post('/api/career/resume', { text: RESUME, fileName: 'asha.docx' })).status, 200);

    const ats = await asha.post('/api/career/ats');
    assert.equal(ats.status, 200);
    assert.equal(ats.json.ats.score, 61);
    assert.deepEqual(ats.json.ats.checks.map(c => c.status), ['pass', 'fail', 'warn']);    // unknown status -> warn
    assert.deepEqual(ats.json.ats.suggestedRoles, ['.NET Developer', 'Scrum Master']);
    assert.equal(ats.json.ats.resume.name, 'Asha Rao');
    assert.deepEqual([ats.json.usage.used, ats.json.usage.tokens.used, ats.json.usage.tokens.daily], [1, 5000, 100000]);   // actions today, and the tokens the AI reported

    const v = await asha.post('/api/career/versions', { role: 'Scrum Master' });
    assert.equal(v.status, 201);
    assert.equal(v.json.version.fitScore, 72);
    assert.equal(v.json.version.resume.headline, 'Scrum Master');
    // the role resume starts from the improved ATS version
    const rolePrompt = s.ai.seen.filter(x => x.url.startsWith('/gemini/')).pop().body.contents[0].parts[0].text;
    assert.match(rolePrompt, /TARGET ROLE: Scrum Master/);
    assert.match(rolePrompt, /PROFESSIONAL SUMMARY/);

    const m = await asha.post('/api/career/match', { jd: 'We need a .NET engineer with C#, Azure Functions and Kubernetes experience to build cloud APIs for our payments team.', jobTitle: 'Backend Engineer', company: 'Northwind' });
    assert.equal(m.status, 201);
    assert.equal(m.json.match.result.score, 78);
    assert.equal(m.json.match.result.bestVersionId, null);                                  // the AI's made-up id is dropped
    assert.match(m.json.match.result.coverLetter, /^Dear Hiring Manager/);

    const page = (await asha.get('/api/career')).json;
    assert.equal(page.resume.fileName, 'asha.docx');
    assert.equal(page.resume.ats.score, 61);
    assert.equal(page.versions.length, 1);
    assert.equal(page.matches.length, 1);
    assert.equal(page.usage.used, 3);

    for (const [kind, id, must] of [['ats', '', 'Asha Rao'], ['version', v.json.version.id, 'Scrum Master'], ['letter', m.json.match.id, 'Dear Hiring Manager']]) {
      const d = await asha.get(`/api/career/download?kind=${kind}&id=${id}`);
      assert.equal(d.status, 200, kind);
      assert.equal(d.headers.get('access-control-allow-origin'), '*');
      assert.match(d.headers.get('content-disposition'), /\.docx"$/);
      assert.equal(d.buf.toString('latin1', 0, 2), 'PK');
      assert.match(docxXml(d.buf), new RegExp(must));
    }
  });
});

test('a customer only sees and changes their own documents', async () => {
  await withServer(async s => {
    const asha = await s.site('asha@example.com'), ravi = await s.site('ravi@example.com');
    await asha.post('/api/career/resume', { text: RESUME });
    await asha.post('/api/career/ats');
    const v = (await asha.post('/api/career/versions', { role: 'Scrum Master' })).json.version;
    assert.equal((await ravi.get('/api/career')).json.resume, null);
    assert.equal((await ravi.get(`/api/career/download?kind=version&id=${v.id}`)).status, 404);
    assert.equal((await ravi.post(`/api/career/versions/${v.id}/delete`)).status, 404);
    assert.equal((await asha.post(`/api/career/versions/${v.id}/delete`)).status, 200);
  });
});

test('the daily AI tokens, extra tokens, and a missing AI key', async () => {
  await withServer(async s => {
    s.app.db.prepare("INSERT INTO job_settings (key, value, updated_at) VALUES ('token_daily_default', '8000', datetime('now'))").run();
    const asha = await s.site('asha@example.com');
    await asha.post('/api/career/resume', { text: RESUME });
    const ats = await asha.post('/api/career/ats');
    assert.equal(ats.status, 200);
    assert.deepEqual([ats.json.usage.tokens.used, ats.json.usage.tokens.left, ats.json.usage.tokens.level], [5000, 3000, 'ok']);   // the AI reported 5,000 tokens (62%, below the warning)
    const v = await asha.post('/api/career/versions', { role: '.NET Developer' });
    assert.equal(v.status, 201);                                                                   // allowed: tokens were left before it
    assert.deepEqual([v.json.usage.tokens.used, v.json.usage.tokens.left, v.json.usage.tokens.level], [10000, 0, 'out']);
    const third = await asha.post('/api/career/versions', { role: 'Scrum Master' });
    assert.equal(third.status, 429);
    assert.match(third.json.error, /today's AI tokens/);
    // extra tokens are spent once the day's allowance is gone
    const id = s.app.db.prepare("SELECT id FROM customers WHERE email = 'asha@example.com'").get().id;
    require('../admin/lib/tokens').grant(s.app.db, id, { kind: 'topup', tokens: 6000 });
    const fourth = await asha.post('/api/career/versions', { role: 'Scrum Master' });
    assert.equal(fourth.status, 201);
    assert.deepEqual([fourth.json.usage.tokens.used, fourth.json.usage.tokens.bonus], [15000, 1000]);
  });

  await withServer({ keys: [] }, async s => {
    const asha = await s.site('asha@example.com');
    await asha.post('/api/career/resume', { text: RESUME });
    const r = await asha.post('/api/career/ats');
    assert.equal(r.status, 503);
    assert.equal((await asha.get('/api/career')).json.usage.used, 0);                       // a failed call is not counted
  });
});

test('Groq is used when there is no Gemini key, or when Gemini is busy', async () => {
  await withServer({ keys: ['groq'] }, async s => {
    const asha = await s.site('asha@example.com');
    await asha.post('/api/career/resume', { text: RESUME });
    assert.equal((await asha.post('/api/career/ats')).json.ats.score, 61);
    const groqCall = s.ai.seen.find(x => x.url === '/groq/chat/completions');
    assert.equal(groqCall.body.response_format.type, 'json_object');
  });
  await withServer({ keys: ['gemini', 'groq'] }, async s => {
    s.ai.failGemini(true);
    const asha = await s.site('asha@example.com');
    await asha.post('/api/career/resume', { text: RESUME });
    assert.equal((await asha.post('/api/career/ats')).status, 200);
    assert.equal(s.ai.seen.filter(x => x.url.startsWith('/gemini/')).length, 3);             // all three Gemini models tried
    assert.ok(s.ai.seen.some(x => x.url === '/groq/chat/completions'));
  });
});

test('a resume PDF is read into text', async () => {
  await withServer(async s => {
    const asha = await s.site('asha@example.com');
    const r = await asha.post('/api/career/pdf-text', { data: Buffer.from('%PDF-1.4 fake').toString('base64') });
    assert.equal(r.status, 200);
    assert.match(r.json.text, /Asha Rao/);
  });
});

test('AI output is cleaned and JSON in a reply is found', () => {
  const r = cleanResume({ name: 'A'.repeat(500), skills: [{ group: 'X', items: ['a', '', 'b'] }, { group: 'empty', items: [] }], experience: 'not a list' });
  assert.equal(r.name.length, 120);
  assert.deepEqual(r.skills, [{ group: 'X', items: ['a', 'b'] }]);
  assert.deepEqual(r.experience, []);
  assert.match(resumeText(cleanResume(RESUME_JSON)), /EXPERIENCE[\s\S]*- Built REST APIs/);
  assert.deepEqual(parseJson('Here you go: {"a": 1} thanks'), { a: 1 });
  assert.equal(parseJson('no json'), null);
});
