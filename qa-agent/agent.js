#!/usr/bin/env node
'use strict';
// ShortlistPrep QA agent: signs in like a candidate and checks the website, the Career toolkit and AI Job search
// with 20 resumes (IT, infrastructure, security and the main engineering branches). It writes an HTML + JSON report.
//
//   node qa-agent/agent.js                          local: site :4173, API :4180, makes its own test account
//   SITE_URL=https://shortlistprep.com API_URL=https://api.shortlistprep.com QA_EMAIL=... QA_PASSWORD=... node qa-agent/agent.js
//
// Options (env):  ONLY=it-java,eng-civil   run just these resumes     LIMIT=3   first 3 resumes only
//                 SEARCH_TIMEOUT_MIN=8     per search                 UI=off    skip the browser checks (no Playwright needed)
//                 COUNTRY=India            CITY=                      OUT=qa-agent/reports
// The agent never creates accounts on a real site: for any host other than localhost give it a QA account (QA_EMAIL, QA_PASSWORD).

const fs = require('fs');
const path = require('path');
const RESUMES = require('./resumes');
const { writeReport } = require('./report');

const SITE = (process.env.SITE_URL || 'http://localhost:4173').replace(/\/+$/, '');
let API = (process.env.API_URL || '').replace(/\/+$/, '');   // when not given, read from the site's own <meta name="api-url"> (see main)
const isLocal = u => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u);
let LOCAL = false;
const TIMEOUT_MS = (Number(process.env.SEARCH_TIMEOUT_MIN) || 8) * 60000;
const COUNTRY = process.env.COUNTRY || 'India';
const CITY = process.env.CITY || '';
const OUT = process.env.OUT || path.join(__dirname, 'reports');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function call(method, url, { token, body, timeout = 60000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    const raw = await res.text();
    try { data = JSON.parse(raw); } catch (_) { data = { raw: raw.slice(0, 300) }; }
    return { status: res.status, ok: res.ok, data, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, ok: false, data: { error: err.message }, ms: Date.now() - t0 };
  }
}
const apiError = r => (r.data && (r.data.error || r.data.message)) || `HTTP ${r.status}`;

// ---------- 1. the public website ----------
const PAGES = ['index.html', 'features.html', 'how-it-works.html', 'pricing.html', 'download.html', 'ats-checker.html', 'faq.html', 'login.html', 'signup.html', 'contact.html', 'trust.html', 'use-cases.html'];

async function checkWebsite() {
  const results = [];
  for (const p of PAGES) {
    const r = await fetch(`${SITE}/${p}`, { signal: AbortSignal.timeout(30000) }).catch(e => ({ status: 0, text: async () => '', error: e.message }));
    const html = r.status === 200 ? await r.text() : '';
    const issues = [];
    if (r.status !== 200) issues.push(`HTTP ${r.status || 'no answer'}`);
    else {
      if (!/<title>[^<]{3,}/i.test(html)) issues.push('missing <title>');
      // local assets (css, js, images) must exist
      const refs = [...html.matchAll(/(?:src|href)="((?!https?:|mailto:|tel:|#|data:)[^"]+?\.(?:css|js|png|jpg|jpeg|webp|svg))(?:\?[^"]*)?"/gi)].map(m => m[1]);
      await Promise.all([...new Set(refs)].map(async a => {
        const ar = await fetch(`${SITE}/${a.replace(/^\//, '')}`, { method: 'HEAD', signal: AbortSignal.timeout(20000) }).catch(() => ({ status: 0 }));
        if (ar.status !== 200) issues.push(`broken asset ${a} (${ar.status || 'no answer'})`);
      }));
    }
    results.push({ page: p, ok: issues.length === 0, issues });
    log(`  ${issues.length ? 'FAIL' : 'ok  '} ${p}${issues.length ? ' - ' + issues[0] : ''}`);
  }
  const health = await call('GET', `${API}/api/health`);
  results.push({ page: 'API /api/health', ok: health.ok, issues: health.ok ? [] : [apiError(health)] });
  return results;
}

