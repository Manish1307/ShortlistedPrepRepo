'use strict';
// Recommended jobs (website: Career toolkit → Live Search): the best matches for a candidate's resume among the jobs
// the server already holds from career sites, found without the AI, so it is instant and uses no AI tokens. The AI job
// search stays for a deeper match; this is the quick first look.
//
// A job's score (0 to 100) comes from: how well its title fits the roles on the resume (up to 42), how many of the resume's
// skills the job names (up to 40), how fresh the posting is (up to 8), the candidate's city (5) and whether the level fits
// (a senior job for a fresher, or the other way round, loses 15). A job needs a role or skill in common to be shown.

const crypto = require('crypto');
const { ApiError, likeTerm } = require('./http');
const { signedInCustomer } = require('./accounts');
const atscheck = require('./atscheck');
const { companyDomain } = require('./jobcatalogue');

const DAY = 86400000;
const POOL_LIMIT = 25000;     // jobs read for one request
const MIN_SCORE = 25;         // a weaker match than this is not worth showing
const SHOW = 40;              // jobs sent back
const PER_COMPANY = 4;        // so one big employer does not fill the list
const CACHE_MS = 10 * 60000;  // the same candidate asking again within this time gets the same answer

/** Words that say what kind of job it is, not which job: "Senior Java Developer" is about Java. */
const GENERIC = new Set(`engineer engineers developer developers manager managers senior junior lead associate specialist executive officer analyst consultant
administrator assistant intern trainee head principal staff sr jr i ii iii iv and of the for in at a an to with executive team technical expert professional`.split(/\s+/));
const TITLE_NOUNS = 'engineer|developer|analyst|manager|consultant|administrator|scientist|architect|designer|specialist|associate|executive|officer|technician|supervisor|programmer|tester|researcher|accountant|coordinator|lead|operator|planner|estimator|surveyor|inspector|auditor|recruiter|writer|strategist|advisor|trainee|intern';
const ROLE_RE = new RegExp(`\\b([A-Za-z][A-Za-z+#./&-]*(?:\\s+[A-Za-z+#./&-]+){0,3}?\\s+(?:${TITLE_NOUNS}))\\b`, 'gi');
const LEAD_JUNK = /^(?:as|a|an|the|and|of|with|for|in|at|to|by|worked|working|work|role|position|current|currently|my|our|their|his|her|is|was|am|being|became|become|promoted|seeking|looking|years|year|experience|experienced)\s+/i;
const SKILL_HEADING = /^(technical\s+|key\s+|core\s+)?(skills|competencies|expertise|technologies|tools)\b\s*[:\-]?\s*(.*)$/i;
const OTHER_HEADING = /^(professional\s+|work\s+)?(summary|profile|objective|experience|employment|education|projects?|certifications?|achievements?|languages|interests|declaration|personal|contact|references)\b/i;
const SKIP_SKILL = new Set(['communication', 'teamwork', 'leadership', 'problem solving', 'ms office', 'microsoft office', 'time management', 'hard working', 'team player', 'english', 'hindi']);
const JUNIOR = /\b(intern|internship|trainee|fresher|graduate|entry[- ]level|junior|jr\.?|apprentice|associate)\b/i;
const SENIOR = /\b(senior|sr\.?|lead|principal|staff|head|director|vp|vice president|manager|architect|chief)\b/i;

const words = s => String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g) || [];
const tokenSet = s => new Set(words(s).map(w => w.replace(/\.+$/, '')));

/** Years of experience the resume states ("4 years", "6+ yrs"), or null. */
function yearsOf(text) {
  const near = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}(?:experience|exp)\b|(?:experience|exp)\b[^.\n]{0,30}?(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i.exec(text);
  const any = near || /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i.exec(text);
  const n = any ? Number(any[1] || any[2]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 40 ? n : null;
}

/** Roles on the resume, best first: the titles in its first lines and wherever a job title appears, plus any the caller knows. */
function rolesOf(text, extra = []) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const tally = new Map();
  const add = (raw, weight) => {
    let r = String(raw).replace(/[^A-Za-z0-9+#./& -]/g, ' ').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 4 && LEAD_JUNK.test(r); i++) r = r.replace(LEAD_JUNK, '');
    r = r.toLowerCase();
    if (r.split(' ').length < 2 || r.length > 48 || r.length < 5) return;
    tally.set(r, (tally.get(r) || 0) + weight);
  };
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ROLE_RE)) add(m[1], i < 4 ? 5 : 1);
  });
  for (const r of extra) add(r, 8);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r)
    .filter((r, i, all) => !all.some((o, j) => j < i && (o.includes(r) || r.includes(o))))   // "java developer" and "java backend developer": the better-ranked one is kept
    .slice(0, 4);
}

