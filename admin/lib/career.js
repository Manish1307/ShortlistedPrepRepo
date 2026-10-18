'use strict';
// Career toolkit (website: My account → Career toolkit), for signed-in customers:
//   1. upload a resume (text; a PDF is read into text first)
//   2. ATS check: a score, checks, keywords, and an improved ATS-friendly version
//   3. role-based resumes: one version per target role (".NET Developer", "Scrum Master", ...)
//   4. job match: paste a job description → match score, missing keywords, tips and a cover letter
// Everything can be downloaded as a plain Word file. The AI never invents experience: it only reorganises and
// rewrites what the resume says, and marks places where a number would help with "[add number]".

const { ApiError, text } = require('./http');
const { now } = require('./db');
const { signedInCustomer } = require('./accounts');
const profiles = require('./profiles');
const { completeJson } = require('./careerai');
const { buildDocx, resumeParagraphs, letterParagraphs } = require('./docx');
const { logActivity } = require('./activity');
const tokens = require('./tokens');

const MAX_RESUME = 20000;
const MAX_JD = 12000;
const MAX_VERSIONS = 8;
const MAX_MATCHES = 50;

const RESUME_SHAPE = `{
  "name": "", "headline": "short professional title",
  "contact": { "email": "", "phone": "", "location": "", "linkedin": "" },
  "summary": "3-4 sentences",
  "skills": [ { "group": "e.g. Languages", "items": ["..."] } ],
  "experience": [ { "title": "", "company": "", "location": "", "start": "", "end": "", "bullets": ["..."] } ],
  "projects": [ { "name": "", "bullets": ["..."] } ],
  "education": [ { "degree": "", "institution": "", "year": "" } ],
  "certifications": ["..."]
}`;

const HONESTY = `Never invent employers, job titles, dates, degrees, certifications, tools, skills or numbers: keep every fact from the
original and add nothing that is not supported by it. Rewrite bullets with strong action verbs and outcomes; where a number would
make a bullet stronger but the original has none, write "[add number]" so the candidate can fill it in. Use plain text only (no
tables, icons, emojis or columns) and standard section headings. Keep the candidate's own contact details exactly.`;

const ATS_PROMPT = `You are an expert resume writer and ATS (applicant tracking system) reviewer for IT professionals.
Review the resume, then write an improved, ATS-friendly version of it. ${HONESTY}
Reply with ONLY a JSON object:
{
  "score": integer 0-100 (how ATS-friendly and effective the ORIGINAL resume is),
  "verdict": "one sentence",
  "checks": [ { "name": "", "status": "pass" | "warn" | "fail", "detail": "one sentence" } ],
  "keywords": { "present": ["..."], "missing": ["important keywords for the roles this candidate fits that are missing; only ones they plausibly have"] },
  "fixes": ["what you changed in the improved version, one line each"],
  "suggestedRoles": ["3-6 job titles this resume fits"],
  "resume": ${RESUME_SHAPE}
}
Give 8-12 checks covering: contact details, standard section headings, simple formatting (no tables/columns/graphics),
keyword coverage, quantified achievements, action verbs, dates and order, length, spelling and grammar, summary quality.`;

const ROLE_PROMPT = `You are an expert resume writer for IT professionals. Create a version of the candidate's resume targeted at ONE role.
Put the most relevant experience, projects and skills first; rewrite the headline and summary for the role; keep less relevant
items short. ${HONESTY}
Reply with ONLY a JSON object:
{
  "role": "the target role",
  "fitScore": integer 0-100 (how well the candidate's real experience supports this role),
  "fitNote": "one or two sentences: strengths for this role, and any gap the candidate should know about",
  "resume": ${RESUME_SHAPE}
}`;

const MATCH_PROMPT = `You are an expert IT recruiter. Compare the candidate's resume with the job description.
Reply with ONLY a JSON object:
{
  "score": integer 0-100 (how well the resume matches the job),
  "verdict": "one sentence",
  "matched": ["skills and keywords from the job that the resume shows"],
  "missing": ["skills and keywords from the job that the resume does not show"],
  "suggestions": ["specific, honest changes to the resume for this job, one line each (only what the candidate really has)"],
  "bestVersionId": the id of the best of the candidate's resume versions listed below, or null,
  "coverLetter": "a cover letter of 180-260 words; paragraphs separated by a blank line; starts with 'Dear Hiring Manager,' (or the named person) and ends with the candidate's name"
}
The cover letter must only use facts from the resume, sound natural and confident, and mention the company and role when given.`;