// ---------- 2. a signed-in candidate ----------
async function signIn() {
  const email = process.env.QA_EMAIL, password = process.env.QA_PASSWORD;
  if (email && password) {
    const r = await call('POST', `${API}/api/account/login`, { body: { email, password } });
    if (!r.ok) throw new Error(`Sign-in failed for ${email}: ${apiError(r)}`);
    return { token: r.data.token, email, ms: r.ms, created: false, password };
  }
  if (!LOCAL) throw new Error('Set QA_EMAIL and QA_PASSWORD (a QA account) when testing a real site: the agent only creates accounts locally.');
  const mail = `qa.agent.${Date.now()}@example.com`, pw = 'QaAgent#' + Math.random().toString(36).slice(2, 10) + '9Z';
  const r = await call('POST', `${API}/api/account/signup`, { body: { name: 'QA Agent', email: mail, password: pw, terms: true } });
  if (!r.ok) throw new Error(`Local sign-up failed: ${apiError(r)}`);
  return { token: r.data.token, email: mail, ms: r.ms, created: true, password: pw };
}

// ---------- 3. Career toolkit + AI Job search, one resume at a time ----------
async function testResume(s, session) {
  const res = { id: s.id, group: s.group, title: s.title, sector: s.sector, steps: {}, issues: [], status: 'pass', jobs: { total: 0, high: 0, medium: 0, stretch: 0 }, top: [], relevance: null, leaks: [], seconds: null };
  const note = (sev, msg) => { res.issues.push({ sev, msg }); if (sev === 'fail') res.status = 'fail'; else if (res.status === 'pass') res.status = 'warn'; };
  const token = session.token;

  // sector (the job search needs it)
  let r = await call('POST', `${API}/api/account/profile`, { token, body: { sector: s.sector } });
  if (!r.ok) { note('fail', `Could not set sector: ${apiError(r)}`); return res; }

  // 1. upload resume
  r = await call('POST', `${API}/api/career/resume`, { token, body: { text: s.text, fileName: `${s.id}.txt` } });
  res.steps.upload = r.ok;
  if (!r.ok) { note('fail', `Resume upload: ${apiError(r)}`); return res; }

  // 2. ATS score
  r = await call('POST', `${API}/api/career/ats-score`, { token });
  res.steps.ats = r.ok;
  if (!r.ok) note('fail', `ATS check: ${apiError(r)}`);
  else {
    res.ats = r.data.ats && r.data.ats.score;
    if (typeof res.ats !== 'number') note('fail', 'ATS check returned no score');
    else if (res.ats < 40) note('warn', `ATS score is only ${res.ats} for a well-formed test resume`);
  }

  // 5. AI Job search
  const t0 = Date.now();
  r = await call('POST', `${API}/api/career/jobsearch`, { token, body: { resume: 'all', role: '', level: '', country: COUNTRY, city: CITY, days: 0, remote: true, companies: '' } });
  if (r.status === 429 || /limit|allowance|plan|upgrade/i.test(apiError(r))) { res.status = 'blocked'; res.issues.push({ sev: 'info', msg: `Plan or token limit reached: ${apiError(r)}. Give the QA account a bigger plan.` }); return res; }
  if (r.status !== 202 && !r.ok) { note('fail', `Start job search: ${apiError(r)}`); return res; }
  const id = r.data.search.id;
  let s2 = null, lastProgress = '', stalledSince = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(4000);
    const g = await call('GET', `${API}/api/career/jobsearch/${id}?size=20`, { token });
    if (!g.ok) { note('warn', `Poll failed: ${apiError(g)}`); continue; }
    s2 = g.data.search;
    if (s2.progress !== lastProgress) { lastProgress = s2.progress; stalledSince = Date.now(); }
    if (s2.status !== 'running') break;
    if (Date.now() - stalledSince > 3 * 60000) { note('warn', `Progress stuck on "${lastProgress}" for 3 minutes`); stalledSince = Date.now(); }
  }
  res.seconds = Math.round((Date.now() - t0) / 1000);
  if (!s2 || s2.status === 'running') { note('fail', `Job search did not finish in ${TIMEOUT_MS / 60000} minutes (last step: ${lastProgress})`); return res; }
  if (s2.status === 'failed' && /AI service is not set up/i.test(s2.error || '')) {
    res.status = 'blocked'; res.issues.push({ sev: 'info', msg: 'The server has no AI key. Add one in the admin dashboard → AI keys, then run again.' });
    await cleanup(id, token); return res;
  }
  if (s2.status !== 'done') { note('fail', `Job search ended as "${s2.status}": ${s2.error || 'no reason given'}`); await cleanup(id, token); return res; }

  const out = s2.result || {};
  res.profile = out.profile || {};
  res.coverage = out.coverage || {};
  res.timings = out.timings;
  res.counts = s2.counts || {};
  res.jobs = { total: out.total || 0, high: s2.counts.high || 0, medium: s2.counts.medium || 0, stretch: s2.counts.stretch || 0 };

  // quality checks
  if (!res.profile.field) note('warn', 'The AI did not name the candidate\'s field');
  else if (!s.field.test(`${res.profile.field} ${(res.profile.targetRoles || []).join(' ')}`)) note('warn', `Detected field "${res.profile.field}" does not look like ${s.title}`);
  if (!(res.profile.targetRoles || []).length) note('warn', 'No target roles suggested');
  if (res.jobs.total === 0) note('fail', 'No jobs found');
  else if (res.jobs.high + res.jobs.medium === 0) note('warn', 'Only low-probability jobs were found');
  const cov = res.coverage;
  if (cov.failed && cov.failed.length > 5) note('warn', `${cov.failed.length} career sites failed to load`);

  // every job of the search (all pages), so the report can list each one
  const list = [];
  for (let page = 1; page <= 10; page++) {
    const g = await call('GET', `${API}/api/career/jobsearch/${id}/jobs?bucket=all&page=${page}&size=20`, { token });
    if (!g.ok) { note('warn', `Could not read page ${page} of the results: ${apiError(g)}`); break; }
    list.push(...g.data.jobs);
    if (page >= g.data.pages) break;
  }
  res.allJobs = list.map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location, score: j.score, bucket: j.bucket, why: j.why, gap: j.gap, url: j.url, resume: j.resume }));
  res.top = list.slice(0, 5).map(j => ({ title: j.title, company: j.company, score: j.score, bucket: j.bucket, url: j.url }));
  if (list.length) {
    // relevance of the best 20 jobs: titles that fit the field, and titles from a different field (leaks)
    const sample = list.slice(0, 20);
    const fits = sample.filter(j => s.field.test(j.title));
    res.relevance = Math.round(100 * fits.length / sample.length);
    res.leaks = sample.filter(j => s.off.test(j.title)).map(j => `${j.title} (${j.company}, score ${j.score})`);
    if (res.relevance < 40) note('warn', `Only ${res.relevance}% of the top ${sample.length} job titles look like ${s.title} work`);
    if (res.leaks.length) note('warn', `${res.leaks.length} job(s) from another field in the top ${sample.length}: ${res.leaks.slice(0, 3).join('; ')}`);
    const noLink = list.filter(j => !/^https?:\/\//.test(j.url || '')).length;
    if (noLink) note('fail', `${noLink} job(s) have no apply link`);
    const noWhy = list.filter(j => !j.why).length;
    if (noWhy > list.length / 2) note('warn', 'Most jobs have no "why this fits" text');
  }

  // Insight (the skill matrix and gaps) for the best jobs; each one is 2 AI calls and one Insight plan of the account
  const wantInsight = process.env.INSIGHT === undefined ? 1 : Number(process.env.INSIGHT);
  res.insights = [];
  for (const j of [...list].sort((a, b) => b.score - a.score).slice(0, wantInsight > 0 ? wantInsight + 3 : 0)) {
    if (res.insights.filter(x => x.ok).length >= wantInsight) break;
    res.insights.push(await testInsight(id, token, j, note));
    if (res.insights[res.insights.length - 1].blocked) break;
  }
  if (wantInsight > 0 && !res.insights.some(x => x.ok) && !res.insights.some(x => x.blocked)) note('fail', 'Insight did not work for any of the top jobs');

  await cleanup(id, token);   // keeps the QA account under its job-search quota
  return res;
}

