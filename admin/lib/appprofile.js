'use strict';
// Application profile (Career toolkit → Apply): everything a company's application form asks for, kept once and
// checked by the candidate: personal details, every job and every education entry with exact dates, skills and
// preferences. The AI fills it from the resume; the candidate corrects it. The website shows it as copy-ready rows and
// the browser extension fills company portals (account creation, sign-in and the application itself) from it.
// Also the application tracker: which jobs the candidate has applied to.

const { ApiError, text } = require('./http');
const { now } = require('./db');
const { signedInCustomer } = require('./accounts');
const { completeJson } = require('./careerai');
const aiTokens = require('./tokens');

const MAX_WORK = 15, MAX_EDU = 8, MAX_CERT = 15;
const STATUSES = ['applied', 'interview', 'offer', 'rejected'];

const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const long = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
const month = v => { const n = Math.round(Number(v)); return n >= 1 && n <= 12 ? n : 0; };
const year = v => { const n = Math.round(Number(v)); return n >= 1950 && n <= 2100 ? n : 0; };
const list = (v, n, max) => (Array.isArray(v) ? v : []).map(x => s(x, max)).filter(Boolean).slice(0, n);

/** Anything (the AI's answer, or the candidate's edits) → a profile of the exact shape the website and extension read. */
function cleanProfile(input) {
  const p = (input && typeof input === 'object') ? input : {};
  const per = p.personal || {};
  const full = s(per.fullName, 120) || [s(per.firstName, 60), s(per.lastName, 60)].filter(Boolean).join(' ');
  const [first, ...rest] = full.split(' ');
  const pre = p.preferences || {};
  return {
    personal: {
      fullName: full, firstName: s(per.firstName, 60) || first || '', lastName: s(per.lastName, 60) || rest.join(' '),
      email: s(per.email, 160), phone: s(per.phone, 40), address: s(per.address, 200), city: s(per.city, 80), state: s(per.state, 80),
      country: s(per.country, 80), postalCode: s(per.postalCode, 20),
      linkedin: s(per.linkedin, 200), github: s(per.github, 200), portfolio: s(per.portfolio, 200),
    },
    summary: long(p.summary, 1200),
    work: (Array.isArray(p.work) ? p.work : []).slice(0, MAX_WORK).map(w => {
      w = w || {};
      const current = !!w.current;
      return { company: s(w.company, 120), title: s(w.title, 120), location: s(w.location, 100),
        startMonth: month(w.startMonth), startYear: year(w.startYear), endMonth: current ? 0 : month(w.endMonth), endYear: current ? 0 : year(w.endYear), current,
        responsibilities: long(w.responsibilities, 2500) };
    }).filter(w => w.company || w.title),
    education: (Array.isArray(p.education) ? p.education : []).slice(0, MAX_EDU).map(e => {
      e = e || {};
      return { school: s(e.school, 160), degree: s(e.degree, 120), field: s(e.field, 120), location: s(e.location, 100),
        startYear: year(e.startYear), endYear: year(e.endYear), grade: s(e.grade, 40) };
    }).filter(e => e.school || e.degree),
    skills: list(p.skills, 40, 60),
    certifications: (Array.isArray(p.certifications) ? p.certifications : []).slice(0, MAX_CERT).map(c => ({ name: s(c && c.name, 120), issuer: s(c && c.issuer, 100), year: year(c && c.year) })).filter(c => c.name),
    languages: list(p.languages, 10, 40),
    preferences: {
      totalExperience: s(pre.totalExperience, 40), noticePeriod: s(pre.noticePeriod, 60), currentCtc: s(pre.currentCtc, 40), expectedCtc: s(pre.expectedCtc, 40),
      workAuthorization: s(pre.workAuthorization, 100), willingToRelocate: s(pre.willingToRelocate, 20),
    },
  };
}

