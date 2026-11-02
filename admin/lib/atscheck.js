'use strict';
// The free ATS check on the website: a rules-based score for a resume's text (no AI, so it is instant, free and the same
// every time), plus the name, email and mobile number found in the resume. A visitor who runs it becomes an opportunity.

const MAX_TEXT = 20000;

const ACTION_VERBS = new Set(`achieved administered analysed analyzed architected automated built collaborated completed configured conducted created
delivered deployed designed developed directed drove enabled engineered established executed exceeded generated implemented improved increased
initiated integrated introduced launched led maintained managed mentored migrated modernised modernized negotiated optimised optimized organised
organized owned planned presented produced reduced refactored resolved reviewed scaled shipped simplified solved streamlined supported tested
trained transformed troubleshot upgraded validated wrote coordinated monitored documented debugged accelerated cut saved won handled`.split(/\s+/));

const SKILL_WORDS = `java javascript typescript python c++ c# .net node react angular vue spring sql mysql postgresql mongodb oracle aws azure gcp docker
kubernetes git jenkins linux html css microservices selenium junit agile scrum jira excel tableau testing automation devops redis kafka
flutter android ios swift kotlin php laravel django flask tally sap salesforce communication leadership sales marketing seo accounting finance
solidworks catia autocad ansys creo cad fea cfd cnc plc scada matlab fmea dfm dfa hvac welding machining casting forging pneumatics hydraulics
simulink revit staad etabs lean kaizen autocad plm windchill sixsigma`.split(/\s+/);
const SKILL_PHRASES = ['machine learning', 'data analysis', 'power bi', 'ci/cd', 'rest api', 'six sigma', 'sheet metal', 'root cause', 'gd&t', 'quality control', 'project management'];   // two-word skills, matched as a phrase