/** A structured resume from the AI, cleaned (strings, lists) so it is safe to store and render. */
function cleanResume(r) {
  const s = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);
  const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  r = r && typeof r === 'object' ? r : {};
  const c = r.contact && typeof r.contact === 'object' ? r.contact : {};
  return {
    name: s(r.name, 120), headline: s(r.headline, 160),
    contact: { email: s(c.email, 160), phone: s(c.phone, 60), location: s(c.location, 120), linkedin: s(c.linkedin, 200) },
    summary: s(r.summary, 1500),
    skills: arr(r.skills, 15).map(g => ({ group: s(g && g.group, 60), items: arr(g && g.items, 40).map(i => s(i, 80)).filter(Boolean) })).filter(g => g.items.length),
    experience: arr(r.experience, 20).map(e => ({ title: s(e && e.title, 120), company: s(e && e.company, 120), location: s(e && e.location, 120),
      start: s(e && e.start, 40), end: s(e && e.end, 40), bullets: arr(e && e.bullets, 12).map(b => s(b, 400)).filter(Boolean) })),
    projects: arr(r.projects, 12).map(p => ({ name: s(p && p.name, 160), bullets: arr(p && p.bullets, 8).map(b => s(b, 400)).filter(Boolean) })),
    education: arr(r.education, 8).map(e => ({ degree: s(e && e.degree, 160), institution: s(e && e.institution, 160), year: s(e && e.year, 20) })),
    certifications: arr(r.certifications, 20).map(x => s(x, 200)).filter(Boolean),
  };
}

/** A structured resume as plain text (for the AI and for "copy as text"). */
function resumeText(r) {
  return resumeParagraphs(r).map(p => (p.kind === 'heading' ? '\n' + p.text.toUpperCase() : p.kind === 'bullet' ? '- ' + p.text : p.text)).join('\n').trim();
}

const score = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const strList = (v, max, len = 200) => (Array.isArray(v) ? v.slice(0, max).map(x => String(x).trim().slice(0, len)).filter(Boolean) : []);
const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
const fileSafe = s => String(s || 'resume').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'resume';

// ---- AI use per customer: the daily AI tokens (tokens.js) are the limit; actions are counted for the dashboard ----
const today = () => now().slice(0, 10);
const usedToday = (db, id) => (db.prepare('SELECT count FROM career_usage WHERE customer_id = ? AND day = ?').get(id, today()) || { count: 0 }).count;
const quota = {
  checkQuota(db, id) { tokens.check(db, id); },
  countUse(db, id) {
    db.prepare(`INSERT INTO career_usage (customer_id, day, count) VALUES (?,?,1)
                ON CONFLICT (customer_id, day) DO UPDATE SET count = count + 1`).run(id, today());
  },
  usage(db, id) { return { used: usedToday(db, id), tokens: tokens.status(db, id) }; },
};