/** What still needs the candidate's attention before applying: a list of short sentences. */
function problems(profile) {
  const out = [], per = profile.personal;
  if (!per.fullName) out.push('Your name is missing.');
  if (!per.email) out.push('Your email is missing.');
  if (!per.phone) out.push('Your phone number is missing.');
  if (!profile.work.length && !profile.education.length) out.push('Add at least one job or education entry.');
  profile.work.forEach((w, i) => {
    const name = w.company || w.title || `Job ${i + 1}`;
    if (!w.company) out.push(`Job ${i + 1}: company name is missing.`);
    if (!w.startYear) out.push(`${name}: start date is missing.`);
    if (!w.current && !w.endYear) out.push(`${name}: end date is missing (tick "I currently work here" if it is your current job).`);
    if (w.startYear && w.endYear && (w.endYear < w.startYear || (w.endYear === w.startYear && w.endMonth && w.startMonth && w.endMonth < w.startMonth))) out.push(`${name}: the end date is before the start date.`);
  });
  profile.education.forEach((e, i) => {
    const name = e.school || `Education ${i + 1}`;
    if (!e.school) out.push(`Education ${i + 1}: college or university is missing.`);
    if (!e.endYear) out.push(`${name}: end year is missing.`);
    if (e.startYear && e.endYear && e.endYear < e.startYear) out.push(`${name}: the end year is before the start year.`);
  });
  return out;
}

const PROFILE_PROMPT = `You fill in a job-application profile from a candidate's resume. Work in any field (IT, science, engineering, healthcare,
finance, sales...). Copy facts exactly as the resume states them.

RULES:
- Never invent anything. If the resume does not say it, leave the text empty "" (or 0 for a number, false for a flag).
- Every job and every education entry in the resume gets its own entry, newest first. Do not merge or drop any.
- Dates: "startMonth" and "endMonth" are numbers 1-12, "startYear" and "endYear" four-digit years. If only a year is given, leave the month 0.
  A job the candidate still holds ("Present", "Current", "Till date") has "current": true and no end date.
- "responsibilities": the resume's own bullets for that job, one per line, starting with "- ". Do not add new ones.
- "fullName": the candidate's full name. Phone and email exactly as written.
- "preferences" (notice period, salary, relocation): only if the resume states them, else "".
- "totalExperience": e.g. "6 years" computed only from the job dates in the resume, else "".
- "skills": the skills, tools and methods the resume lists (up to 40).
Reply with ONLY a JSON object:
{
  "personal": { "fullName": "", "email": "", "phone": "", "address": "", "city": "", "state": "", "country": "", "postalCode": "", "linkedin": "", "github": "", "portfolio": "" },
  "summary": "the resume's own profile summary, if it has one",
  "work": [ { "company": "", "title": "", "location": "", "startMonth": 0, "startYear": 0, "endMonth": 0, "endYear": 0, "current": false, "responsibilities": "" } ],
  "education": [ { "school": "", "degree": "", "field": "", "location": "", "startYear": 0, "endYear": 0, "grade": "" } ],
  "skills": [], "certifications": [ { "name": "", "issuer": "", "year": 0 } ], "languages": [],
  "preferences": { "totalExperience": "", "noticePeriod": "", "currentCtc": "", "expectedCtc": "", "workAuthorization": "", "willingToRelocate": "" }
}`;