const SECTIONS = {
  summary: /^(professional\s+)?(summary|profile|objective|career\s+objective|about\s+me)\b/i,
  experience: /^(work\s+|professional\s+|employment\s+)?(experience|history)\b|^internships?\b/i,
  education: /^(education|academic|qualifications?)\b/i,
  skills: /^(technical\s+|key\s+|core\s+)?(skills|competencies|expertise|technologies)\b/i,
  projects: /^(academic\s+|personal\s+|key\s+)?projects?\b/i,
  certifications: /^(certifications?|courses|achievements|awards)\b/i,
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?\s?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+?\d[\d\s().-]{8,}\d/g;

const titleCase = s => s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/** { name, email, phone } found in the resume text; an empty string for what is not there. */
function extractContact(text) {
  const t = String(text || '');
  const email = ((t.match(EMAIL) || [''])[0]).toLowerCase();
  let phone = '';
  for (const m of t.match(PHONE) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13 && !/^(19|20)\d{2}(19|20)\d{2}/.test(digits)) { phone = m.replace(/\s+/g, ' ').trim(); break; }
  }
  let name = '';
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 10);
  for (const line of lines) {
    if (/@|https?:|www\.|linkedin|github|\d{4,}|resume|curriculum|vitae|^cv\b/i.test(line)) continue;
    const words = line.replace(/[,|•·].*$/, '').trim().split(/\s+/);
    if (words.length < 2 || words.length > 4 || line.length > 40) continue;
    if (!words.every(w => /^[A-Za-z][A-Za-z.'-]*$/.test(w))) continue;
    const upper = line === line.toUpperCase();
    if (!upper && !words.every(w => /^[A-Z]/.test(w))) continue;
    if (Object.values(SECTIONS).some(rx => rx.test(line))) continue;
    name = upper ? titleCase(line) : words.join(' ');
    break;
  }
  return { name, email, phone };
}

const pct = (n, d) => (d ? n / d : 0);
const check = (name, weight, ratio, detail) => ({
  name, weight, points: Math.round(weight * Math.max(0, Math.min(1, ratio))),
  status: ratio >= 0.8 ? 'pass' : ratio >= 0.4 ? 'warn' : 'fail', detail,
});

/** { score, verdict, checks: [{name, status, detail, points, weight}], skills: [...], fixFirst: [...] } for the resume text. */
function scoreResume(rawText) {
  const text = String(rawText || '').slice(0, MAX_TEXT);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const words = (text.match(/\b[\w'+#./-]+\b/g) || []).length;
  const lower = text.toLowerCase();
  const contact = extractContact(text);

  const found = {};
  for (const l of lines) {
    const head = l.replace(/[:\-–—|]+$/, '').trim();
    if (head.length <= 40) for (const [k, rx] of Object.entries(SECTIONS)) if (rx.test(head)) found[k] = true;
  }
  const BULLET = /^[-•*▪●◦–·]\s*/;   // the last three are the bullet glyphs Word's symbol font leaves in PDFs
  const bullets = lines.filter(l => BULLET.test(l) && l.replace(BULLET, ''));
  const bulletText = bullets.map(l => l.replace(BULLET, ''));
  const verbLed = bulletText.filter(l => ACTION_VERBS.has((l.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, ''))).length;
  const numbered = lines.filter(l => /\d+\s?%|\d+\+|[₹$€]\s?\d|\b\d{2,}\b\s*(users|clients|customers|projects|members|team|crore|lakh|lpa|cr|k|m)\b|\b(increased|reduced|improved|saved|grew|cut)\b.*\b\d+/i.test(l)
    && !/^(\+?\d[\d\s-]{9,}|.*@)/.test(l)).length;
  const dates = (text.match(/\b(19|20)\d{2}\b\s*(?:-|–|—|to)\s*(?:\b(19|20)\d{2}\b|present|current|till date|ongoing)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(19|20)\d{2}/gi) || []).length;
  const skills = [...new Set([
    ...SKILL_PHRASES.filter(p => lower.includes(p)),
    ...SKILL_WORDS.filter(w => new RegExp('(^|[^a-z0-9+#])' + w.replace(/[.+#/]/g, '\\$&') + '($|[^a-z0-9+#])', 'i').test(lower)),
  ])];
  const firstPerson = (text.match(/\b(i|my|me)\b/gi) || []).length;
  const messy = (text.match(/\t/g) || []).length + (text.match(/ {4,}/g) || []).length + (text.match(/\|/g) || []).length;

  const coreSections = ['experience', 'education', 'skills'].filter(k => found[k] || (k === 'experience' && found.projects)).length;
  const checks = [
    check('Contact details', 10, (contact.email ? 0.5 : 0) + (contact.phone ? 0.5 : 0),
      contact.email && contact.phone ? 'Email and phone number are easy to find.' : `Add ${[!contact.email && 'an email address', !contact.phone && 'a phone number'].filter(Boolean).join(' and ')} at the top, as plain text.`),
    check('Standard section headings', 15, coreSections / 3,
      coreSections === 3 ? 'Experience (or projects), Education and Skills headings were found.' : 'Use clear headings such as Experience, Education and Skills so the ATS can sort your resume into sections.'),
    check('Professional summary', 5, found.summary ? 1 : 0, found.summary ? 'A summary or objective is present.' : 'Add a 2-3 line Summary at the top, with your role and strongest skills.'),
    check('Length', 10, words >= 250 && words <= 900 ? 1 : words >= 150 && words <= 1200 ? 0.6 : 0.2,
      words < 150 ? `Only ${words} words. A resume needs more detail about your work and skills.` : words < 250 ? `About ${words} words. Add more about what you did and achieved.` : words > 900 ? `About ${words} words. Trim to the most relevant points, ideally one or two pages.` : `About ${words} words, a good length.`),
    check('Bullet points', 10, pct(bullets.length, 6), bullets.length >= 6 ? 'Your experience is written as bullet points.' : 'Write what you did as short bullet points (start each line with a dash or dot).'),
    check('Action verbs', 10, bullets.length ? pct(verbLed, bullets.length) / 0.5 : 0,
      bullets.length && verbLed / bullets.length >= 0.4 ? 'Most bullets start with a strong verb.' : 'Start bullets with verbs like Built, Led, Reduced, Delivered instead of "Responsible for".'),
    check('Numbers and results', 15, pct(numbered, 4), numbered >= 4 ? 'Achievements include numbers, which recruiters notice.' : 'Add numbers to your achievements: percentages, users, time saved, team size, revenue.'),
    check('Dates', 5, pct(dates, 2), dates >= 2 ? 'Dates are written clearly.' : 'Write dates like "Jan 2022 – Present" for each job, project or course.'),
    check('Skills and keywords', 10, pct(skills.length, 8), skills.length >= 8 ? `${skills.length} recognised skills and keywords found.` : `Only ${skills.length} recognised skills found. List the tools, languages and skills the job asks for, if you really have them.`),
    check('Simple formatting', 5, messy > 12 ? 0.3 : messy > 4 ? 0.7 : 1, messy > 12 ? 'The text looks like it comes from tables or columns, which many ATS cannot read in order. Use one column.' : 'The layout reads as simple text.'),
    check('Professional tone', 5, firstPerson > 6 ? 0.3 : firstPerson > 2 ? 0.7 : 1, firstPerson > 6 ? 'Avoid "I" and "my". Write bullets without pronouns.' : 'No overuse of "I" and "my".'),
  ];
  const score = checks.reduce((n, c) => n + c.points, 0);
  const verdict = score >= 80 ? 'Strong. Most ATS will read this resume well.' : score >= 60 ? 'Decent, but a few fixes will raise your chances.' : score >= 40 ? 'Needs work before you apply. Start with the fixes below.' : 'Weak for an ATS right now. The fixes below will make a big difference.';
  const fixFirst = checks.filter(c => c.status !== 'pass').sort((a, b) => (b.weight - b.points) - (a.weight - a.points)).slice(0, 3).map(c => c.detail);
  return { score, verdict, checks, skills: skills.slice(0, 30), fixFirst, words };
}

module.exports = { extractContact, scoreResume, MAX_TEXT };
