'use strict';
// Insight (AI Job search results; formerly "Prepare for this job"): for one job, the skill matrix taken from the job's
// own description (technical and functional requirements), what the candidate already matches, the skill gaps
// that keep the fit score below 100 (with how many points each one is worth), a study plan, topics to revise,
// likely interview questions and tips. The AI only chooses WHAT to search for; every link is built here as a search
// on YouTube, Udemy (free and paid), Coursera, the official documentation site or article sites, so a link can never
// point to a made-up video or course.

const PREP_PROMPT = `You are an expert career coach and technical interview trainer for IT candidates in India.
You get the candidate's resume, one job posting, and the fit score the candidate already has for it.
Explain exactly what stands between the candidate and a 100/100 fit, and how to close each gap fast.

ACCURACY COMES FIRST. Everything you write about the JOB must come from its JOB DESCRIPTION; everything about the
CANDIDATE must come from the resume. Never use what roles with this title "usually" involve, and never mention a
skill, tool, duty or domain the job description does not mention (for example: no RFPs, presales, SOWs, account
growth, cloud migration or FinOps unless the description names them). Ignore the company introduction, benefits and
equal-opportunity text: they are not requirements. Do not describe the candidate's employer or situation (for example
"internal candidate") unless the resume says so.

RULES:
- Never claim the candidate has skills or experience the resume does not show.
- "gaps" are the requirements (from "requirements") the resume lacks or shows weakly.
  Give each gap "points": how much closing it would raise the fit score. The points of all gaps should add up to about
  (100 - current fit score).
- "revise" topics are requirements the resume already shows ("match" or "partial") that the interview will probe:
  name each with the job description's own words (e.g. "Spring Boot and Hibernate", "AWS SQS and CloudWatch").
- "matched" lists only requirements from the job description that the resume shows.
- "plan" and "tips" use only the gaps above and the job description.
- "searchQuery" must be a short search phrase that finds good tutorials for that exact skill, e.g. "Power Platform ALM pipelines tutorial".
- "provider" is the company that owns the official documentation for the skill: one of
  microsoft, aws, google, oracle, salesforce, sap, servicenow, atlassian, ibm, redhat, kubernetes, python, java, scrum, pmi, other.
- "certification" is the official certification that proves the skill, if a well-known one exists (e.g. "PL-600"), else "".
- "requirements" is the skill matrix. Take it ONLY from the JOB DESCRIPTION: every requirement it states, and nothing
  it does not state (never add skills that such roles "usually" need). 4-14 rows.
  "skill": the requirement in 2-6 words, using the job description's own words.
  "type": "technical" (languages, tools, platforms, methods, certifications, technical experience) or
          "functional" (domain and business knowledge, responsibilities, soft skills, years and kind of experience, education).
  "priority": "must" (required, minimum, must have) or "nice" (preferred, plus, good to have).
  "quote": the exact words from the job description that state it, copied character for character (at most 15 words).
  "weight": how much it matters for this job (all weights add up to 100; must-haves weigh more than nice-to-haves).
  "status": "match" (the resume clearly shows it), "partial" (some or related experience) or "missing".
  "evidence": where the resume shows it, in a few words ("" when missing).
- Each gap's "skill" must be exactly the "skill" of a requirement whose status is "partial" or "missing".
- Keep every text short and practical.
Reply with ONLY a JSON object:
{
  "summary": "one sentence: where the candidate stands for this job",
  "requirements": [ { "skill": "...", "type": "technical" | "functional", "priority": "must" | "nice", "quote": "...", "weight": 0-100, "status": "match" | "partial" | "missing", "evidence": "..." } ],
  "matched": ["skills from the job the resume already shows"],
  "gaps": [ { "skill": "...", "points": 0-50, "importance": "high" | "medium" | "low", "why": "why this job needs it",
              "howToClose": "the fastest honest way to close it", "hours": estimated study hours, "searchQuery": "...",
              "provider": "...", "certification": "" } ],
  "revise": [ { "topic": "a topic the candidate knows but should revise for this interview", "searchQuery": "..." } ],
  "plan": ["3-5 steps, in order, to reach a full fit, with rough days or weeks"],
  "tips": ["2-4 tips: what to highlight in the resume, cover letter or interview for this job"]
}`;

