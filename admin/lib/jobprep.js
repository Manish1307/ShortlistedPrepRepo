'use strict';
// "Prepare for this job" (AI Job search results): for one job, what the candidate already matches, the skill gaps
// that keep the fit score below 100 (with how many points each one is worth), a study plan, topics to revise,
// likely interview questions and tips. The AI only chooses WHAT to search for; every link is built here as a search
// on YouTube, Udemy (free and paid), Coursera, the official documentation site or article sites, so a link can never
// point to a made-up video or course.

const PREP_PROMPT = `You are an expert career coach and technical interview trainer for IT candidates in India.
You get the candidate's resume, one job posting, and the fit score the candidate already has for it.
Explain exactly what stands between the candidate and a 100/100 fit, and how to close each gap fast.

RULES:
- Never claim the candidate has skills or experience the resume does not show.
- "gaps" are the skills, tools, certifications or experience the job wants that the resume lacks or shows weakly.
  Give each gap "points": how much closing it would raise the fit score. The points of all gaps should add up to about
  (100 - current fit score).
- "searchQuery" must be a short search phrase that finds good tutorials for that exact skill, e.g. "Power Platform ALM pipelines tutorial".
- "provider" is the company that owns the official documentation for the skill: one of
  microsoft, aws, google, oracle, salesforce, sap, servicenow, atlassian, ibm, redhat, kubernetes, python, java, scrum, pmi, other.
- "certification" is the official certification that proves the skill, if a well-known one exists (e.g. "PL-600"), else "".
- Keep every text short and practical.
Reply with ONLY a JSON object:
{
  "summary": "one sentence: where the candidate stands for this job",
  "matched": ["skills from the job the resume already shows"],
  "gaps": [ { "skill": "...", "points": 0-50, "importance": "high" | "medium" | "low", "why": "why this job needs it",
              "howToClose": "the fastest honest way to close it", "hours": estimated study hours, "searchQuery": "...",
              "provider": "...", "certification": "" } ],
  "revise": [ { "topic": "a topic the candidate knows but should revise for this interview", "searchQuery": "..." } ],
  "plan": ["3-5 steps, in order, to reach a full fit, with rough days or weeks"],
  "interviewQuestions": ["6-8 questions this interview is likely to ask"],
  "tips": ["2-4 tips: what to highlight in the resume, cover letter or interview for this job"]
}`;

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

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const list = (v, n, max) => (Array.isArray(v) ? v : []).map(x => str(x, max)).filter(Boolean).slice(0, n);

/** The AI's answer, checked and with the links added. */
function cleanPrep(out, fit) {
  const gaps = (Array.isArray(out.gaps) ? out.gaps : []).slice(0, 8).map(g => {
    const skill = str(g && g.skill, 80);
    if (!skill) return null;
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
    fit, summary: str(out.summary, 300), matched: list(out.matched, 20, 60), gaps,
    gapPoints: gaps.reduce((n, g) => n + g.points, 0),
    revise: (Array.isArray(out.revise) ? out.revise : []).slice(0, 8).map(r => {
      const topic = str(r && r.topic, 80);
      return topic ? { topic, links: learningLinks(str(r.searchQuery, 100) || `${topic} interview questions`, 'other').filter(l => ['youtube', 'articles'].includes(l.kind)) } : null;
    }).filter(Boolean),
    plan: list(out.plan, 6, 240), interviewQuestions: list(out.interviewQuestions, 10, 240), tips: list(out.tips, 5, 240),
    createdAt: new Date().toISOString(),
  };
}

module.exports = { PREP_PROMPT, learningLinks, cleanPrep };
