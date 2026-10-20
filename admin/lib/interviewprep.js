'use strict';
// Interview prep (Virtual Interview app + My account): personalised practice questions made ONLY from the candidate's
// own resume: questions about their projects, skills and achievements, and scenario questions about the situations their
// roles would meet, each with a model answer to explore. The desktop app reaches it with its licence token (the licence
// decides which customer, and the customer's resumes come from the Career toolkit or the dashboard); the website shows the
// same sets under My account → Interview prep, and the dashboard shows them on the customer.

const { ApiError } = require('./http');
const { now } = require('./db');
const { signedInCustomer } = require('./accounts');
const { completeJson } = require('./careerai');
const licences = require('./licence');
const profiles = require('./profiles');
const aiTokens = require('./tokens');
const intro = require('./introcoach');

const KEEP_SETS = 30;          // per customer
const PERSONAL = 10, SCENARIO = 5;

const PROMPT = `You are an experienced interviewer preparing ONE candidate for interviews, using only the candidate's RESUME.
Work in whatever field the resume is in (IT, science and research, engineering, healthcare, finance, sales, teaching or any other).

Write two kinds of practice questions:
1. "personalised": exactly ${PERSONAL} questions about things the resume itself states: its projects, tools, methods, results, responsibilities,
   career moves and gaps. Questions an interviewer reading this resume would really ask ("You wrote that ... how did you ...?").
2. "scenario": exactly ${SCENARIO} realistic work situations that this candidate's roles and skills would meet ("You are asked to ... what do you do?").

RULES:
- Base every question on the resume. Never ask about a tool, method or experience the resume does not mention, except that a scenario
  may be a situation a person with these roles would plausibly face.
- "resumeRef": the exact words from the resume (at most 15 words, copied character for character) that the question is about. "" for a scenario that has no single line.
- "answer": a model answer in the first person, 60 to 130 words, using ONLY experience, tools and results the resume shows. Never invent numbers,
  employers, projects or skills. When the resume gives no figure, say what you would measure instead of making one up.
- "points": 3 to 5 short points a strong answer covers.
- "topic": two or three words.
Reply with ONLY a JSON object:
{
  "personalised": [ { "question": "...", "topic": "...", "resumeRef": "...", "answer": "...", "points": ["..."] } ],
  "scenario": [ { "question": "...", "topic": "...", "resumeRef": "", "answer": "...", "points": ["..."] } ]
}`;

const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The AI's reply → [{kind, question, topic, resumeRef, answer, points}]; entries without a question and answer are dropped, a quote not in the resume is blanked. */
function cleanQuestions(out, resumeText) {
  const resume = ' ' + norm(resumeText) + ' ';
  const list = (v, kind, max) => (Array.isArray(v) ? v : []).map(q => {
    q = q || {};
    const question = s(q.question, 400), answer = s(q.answer, 1400);
    if (question.length < 10 || answer.length < 20) return null;
    const ref = s(q.resumeRef, 160);
    return {
      kind, question, answer, topic: s(q.topic, 60) || 'General',
      resumeRef: ref && resume.includes(' ' + norm(ref) + ' ') ? ref : '',
      points: (Array.isArray(q.points) ? q.points : []).map(p => s(p, 200)).filter(Boolean).slice(0, 5),
    };
  }).filter(Boolean).slice(0, max);
  return [...list(out && out.personalised, 'personal', PERSONAL), ...list(out && out.scenario, 'scenario', SCENARIO)];
}