/** 20 practice questions for one job, in a call of their own: 5 multiple choice, 10 short "what is" questions, 5 scenarios. */
const QUESTIONS_PROMPT = `You are an expert interviewer. You get one JOB DESCRIPTION and the candidate's resume. Write 20 practice
interview questions, with answers, that THIS job's interview is likely to ask. Work in whatever field the job is in
(IT, science and research, engineering, healthcare, finance, sales or any other): never assume IT.

RULES:
- Every question must be about a responsibility, requirement, tool, method or domain topic that the JOB DESCRIPTION states.
  Never ask about something the job description does not mention.
- Exactly 5 "mcq": a multiple-choice question with exactly 4 options, one correct. "correct" is the index (0-3) of the
  right option. Make the wrong options believable. "explanation": one or two sentences on why it is right.
- Exactly 10 "short": a direct "what is / what does / how do you / why" question on a topic of the job. "answer": a
  correct, complete answer in 2-4 sentences, as a strong candidate would say it.
- Exactly 5 "scenario": a realistic work situation from this job ("You are asked to ... what do you do?").
  "answer": a model answer in 4-6 sentences: the steps to take and why.
- Mix easy and hard questions. Answers must be factually correct. Keep every text short and practical.
Reply with ONLY a JSON object:
{
  "mcq": [ { "question": "...", "options": ["...", "...", "...", "..."], "correct": 0, "explanation": "..." } ],
  "short": [ { "question": "...", "answer": "..." } ],
  "scenario": [ { "question": "...", "answer": "..." } ]
}`;

/** The AI's questions → [{type, question, options?, correct?, answer}] (mcq, then short, then scenario); bad entries are dropped. */
function cleanQuestions(out) {
  const arr = v => (Array.isArray(v) ? v : []);
  const mcq = arr(out && out.mcq).map(x => {
    const options = arr(x && x.options).map(o => str(o, 200)).filter(Boolean);
    const correct = Number(x && x.correct);
    const question = str(x && x.question, 300);
    if (!question || options.length !== 4 || !Number.isInteger(correct) || correct < 0 || correct > 3) return null;
    return { type: 'mcq', question, options, correct, answer: str(x.explanation, 400) };
  }).filter(Boolean).slice(0, 5);
  const text = (v, type, max) => arr(v).map(x => {
    const question = str(x && x.question, 300), answer = str(x && x.answer, max);
    return question && answer ? { type, question, answer } : null;
  }).filter(Boolean);
  return [...mcq, ...text(out && out.short, 'short', 700).slice(0, 10), ...text(out && out.scenario, 'scenario', 1000).slice(0, 5)];
}

const OFFICIAL = {
  microsoft: 'learn.microsoft.com', aws: 'docs.aws.amazon.com', google: 'cloud.google.com', oracle: 'docs.oracle.com',
  salesforce: 'trailhead.salesforce.com', sap: 'learning.sap.com', servicenow: 'servicenow.com', atlassian: 'atlassian.com',
  ibm: 'ibm.com', redhat: 'redhat.com', kubernetes: 'kubernetes.io', python: 'docs.python.org', java: 'dev.java',
  scrum: 'scrum.org', pmi: 'pmi.org',
};
const q = s => encodeURIComponent(String(s || '').trim());
const google = s => `https://www.google.com/search?q=${q(s)}`;