/** Skills on the resume: the recognised keywords (ATS check) and the items of its Skills section, lower case. */
function skillsOf(text) {
  const out = new Set(atscheck.scoreResume(text).skills.map(s => s.toLowerCase()));
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = SKILL_HEADING.exec(lines[i]);
    if (!m) continue;
    const block = [m[3]];
    for (let k = i + 1; k < lines.length && block.length < 14; k++) {
      if (!lines[k]) { if (block.join('').trim()) break; continue; }
      if (OTHER_HEADING.test(lines[k]) && lines[k].length < 40) break;
      block.push(lines[k]);
    }
    for (const part of block.join('\n').split(/[,;|•·\n]|\s{2,}/)) {
      const s = part.replace(/^[-–—*•\s]+|[.\s]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
      if (s.length >= 2 && s.length <= 32 && s.split(' ').length <= 4 && !SKIP_SKILL.has(s) && /[a-z]/.test(s)) out.add(s);
    }
  }
  return [...out].slice(0, 60);
}

/**
 * The profile used to match: { roles, skills, years }. extraRoles: roles the candidate already chose elsewhere
 * (a role-based resume, the target roles of an earlier Live Search).
 */
function profileOf(text, extraRoles = []) {
  return { roles: rolesOf(text, extraRoles), skills: skillsOf(text), years: yearsOf(text) };
}

/**
 * Scores jobs for a profile: [{ job, score, role, skills }], best first, at most `limit`, at most PER_COMPANY from one company.
 * jobs: [{ id, title, department, description, location, posted_at, company }].
 */
function rank(profile, jobs, { city = '', now = Date.now(), limit = SHOW } = {}) {
  const roles = profile.roles.map(r => {
    const ws = words(r).map(w => w.replace(/\.+$/, ''));
    const key = ws.filter(w => !GENERIC.has(w) && w.length > 1);
    return { phrase: r, key, noun: ws.filter(w => GENERIC.has(w)) };
  });
  const single = profile.skills.filter(s => !s.includes(' '));
  const multi = profile.skills.filter(s => s.includes(' '));
  const cityLow = String(city || '').trim().toLowerCase();
  const out = [];
  for (const job of jobs) {
    const title = String(job.title || '').toLowerCase();
    const titleTokens = tokenSet(title);
    let titlePts = 0, role = '';
    for (const r of roles) {
      let pts = 0;
      if (title.includes(r.phrase)) pts = 42;
      else if (r.key.length) {
        const hit = r.key.filter(w => titleTokens.has(w)).length;
        if (hit) pts = 38 * (hit / r.key.length) + (r.noun.some(n => titleTokens.has(n)) ? 4 : 0);
      }
      if (pts > titlePts) { titlePts = pts; role = r.phrase; }
    }
    const body = `${title} ${String(job.department || '').toLowerCase()} ${String(job.description || '').toLowerCase()}`;
    const tokens = tokenSet(body);
    const found = [...single.filter(s => tokens.has(s)), ...multi.filter(s => body.includes(s))];
    const matched = found.filter(s => !found.includes(s + 's'));   // "rest api" and "rest apis" count once
    if (!(titlePts >= 15 || matched.length >= 2 || (titlePts > 0 && matched.length >= 1))) continue;   // nothing in common
    let score = titlePts + Math.min(40, matched.length * 7);
    const age = job.posted_at ? (now - Date.parse(job.posted_at)) / DAY : NaN;
    if (age >= 0) score += age <= 7 ? 8 : age <= 14 ? 5 : age <= 30 ? 3 : age <= 60 ? 1 : 0;
    if (cityLow && String(job.location || '').toLowerCase().includes(cityLow)) score += 5;
    if (profile.years !== null) {
      if (SENIOR.test(title) && profile.years < 3) score -= 15;
      else if (JUNIOR.test(title) && !/\bassociate\b/i.test(title) && profile.years > 7) score -= 15;
    }
    if (score < MIN_SCORE) continue;
    out.push({ job, score: Math.max(0, Math.min(100, Math.round(score))), role: titlePts >= 15 ? role : '', skills: matched.slice(0, 6) });
  }
  out.sort((a, b) => b.score - a.score || String(b.job.posted_at || '').localeCompare(String(a.job.posted_at || '')));
  const per = new Map(), kept = [];
  for (const x of out) {
    const n = per.get(x.job.company) || 0;
    if (n >= PER_COMPANY) continue;
    per.set(x.job.company, n + 1);
    kept.push(x);
    if (kept.length >= limit) break;
  }
  return kept;
}

