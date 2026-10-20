'use strict';
// "Tell me about yourself" coach. Two jobs, both grounded in the candidate's own resume and profile:
//   1. a GUIDE: personalised bullet points to cover in the introduction, and a short script built only from resume facts;
//   2. a REVIEW of what the candidate actually said: every claim checked against the resume, a score, what to add, what to
//      trim, a more impressive version, and the bullet points again, tied to the resume.
// The AI does the judging; this file keeps it honest: a quote it gives as evidence must really be in the resume, numbers the
// candidate said that the resume does not contain are flagged here (not by the AI), and length and filler words are counted here.

const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const arr = v => (Array.isArray(v) ? v : []);
const list = (v, n, max) => arr(v).map(x => s(x, max)).filter(Boolean).slice(0, n);
const score = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0; };

const GUIDE_PROMPT = `You write a personalised INTRODUCTION GUIDE for one candidate: how to answer "Tell me about yourself" in an interview.
Work in whatever field the resume is in (IT, science and research, engineering, healthcare, finance, sales, teaching or any other).
Use ONLY the candidate's RESUME (and the target role, company and focus topics when given).

The best introduction is about 75 to 90 seconds and follows this order:
  1. Present: who you are now (role, years, area).
  2. Past: two or three achievements that matter for the target role, with results only when the resume gives them.
  3. Strengths: the skills and tools that fit the role.
  4. Why this role (and company, when given), and where you want to go.

RULES:
- Every bullet and every sentence must come from the resume. Never invent employers, projects, numbers, tools or skills.
  When the resume gives no figure, do not give one.
- "points": 6 to 8 personalised bullet points the candidate should cover, in speaking order. Each has a short "label"
  (Present, Past, Strength, Why this role, Next) and a "bullet" of one sentence they can say. "resumeRef" is the exact words
  from the resume (at most 15 words, copied character for character) the bullet comes from; "" only for the "Why this role" bullet.
- "script": a spoken introduction in the first person, 170 to 210 words, built from those bullets, plain and confident.
- "closing": one sentence that links their story to the target role.
- "tips": 3 short delivery tips for this candidate.
Reply with ONLY a JSON object:
{ "points": [ { "label": "Present", "bullet": "...", "resumeRef": "..." } ], "script": "...", "closing": "...", "tips": ["..."] }`;

const REVIEW_PROMPT = `You review a candidate's answer to "Tell me about yourself" for a mock interview, like a kind but exact interview coach.
You get the candidate's RESUME, their ANSWER (spoken and typed in by speech recognition, or typed), and the target role, company and focus topics when given.
Work in whatever field the resume is in.

DO THIS:
1. CHECK EVERY FACT. List each factual claim in the answer (jobs, years, tools, results, numbers, education, certificates) as a "claims" entry
   and compare it with the RESUME: "supported" (the resume shows it), "partly" (close, or only some of it), or "not_in_resume" (the resume does not show it).
   "evidence" is the exact words from the resume (at most 15 words, copied character for character), or "" when there is none.
   Never mark something supported without evidence.
2. SCORE 0 to 10: "structure" (present, past, why this role, next), "relevance" (to the target role), "impact" (results and proof, not duties),
   "authenticity" (matches the resume, no exaggeration), "delivery" (length about 75 to 90 seconds, clear, no rambling). "score" is the overall score. Be fair.
3. "strengths": what worked (up to 4). "trim": what to cut or shorten (up to 4). "improvements": specific changes, in order of importance (up to 6).
4. "missing": up to 5 strong things the RESUME shows that would impress an interviewer for this role and that the answer left out:
   each has "point", "why" and "resumeRef" (exact resume words, at most 15 words).
5. "impressive": a better version of THEIR answer in the first person, 170 to 210 words, using ONLY facts from the resume, keeping their own wording where it was good,
   fixing the structure, and adding the strongest missing points. Do not add anything the resume does not show, and drop claims marked not_in_resume.
6. "points": 6 to 8 personalised bullet points they should cover next time, in speaking order, each with "label", "bullet" and "resumeRef" (as in a guide).
7. "followUps": 3 questions an interviewer would likely ask next, based on what they said.
RULES: never invent facts; be specific and encouraging; talk to the candidate as "you".
Reply with ONLY a JSON object:
{ "score": 0-10, "verdict": "one sentence",
  "scores": { "structure": 0-10, "relevance": 0-10, "impact": 0-10, "authenticity": 0-10, "delivery": 0-10 },
  "claims": [ { "claim": "...", "status": "supported" | "partly" | "not_in_resume", "evidence": "...", "note": "..." } ],
  "strengths": ["..."], "trim": ["..."], "improvements": ["..."],
  "missing": [ { "point": "...", "why": "...", "resumeRef": "..." } ],
  "impressive": "...", "points": [ { "label": "...", "bullet": "...", "resumeRef": "..." } ], "followUps": ["..."] }`;

/** A quote the AI gives as evidence only counts when its words really are in the resume. */
function quoteIn(resumeText, quote) {
  const q = norm(quote);
  return q.length >= 4 && (' ' + norm(resumeText) + ' ').includes(' ' + q + ' ') ? s(quote, 160) : '';
}