function addRoutes(ctx) {
  const { db, add, one, all } = ctx;
  const ai = { db, vault: ctx.vault, upstream: ctx.upstream };
  const me = req => signedInCustomer(db, req).customer;
  const parse = v => { try { return JSON.parse(v); } catch (_) { return null; } };
  const present = row => {
    const profile = row ? cleanProfile(parse(row.profile_json)) : null;
    return { profile, problems: profile ? problems(profile) : [], updatedAt: row ? row.updated_at : null, confirmedAt: row ? row.confirmed_at : null };
  };

  add('GET', '/api/career/app-profile', { public: true }, req => {
    const c = me(req);
    return present(one('SELECT * FROM career_app_profiles WHERE customer_id = ?', c.id));
  });

  // the candidate's edits; "confirm" says they have checked it
  add('POST', '/api/career/app-profile', { public: true, maxBody: 200 * 1024 }, (req, res, { body }) => {
    const c = me(req);
    const profile = cleanProfile(body.profile);
    const stamp = now();
    db.prepare(`INSERT INTO career_app_profiles (customer_id, profile_json, updated_at, confirmed_at) VALUES (?,?,?,?)
                ON CONFLICT (customer_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at,
                  confirmed_at = CASE WHEN ? THEN excluded.updated_at ELSE career_app_profiles.confirmed_at END`)
      .run(c.id, JSON.stringify(profile), stamp, body.confirm ? stamp : null, body.confirm ? 1 : 0);
    return present(one('SELECT * FROM career_app_profiles WHERE customer_id = ?', c.id));
  });

  // fill it from the resume (one AI action); replaces what is there
  add('POST', '/api/career/app-profile/generate', { public: true }, async req => {
    const c = me(req);
    const career = require('./career');
    career.checkQuota(db, c.id);
    const r = one('SELECT * FROM career_resumes WHERE customer_id = ?', c.id);
    if (!r) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1).', 'no-resume');
    const ats = parse(r.ats_json);
    const original = String(r.source_text || '');
    // the uploaded text has the contact details and exact dates; the improved resume may have dropped some
    const resumeText = original.length > 200 ? original : String(ats ? career.resumeText(ats.resume) : original);
    const out = await completeJson({ ...ai, meter: aiTokens.meter(db, c.id) }, {
      system: PROFILE_PROMPT, user: `RESUME:\n${resumeText.slice(0, 20000)}\n\nACCOUNT EMAIL: ${c.email}\nACCOUNT NAME: ${c.name || ''}`, maxTokens: 8000 });
    const profile = cleanProfile(out);
    if (!profile.personal.email) profile.personal.email = c.email;
    if (!profile.personal.fullName && c.name) profile.personal = cleanProfile({ personal: { ...profile.personal, fullName: c.name } }).personal;
    if (!profile.work.length && !profile.education.length) throw new ApiError(502, 'The AI could not read jobs or education from your resume this time. Please try again.', 'ai');
    const stamp = now();
    db.prepare(`INSERT INTO career_app_profiles (customer_id, profile_json, updated_at, confirmed_at) VALUES (?,?,?,NULL)
                ON CONFLICT (customer_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at, confirmed_at = NULL`).run(c.id, JSON.stringify(profile), stamp);
    career.countUse(db, c.id);
    return { ...present(one('SELECT * FROM career_app_profiles WHERE customer_id = ?', c.id)), usage: career.usage(db, c.id) };
  });

  // ---------- application tracker ----------
  const row = a => ({ id: a.id, title: a.title, company: a.company, url: a.url, status: a.status, jobId: a.job_id, searchId: a.search_id, createdAt: a.created_at, updatedAt: a.updated_at });
  add('GET', '/api/career/applications', { public: true }, req => {
    const c = me(req);
    return { applications: all('SELECT * FROM career_applications WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 500', c.id).map(row) };
  });
  // mark a job as applied (or move it along): one row per job link
  add('POST', '/api/career/applications', { public: true }, (req, res, { body }) => {
    const c = me(req);
    const url = text(body.url, 600, { required: true, field: 'Job link' });
    if (!/^https:\/\//i.test(url)) throw new ApiError(400, 'The job link must start with https://');
    const status = STATUSES.includes(body.status) ? body.status : 'applied';
    const stamp = now();
    db.prepare(`INSERT INTO career_applications (customer_id, search_id, job_id, title, company, url, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT (customer_id, url) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
      .run(c.id, Math.round(Number(body.searchId)) || null, Math.round(Number(body.jobId)) || null, text(body.title, 200, { field: 'Title' }), text(body.company, 150, { field: 'Company' }), url, status, stamp, stamp);
    return { application: row(one('SELECT * FROM career_applications WHERE customer_id = ? AND url = ?', c.id, url)) };
  });
  add('POST', '/api/career/applications/:id/delete', { public: true }, (req, res, { params }) => {
    const c = me(req);
    db.prepare('DELETE FROM career_applications WHERE id = ? AND customer_id = ?').run(params.id, c.id);
    return { ok: true };
  });
}

module.exports = { addRoutes, cleanProfile, problems, PROFILE_PROMPT, STATUSES };