/** The Insight button for one job: the skill matrix, the gaps, revision topics, plan and the 20 practice questions. */
async function testInsight(searchId, token, job, note) {
  const out = { job: { id: job.id, title: job.title, company: job.company, score: job.score, url: job.url }, ok: false, issues: [] };
  const bad = (sev, msg) => { out.issues.push({ sev, msg }); if (sev === 'fail') out.failed = true; };
  const r = await call('POST', `${API}/api/career/jobsearch/${searchId}/prep`, { token, body: { jobId: job.id }, timeout: 240000 });
  out.seconds = Math.round(r.ms / 100) / 10;
  if (r.status === 422) { out.skipped = 'The careers site gives no readable description for this job, so Insight asks for a pasted one (this is expected sometimes).'; return out; }
  if (r.status === 429 || /limit|allowance|plan|upgrade/i.test(apiError(r))) { out.blocked = true; out.skipped = 'Plan or token limit: ' + apiError(r); return out; }
  if (!r.ok) { bad('fail', `Insight request failed: ${apiError(r)}`); note('fail', `Insight for "${job.title}": ${apiError(r)}`); return out; }
  const p = r.data.prep || {};
  const m = p.matrix;
  out.fit = p.fit; out.summary = p.summary; out.matrix = m; out.gaps = p.gaps || []; out.gapPoints = p.gapPoints; out.matched = p.matched || [];
  out.revise = p.revise || []; out.plan = p.plan || []; out.tips = p.tips || []; out.questions = p.interviewQuestions || [];
  if (!m || !m.rows || !m.rows.length) bad('fail', 'No skill matrix');
  else {
    if (m.rows.length < 3) bad('warn', `Skill matrix has only ${m.rows.length} requirement(s)`);
    const w = m.rows.reduce((n, x) => n + x.weight, 0);
    if (Math.abs(w - 100) > 1) bad('warn', `Matrix weights add up to ${w}, not 100`);
    if (typeof p.fit === 'number' && Math.abs(m.score - p.fit) > 25) bad('warn', `Matrix score ${m.score} is far from the search fit score ${p.fit}`);
  }
  if (!out.gaps.length && m && m.counts && (m.counts.missing + m.counts.partial) > 0) bad('warn', 'The matrix shows missing skills but no gaps are listed');
  if (out.gaps.some(g => !g.howToClose)) bad('warn', 'Some gaps have no "how to close" advice');
  if (out.gaps.some(g => !(g.links || []).length)) bad('warn', 'Some gaps have no learning links');
  if (!out.plan.length) bad('warn', 'No study plan');
  if (out.questions.length < 20) bad('warn', `${out.questions.length} practice questions (expected 20)`);
  if (out.questions.some(q => q.type === 'mcq' && (!q.options || q.options.length < 2))) bad('warn', 'A multiple-choice question has no options');
  if (out.questions.some(q => !q.answer && q.type !== 'mcq')) bad('warn', 'Some practice questions have no answer');
  for (const i of out.issues) note(i.sev, `Insight "${job.title}": ${i.msg}`);
  out.ok = !out.failed;
  return out;
}
const cleanup = (id, token) => call('POST', `${API}/api/career/jobsearch/${id}/delete`, { token });