function cleanPoints(v, resumeText) {
  return arr(v).map(p => {
    p = p || {};
    const bullet = s(p.bullet, 260);
    if (bullet.length < 8) return null;
    return { label: s(p.label, 30) || 'Point', bullet, resumeRef: quoteIn(resumeText, p.resumeRef) };
  }).filter(Boolean).slice(0, 9);
}

/** The AI's guide → {points, script, closing, tips}; null when it is unusable. */
function cleanGuide(out, resumeText) {
  const points = cleanPoints(out && out.points, resumeText);
  const script = String((out && out.script) || '').replace(/\r/g, '').trim().slice(0, 2200);
  if (points.length < 4 || script.length < 80) return null;
  return { points, script, closing: s(out.closing, 280), tips: list(out.tips, 4, 200) };
}

const STATUSES = ['supported', 'partly', 'not_in_resume'];

// ---- things this file measures itself ----
const FILLER = /\b(um+|uh+|erm|you know|i mean|basically|actually|sort of|kind of)\b/gi;
const words = text => (String(text || '').match(/[A-Za-z0-9'’-]+/g) || []);

function metricsOf(answer, seconds) {
  const w = words(answer).length;
  const spoken = Math.max(0, Math.round(Number(seconds) || 0));
  const est = Math.round(w / 2.4);   // about 145 words a minute
  const fillers = (String(answer || '').match(FILLER) || []).length;
  const shown = spoken >= 10 ? spoken : est;
  return {
    words: w, seconds: spoken, estSeconds: est, fillers,
    length: shown < 40 ? 'short' : shown <= 110 ? 'good' : 'long',
    note: shown < 40 ? 'Too short: about ' + shown + ' seconds. Aim for 60 to 90.' : shown <= 110 ? 'A good length: about ' + shown + ' seconds.' : 'Long: about ' + shown + ' seconds. Aim for 60 to 90.',
  };
}

/** Numbers the candidate said that do not appear in the resume (a years-of-experience figure, a percentage, an amount…). */
function numberFlags(answer, resumeText) {
  const inResume = new Set((String(resumeText || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => n.replace(/,/g, '')));
  const out = [], seen = new Set();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(%|percent|years?|yrs?|months?|lakhs?|crores?|k\b|m\b|million|\+)?/gi;
  let m;
  while ((m = re.exec(String(answer || '')))) {
    const n = m[1].replace(/,/g, '');
    if (inResume.has(n) || seen.has(n)) continue;
    if (/^(19|20)\d\d$/.test(n)) continue;                      // a year: the dates are checked as claims
    seen.add(n);
    const text = (m[1] + (m[2] ? (/^[%+]$/.test(m[2]) ? m[2] : ' ' + m[2]) : '')).trim();
    out.push({ text, note: 'The resume does not show this number. Say it only if it is true, or add it to your resume.' });
  }
  return out.slice(0, 8);
}

/** The AI's review → the review that is stored and shown, with our own checks added. */
function cleanReview(out, resumeText, answer, seconds) {
  if (!out || typeof out !== 'object') return null;
  const impressive = String(out.impressive || '').replace(/\r/g, '').trim().slice(0, 2400);
  const claims = arr(out.claims).map(c => {
    c = c || {};
    const claim = s(c.claim, 240);
    if (!claim) return null;
    let status = STATUSES.includes(c.status) ? c.status : 'partly';
    const evidence = quoteIn(resumeText, c.evidence);
    let note = s(c.note, 240);
    if (status === 'supported' && !evidence) { status = 'partly'; note = (note ? note + ' ' : '') + 'We could not find the matching words in your resume.'; }
    return { claim, status, evidence, note };
  }).filter(Boolean).slice(0, 14);
  if (!claims.length && !impressive) return null;
  const sc = out.scores || {};
  const scores = { structure: score(sc.structure), relevance: score(sc.relevance), impact: score(sc.impact), authenticity: score(sc.authenticity), delivery: score(sc.delivery) };
  const flags = numberFlags(answer, resumeText);
  const count = st => claims.filter(c => c.status === st).length;
  return {
    score: score(out.score), verdict: s(out.verdict, 300), scores,
    claims, verified: { supported: count('supported'), partly: count('partly'), notInResume: count('not_in_resume') },
    numberFlags: flags, metrics: metricsOf(answer, seconds),
    strengths: list(out.strengths, 4, 240), trim: list(out.trim, 4, 240), improvements: list(out.improvements, 6, 300),
    missing: arr(out.missing).map(m => ({ point: s(m && m.point, 240), why: s(m && m.why, 240), resumeRef: quoteIn(resumeText, m && m.resumeRef) })).filter(m => m.point).slice(0, 5),
    impressive, points: cleanPoints(out.points, resumeText), followUps: list(out.followUps, 3, 240),
  };
}

module.exports = { GUIDE_PROMPT, REVIEW_PROMPT, cleanGuide, cleanReview, cleanPoints, metricsOf, numberFlags, quoteIn };
