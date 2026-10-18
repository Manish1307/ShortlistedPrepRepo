'use strict';
// AI Job search (website: Career toolkit → step 5). The candidate picks one resume or all of them, and says where and
// what to look for: country, city, role, level and, optionally, the companies (names or careers URLs). The server
// reads those companies' live openings from their own career sites (jobsources.js; a built-in list of well-known
// companies when none are given), then the AI, guided by the admin's Master Prompt (dashboard → Jobs), works out the
// candidate's profile and scores the most relevant real jobs into high, medium and low-probability groups.
// The AI only ever scores jobs that were fetched from a career site: it cannot invent a company, a job or a link.
//
// A search runs in the background (fetching dozens of career sites takes a while); the page polls for its progress.

const { ApiError, text, likeTerm } = require('./http');
const { now, transaction } = require('./db');
const { signedInCustomer } = require('./accounts');
const { completeJson } = require('./careerai');
const sources = require('./jobsources');
const { CATALOGUE } = require('./jobcatalogue');
const { logActivity } = require('./activity');
const jobprep = require('./jobprep');

const HOUR = 3600000, DAY = 24 * HOUR;
const FRESH_FOR = 6 * HOUR;       // a company's jobs fetched within this time are used as they are
const RETRY_FAILED = HOUR;        // a career site that failed is tried again after this
const FETCH_BUDGET = 90000;       // a search waits at most this long for career sites (the rest keep loading)
const PARALLEL = 6;               // career sites fetched at the same time
const AI_BATCH = 60;              // jobs the AI scores per search
const MAX_COMPANIES = 30;         // typed by the candidate
const KEEP_SEARCHES = 20;         // per candidate
const BUCKETS = ['high', 'medium', 'stretch'];
const LEVELS = ['', 'Fresher / entry-level', 'Mid-level', 'Senior', 'Lead / manager'];

const DEFAULT_MASTER_PROMPT = `Act as an expert AI recruiter and job-hunting machine for candidates in India.

1. Analyse the candidate's resume(s) in depth: skills, tools, domain, education, years of experience and achievements.
   Work out their real level (fresher / entry-level, mid-level, senior, lead or manager) and the roles they should target.
   Suggest fresher or entry-level roles only when the resume shows little or no work experience.
2. Respect the candidate's search preferences (country, city, role, level) when they give them.
3. For each job posting, give a fit score from 0 to 100:
   - required skills and tools the candidate actually has (40%)
   - experience level match: not too junior, not too senior (25%)
   - role and domain relevance (20%)
   - location fit with the candidate's preferences (15%)
4. Put every job in one group:
   - "high": high probability, apply first (score 75 or more)
   - "medium": medium probability, small gaps (score 50 to 74)
   - "stretch": low probability, worth a try (score under 50)
5. For each job, write one short, honest reason for the score and the single most important gap (or "none").
   Treat startups, scale-ups, MNCs, consulting firms, tech and non-tech companies equally; judge only the fit.
6. List the most important fixes to make to the resume before applying: leftover placeholders, typos, outdated
   lines, missing numbers, missing certifications.`;

const ANALYSIS_RULES = `RULES (always apply):
- This step only analyses the candidate. Do not list or invent jobs.
- Never claim skills or experience the resume does not show.
- Reply with ONLY a JSON object:
{
  "level": "e.g. Mid-level (6 years)",
  "summary": "one or two sentences about the candidate",
  "strengths": ["3-6 strongest areas"],
  "targetRoles": ["3-6 job titles to target, best first"],
  "searchTerms": ["6-15 short job-title words or phrases that find matching postings, e.g. program manager, power platform, scrum master"],
  "resumeFixes": ["up to 6 specific fixes to the resume before applying"]
}`;

const SCORING_RULES = `RULES (always apply):
- Score ONLY the job postings listed below, using their exact "id". Never invent companies, jobs or links.
- Never claim the candidate has skills or experience the resume does not show.
- Reply with ONLY a JSON object:
{ "matches": [ { "id": 123, "score": 0-100, "bucket": "high" | "medium" | "stretch", "why": "one sentence", "gap": "short phrase or none", "resume": "label of the best resume to send" } ] }
Include every listed job in "matches".`;