// ---------- 4. the browser (optional, needs Playwright) ----------
async function checkBrowser(session, shotsDir) {
  let pw;
  try { pw = require('playwright'); } catch (_) { return { skipped: 'Playwright is not installed (cd qa-agent && npm install && npx playwright install chromium)', checks: [] }; }
  fs.mkdirSync(shotsDir, { recursive: true });
  const browser = await pw.chromium.launch();
  const checks = [];
  const consoleErrors = [], failedRequests = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(`${page.url().replace(SITE, '')}: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', e => consoleErrors.push(`${page.url().replace(SITE, '')}: ${e.message.slice(0, 160)}`));
    page.on('requestfailed', q => failedRequests.push(`${q.url().slice(0, 120)} (${q.failure() && q.failure().errorText})`));
    const step = async (name, fn) => {
      try { await fn(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: String(e.message).split('\n')[0] }); }
    };
    const shot = n => page.screenshot({ path: path.join(shotsDir, n + '.png'), fullPage: true }).catch(() => {});

    await step('Home page opens', async () => { await page.goto(SITE + '/index.html', { waitUntil: 'networkidle' }); await shot('01-home'); });
    await step('Sign in through the login form', async () => {
      await page.goto(SITE + '/login.html', { waitUntil: 'networkidle' });
      await page.fill('#account-login input[name=email]', session.email);
      await page.fill('#account-login input[name=password]', session.password);
      await Promise.all([page.waitForURL(/account\.html/, { timeout: 20000 }), page.click('#account-login button[type=submit]')]);
      await shot('02-account');
    });
    await step('My account page shows the signed-in user', async () => { await page.waitForSelector('h1', { timeout: 10000 }); });
    await step('Career toolkit opens with all 5 steps', async () => {
      await page.goto(SITE + '/career.html', { waitUntil: 'networkidle' });
      await page.waitForSelector('.cr-steps a', { timeout: 15000 });
      const n = await page.locator('.cr-steps a').count();
      if (n !== 5) throw new Error(`expected 5 steps, found ${n}`);
      await shot('03-career');
    });
    for (const [anchor, label] of [['cr-resume', 'Upload resume'], ['cr-ats', 'ATS check'], ['cr-versions', 'Role-based resumes'], ['cr-match', 'Job match'], ['cr-jobs', 'AI Job search']]) {
      await step(`Step "${label}" renders`, async () => {
        await page.click(`.cr-steps a[href="#${anchor}"]`);
        await page.waitForTimeout(600);
        const text = await page.locator('#cr-content').innerText();
        if (text.trim().length < 40) throw new Error('the step is empty');
        if (/something went wrong|undefined|\[object/i.test(text)) throw new Error('the step shows an error or raw value');
        await shot('04-' + anchor);
      });
    }
    await step('AI Job search shows a form with a Search button', async () => {
      await page.click('.cr-steps a[href="#cr-jobs"]');
      await page.waitForTimeout(600);
      if (!(await page.getByRole('button', { name: /search|find/i }).first().isVisible())) throw new Error('no Search button');
    });
    await step('Mobile layout has no sideways scroll', async () => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(SITE + '/career.html', { waitUntil: 'networkidle' });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await shot('05-career-mobile');
      if (over > 4) throw new Error(`page is ${over}px wider than the phone screen`);
    });
  } finally { await browser.close(); }
  return { checks, consoleErrors: [...new Set(consoleErrors)].slice(0, 20), failedRequests: [...new Set(failedRequests)].slice(0, 20) };
}

// ---------- run ----------
(async () => {
  const startedAt = new Date();
  const runDir = path.join(OUT, startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(runDir, { recursive: true });
  const report = { startedAt: startedAt.toISOString(), site: SITE, api: '', website: [], browser: null, resumes: [], fatal: null };

  try {
    if (!API) {
      const html = await fetch(`${SITE}/login.html`, { signal: AbortSignal.timeout(30000) }).then(r => r.text()).catch(() => '');
      const m = /<meta name="api-url" content="([^"]+)"/.exec(html);
      API = m ? m[1].replace(/\/+$/, '') : 'http://localhost:4180';
      log('API address:', API);
    }
    LOCAL = isLocal(API);
    report.api = API;
    log('Checking the public website…');
    report.website = await checkWebsite();
    log(`  ${report.website.filter(x => x.ok).length}/${report.website.length} OK`);

    log('Signing in…');
    const session = await signIn();
    report.account = { email: session.email, created: session.created, signInMs: session.ms };

    if (process.env.UI !== 'off') {
      log('Browser checks (login, Career toolkit)…');
      report.browser = await checkBrowser(session, path.join(runDir, 'screenshots'));
      if (report.browser.skipped) log('  skipped:', report.browser.skipped);
    }

    let list = RESUMES;
    if (process.env.ONLY) list = list.filter(r => process.env.ONLY.split(',').includes(r.id));
    if (process.env.LIMIT) list = list.slice(0, Number(process.env.LIMIT));
    for (const [i, s] of list.entries()) {
      log(`[${i + 1}/${list.length}] ${s.id}: ${s.title}`);
      const r = await testResume(s, session);
      report.resumes.push(r);
      log(`  ${r.status.toUpperCase()} · ${r.jobs.total} jobs (${r.jobs.high} high, ${r.jobs.medium} medium) · ${r.seconds ?? '-'}s${r.issues.length ? ' · ' + r.issues.map(x => x.msg).join(' | ').slice(0, 160) : ''}`);
      if (r.status === 'blocked') { log('Stopping: plan limit reached.'); break; }
    }
  } catch (err) {
    report.fatal = err.message;
    log('FATAL:', err.message);
  }

  report.finishedAt = new Date().toISOString();
  const files = writeReport(report, runDir);
  log('Report:', files.html);
  const failed = report.fatal || report.resumes.some(r => r.status === 'fail') || report.website.some(w => !w.ok) || (report.browser && report.browser.checks.some(c => !c.ok));
  process.exit(failed ? 1 : 0);
})();