function addRoutes(ctx) {
  const { db, add, one, all } = ctx;
  const ai = { db, vault: ctx.vault, upstream: ctx.upstream };
  const me = req => signedInCustomer(db, req).customer;
  const aiFor = customerId => ({ ...ai, meter: tokens.meter(db, customerId) });   // counts the tokens against the customer

  // ---- daily AI limit per customer (shared with Find jobs, jobs.js) ----
  const checkQuota = id => quota.checkQuota(db, id);
  const countUse = id => quota.countUse(db, id);
  const usage = id => quota.usage(db, id);

  const resumeOf = id => one('SELECT * FROM career_resumes WHERE customer_id = ?', id);
  const requireResume = id => { const r = resumeOf(id); if (!r) throw new ApiError(400, 'Upload your resume first.', 'no-resume'); return r; };
  const versionsOf = id => all('SELECT id, role, content_json, created_at FROM career_versions WHERE customer_id = ? ORDER BY id DESC', id)
    .map(v => { const c = parse(v.content_json) || {}; return { id: v.id, role: v.role, fitScore: c.fitScore, fitNote: c.fitNote, resume: c.resume, createdAt: v.created_at }; });

  // ===== everything on the page =====
  add('GET', '/api/career', { public: true }, req => {
    const c = me(req);
    const r = resumeOf(c.id);
    return {
      resume: r ? { fileName: r.file_name, uploadedAt: r.uploaded_at, chars: r.source_text.length, ats: parse(r.ats_json), atsAt: r.ats_at } : null,
      versions: versionsOf(c.id),
      matches: all('SELECT id, job_title, company, version_id, result_json, created_at FROM career_matches WHERE customer_id = ? ORDER BY id DESC LIMIT 20', c.id)
        .map(m => ({ id: m.id, jobTitle: m.job_title, company: m.company, versionId: m.version_id, result: parse(m.result_json), createdAt: m.created_at })),
      usage: usage(c.id),
    };
  });

  // ===== 1. the resume =====
  add('POST', '/api/career/resume', { public: true, maxBody: 300 * 1024 }, (req, res, { body }) => {
    const c = me(req);
    const source = text(body.text, MAX_RESUME, { required: true, field: 'Resume text' });
    if (source.length < 200) throw new ApiError(400, 'That looks too short for a resume. Upload the full file or paste all of it.');
    db.prepare(`INSERT INTO career_resumes (customer_id, file_name, source_text, ats_json, ats_at, uploaded_at) VALUES (?,?,?,NULL,NULL,?)
                ON CONFLICT (customer_id) DO UPDATE SET file_name = excluded.file_name, source_text = excluded.source_text, ats_json = NULL, ats_at = NULL, uploaded_at = excluded.uploaded_at`)
      .run(c.id, text(body.fileName, 200, { field: 'File name' }), source, now());
    logActivity(db, c.id, 'resume.uploaded', `${text(body.fileName, 200, { field: 'File name' }) || 'Pasted resume'} · ${source.length.toLocaleString('en-IN')} characters`);
    return { ok: true };
  });

  // a resume PDF -> its text (read by Gemini); counts as one AI action
  add('POST', '/api/career/pdf-text', { public: true, maxBody: 8 * 1024 * 1024 }, async (req, res, { body }) => {
    const c = me(req);
    checkQuota(c.id);
    const data = String(body.data || '').replace(/\s+/g, '');
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new ApiError(400, 'Choose a PDF file');
    if (data.length * 0.75 > 6 * 1024 * 1024) throw new ApiError(400, 'The PDF is larger than 6 MB');
    const out = await profiles.readPdf({ db, vault: ctx.vault, data, upstream: (ctx.upstream && ctx.upstream.gemini) || undefined, meter: tokens.meter(db, c.id) });
    countUse(c.id);
    logActivity(db, c.id, 'resume.pdf_read', 'PDF read by the AI');
    return { text: out.slice(0, MAX_RESUME) };
  });

  // ===== 2. ATS check and improved version =====
  add('POST', '/api/career/ats', { public: true }, async req => {
    const c = me(req);
    const r = requireResume(c.id);
    checkQuota(c.id);
    const out = await completeJson(aiFor(c.id), { system: ATS_PROMPT, user: 'RESUME:\n' + r.source_text, maxTokens: 8000 });
    const result = {
      score: score(out.score), verdict: String(out.verdict || '').slice(0, 300),
      checks: (Array.isArray(out.checks) ? out.checks.slice(0, 14) : []).map(k => ({
        name: String((k && k.name) || '').slice(0, 80), status: ['pass', 'warn', 'fail'].includes(k && k.status) ? k.status : 'warn',
        detail: String((k && k.detail) || '').slice(0, 300) })).filter(k => k.name),
      keywords: { present: strList(out.keywords && out.keywords.present, 40, 60), missing: strList(out.keywords && out.keywords.missing, 30, 60) },
      fixes: strList(out.fixes, 15, 300),
      suggestedRoles: strList(out.suggestedRoles, 8, 80),
      resume: cleanResume(out.resume),
    };
    db.prepare('UPDATE career_resumes SET ats_json = ?, ats_at = ? WHERE customer_id = ?').run(JSON.stringify(result), now(), c.id);
    countUse(c.id);
    logActivity(db, c.id, 'ats.checked', `ATS score ${result.score}`);
    return { ats: result, usage: usage(c.id) };
  });

  // ===== 3. role-based resumes =====
  add('POST', '/api/career/versions', { public: true }, async (req, res, { body }) => {
    const c = me(req);
    const r = requireResume(c.id);
    const role = text(body.role, 80, { required: true, field: 'Role' });
    if (one('SELECT COUNT(*) AS n FROM career_versions WHERE customer_id = ?', c.id).n >= MAX_VERSIONS) {
      throw new ApiError(400, `You can keep up to ${MAX_VERSIONS} role-based resumes. Delete one to make another.`);
    }
    checkQuota(c.id);
    const ats = parse(r.ats_json);
    const base = ats && ats.resume ? resumeText(ats.resume) : r.source_text;   // start from the improved version when there is one
    const out = await completeJson(aiFor(c.id), { system: ROLE_PROMPT, user: `TARGET ROLE: ${role}\n\nRESUME:\n${base}`, maxTokens: 8000 });
    const content = { fitScore: score(out.fitScore), fitNote: String(out.fitNote || '').slice(0, 500), resume: cleanResume(out.resume) };
    const id = Number(db.prepare('INSERT INTO career_versions (customer_id, role, content_json, created_at) VALUES (?,?,?,?)')
      .run(c.id, role, JSON.stringify(content), now()).lastInsertRowid);
    countUse(c.id);
    logActivity(db, c.id, 'version.created', `${role} · fit ${content.fitScore}`);
    return { status: 201, body: { version: versionsOf(c.id).find(v => v.id === id), usage: usage(c.id) } };
  });

  add('POST', '/api/career/versions/:id/delete', { public: true }, (req, res, { params }) => {
    const c = me(req);
    const v = one('SELECT role FROM career_versions WHERE id = ? AND customer_id = ?', params.id, c.id);
    const r = db.prepare('DELETE FROM career_versions WHERE id = ? AND customer_id = ?').run(params.id, c.id);
    if (!r.changes) throw new ApiError(404, 'Resume version not found');
    logActivity(db, c.id, 'version.deleted', v ? v.role : '');
    return { ok: true };
  });

  // ===== 4. job match and cover letter =====
  add('POST', '/api/career/match', { public: true, maxBody: 100 * 1024 }, async (req, res, { body }) => {
    const c = me(req);
    const r = requireResume(c.id);
    const jd = text(body.jd, MAX_JD, { required: true, field: 'Job description' });
    if (jd.length < 80) throw new ApiError(400, 'Paste the full job description (it looks too short).');
    const jobTitle = text(body.jobTitle, 120, { field: 'Job title' });
    const company = text(body.company, 120, { field: 'Company' });
    checkQuota(c.id);
    const versions = versionsOf(c.id);
    const chosen = body.versionId ? versions.find(v => v.id === Number(body.versionId)) : null;
    if (body.versionId && !chosen) throw new ApiError(404, 'Resume version not found');
    const ats = parse(r.ats_json);
    const resume = chosen ? resumeText(chosen.resume) : ats && ats.resume ? resumeText(ats.resume) : r.source_text;
    const user = [`JOB TITLE: ${jobTitle || '(not given)'}`, `COMPANY: ${company || '(not given)'}`, '', 'JOB DESCRIPTION:', jd, '',
      'CANDIDATE RESUME:', resume, '', 'CANDIDATE RESUME VERSIONS (id: role):',
      versions.length ? versions.map(v => `${v.id}: ${v.role}`).join('\n') : '(none)'].join('\n');
    const out = await completeJson(aiFor(c.id), { system: MATCH_PROMPT, user, maxTokens: 4000 });
    const best = chosen ? chosen.id : versions.some(v => v.id === Number(out.bestVersionId)) ? Number(out.bestVersionId) : null;
    const result = {
      score: score(out.score), verdict: String(out.verdict || '').slice(0, 300),
      matched: strList(out.matched, 30, 60), missing: strList(out.missing, 30, 60), suggestions: strList(out.suggestions, 10, 300),
      bestVersionId: best, coverLetter: String(out.coverLetter || '').trim().slice(0, 4000),
    };
    if (one('SELECT COUNT(*) AS n FROM career_matches WHERE customer_id = ?', c.id).n >= MAX_MATCHES) {
      db.prepare('DELETE FROM career_matches WHERE id = (SELECT MIN(id) FROM career_matches WHERE customer_id = ?)').run(c.id);   // keep the newest 50
    }
    const id = Number(db.prepare('INSERT INTO career_matches (customer_id, job_title, company, jd_text, version_id, result_json, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(c.id, jobTitle, company, jd, best, JSON.stringify(result), now()).lastInsertRowid);
    countUse(c.id);
    logActivity(db, c.id, 'match.created', `${[jobTitle, company].filter(Boolean).join(' at ') || 'Job'} · score ${result.score}${result.coverLetter ? ' · cover letter' : ''}`);
    return { status: 201, body: { match: { id, jobTitle, company, versionId: best, result, createdAt: now() }, usage: usage(c.id) } };
  });

  add('POST', '/api/career/matches/:id/delete', { public: true }, (req, res, { params }) => {
    const c = me(req);
    const m = one('SELECT job_title, company FROM career_matches WHERE id = ? AND customer_id = ?', params.id, c.id);
    const r = db.prepare('DELETE FROM career_matches WHERE id = ? AND customer_id = ?').run(params.id, c.id);
    if (!r.changes) throw new ApiError(404, 'Job match not found');
    logActivity(db, c.id, 'match.deleted', m ? [m.job_title, m.company].filter(Boolean).join(' at ') : '');
    return { ok: true };
  });

  // ===== downloads: the improved resume, a role version, or a cover letter, as a Word file =====
  add('GET', '/api/career/download', { public: true }, (req, res, { query }) => {
    const c = me(req);
    const doc = careerDocument(db, c.id, query.get('kind'), Number(query.get('id')));
    logActivity(db, c.id, 'download', doc.label);
    sendDocument(res, doc, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition' });
  });
}

/**
 * One of a customer's documents, ready to send: {name, label, type, body}. kind: "ats" (the improved resume),
 * "version" (a role resume, id), "letter" (a cover letter, id) as Word files, or "original" (the uploaded text).
 */
function careerDocument(db, customerId, kind, id) {
  const resume = db.prepare('SELECT file_name, source_text, ats_json FROM career_resumes WHERE customer_id = ?').get(customerId);
  const docx = (paragraphs, name, label) => ({ name: fileSafe(name) + '.docx', label, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: buildDocx(paragraphs) });
  if (kind === 'original') {
    if (!resume) throw new ApiError(404, 'No resume uploaded');
    return { name: fileSafe(String(resume.file_name || 'resume').replace(/\.\w+$/, '')) + '.txt', label: 'Uploaded resume (text)', type: 'text/plain; charset=utf-8', body: Buffer.from(resume.source_text, 'utf8') };
  }
  if (kind === 'ats') {
    const ats = parse((resume || {}).ats_json);
    if (!ats) throw new ApiError(404, 'Run the ATS check first');
    return docx(resumeParagraphs(ats.resume), `${ats.resume.name || 'resume'}-ATS`, 'ATS-friendly resume');
  }
  if (kind === 'version') {
    const v = db.prepare('SELECT role, content_json FROM career_versions WHERE id = ? AND customer_id = ?').get(id, customerId);
    const c = v && parse(v.content_json);
    if (!c) throw new ApiError(404, 'Resume version not found');
    return docx(resumeParagraphs(c.resume), `${c.resume.name || 'resume'}-${v.role}`, `Role resume: ${v.role}`);
  }
  if (kind === 'letter') {
    const m = db.prepare('SELECT company, job_title, result_json FROM career_matches WHERE id = ? AND customer_id = ?').get(id, customerId);
    const result = m && parse(m.result_json);
    if (!result || !result.coverLetter) throw new ApiError(404, 'Cover letter not found');
    return docx(letterParagraphs(result.coverLetter), `Cover-letter-${m.company || m.job_title || 'job'}`, `Cover letter: ${[m.job_title, m.company].filter(Boolean).join(' at ') || 'job'}`);
  }
  throw new ApiError(400, 'Unknown document');
}

function sendDocument(res, doc, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': doc.type,
    'Content-Disposition': `attachment; filename="${doc.name}"`,
    'Content-Length': doc.body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(doc.body);
}

module.exports = { addRoutes, cleanResume, resumeText, careerDocument, sendDocument, checkQuota: quota.checkQuota, countUse: quota.countUse, usage: quota.usage, MAX_RESUME };