const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const strings = (v, n, max) => (Array.isArray(v) ? v : []).map(x => String(x || '').trim().slice(0, max)).filter(Boolean).slice(0, n);
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

function masterPrompt(db) {
  const row = db.prepare("SELECT value, updated_at, updated_by FROM job_settings WHERE key = 'master_prompt'").get();
  return row ? { prompt: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by, isDefault: false }
    : { prompt: DEFAULT_MASTER_PROMPT, updatedAt: null, updatedBy: '', isDefault: true };
}

// ===================== career sites → jobs table =====================

/** Save one company's jobs: new ones added, known ones refreshed, missing ones closed. list: already fetched, or fetched here. */
async function syncCompany(db, company, opts = {}, list = null) {
  const stamp = now();
  try {
    const extra = parse(company.extra) || {};
    if (!list) list = await sources.fetchJobs({ provider: company.provider, board: company.board, wd: extra.wd, defaultCountry: company.default_country }, opts);
    transaction(db, () => {
      const upsert = db.prepare(`INSERT INTO jobs (company_id, external_id, title, location, country, department, employment_type, posted_at, url, description, active, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT (company_id, external_id) DO UPDATE SET title = excluded.title, location = excluded.location, country = excluded.country,
          department = excluded.department, employment_type = excluded.employment_type, posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
          url = excluded.url, description = excluded.description, active = 1, last_seen = excluded.last_seen`);
      for (const j of list) {
        if (!j.title || !j.url || !/^https:\/\//i.test(j.url)) continue;
        upsert.run(company.id, j.externalId, String(j.title).slice(0, 300), String(j.location || '').slice(0, 300), String(j.country || '').slice(0, 80),
          String(j.department || '').slice(0, 160), String(j.employmentType || '').slice(0, 80), j.postedAt, j.url, String(j.description || '').slice(0, 2000), stamp, stamp);
      }
      db.prepare('UPDATE jobs SET active = 0 WHERE company_id = ? AND last_seen < ?').run(company.id, stamp);                 // closed since the last fetch
      db.prepare('DELETE FROM jobs WHERE company_id = ? AND active = 0 AND last_seen < ?').run(company.id, new Date(Date.now() - 30 * DAY).toISOString());
      const count = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND active = 1').get(company.id).n;
      db.prepare("UPDATE job_companies SET last_sync = ?, last_error = '', job_count = ? WHERE id = ?").run(stamp, count, company.id);
    });
    return { ok: true, jobs: list.length };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 300);
    try { db.prepare('UPDATE job_companies SET last_sync = ?, last_error = ? WHERE id = ?').run(stamp, message, company.id); } catch (_) { /* database closed */ }
    return { ok: false, error: message };
  }
}

// one fetch per company at a time, shared by searches that run together
const inflight = new WeakMap();
function refresh(db, company, opts) {
  if (!inflight.has(db)) inflight.set(db, new Map());
  const running = inflight.get(db);
  if (!running.has(company.id)) running.set(company.id, syncCompany(db, company, opts).finally(() => running.delete(company.id)));
  return running.get(company.id);
}

const isFresh = c => c.last_sync && Date.now() - Date.parse(c.last_sync) < (c.last_error ? RETRY_FAILED : FRESH_FOR);

/** Fetch the companies whose jobs are out of date, waiting at most `budget` ms. Calls progress(done, total). */
async function gather(db, companies, opts, progress, budget = FETCH_BUDGET) {
  const queue = companies.filter(c => !isFresh(c));
  let done = companies.length - queue.length;
  progress(done, companies.length);
  const worker = async () => {
    while (queue.length) { await refresh(db, queue.shift(), opts); done++; progress(done, companies.length); }
  };
  const all = Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  await Promise.race([all, sleep(budget)]);
  return { loading: companies.length - done };
}

