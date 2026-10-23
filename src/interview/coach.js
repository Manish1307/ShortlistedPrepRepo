'use strict';
// The AI mock interviewer: writes practice questions for a company, role and round, scores the candidate's answer
// with feedback, and builds the end-of-interview report. No Electron or network code of its own: it talks to any
// AI object with complete({ system, user, maxTokens, json, signal }) -> text, so it can be tested with fakes.

// Companies the candidate can practise for. The questions are written in the usual style of each company's
// interviews; they are practice questions, not leaked or official ones.
const COMPANIES = [
  'Google', 'Microsoft', 'Amazon', 'Apple', 'Meta', 'Netflix', 'Adobe', 'Salesforce', 'Oracle', 'IBM',
  'Intel', 'Cisco', 'SAP', 'VMware', 'Nvidia', 'Qualcomm', 'Uber', 'LinkedIn', 'PayPal', 'Atlassian',
  'ServiceNow', 'Walmart Global Tech', 'Goldman Sachs', 'JPMorgan Chase', 'Morgan Stanley', 'Deloitte', 'Accenture', 'Capgemini', 'Cognizant', 'TCS',
  'Infosys', 'Wipro', 'HCLTech', 'Tech Mahindra', 'LTIMindtree', 'Mphasis', 'Persistent Systems', 'Zoho', 'Flipkart', 'Swiggy',
  'Zomato', 'Paytm', 'PhonePe', 'Razorpay', 'Freshworks', 'Ola', 'Myntra', 'Juspay', 'Siemens', 'Ericsson',
];

const ROUNDS = {
  technical: 'Technical: concepts of the role\'s main technologies',
  dsa: 'Coding: data structures and algorithms',
  'system-design': 'System design',
  hr: 'HR and behavioural',
  managerial: 'Managerial: projects, decisions and teamwork',
};

const LEVELS = {
  fresher: 'Fresher / campus hire (0 years)',
  junior: '1 to 3 years of experience',
  mid: '3 to 6 years of experience',
  senior: '6 or more years of experience',
};

const QUESTION_PROMPT = `You are an experienced interviewer at a technology company, preparing a practice interview for a candidate.

Write interview questions for the company, role, round and experience level given. Make them realistic: the kind of questions this company is known to ask for this round, at the right difficulty for the level. Mix easier and harder ones, starting easier. Each question must be clear and answerable by speaking for one to three minutes (for a coding round: explaining the approach, its complexity and the key code). Do not repeat any question in the "already asked" list. Never claim a question is a real or leaked question from the company.

For each question give the main points a strong answer must cover (3 to 6 short points) and its topic in two or three words.

Reply with ONLY JSON in this shape:
{"questions":[{"question":"...","topic":"...","points":["...","..."]}]}`;

const EVALUATE_PROMPT = `You are an experienced, fair interviewer giving feedback after a practice interview question. The candidate's answer was spoken and turned into text by speech recognition, so ignore small recognition mistakes and missing punctuation.

Score the answer from 0 to 10 for this round and experience level:
- 9-10: complete, correct, well structured, with examples or trade-offs; would clearly pass.
- 7-8: correct and mostly complete; small gaps.
- 5-6: partly right; important points missing or unclear.
- 3-4: weak; major mistakes or very incomplete.
- 0-2: no real answer, off topic, or wrong.

Be specific and encouraging, like a mentor. Talk to the candidate as "you". Use plain words.
- "strengths": what was good (0 to 3 short points; none if the answer was empty).
- "missing": what was missing or wrong, and how to fix it (1 to 4 short points).
- "betterAnswer": a model answer the candidate could say in an interview, in the first person, 80 to 180 words; for a coding question include the approach, complexity and short code between \`\`\` lines.
- "followUp": one natural follow-up question an interviewer would ask next based on this answer, or "" when none fits.
- "verdict": one short sentence summing up the answer.

Reply with ONLY JSON in this shape:
{"score":7,"verdict":"...","strengths":["..."],"missing":["..."],"betterAnswer":"...","followUp":"..."}`;