/** Search links for one skill: videos, courses, the official documentation and articles. */
function learningLinks(query, provider) {
  const links = [
    { kind: 'youtube', label: 'YouTube videos', url: `https://www.youtube.com/results?search_query=${q(query)}` },
    { kind: 'udemy-free', label: 'Udemy (free)', url: `https://www.udemy.com/courses/search/?q=${q(query)}&price=price-free` },
    { kind: 'udemy-paid', label: 'Udemy (paid)', url: `https://www.udemy.com/courses/search/?q=${q(query)}&price=price-paid` },
    { kind: 'coursera', label: 'Coursera', url: `https://www.coursera.org/search?query=${q(query)}` },
  ];
  if (provider === 'microsoft') links.push({ kind: 'official', label: 'Microsoft Learn', url: `https://learn.microsoft.com/en-us/search/?terms=${q(query)}` });
  else if (OFFICIAL[provider]) links.push({ kind: 'official', label: `Official docs (${OFFICIAL[provider]})`, url: google(`site:${OFFICIAL[provider]} ${query}`) });
  else links.push({ kind: 'official', label: 'Official documentation', url: google(`${query} official documentation`) });
  links.push({ kind: 'articles', label: 'Articles', url: google(`${query} site:freecodecamp.org OR site:geeksforgeeks.org OR site:medium.com OR site:dev.to`) });
  return links;
}

const VERSION = 4;              // 2: matrix from the job description; 3: gaps, topics and questions from it too, never a guess; 4: 20 practice questions with answers
const MIN_DESCRIPTION = 300;    // characters: shorter is not a job description we can trust
const MAX_DESCRIPTION = 15000;  // characters a candidate may paste
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const list = (v, n, max) => (Array.isArray(v) ? v : []).map(x => str(x, max)).filter(Boolean).slice(0, n);