/** Keep the cache small: refresh companies searched in the last 3 days, drop those nobody searched for 14 days. */
async function maintain(db, opts = {}) {
  db.prepare('DELETE FROM job_companies WHERE COALESCE(last_used, created_at) < ?').run(new Date(Date.now() - 14 * DAY).toISOString());
  const recent = db.prepare('SELECT * FROM job_companies WHERE last_used >= ? ORDER BY id').all(new Date(Date.now() - 3 * DAY).toISOString());
  for (const c of recent) await refresh(db, c, opts);
  return recent.length;
}

/** Every JOB_SYNC_HOURS (default 6; 0 turns it off). */
function scheduleSync(db) {
  const hours = process.env.JOB_SYNC_HOURS === undefined ? 6 : Number(process.env.JOB_SYNC_HOURS);
  if (!(hours > 0)) return null;
  const run = () => maintain(db).catch(err => console.error('Job refresh failed:', err));
  setTimeout(run, 60 * 1000).unref();
  return setInterval(run, hours * HOUR).unref();
}

// ===================== companies typed by the candidate → career sites =====================

const CAREERS_URL = { greenhouse: b => `https://boards.greenhouse.io/${b}`, lever: b => `https://jobs.lever.co/${b}`, ashby: b => `https://jobs.ashbyhq.com/${b}`, smartrecruiters: b => `https://careers.smartrecruiters.com/${b}` };

/** "Infosys, https://jobs.lever.co/acme\nTCS" → up to MAX_COMPANIES distinct entries. */
function companyList(input) {
  const seen = new Set(), out = [];
  for (const raw of String(input || '').split(/[\n,;]+/)) {
    const s = raw.trim();
    if (s && !seen.has(norm(s))) { seen.add(norm(s)); out.push(s.slice(0, 300)); }
  }
  if (out.length > MAX_COMPANIES) throw new ApiError(400, `Enter at most ${MAX_COMPANIES} companies`);
  return out;
}