function addRoutes(ctx) {
  const { db, add, one, all, tokens } = ctx;
  const ai = { db, vault: ctx.vault, upstream: ctx.upstream };
  const parse = v => { try { return JSON.parse(v); } catch (_) { return null; } };
  const career = require('./career');

  /** The customer's resumes: the Career toolkit's (improved or uploaded, and each role-based version) and the one support added in the dashboard. */
  function resumesOf(customerId) {
    const out = [];
    const r = one('SELECT * FROM career_resumes WHERE customer_id = ?', customerId);
    if (r) {
      const ats = parse(r.ats_json);
      const text = ats ? career.resumeText(ats.resume) : r.source_text;
      out.push({ key: 'main', label: ats ? 'My ATS-friendly resume' : 'My uploaded resume', text });
      for (const v of all('SELECT id, role, content_json FROM career_versions WHERE customer_id = ? ORDER BY id DESC', customerId)) {
        const c = parse(v.content_json);
        if (c && c.resume) out.push({ key: 'v' + v.id, label: 'Resume for ' + v.role, text: career.resumeText(c.resume) });
      }
    }
    const p = profiles.profileOf(db, customerId);
    if (p.resume && p.resume.trim().length > 100) out.push({ key: 'profile', label: p.resumeName ? 'Resume on file: ' + p.resumeName : 'Resume on file', text: p.resume });
    return out;
  }
  const publicResumes = customerId => resumesOf(customerId).map(r => ({ key: r.key, label: r.label, chars: r.text.length }));

  /** One personalised set from one resume: one AI action, saved for the account and the dashboard. */
  async function generate(customerId, licenceId, { resumeKey, role, source }) {
    career.checkQuota(db, customerId);
    const resumes = resumesOf(customerId);
    if (!resumes.length) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1) so the questions can come from it.', 'no-resume');
    const resume = resumes.find(r => r.key === resumeKey) || resumes[0];
    if (resume.text.trim().length < 150) throw new ApiError(400, 'This resume is too short to make questions from.', 'no-resume');
    const target = s(role, 120);
    const out = await completeJson({ ...ai, meter: aiTokens.meter(db, customerId) }, {
      system: PROMPT,
      user: `${target ? `TARGET ROLE: ${target}\n\n` : ''}RESUME (${resume.label}):\n${resume.text.slice(0, 20000)}`,
      maxTokens: 9000,
    });
    const questions = cleanQuestions(out, resume.text);
    if (questions.length < 8) throw new ApiError(502, 'The AI could not write questions from this resume this time. Please try again.', 'ai');
    const r = db.prepare(`INSERT INTO interview_sets (customer_id, licence_id, resume_key, resume_label, role, source, questions_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(customerId, licenceId || null, resume.key, resume.label, target, source, JSON.stringify(questions), now());
    db.prepare(`DELETE FROM interview_sets WHERE customer_id = ? AND id NOT IN (SELECT id FROM interview_sets WHERE customer_id = ? ORDER BY id DESC LIMIT ${KEEP_SETS})`).run(customerId, customerId);
    career.countUse(db, customerId);
    return present(one('SELECT * FROM interview_sets WHERE id = ?', r.lastInsertRowid));
  }
  const present = row => ({ id: row.id, resumeKey: row.resume_key, resumeLabel: row.resume_label, role: row.role, source: row.source, createdAt: row.created_at, questions: parse(row.questions_json) || [] });
  const setsOf = customerId => all('SELECT * FROM interview_sets WHERE customer_id = ? ORDER BY id DESC LIMIT 30', customerId).map(present);

  // ===== "Tell me about yourself": a guide of personalised bullet points, and a review of the candidate's own answer =====
  const KEEP_INTROS = 40;
  const presentIntro = row => ({
    id: row.id, kind: row.answer ? 'attempt' : 'guide', resumeKey: row.resume_key, resumeLabel: row.resume_label, role: row.role, company: row.company, source: row.source,
    createdAt: row.created_at, guide: parse(row.guide_json), answer: row.answer, seconds: row.seconds, review: parse(row.review_json),
  });
  const introsOf = customerId => all('SELECT * FROM interview_intros WHERE customer_id = ? ORDER BY id DESC LIMIT 40', customerId).map(presentIntro);

  /** What the AI may use besides the resume: the topics support set for this candidate, and the roles the ATS check suggested. */
  function contextFor(customerId, resume, { role, company }) {
    const p = profiles.profileOf(db, customerId);
    const ats = parse((one('SELECT ats_json FROM career_resumes WHERE customer_id = ?', customerId) || {}).ats_json) || {};
    const c = one('SELECT name FROM customers WHERE id = ?', customerId) || {};
    return [
      c.name ? `CANDIDATE: ${c.name}` : '',
      role ? `TARGET ROLE: ${s(role, 120)}` : (Array.isArray(ats.suggestedRoles) && ats.suggestedRoles.length ? `LIKELY ROLES (from the ATS check): ${ats.suggestedRoles.slice(0, 4).join(', ')}` : ''),
      company ? `COMPANY: ${s(company, 100)}` : '',
      p.topics && p.topics.length ? `FOCUS TOPICS (set by support): ${p.topics.join(', ')}` : '',
      `RESUME (${resume.label}):\n${resume.text.slice(0, 20000)}`,
    ].filter(Boolean).join('\n');
  }
  function pickResume(customerId, key) {
    const resumes = resumesOf(customerId);
    if (!resumes.length) throw new ApiError(400, 'Upload your resume first (Career toolkit, step 1), so your introduction can be checked against it.', 'no-resume');
    const resume = resumes.find(r => r.key === key) || resumes[0];
    if (resume.text.trim().length < 150) throw new ApiError(400, 'This resume is too short to build an introduction from.', 'no-resume');
    return resume;
  }
  const trimIntros = customerId => db.prepare(`DELETE FROM interview_intros WHERE customer_id = ? AND id NOT IN (SELECT id FROM interview_intros WHERE customer_id = ? ORDER BY id DESC LIMIT ${KEEP_INTROS})`).run(customerId, customerId);

  /** The guide for one resume, role and company: bullet points and a script. Made once and kept; "refresh" makes a new one. */
  async function introGuide(customerId, licenceId, { resumeKey, role, company, source, refresh }) {
    const resume = pickResume(customerId, resumeKey);
    const r = s(role, 120), co = s(company, 100);
    if (!refresh) {
      const old = one(`SELECT * FROM interview_intros WHERE customer_id = ? AND resume_key = ? AND role = ? AND company = ? AND guide_json IS NOT NULL AND answer = '' ORDER BY id DESC LIMIT 1`, customerId, resume.key, r, co);
      if (old) return presentIntro(old);
    }
    career.checkQuota(db, customerId);
    const out = await completeJson({ ...ai, meter: aiTokens.meter(db, customerId) }, { system: intro.GUIDE_PROMPT, user: contextFor(customerId, resume, { role: r, company: co }), maxTokens: 5000 });
    const guide = intro.cleanGuide(out, resume.text);
    if (!guide) throw new ApiError(502, 'The AI could not write your introduction guide this time. Please try again.', 'ai');
    const row = db.prepare('INSERT INTO interview_intros (customer_id, licence_id, resume_key, resume_label, role, company, source, guide_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(customerId, licenceId || null, resume.key, resume.label, r, co, source, JSON.stringify(guide), now());
    trimIntros(customerId);
    career.countUse(db, customerId);
    return presentIntro(one('SELECT * FROM interview_intros WHERE id = ?', row.lastInsertRowid));
  }

  /** The review of one answer to "Tell me about yourself", checked against the resume. */
  async function introReview(customerId, licenceId, { resumeKey, role, company, answer, seconds, source }) {
    const said = String(answer || '').replace(/\r/g, '').trim().slice(0, 6000);
    if (said.split(/\s+/).filter(Boolean).length < 15) throw new ApiError(400, 'Say or type a little more first: an introduction is about 150 words.', 'short');
    const resume = pickResume(customerId, resumeKey);
    const r = s(role, 120), co = s(company, 100);
    career.checkQuota(db, customerId);
    const out = await completeJson({ ...ai, meter: aiTokens.meter(db, customerId) }, {
      system: intro.REVIEW_PROMPT, user: `${contextFor(customerId, resume, { role: r, company: co })}\n\nCANDIDATE'S ANSWER (${Math.round(Number(seconds) || 0)} seconds):\n${said}`, maxTokens: 8000 });
    const review = intro.cleanReview(out, resume.text, said, seconds);
    if (!review) throw new ApiError(502, 'The AI could not review this answer this time. Please try again.', 'ai');
    const guideRow = one(`SELECT guide_json FROM interview_intros WHERE customer_id = ? AND resume_key = ? AND role = ? AND company = ? AND guide_json IS NOT NULL AND answer = '' ORDER BY id DESC LIMIT 1`, customerId, resume.key, r, co);
    const row = db.prepare('INSERT INTO interview_intros (customer_id, licence_id, resume_key, resume_label, role, company, source, guide_json, answer, seconds, review_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(customerId, licenceId || null, resume.key, resume.label, r, co, source, guideRow ? guideRow.guide_json : null, said, Math.max(0, Math.round(Number(seconds) || 0)), JSON.stringify(review), now());
    trimIntros(customerId);
    career.countUse(db, customerId);
    return presentIntro(one('SELECT * FROM interview_intros WHERE id = ?', row.lastInsertRowid));
  }

  // ===== the desktop app: licence token (the same one the AI proxy and conversations use) =====
  function authorise(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    const t = m && tokens && tokens.verify(m[1]);
    if (!t) throw new ApiError(401, 'Access has expired. The app will renew it.', 'token');
    const lic = one('SELECT * FROM licences WHERE id = ?', t.licenceId);
    if (!lic || licences.effectiveStatus(lic) !== 'active') throw new ApiError(403, 'The licence is not active.', 'licence');
    if (!one('SELECT 1 FROM devices WHERE licence_id = ? AND device_id = ?', lic.id, t.deviceId)) throw new ApiError(403, 'This computer is not activated for the licence.', 'licence');
    return lic;
  }
  add('GET', '/api/app/interview/resumes', { public: true, before: authorise }, req => {
    const lic = authorise(req);
    return { resumes: publicResumes(lic.customer_id), sets: setsOf(lic.customer_id).slice(0, 10).map(x => ({ id: x.id, resumeLabel: x.resumeLabel, role: x.role, createdAt: x.createdAt, count: x.questions.length })) };
  });
  add('POST', '/api/app/interview/questions', { public: true, before: authorise }, async (req, res, { body }) => {
    const lic = authorise(req);
    return { set: await generate(lic.customer_id, lic.id, { resumeKey: String(body.resumeKey || ''), role: body.role, source: 'app' }) };
  });
  add('POST', '/api/app/interview/intro/guide', { public: true, before: authorise }, async (req, res, { body }) => {
    const lic = authorise(req);
    return { intro: await introGuide(lic.customer_id, lic.id, { resumeKey: String(body.resumeKey || ''), role: body.role, company: body.company, source: 'app', refresh: body.refresh === true }) };
  });
  add('POST', '/api/app/interview/intro/review', { public: true, before: authorise, maxBody: 64 * 1024 }, async (req, res, { body }) => {
    const lic = authorise(req);
    return { intro: await introReview(lic.customer_id, lic.id, { resumeKey: String(body.resumeKey || ''), role: body.role, company: body.company, answer: body.answer, seconds: body.seconds, source: 'app' }) };
  });
  add('GET', '/api/app/interview/sets/:id', { public: true, before: authorise }, (req, res, { params }) => {
    const lic = authorise(req);
    const row = one('SELECT * FROM interview_sets WHERE id = ? AND customer_id = ?', params.id, lic.customer_id);
    if (!row) throw new ApiError(404, 'Question set not found');
    return { set: present(row) };
  });

  // ===== the website: My account → Interview prep =====
  const me = req => signedInCustomer(db, req).customer;
  add('GET', '/api/account/interview', { public: true }, req => {
    const c = me(req);
    return { resumes: publicResumes(c.id), sets: setsOf(c.id), intros: introsOf(c.id) };
  });
  add('POST', '/api/account/interview/intro/guide', { public: true }, async (req, res, { body }) => {
    const c = me(req);
    return { intro: await introGuide(c.id, null, { resumeKey: String(body.resumeKey || ''), role: body.role, company: body.company, source: 'web', refresh: body.refresh === true }), usage: career.usage(db, c.id) };
  });
  add('POST', '/api/account/interview/intro/:id/delete', { public: true }, (req, res, { params }) => {
    const c = me(req);
    db.prepare('DELETE FROM interview_intros WHERE id = ? AND customer_id = ?').run(params.id, c.id);
    return { ok: true };
  });
  add('POST', '/api/account/interview', { public: true }, async (req, res, { body }) => {
    const c = me(req);
    return { set: await generate(c.id, null, { resumeKey: String(body.resumeKey || ''), role: body.role, source: 'web' }), usage: career.usage(db, c.id) };
  });
  add('POST', '/api/account/interview/:id/delete', { public: true }, (req, res, { params }) => {
    const c = me(req);
    db.prepare('DELETE FROM interview_sets WHERE id = ? AND customer_id = ?').run(params.id, c.id);
    return { ok: true };
  });

  // ===== the dashboard: the same sets, on the customer =====
  add('GET', '/admin/api/customers/:id/interview', { admin: true }, (req, res, { params }) => {
    if (!one('SELECT id FROM customers WHERE id = ?', params.id)) throw new ApiError(404, 'Customer not found');
    return { sets: setsOf(Number(params.id)), intros: introsOf(Number(params.id)), resumes: publicResumes(Number(params.id)) };
  });
}

module.exports = { addRoutes, cleanQuestions, PROMPT, PERSONAL, SCENARIO };