function addRoutes(ctx) {
  const { db, add, one, all } = ctx;
  const cache = new Map();   // customer + resume + filters → { at, data }
  const me = req => signedInCustomer(db, req).customer;
  const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };

  add('GET', '/api/career/recommended', { public: true }, (req, res, { query }) => {
    const c = me(req);
    const r = one('SELECT source_text FROM career_resumes WHERE customer_id = ?', c.id);
    if (!r) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1).', 'no-resume');
    const country = String(query.get('country') || '').trim().slice(0, 80);
    const city = String(query.get('city') || '').trim().slice(0, 80);
    const days = [7, 14, 30].includes(Number(query.get('days'))) ? Number(query.get('days')) : 0;

    // roles the candidate already named elsewhere: their role-based resumes and the targets of their latest Live Search
    const extra = all('SELECT role FROM career_versions WHERE customer_id = ?', c.id).map(v => v.role);
    const last = one("SELECT result_json FROM career_job_searches WHERE customer_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1", c.id);
    const profile0 = last && (parse(last.result_json) || {}).profile;
    if (profile0 && Array.isArray(profile0.targetRoles)) extra.push(...profile0.targetRoles.slice(0, 3));

    const key = [c.id, crypto.createHash('sha1').update(r.source_text).digest('hex').slice(0, 12), extra.join('|'), country, city, days].join('~');
    const hit = cache.get(key);
    const withSector = d => ({ ...d, sector: c.sector || '' });   // the candidate's sector (the Jobs page opens on it); not cached
    if (hit && Date.now() - hit.at < CACHE_MS) return withSector(hit.data);

    const profile = profileOf(r.source_text, extra);
    const held = one('SELECT COUNT(*) AS n FROM jobs WHERE active = 1').n;
    let data;
    if (!profile.roles.length && profile.skills.length < 2) {
      data = { recommended: [], held, considered: 0, basedOn: profile, message: 'We could not find a job title or skills in your resume. Add a Skills section and your job title, then try again.' };
    } else {
      const where = ['j.active = 1'], params = [];
      if (country) { where.push("(j.country = ? OR j.location LIKE ? ESCAPE '\\' OR (j.country IN ('', 'Remote') AND j.location LIKE '%remote%'))"); params.push(country, likeTerm(country)); }
      if (days) { where.push('j.posted_at >= ?'); params.push(new Date(Date.now() - days * DAY).toISOString()); }
      const pool = all(`SELECT j.id, j.title, j.location, j.country, j.department, j.posted_at, j.url, substr(j.description, 1, 1500) AS description, c.name AS company, c.careers_url
                        FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE ${where.join(' AND ')} ORDER BY j.posted_at IS NULL, j.posted_at DESC LIMIT ${POOL_LIMIT}`, ...params);
      const ranked = rank(profile, pool, { city });
      data = {
        held, considered: pool.length, basedOn: profile,
        recommended: ranked.map(x => ({ id: x.job.id, title: x.job.title, company: x.job.company, location: x.job.location, country: x.job.country, postedAt: x.job.posted_at,
          url: x.job.url, score: x.score, role: x.role, skills: x.skills, domain: companyDomain(x.job.company, x.job.careers_url) })),
      };
      if (!data.recommended.length) data.message = pool.length ? 'No cached job matches your resume well enough yet. Try a wider location or date range, or run a Live Search.' : 'We hold no jobs for that location yet. Try another country, or run a Live Search.';
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), data });
    return withSector(data);
  });
}

module.exports = { addRoutes, profileOf, rolesOf, skillsOf, yearsOf, rank };