function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;
  const ai = { db, vault: ctx.vault, upstream: ctx.upstream };
  const fetchOpts = { base: ctx.jobSourceBase || {} };
  const catalogue = ctx.jobCatalogue || CATALOGUE;
  const budget = ctx.jobFetchBudget || FETCH_BUDGET;

  // a search cannot survive a restart
  db.prepare("UPDATE career_job_searches SET status = 'failed', error = 'The search was interrupted. Please run it again.', finished_at = ? WHERE status = 'running'").run(now());

  /** The job_companies row for a career site (added if new), marked as used now. */
  function boardRow(name, board, url) {
    const stamp = now();
    db.prepare(`INSERT INTO job_companies (name, careers_url, provider, board, extra, created_at, last_used) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT (provider, board) DO UPDATE SET last_used = excluded.last_used`)
      .run(name, url, board.provider, board.board, JSON.stringify(board.wd ? { wd: board.wd } : {}), stamp, stamp);
    return one('SELECT * FROM job_companies WHERE provider = ? AND board = ?', board.provider, board.board);
  }

  /** A company name or careers URL → {row} or {error}. Unknown names are looked up on the job-board systems. */
  async function resolve(entry) {
    if (/^https?:\/\//i.test(entry) || /^[\w-]+(\.[\w-]+)+\//.test(entry)) {
      const board = sources.parseBoardUrl(/^https?:/i.test(entry) ? entry : 'https://' + entry);
      if (!board) return { name: entry, error: 'not-supported' };
      return { name: entry, row: boardRow(board.board.split('/')[0], board, entry) };
    }
    const key = norm(entry);
    const known = catalogue.find(c => norm(c.name) === key);
    if (known) return { name: entry, row: boardRow(known.name, sources.parseBoardUrl(known.url), known.url) };
    const cached = all('SELECT * FROM job_companies').find(c => norm(c.name) === key && !c.last_error && c.job_count > 0);
    if (cached) return { name: entry, row: boardRow(cached.name, { provider: cached.provider, board: cached.board, ...(parse(cached.extra) || {}) }, cached.careers_url) };
    // try the name as a board on each system; the first that lists jobs wins
    const hyphen = entry.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const tries = [['greenhouse', key], ['lever', key], ['lever', hyphen], ['ashby', key], ['smartrecruiters', entry.replace(/[^A-Za-z0-9]/g, '')]]
      .filter(([, b], i, a) => b && a.findIndex(x => x[0] === a[i][0] && x[1] === b) === i);
    const found = await Promise.all(tries.map(([provider, board]) =>
      sources.fetchJobs({ provider, board }, fetchOpts).then(list => (list.length ? { provider, board, list } : null), () => null)));
    const hit = found.find(Boolean);
    if (!hit) return { name: entry, error: 'not-found' };
    const row = boardRow(entry.trim(), hit, CAREERS_URL[hit.provider](hit.board));
    await syncCompany(db, row, fetchOpts, hit.list);
    return { name: entry, row: one('SELECT * FROM job_companies WHERE id = ?', row.id) };
  }

  /** The resume(s) the candidate picked: "all", "ats" (the improved one, or the uploaded text) or "v<id>" (a role version). */
  function resumesFor(customerId, key) {
    const r = one('SELECT * FROM career_resumes WHERE customer_id = ?', customerId);
    if (!r) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1).', 'no-resume');
    const career = require('./career');
    const ats = parse(r.ats_json);
    const main = { key: 'ats', label: ats ? 'ATS-friendly resume' : 'Uploaded resume', text: ats ? career.resumeText(ats.resume) : r.source_text };
    const versions = all('SELECT id, role, content_json FROM career_versions WHERE customer_id = ? ORDER BY id DESC', customerId)
      .map(v => { const c = parse(v.content_json); return c && { key: 'v' + v.id, label: v.role, text: career.resumeText(c.resume) }; }).filter(Boolean);
    if (key === 'all') return [main, ...versions];
    if (key === 'ats') return [main];
    const v = versions.find(x => x.key === key);
    if (!v) throw new ApiError(404, 'Resume version not found');
    return [v];
  }

  const presentSearch = (row, full) => {
    const result = parse(row.result_json);
    const counts = Object.fromEntries(BUCKETS.map(b => [b, result ? result.jobs.filter(j => j.bucket === b).length : 0]));
    return { id: row.id, params: parse(row.params_json) || {}, status: row.status, progress: row.progress, error: row.error,
      createdAt: row.created_at, finishedAt: row.finished_at, counts, ...(full ? { result } : {}) };
  };

  /** The whole search, in the background. Errors are saved on the search; nothing is counted unless it succeeds. */
  async function runSearch(id, customerId, p, resumes) {
    const step = progress => db.prepare('UPDATE career_job_searches SET progress = ? WHERE id = ?').run(progress, id);
    try {
      // 1. the companies' career sites
      const typed = companyList(p.companies);
      step(typed.length ? `Finding the career sites of ${typed.length} compan${typed.length === 1 ? 'y' : 'ies'}…` : 'Getting ready to search…');
      const resolved = typed.length ? await Promise.all(typed.map(resolve))
        : catalogue.map(c => ({ name: c.name, row: boardRow(c.name, sources.parseBoardUrl(c.url), c.url), builtIn: true }));
      const rows = resolved.filter(r => r.row).map(r => r.row);
      if (!rows.length) throw new ApiError(400, 'None of those companies could be found. Check the names, or paste the link of their careers page.');
      const { loading } = await gather(db, rows, fetchOpts, (done, total) => step(`Reading live openings from career sites: ${done} of ${total}…`), budget);

      // 2. the jobs within the candidate's filters
      const where = [`j.active = 1`, `j.company_id IN (${rows.map(() => '?').join(',')})`], params = rows.map(r => r.id);
      if (p.country) {
        where.push(`(j.country = ? OR j.location LIKE ? ESCAPE '\\'${p.remote ? " OR (j.country IN ('', 'Remote') AND j.location LIKE '%remote%')" : ''})`);   // remote, but not tied to another country
        params.push(p.country, likeTerm(p.country));
      }
      if (p.city) { where.push("j.location LIKE ? ESCAPE '\\'"); params.push(likeTerm(p.city)); }
      if (p.days) { where.push('j.posted_at >= ?'); params.push(new Date(Date.now() - p.days * DAY).toISOString()); }
      const pool = all(`SELECT j.id, j.title, j.location, j.country, j.department, j.posted_at, j.url, substr(j.description, 1, 1500) AS description, c.name AS company
                        FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE ${where.join(' AND ')}
                        ORDER BY j.posted_at IS NULL, j.posted_at DESC LIMIT 20000`, ...params);
      if (!pool.length) throw new ApiError(400, `No live openings were found${p.country ? ' in ' + p.country : ''}${p.city ? ', ' + p.city : ''} at ${typed.length ? 'those companies' : 'the companies we searched'}. Try a wider location, a longer date range, or other companies.`);

      // 3. the candidate's profile (and the job titles to look for)
      step('Analysing your resume…');
      const prompt = masterPrompt(db).prompt;
      const resumeBlock = resumes.map(r => `=== RESUME: ${r.label} ===\n${r.text.slice(0, resumes.length > 1 ? 8000 : 20000)}`).join('\n\n').slice(0, 40000);
      const wishes = [`Country: ${p.country || 'any'}`, `City: ${p.city || 'any'}`, `Role or keywords: ${p.role || '(let the AI decide)'}`, `Level: ${p.level || '(let the AI decide from the resume)'}`].join('\n');
      const a = await completeJson(ai, { system: prompt + '\n\n' + ANALYSIS_RULES, user: `CANDIDATE'S SEARCH PREFERENCES:\n${wishes}\n\nCANDIDATE RESUME(S):\n${resumeBlock}`, maxTokens: 3000 });
      const profile = { level: String(a.level || '').slice(0, 100), summary: String(a.summary || '').slice(0, 400), strengths: strings(a.strengths, 6, 120),
        targetRoles: strings(a.targetRoles, 6, 80), resumeFixes: strings(a.resumeFixes, 6, 300) };

      // 4. the most relevant jobs: the role typed and the profile's job titles found in the title (most) and description
      const role = String(p.role || '').toLowerCase().trim();
      const phrases = [...new Set([...strings(a.searchTerms, 15, 60), ...profile.targetRoles, ...(role ? [role] : [])].map(s => s.toLowerCase()))].filter(s => s.length > 1);
      const relevance = j => {
        const title = j.title.toLowerCase(), rest = (j.department + ' ' + j.description).toLowerCase();
        let n = !role ? 0 : title.includes(role) ? 12 : rest.includes(role) ? 3 : 0;
        for (const ph of phrases) {
          if (title.includes(ph)) { n += 6; continue; }
          const words = ph.split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
          const hits = words.filter(w => title.includes(w)).length;
          n += words.length && hits === words.length ? 4 : hits;
          if (rest.includes(ph)) n += 1;
        }
        return n;
      };
      const ranked = pool.map((j, i) => ({ j, r: relevance(j), i })).filter(x => x.r > 0).sort((x, y) => y.r - x.r || x.i - y.i);
      // no single company fills the batch: each gets a fair share first, then the best of the rest fill it up
      const order = ranked.length ? ranked.map(x => x.j) : pool;
      const share = Math.max(10, Math.ceil(AI_BATCH / rows.length)), perCompany = new Map();
      const first = order.filter(j => { const n = perCompany.get(j.company) || 0; perCompany.set(j.company, n + 1); return n < share; }).slice(0, AI_BATCH);
      const picked = new Set(first);
      const batch = first.concat(order.filter(j => !picked.has(j)).slice(0, AI_BATCH - first.length));

      // 5. score them with the Master Prompt
      step(`Scoring the ${batch.length} most relevant of ${pool.length.toLocaleString('en-IN')} live jobs against your resume…`);
      const lines = batch.map(j => JSON.stringify({ id: j.id, title: j.title, company: j.company, location: j.location, country: j.country,
        posted: (j.posted_at || '').slice(0, 10), summary: String(j.description || '').replace(/\s+/g, ' ').slice(0, 350) }));
      const labels = resumes.map(r => r.label);
      const out = await completeJson(ai, {
        system: prompt + '\n\n' + SCORING_RULES,
        user: `CANDIDATE'S SEARCH PREFERENCES:\n${wishes}\n\nCANDIDATE PROFILE: ${profile.level}. ${profile.summary}\n\nCANDIDATE RESUME(S) (labels: ${labels.join(' | ')}):\n${resumeBlock}\n\nJOB POSTINGS (one JSON object per line):\n${lines.join('\n')}`,
        maxTokens: 12000,
      });
      const byId = new Map(batch.map(j => [j.id, j]));
      const seen = new Set();
      const jobs = (Array.isArray(out.matches) ? out.matches : []).filter(m => m && byId.has(Number(m.id)) && !seen.has(Number(m.id)) && seen.add(Number(m.id))).map(m => {
        const j = byId.get(Number(m.id));
        const score = Math.max(0, Math.min(100, Math.round(Number(m.score) || 0)));
        return { id: j.id, title: j.title, company: j.company, location: j.location, country: j.country, postedAt: j.posted_at, url: j.url, score,
          bucket: BUCKETS.includes(m.bucket) ? m.bucket : score >= 75 ? 'high' : score >= 50 ? 'medium' : 'stretch',
          why: String(m.why || m.reason || '').slice(0, 300), gap: String(m.gap || '').slice(0, 160),
          resume: resumes.length > 1 && labels.includes(m.resume) ? m.resume : '' };
      }).sort((x, y) => y.score - x.score);
      // nothing usable (e.g. the AI answered with made-up ids only): an error, not counted against today's limit
      if (!jobs.length) throw new ApiError(502, 'The AI could not score the jobs this time. Please try again.', 'ai');

      const result = { profile, jobs, coverage: {
        companies: rows.length, loading, live: pool.length, considered: batch.length,
        notFound: resolved.filter(r => r.error === 'not-found').map(r => r.name),
        notSupported: resolved.filter(r => r.error === 'not-supported').map(r => r.name),
        failed: typed.length ? rows.filter(r => { const c = one('SELECT last_error, job_count FROM job_companies WHERE id = ?', r.id); return c && c.last_error && !c.job_count; }).map(r => r.name) : [],
      } };
      db.prepare("UPDATE career_job_searches SET status = 'done', progress = '', result_json = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(result), now(), id);
      require('./career').countUse(db, customerId);
      logActivity(db, customerId, 'jobsearch.done', `${jobs.length} matches: ${jobs.filter(j => j.bucket === 'high').length} high, ${jobs.filter(j => j.bucket === 'medium').length} medium, ${jobs.filter(j => j.bucket === 'stretch').length} low`);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('AI Job search failed:', err);
      const message = err instanceof ApiError ? err.message : 'Something went wrong with this search. Please try again.';
      try { db.prepare("UPDATE career_job_searches SET status = 'failed', progress = '', error = ?, finished_at = ? WHERE id = ?").run(message, now(), id); } catch (_) { /* database closed */ }
      logActivity(db, customerId, 'jobsearch.failed', message);
    }
  }

  // ===================== dashboard =====================
  add('GET', '/admin/api/jobs', { admin: true }, () => {
    const week = new Date(Date.now() - 7 * DAY).toISOString();
    return {
      prompt: masterPrompt(db), defaultPrompt: DEFAULT_MASTER_PROMPT, outputRules: ANALYSIS_RULES + '\n\n' + SCORING_RULES,
      stats: {
        searches: one('SELECT COUNT(*) AS n FROM career_job_searches WHERE created_at >= ?', week).n,
        candidates: one('SELECT COUNT(DISTINCT customer_id) AS n FROM career_job_searches WHERE created_at >= ?', week).n,
        failed: one("SELECT COUNT(*) AS n FROM career_job_searches WHERE created_at >= ? AND status = 'failed'", week).n,
        companies: one('SELECT COUNT(*) AS n FROM job_companies').n,
        jobs: one('SELECT COUNT(*) AS n FROM jobs WHERE active = 1').n,
      },
      builtInCompanies: catalogue.map(c => c.name),
    };
  });

  add('POST', '/admin/api/jobs/prompt', { admin: true, perm: 'jobs.write' }, (req, res, { body, admin }) => {
    if (body.reset) db.prepare("DELETE FROM job_settings WHERE key = 'master_prompt'").run();
    else {
      const prompt = text(body.prompt, 8000, { required: true, field: 'Master prompt' });
      if (prompt.length < 40) throw new ApiError(400, 'The master prompt is too short');
      db.prepare(`INSERT INTO job_settings (key, value, updated_at, updated_by) VALUES ('master_prompt', ?, ?, ?)
                  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(prompt, now(), admin.email);
    }
    audit(admin, body.reset ? 'jobs.prompt.reset' : 'jobs.prompt.updated');
    return { prompt: masterPrompt(db) };
  });

  // ===================== website: Career toolkit → AI Job search =====================
  const me = req => signedInCustomer(db, req).customer;
  const searchRow = (id, customerId) => one('SELECT * FROM career_job_searches WHERE id = ? AND customer_id = ?', id, customerId);

  add('POST', '/api/career/jobsearch', { public: true }, (req, res, { body }) => {
    const c = me(req);
    require('./career').checkQuota(db, c.id);
    const resume = /^(all|ats|v\d+)$/.test(String(body.resume || '')) ? String(body.resume) : 'all';
    const p = {
      resume, country: text(body.country, 80, { field: 'Country' }), city: text(body.city, 80, { field: 'City' }),
      role: text(body.role, 120, { field: 'Role' }), level: LEVELS.includes(body.level) ? body.level : '',
      days: [7, 14, 30].includes(Number(body.days)) ? Number(body.days) : 0, remote: body.remote !== false,
      companies: text(body.companies, 4000, { field: 'Companies' }),
    };
    companyList(p.companies);                                     // too many companies: say so now
    const resumes = resumesFor(c.id, resume);
    p.resumeLabel = resume === 'all' ? `All my resumes (${resumes.length})` : resumes[0].label;
    if (one("SELECT id FROM career_job_searches WHERE customer_id = ? AND status = 'running'", c.id)) {
      throw new ApiError(409, 'A search is already running. Please wait for it to finish.');
    }
    const id = Number(db.prepare('INSERT INTO career_job_searches (customer_id, params_json, status, progress, created_at) VALUES (?,?,?,?,?)')
      .run(c.id, JSON.stringify(p), 'running', 'Starting…', now()).lastInsertRowid);
    db.prepare(`DELETE FROM career_job_searches WHERE customer_id = ? AND id NOT IN (SELECT id FROM career_job_searches WHERE customer_id = ? ORDER BY id DESC LIMIT ${KEEP_SEARCHES})`).run(c.id, c.id);
    logActivity(db, c.id, 'jobsearch.started', [p.role || 'roles from resume', [p.city, p.country].filter(Boolean).join(', ') || 'any location', p.companies ? 'chosen companies' : 'well-known companies', p.resumeLabel].join(' · '));
    runSearch(id, c.id, p, resumes);                              // not awaited: the page polls GET /api/career/jobsearch/:id
    return { status: 202, body: { search: presentSearch(searchRow(id, c.id), true) } };
  });

  add('GET', '/api/career/jobsearch', { public: true }, req => {
    const c = me(req);
    return { searches: all('SELECT * FROM career_job_searches WHERE customer_id = ? ORDER BY id DESC', c.id).map(r => presentSearch(r, false)), builtInCompanies: catalogue.length };
  });

  add('GET', '/api/career/jobsearch/:id', { public: true }, (req, res, { params }) => {
    const c = me(req);
    const row = searchRow(params.id, c.id);
    if (!row) throw new ApiError(404, 'Search not found');
    return { search: presentSearch(row, true), usage: require('./career').usage(db, c.id) };
  });

  // "Prepare for this job": the skill gaps to a full fit, learning links, revision topics and interview questions.
  // Made once per job (one AI action) and kept with the search.
  add('POST', '/api/career/jobsearch/:id/prep', { public: true }, async (req, res, { params, body }) => {
    const c = me(req);
    const row = searchRow(params.id, c.id);
    const result = row && parse(row.result_json);
    if (!result) throw new ApiError(404, 'Search not found');
    const job = result.jobs.find(j => j.id === Number(body.jobId));
    if (!job) throw new ApiError(404, 'Job not found in this search');
    if (job.prep) return { prep: job.prep, usage: require('./career').usage(db, c.id) };
    require('./career').checkQuota(db, c.id);
    const resumes = resumesFor(c.id, 'all');
    const resume = resumes.find(r => r.label === job.resume) || resumes[0];
    const posting = one('SELECT department, employment_type, description FROM jobs WHERE id = ?', job.id) || {};
    const out = await completeJson(ai, {
      system: jobprep.PREP_PROMPT,
      user: [`JOB: ${job.title} at ${job.company} (${job.location || job.country || 'location not given'})`,
        posting.department ? `TEAM: ${posting.department}` : '', `CURRENT FIT SCORE: ${job.score}/100`,
        job.why ? `WHY THIS SCORE: ${job.why}` : '', job.gap ? `MAIN GAP NOTED: ${job.gap}` : '',
        `JOB DESCRIPTION:\n${String(posting.description || '').slice(0, 5000) || '(the careers site gave no description: use the job title, company and what such roles usually need)'}`,
        `\nCANDIDATE RESUME (${resume.label}):\n${resume.text.slice(0, 15000)}`].filter(Boolean).join('\n'),
      maxTokens: 3500,
    });
    const prep = jobprep.cleanPrep(out, job.score);
    if (!prep.gaps.length && !prep.interviewQuestions.length) throw new ApiError(502, 'The AI could not prepare this job this time. Please try again.', 'ai');
    // save it with the search (read again: another job may have been prepared meanwhile)
    const fresh = parse(one('SELECT result_json FROM career_job_searches WHERE id = ?', row.id).result_json);
    const target = fresh.jobs.find(j => j.id === job.id);
    if (target) target.prep = prep;
    db.prepare('UPDATE career_job_searches SET result_json = ? WHERE id = ?').run(JSON.stringify(fresh), row.id);
    require('./career').countUse(db, c.id);
    logActivity(db, c.id, 'jobprep.created', `${job.title} at ${job.company} · ${prep.gaps.length} gaps`);
    return { prep, usage: require('./career').usage(db, c.id) };
  });

  add('POST', '/api/career/jobsearch/:id/delete', { public: true }, (req, res, { params }) => {
    const c = me(req);
    const row = searchRow(params.id, c.id);
    if (!row) throw new ApiError(404, 'Search not found');
    if (row.status === 'running') throw new ApiError(409, 'Wait for the search to finish first.');
    db.prepare('DELETE FROM career_job_searches WHERE id = ?').run(row.id);
    return { ok: true };
  });
}
const STOP = new Set(['and', 'the', 'for', 'with', 'senior', 'junior', 'lead', 'engineer', 'developer', 'manager', 'specialist', 'analyst', 'of', 'in', 'to', 'an', 'at', 'team', 'associate', 'ii', 'iii', 'sr', 'jr']);

module.exports = { addRoutes, syncCompany, maintain, scheduleSync, masterPrompt, companyList, DEFAULT_MASTER_PROMPT, ANALYSIS_RULES, SCORING_RULES };