/** Find the JSON object in a model reply (tolerates code fences and words around it). null = unusable. */
function parseJson(text) {
  const s = String(text || '');
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

const clean = (v, max = 2000) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const list = (v, n, max = 300) => (Array.isArray(v) ? v.map(x => clean(x, max)).filter(Boolean).slice(0, n) : []);

function describe({ company, role, round, level }) {
  return [
    `Company: ${company && company !== 'Any' ? company : 'any large technology company'}`,
    `Role: ${clean(role, 120) || 'Software engineer'}`,
    `Round: ${round === 'resume' ? 'Questions from the candidate\'s own resume: their projects, skills and work situations' : ROUNDS[round] || ROUNDS.technical}`,
    `Experience level: ${level === 'resume' ? 'as shown by the candidate\'s resume' : LEVELS[level] || LEVELS.junior}`,
  ].join('\n');
}

/**
 * @returns {Promise<Array<{question: string, topic: string, points: string[]}>>}
 */
async function generateQuestions(ai, { company, role, round, level, count = 5, focus = '', avoid = [], signal } = {}) {
  const n = Math.max(1, Math.min(15, Number(count) || 5));
  const user = [
    describe({ company, role, round, level }),
    focus ? `Focus on: ${clean(focus, 300)}` : '',
    `Number of questions: ${n}`,
    avoid.length ? `Already asked (do not repeat):\n${avoid.slice(-30).map(q => `- ${clean(q, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  const reply = await ai.complete({ system: QUESTION_PROMPT, user, maxTokens: 3000, json: true, signal });
  const data = parseJson(reply);
  const raw = Array.isArray(data) ? data : data && Array.isArray(data.questions) ? data.questions : null;
  if (!raw) throw new Error('The AI did not return questions in the expected form. Try again.');
  const questions = raw
    .map(q => (typeof q === 'string' ? { question: q } : q || {}))
    .map(q => ({ question: clean(q.question, 1500), topic: clean(q.topic, 60) || 'General', points: list(q.points, 6) }))
    .filter(q => q.question.length > 8)
    .slice(0, n);
  if (!questions.length) throw new Error('The AI did not return any questions. Try again.');
  return questions;
}

/**
 * @returns {Promise<{score: number, verdict: string, strengths: string[], missing: string[], betterAnswer: string, followUp: string}>}
 */
async function evaluateAnswer(ai, { company, role, round, level, question, points = [], answer, reference = '', signal } = {}) {
  const said = clean(answer, 6000);
  if (!said) {
    return { score: 0, verdict: 'No answer was given.', strengths: [], missing: ['Say something even when unsure: explain what you know and how you would find out the rest.'], betterAnswer: '', followUp: '' };
  }
  const user = [
    describe({ company, role, round, level }),
    '',
    `Question: ${clean(question, 1500)}`,
    points.length ? `Points a strong answer covers:\n${points.map(p => `- ${p}`).join('\n')}` : '',
    reference ? `The question comes from the candidate's own resume. A model answer, using only what the resume shows:\n${clean(reference, 1500)}` : '',
    '',
    `Candidate's answer:\n${said}`,
  ].filter(x => x !== null).join('\n');
  const reply = await ai.complete({ system: EVALUATE_PROMPT, user, maxTokens: 2000, json: true, signal });
  const d = parseJson(reply);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('The AI did not return feedback in the expected form. Try again.');
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score))));
  return {
    score: Number.isFinite(score) ? score : 0,
    verdict: clean(d.verdict, 300),
    strengths: list(d.strengths, 3),
    missing: list(d.missing, 4),
    betterAnswer: clean(d.betterAnswer, 4000),
    followUp: clean(d.followUp, 600),
  };
}

/** The end-of-interview numbers. items: [{ topic, score|null, skipped }] */
function summarize(items) {
  const answered = items.filter(i => !i.skipped && typeof i.score === 'number');
  const average = answered.length ? Math.round((answered.reduce((a, i) => a + i.score, 0) / answered.length) * 10) / 10 : 0;
  const byTopic = new Map();
  for (const i of answered) {
    const t = byTopic.get(i.topic) || [];
    t.push(i.score);
    byTopic.set(i.topic, t);
  }
  const topicAvg = [...byTopic].map(([topic, s]) => ({ topic, avg: s.reduce((a, b) => a + b, 0) / s.length }));
  return {
    questions: items.length,
    answered: answered.length,
    skipped: items.filter(i => i.skipped).length,
    average,
    readiness: average >= 8 ? 'Ready' : average >= 6 ? 'Nearly there' : average >= 4 ? 'Needs practice' : 'Keep practising',
    strongTopics: topicAvg.filter(t => t.avg >= 7).map(t => t.topic),
    weakTopics: topicAvg.filter(t => t.avg < 6).map(t => t.topic),
  };
}

/** The report as plain text (saved for the candidate). */
function formatReport(session) {
  const s = summarize(session.items);
  const out = [];
  out.push('MOCK INTERVIEW REPORT');
  out.push('='.repeat(60));
  out.push(`Date      : ${new Date(session.startedAt || Date.now()).toLocaleString()}`);
  out.push(`Company   : ${session.company || 'Any'}`);
  out.push(`Role      : ${session.role || 'Software engineer'}`);
  out.push(`Round     : ${ROUNDS[session.round] || session.round || ''}`);
  out.push(`Level     : ${LEVELS[session.level] || session.level || ''}`);
  out.push('');
  out.push(`Overall score: ${s.average} / 10  (${s.readiness})`);
  out.push(`Answered: ${s.answered}   Skipped: ${s.skipped}`);
  if (s.strongTopics.length) out.push(`Strong topics: ${s.strongTopics.join(', ')}`);
  if (s.weakTopics.length) out.push(`Practise more: ${s.weakTopics.join(', ')}`);
  out.push('');
  session.items.forEach((i, n) => {
    out.push('-'.repeat(60));
    out.push(`Q${n + 1}. [${i.topic}]${i.followUpOf ? ' (follow-up)' : ''} ${i.question}`);
    if (i.skipped) { out.push('Skipped.'); out.push(''); return; }
    out.push(`Score: ${i.score} / 10. ${i.verdict || ''}`);
    out.push('');
    out.push('Your answer:');
    out.push(i.answer || '(none)');
    if (i.strengths && i.strengths.length) { out.push(''); out.push('Good:'); i.strengths.forEach(x => out.push(`  + ${x}`)); }
    if (i.missing && i.missing.length) { out.push(''); out.push('To improve:'); i.missing.forEach(x => out.push(`  - ${x}`)); }
    if (i.betterAnswer) { out.push(''); out.push('A stronger answer:'); out.push(i.betterAnswer); }
    out.push('');
  });
  return out.join('\n');
}

module.exports = { COMPANIES, ROUNDS, LEVELS, QUESTION_PROMPT, EVALUATE_PROMPT, parseJson, generateQuestions, evaluateAnswer, summarize, formatReport };