const CREDIT = { match: 1, partial: 0.5, missing: 0 };
const NOISE = new Set(['and', 'or', 'the', 'of', 'in', 'with', 'for', 'to', 'a', 'an', 'on', 'at', 'experience', 'knowledge', 'skills', 'strong', 'good', 'years', 'year', 'plus']);
/** Lower case, words only: "Node.js / C#" → " node js c# " (so a quote is found whatever the spacing or punctuation). */
const flat = t => ' ' + String(t || '').toLowerCase().replace(/[^a-z0-9#+]+/g, ' ').trim() + ' ';
/** Whether the job description states this requirement: its quote is in the text, or else every word of its name is. */
function inDescription(row, jd) {
  if (row.quote && flat(row.quote).trim().length > 2 && jd.includes(flat(row.quote))) return true;
  const words = flat(row.skill).trim().split(' ').filter(w => w && !NOISE.has(w));
  return words.length > 0 && words.every(w => jd.includes(' ' + w + ' ') || (w.length > 4 && jd.includes(' ' + w.replace(/s$/, ''))));
}

const words = t => flat(t).trim().split(' ').filter(w => w.length > 1 && !NOISE.has(w));
/** Whether a phrase is about the job description: at least half its words are in it (text: flat(jd)). */
function mentions(text, phrase) {
  const w = words(phrase);
  return w.length > 0 && w.filter(x => text.includes(' ' + x + ' ')).length / w.length >= 0.5;
}
/** Whether two skill names are the same requirement: they share at least half the words of the shorter one. */
function sameSkill(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  return x.filter(w => y.includes(w)).length / Math.min(x.length, y.length) >= 0.5;
}

/**
 * The required-vs-gap matrix: each requirement with its type (technical / functional), priority, the words of the job
 * description that state it, its weight (scaled so all weights add up to 100), the candidate's status, the points
 * earned (weight × 1 / ½ / 0) and the points missing. null when the AI gave none.
 * With the job description (jd), a requirement the description does not state is dropped, so the matrix matches the
 * job's real requirements exactly; "dropped" says how many.
 */
function skillMatrix(requirements, jd) {
  const text = jd == null ? null : flat(jd);
  let rows = (Array.isArray(requirements) ? requirements : []).slice(0, 16).map(r => ({
    skill: str(r && r.skill, 90), type: r && r.type === 'functional' ? 'functional' : 'technical', priority: r && r.priority === 'nice' ? 'nice' : 'must',
    quote: str(r && r.quote, 200), weight: Math.max(0, Number(r && r.weight) || 0),
    status: Object.prototype.hasOwnProperty.call(CREDIT, r && r.status) ? r.status : 'missing', evidence: str(r && r.evidence, 160),
  })).filter(r => r.skill);
  const given = rows.length;
  if (text) rows = rows.filter(r => inDescription(r, text)).map(r => (r.quote && !text.includes(flat(r.quote)) ? { ...r, quote: '' } : r));
  if (!rows.length) return null;
  const dropped = given - rows.length;
  const total = rows.reduce((n, r) => n + r.weight, 0) || rows.length;
  let left = 100;
  rows.forEach((r, i) => {   // whole-number weights that add up to exactly 100
    r.weight = i === rows.length - 1 ? left : Math.round(((r.weight || 1) / total) * 100);
    left -= r.weight;
  });
  rows.forEach(r => { r.weight = Math.max(0, r.weight); r.earned = Math.round(r.weight * CREDIT[r.status] * 10) / 10; r.missing = Math.round((r.weight - r.earned) * 10) / 10; });
  rows.sort((a, b) => b.weight - a.weight);
  const score = Math.round(rows.reduce((n, r) => n + r.earned, 0));
  return { rows, score, counts: { match: rows.filter(r => r.status === 'match').length, partial: rows.filter(r => r.status === 'partial').length, missing: rows.filter(r => r.status === 'missing').length },
    types: { technical: rows.filter(r => r.type === 'technical').length, functional: rows.filter(r => r.type === 'functional').length },
    ...(text ? { checked: true, dropped } : {}) };
}

/**
 * The AI's answer, checked and with the links added. jd: the job description the AI was given ('' when the careers
 * site gave none); the skill matrix keeps only the requirements it states.
 */
function cleanPrep(out, fit, jd) {
  const matrix = jd ? skillMatrix(out.requirements, jd) : null;
  const text = flat(jd);
  // a gap must be a requirement of the matrix that the resume lacks or shows weakly; it takes that requirement's name
  const open = matrix ? matrix.rows.filter(r => r.status !== 'match') : [];
  const used = new Set();
  const gaps = (Array.isArray(out.gaps) ? out.gaps : []).slice(0, 10).map(g => {
    let skill = str(g && g.skill, 80);
    if (!skill) return null;
    if (jd) {
      const row = open.find(r => sameSkill(r.skill, skill));
      if (!row || used.has(row.skill)) return null;
      used.add(row.skill);
      skill = row.skill;
    }
    const provider = Object.prototype.hasOwnProperty.call(OFFICIAL, g.provider) ? g.provider : 'other';
    const query = str(g.searchQuery, 100) || `${skill} tutorial`;
    const certification = str(g.certification, 80);
    return {
      skill, points: Math.max(0, Math.min(50, Math.round(Number(g.points) || 0))),
      importance: ['high', 'medium', 'low'].includes(g.importance) ? g.importance : 'medium',
      why: str(g.why, 240), howToClose: str(g.howToClose, 300), hours: Math.max(0, Math.min(400, Math.round(Number(g.hours) || 0))),
      provider, links: learningLinks(query, provider),
      certification: certification ? { name: certification, url: google(`${certification} certification official`) } : null,
    };
  }).filter(Boolean).sort((a, b) => b.points - a.points);
  return {
    version: VERSION, fit, summary: str(out.summary, 300), matrix, description: jd ? 'full' : 'none',
    matched: list(out.matched, 20, 60).filter(m => !jd || mentions(text, m)), gaps,
    gapPoints: gaps.reduce((n, g) => n + g.points, 0),
    // topics to revise are things the job description talks about
    revise: (Array.isArray(out.revise) ? out.revise : []).slice(0, 8).map(r => {
      const topic = str(r && r.topic, 80);
      if (!topic || (jd && !mentions(text, topic))) return null;
      return { topic, links: learningLinks(str(r.searchQuery, 100) || `${topic} interview questions`, 'other').filter(l => ['youtube', 'articles'].includes(l.kind)) };
    }).filter(Boolean),
    plan: list(out.plan, 6, 240), interviewQuestions: cleanQuestions(out.questions), tips: list(out.tips, 5, 240),
    createdAt: new Date().toISOString(),
  };
}

module.exports = { PREP_PROMPT, QUESTIONS_PROMPT, cleanQuestions, learningLinks, cleanPrep, skillMatrix, VERSION, MIN_DESCRIPTION, MAX_DESCRIPTION };
