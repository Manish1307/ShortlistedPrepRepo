'use strict';
// Find jobs: real, active openings from the companies the admin adds (by their careers URL, see jobsources.js),
// synced every few hours. Candidates filter and page through them on the website (Career toolkit → Find jobs), and
// the AI scores the jobs against their resume with the admin's Master Prompt (dashboard → Jobs).
// The AI only ever ranks jobs that exist in the database: it cannot invent a company, a job or a link.

const { ApiError, text, integer, likeTerm } = require('./http');
const { now, transaction } = require('./db');
const { signedInCustomer } = require('./accounts');
const { completeJson } = require('./careerai');
const sources = require('./jobsources');

const DAY = 86400000;
const AI_BATCH = 40;              // jobs sent to the AI per "Find my best matches"

const DEFAULT_MASTER_PROMPT = `Act as an expert AI recruiter and job-hunting assistant for candidates in India.

1. Analyse the candidate's resume in depth: skills, tools, domain, education, years of experience and achievements.
   Work out their real seniority (fresher / entry-level, mid-level, senior or lead) and the roles they should target.
   Do not assume they are a fresher if the resume shows experience.
2. For EACH job posting provided, give a fit score from 0 to 100 based on:
   - required skills and tools the candidate actually has (40%)
   - experience level match: not too junior, not too senior (25%)
   - role and domain relevance (20%)
   - location fit: prefer India, and remote roles open to India (15%)
3. Put every job in one group:
   - "high": strong match, apply first (score 75 or more)
   - "medium": good match with small gaps (score 50 to 74)
   - "stretch": worth trying, but clear gaps (score under 50 that is still realistic)
4. For each job, write one short, honest reason for the score and the single most important gap (or "none").
   Consider startups, scale-ups, MNCs, consulting firms, tech and non-tech companies equally; judge only the fit.`;

const OUTPUT_RULES = `RULES (always apply):
- Score ONLY the job postings listed below, using their exact "id". Never invent companies, jobs or links.
- Never claim the candidate has skills or experience the resume does not show.
- Reply with ONLY a JSON object:
{
  "profile": { "seniority": "e.g. Mid-level (6 years)", "targetRoles": ["3-6 roles the candidate should target"], "summary": "one sentence" },
  "matches": [ { "id": 123, "score": 0-100, "bucket": "high" | "medium" | "stretch", "reason": "one sentence", "gap": "short phrase or none" } ]
}
Include every listed job in "matches".`;

const BUCKETS = ['high', 'medium', 'stretch'];
const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };

function masterPrompt(db) {
  const row = db.prepare("SELECT value, updated_at, updated_by FROM job_settings WHERE key = 'master_prompt'").get();
  return row ? { prompt: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by, isDefault: false }
    : { prompt: DEFAULT_MASTER_PROMPT, updatedAt: null, updatedBy: '', isDefault: true };
}

/** Fetch one company's jobs and update the database: new jobs added, known ones refreshed, missing ones closed. */
async function syncCompany(db, company, opts = {}) {
  const stamp = now();
  try {
    const extra = parse(company.extra) || {};
    const list = await sources.fetchJobs({ provider: company.provider, board: company.board, wd: extra.wd, defaultCountry: company.default_country }, opts);
    transaction(db, () => {
      const upsert = db.prepare(`INSERT INTO jobs (company_id, external_id, title, location, country, department, employment_type, posted_at, url, description, active, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT (company_id, external_id) DO UPDATE SET title = excluded.title, location = excluded.location, country = excluded.country,
          department = excluded.department, employment_type = excluded.employment_type, posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
          url = excluded.url, description = excluded.description, active = 1, last_seen = excluded.last_seen`);
      for (const j of list) {
        if (!j.title || !j.url || !/^https:\/\//i.test(j.url)) continue;
        upsert.run(company.id, j.externalId, String(j.title).slice(0, 300), String(j.location || '').slice(0, 300), String(j.country || '').slice(0, 80),
          String(j.department || '').slice(0, 160), String(j.employmentType || '').slice(0, 80), j.postedAt, j.url, j.description || '', stamp, stamp);
      }
      db.prepare('UPDATE jobs SET active = 0 WHERE company_id = ? AND last_seen < ?').run(company.id, stamp);                 // closed since the last sync
      db.prepare('DELETE FROM jobs WHERE company_id = ? AND active = 0 AND last_seen < ?').run(company.id, new Date(Date.now() - 60 * DAY).toISOString());
      const count = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND active = 1').get(company.id).n;
      db.prepare("UPDATE job_companies SET last_sync = ?, last_error = '', job_count = ? WHERE id = ?").run(stamp, count, company.id);
    });
    return { ok: true, jobs: list.length };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 300);
    db.prepare('UPDATE job_companies SET last_sync = ?, last_error = ? WHERE id = ?').run(stamp, message, company.id);
    return { ok: false, error: message };
  }
}

async function syncAll(db, opts = {}) {
  const results = [];
  for (const c of db.prepare('SELECT * FROM job_companies WHERE enabled = 1 ORDER BY id').all()) results.push({ id: c.id, name: c.name, ...(await syncCompany(db, c, opts)) });
  return results;
}

/** Sync every few hours while the server runs (JOB_SYNC_HOURS, default 6; 0 turns it off). */
function scheduleSync(db) {
  const hours = process.env.JOB_SYNC_HOURS === undefined ? 6 : Number(process.env.JOB_SYNC_HOURS);
  if (!(hours > 0)) return null;
  const run = () => syncAll(db).catch(err => console.error('Job sync failed:', err));
  setTimeout(run, 60 * 1000).unref();
  return setInterval(run, hours * 3600 * 1000).unref();
}

/** Keywords from a structured resume (skills, headline, titles), for picking the jobs worth sending to the AI. */
function resumeKeywords(resume, extra = '') {
  const words = [];
  const add = s => String(s || '').toLowerCase().split(/[^a-z0-9.+#]+/).filter(w => w.length > 1 && !STOP.has(w)).forEach(w => words.push(w));
  if (resume) {
    add(resume.headline);
    (resume.skills || []).forEach(g => (g.items || []).forEach(add));
    (resume.experience || []).forEach(e => add(e.title));
  }
  add(extra);
  return [...new Set(words)];
}
const STOP = new Set(['and', 'the', 'for', 'with', 'senior', 'junior', 'lead', 'engineer', 'developer', 'manager', 'of', 'in', 'to', 'a', 'an', 'at', 'team', 'specialist', 'associate', 'ii', 'iii', 'sr', 'jr']);

function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;
  const ai = { db, vault: ctx.vault, upstream: ctx.upstream };
  const fetchOpts = { base: ctx.jobSourceBase || {} };
  const companyRow = id => one('SELECT * FROM job_companies WHERE id = ?', id);
  const present = c => ({ id: c.id, name: c.name, careersUrl: c.careers_url, provider: c.provider, board: c.board, defaultCountry: c.default_country,
    enabled: !!c.enabled, lastSync: c.last_sync, lastError: c.last_error, jobCount: c.job_count });

  // ===================== dashboard =====================
  add('GET', '/admin/api/jobs', { admin: true }, () => ({
    companies: all('SELECT * FROM job_companies ORDER BY name COLLATE NOCASE').map(present),
    stats: one(`SELECT COUNT(*) AS active, SUM(CASE WHEN posted_at >= ? THEN 1 ELSE 0 END) AS week, SUM(CASE WHEN country = 'India' THEN 1 ELSE 0 END) AS india
                FROM jobs WHERE active = 1`, new Date(Date.now() - 7 * DAY).toISOString()),
    prompt: masterPrompt(db), defaultPrompt: DEFAULT_MASTER_PROMPT, outputRules: OUTPUT_RULES,
    syncHours: process.env.JOB_SYNC_HOURS === undefined ? 6 : Number(process.env.JOB_SYNC_HOURS),
  }));

  add('POST', '/admin/api/jobs/companies', { admin: true, perm: 'jobs.write' }, async (req, res, { body, admin }) => {
    const name = text(body.name, 120, { required: true, field: 'Company name' });
    const url = text(body.careersUrl, 500, { required: true, field: 'Careers URL' });
    const board = sources.parseBoardUrl(url);
    if (!board) throw new ApiError(400, 'That careers URL is not from a supported job board (Greenhouse, Lever, SmartRecruiters, Ashby or Workday). Open the company\'s job list and copy the address of that page.');
    if (one('SELECT id FROM job_companies WHERE provider = ? AND board = ?', board.provider, board.board)) throw new ApiError(409, 'That company is already in the list');
    const r = db.prepare('INSERT INTO job_companies (name, careers_url, provider, board, extra, default_country, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(name, url, board.provider, board.board, JSON.stringify(board.wd ? { wd: board.wd } : {}), text(body.defaultCountry, 80, { field: 'Default country' }), now());
    audit(admin, 'jobs.company.added', name, `${board.provider}: ${board.board}`);
    const sync = await syncCompany(db, companyRow(r.lastInsertRowid), fetchOpts);
    return { status: 201, body: { company: present(companyRow(r.lastInsertRowid)), sync } };
  });

  add('POST', '/admin/api/jobs/companies/:id', { admin: true, perm: 'jobs.write' }, async (req, res, { params, body, admin }) => {
    const c = companyRow(params.id);
    if (!c) throw new ApiError(404, 'Company not found');
    const action = String(body.action || '');
    let sync = null;
    if (action === 'sync') sync = await syncCompany(db, c, fetchOpts);
    else if (action === 'enable' || action === 'disable') {
      db.prepare('UPDATE job_companies SET enabled = ? WHERE id = ?').run(action === 'enable' ? 1 : 0, c.id);
      db.prepare('UPDATE jobs SET active = ? WHERE company_id = ?').run(action === 'enable' ? 1 : 0, c.id);   // a hidden company's jobs are not listed
      if (action === 'enable') sync = await syncCompany(db, companyRow(c.id), fetchOpts);
    } else if (action === 'update') {
      db.prepare('UPDATE job_companies SET name = ?, default_country = ? WHERE id = ?')
        .run(text(body.name, 120, { required: true, field: 'Company name' }), text(body.defaultCountry, 80, { field: 'Default country' }), c.id);
    } else throw new ApiError(400, 'Unknown action');
    audit(admin, `jobs.company.${action}`, c.name);
    return { company: present(companyRow(c.id)), sync };
  });

  add('DELETE', '/admin/api/jobs/companies/:id', { admin: true, perm: 'jobs.write' }, (req, res, { params, admin }) => {
    const c = companyRow(params.id);
    if (!c) throw new ApiError(404, 'Company not found');
    db.prepare('DELETE FROM job_companies WHERE id = ?').run(c.id);
    audit(admin, 'jobs.company.deleted', c.name);
    return { ok: true };
  });

  add('POST', '/admin/api/jobs/sync', { admin: true, perm: 'jobs.write' }, async (req, res, { admin }) => {
    const results = await syncAll(db, fetchOpts);
    audit(admin, 'jobs.synced', `${results.length} companies`, results.filter(r => !r.ok).map(r => r.name).join(', '));
    return { results };
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

  // ===================== website: Career toolkit → Find jobs =====================
  const me = req => signedInCustomer(db, req).customer;

  /** The resume the candidate picked: "ats" (the improved one, or the uploaded text) or "v<id>" (a role version). */
  function resumeFor(customerId, key) {
    const r = one('SELECT * FROM career_resumes WHERE customer_id = ?', customerId);
    if (!r) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1).', 'no-resume');
    const career = require('./career');
    if (/^v\d+$/.test(key)) {
      const v = one('SELECT role, content_json FROM career_versions WHERE id = ? AND customer_id = ?', Number(key.slice(1)), customerId);
      const c = v && parse(v.content_json);
      if (!c) throw new ApiError(404, 'Resume version not found');
      return { key, label: v.role, text: career.resumeText(c.resume), structured: c.resume, role: v.role };
    }
    const ats = parse(r.ats_json);
    return { key: 'ats', label: ats ? 'ATS-friendly resume' : 'Uploaded resume', text: ats ? career.resumeText(ats.resume) : r.source_text, structured: ats && ats.resume, role: '' };
  }

  /** WHERE clause + params for the candidate's filters. */
  function filterSql(q) {
    const where = ['j.active = 1', 'c.enabled = 1'], params = [];
    const ids = String(q.get('companies') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 100);
    if (ids.length) { where.push(`j.company_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
    const role = String(q.get('q') || '').trim();
    if (role) { where.push("(j.title LIKE ? ESCAPE '\\' OR j.department LIKE ? ESCAPE '\\')"); params.push(likeTerm(role), likeTerm(role)); }
    const location = String(q.get('location') || '').trim();
    if (location) { where.push("j.location LIKE ? ESCAPE '\\'"); params.push(likeTerm(location)); }
    const country = String(q.get('country') || '').trim();
    if (country) { where.push('j.country = ?'); params.push(country); }
    const days = Number(q.get('days'));
    if ([1, 3, 7, 14, 30].includes(days)) { where.push('j.posted_at >= ?'); params.push(new Date(Date.now() - days * DAY).toISOString()); }
    return { where: where.join(' AND '), params };
  }

  add('GET', '/api/career/jobs', { public: true }, (req, res, { query }) => {
    const c = me(req);
    const resumeKey = /^(ats|v\d+)$/.test(String(query.get('resume') || '')) ? query.get('resume') : 'ats';
    const page = Math.max(1, Math.floor(Number(query.get('page')) || 1));
    const pageSize = [10, 20, 50].includes(Number(query.get('pageSize'))) ? Number(query.get('pageSize')) : 20;
    const bucket = BUCKETS.includes(query.get('bucket')) ? query.get('bucket') : '';
    const sort = query.get('sort') === 'match' ? 'match' : 'newest';
    const f = filterSql(query);
    const scoreJoin = 'LEFT JOIN career_job_scores s ON s.job_id = j.id AND s.customer_id = ? AND s.resume_key = ?';
    const where = f.where + (bucket ? ' AND s.bucket = ?' : '');
    const params = [c.id, resumeKey, ...f.params, ...(bucket ? [bucket] : [])];
    const total = one(`SELECT COUNT(*) AS n FROM jobs j JOIN job_companies c ON c.id = j.company_id ${scoreJoin} WHERE ${where}`, ...params).n;
    const order = sort === 'match' ? 's.score IS NULL, s.score DESC, j.posted_at IS NULL, j.posted_at DESC' : 'j.posted_at IS NULL, j.posted_at DESC, j.id DESC';
    const rows = all(`SELECT j.id, j.title, j.location, j.country, j.department, j.employment_type, j.posted_at, j.url, c.name AS company,
                             s.score, s.bucket, s.reason, s.gap
                      FROM jobs j JOIN job_companies c ON c.id = j.company_id ${scoreJoin}
                      WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
    const counts = Object.fromEntries(BUCKETS.map(b => [b, 0]));
    for (const r of all('SELECT bucket, COUNT(*) AS n FROM career_job_scores s JOIN jobs j ON j.id = s.job_id WHERE s.customer_id = ? AND s.resume_key = ? AND j.active = 1 GROUP BY bucket', c.id, resumeKey)) counts[r.bucket] = r.n;
    return {
      jobs: rows.map(r => ({ id: r.id, title: r.title, company: r.company, location: r.location, country: r.country, department: r.department,
        employmentType: r.employment_type, postedAt: r.posted_at, url: r.url,
        match: r.score == null ? null : { score: r.score, bucket: r.bucket, reason: r.reason, gap: r.gap } })),
      total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), counts,
      companies: all(`SELECT c.id, c.name, COUNT(j.id) AS jobs FROM job_companies c LEFT JOIN jobs j ON j.company_id = c.id AND j.active = 1
                      WHERE c.enabled = 1 GROUP BY c.id ORDER BY c.name COLLATE NOCASE`),
      countries: all("SELECT country, COUNT(*) AS n FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE j.active = 1 AND c.enabled = 1 AND country <> '' GROUP BY country ORDER BY n DESC").map(r => ({ name: r.country, jobs: r.n })),
      scoredAt: (one('SELECT MAX(scored_at) AS t FROM career_job_scores WHERE customer_id = ? AND resume_key = ?', c.id, resumeKey) || {}).t,
    };
  });

  // the Master Prompt runs on the candidate's resume and the most relevant real jobs within their filters
  add('POST', '/api/career/jobs/match', { public: true }, async (req, res, { body }) => {
    const c = me(req);
    const career = require('./career');
    career.checkQuota(db, c.id);
    const resume = resumeFor(c.id, /^(ats|v\d+)$/.test(String(body.resume || '')) ? body.resume : 'ats');
    const q = new URLSearchParams();
    for (const k of ['companies', 'q', 'location', 'country', 'days']) if (body[k] != null && body[k] !== '') q.set(k, Array.isArray(body[k]) ? body[k].join(',') : String(body[k]));
    const f = filterSql(q);
    const pool = all(`SELECT j.id, j.title, j.location, j.country, j.department, j.posted_at, substr(j.description, 1, 1500) AS description, c.name AS company
                      FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE ${f.where} ORDER BY j.posted_at IS NULL, j.posted_at DESC LIMIT 3000`, ...f.params);
    if (!pool.length) throw new ApiError(400, 'No active jobs match your filters. Widen the filters and try again.');
    // send the most relevant jobs: keyword overlap with the resume (title counts most), newest first on ties
    const keywords = resumeKeywords(resume.structured, resume.role + ' ' + (resume.structured ? '' : resume.text.slice(0, 3000)));
    const relevance = j => {
      const title = j.title.toLowerCase(), rest = (j.department + ' ' + j.description).toLowerCase();
      return keywords.reduce((n, k) => n + (title.includes(k) ? 3 : 0) + (rest.includes(k) ? 1 : 0), 0);
    };
    const batch = pool.map((j, i) => ({ j, r: relevance(j), i })).sort((a, b) => b.r - a.r || a.i - b.i).slice(0, AI_BATCH).map(x => x.j);
    const lines = batch.map(j => JSON.stringify({ id: j.id, title: j.title, company: j.company, location: j.location, country: j.country,
      posted: (j.posted_at || '').slice(0, 10), summary: String(j.description || '').replace(/\s+/g, ' ').slice(0, 350) }));
    const out = await completeJson(ai, {
      system: masterPrompt(db).prompt + '\n\n' + OUTPUT_RULES,
      user: `CANDIDATE RESUME (${resume.label}):\n${resume.text}\n\nJOB POSTINGS (one JSON object per line):\n${lines.join('\n')}`,
      maxTokens: 8000,
    });
    const sent = new Set(batch.map(j => j.id));
    const matches = (Array.isArray(out.matches) ? out.matches : []).filter(m => m && sent.has(Number(m.id)));
    // nothing usable (e.g. the AI scored made-up ids only): say so, and do not count it against today's limit
    if (!matches.length) throw new ApiError(502, 'The AI could not score these jobs this time. Please try again.', 'ai');
    const stamp = now();
    transaction(db, () => {
      const save = db.prepare(`INSERT INTO career_job_scores (customer_id, resume_key, job_id, score, bucket, reason, gap, scored_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT (customer_id, resume_key, job_id) DO UPDATE SET score = excluded.score, bucket = excluded.bucket, reason = excluded.reason, gap = excluded.gap, scored_at = excluded.scored_at`);
      for (const m of matches) {
        const score = Math.max(0, Math.min(100, Math.round(Number(m.score) || 0)));
        const bucket = BUCKETS.includes(m.bucket) ? m.bucket : score >= 75 ? 'high' : score >= 50 ? 'medium' : 'stretch';
        save.run(c.id, resume.key, Number(m.id), score, bucket, String(m.reason || '').slice(0, 300), String(m.gap || '').slice(0, 120), stamp);
      }
    });
    career.countUse(db, c.id);
    const p = out.profile && typeof out.profile === 'object' ? out.profile : {};
    return {
      scored: matches.length, considered: batch.length, available: pool.length,
      profile: { seniority: String(p.seniority || '').slice(0, 80), targetRoles: (Array.isArray(p.targetRoles) ? p.targetRoles : []).slice(0, 6).map(r => String(r).slice(0, 80)), summary: String(p.summary || '').slice(0, 300) },
      usage: career.usage(db, c.id),
    };
  });
}

module.exports = { addRoutes, syncCompany, syncAll, scheduleSync, masterPrompt, resumeKeywords, DEFAULT_MASTER_PROMPT, OUTPUT_RULES };
