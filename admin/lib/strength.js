'use strict';
// "How much of ShortlistPrep have you used?" for a signed-in customer. The platform is four capabilities that share
// 100%: ATS score check 20, AI Job Search 25, Interview preparation 20 (introduction preparation is most of it) and
// Interview support 35 (the desktop apps). Each capability is a few steps, worth part of its share; a step is done when
// the customer's records show it (the same data as the Activity log and the Candidates page in the dashboard).

const entitlements = require('./entitlements');

const CAPABILITIES = [
  { id: 'ats', label: 'ATS score check', journey: 'Fix your resume', weight: 20, blurb: 'See how an applicant tracking system reads your resume, and fix it.', steps: [
    { id: 'resume', label: 'Upload your resume', weight: 5, href: 'career.html?step=cr-resume', cta: 'Upload resume',
      sql: 'SELECT COUNT(*) FROM career_resumes WHERE customer_id = ?' },
    { id: 'ats', label: 'Check your ATS score', weight: 5, href: 'career.html?step=cr-ats', cta: 'Check my ATS score',
      sql: "SELECT COUNT(*) FROM career_activity WHERE customer_id = ? AND action IN ('ats.checked', 'ats.improved')" },
    { id: 'improve', limitKey: '', label: 'Improve your ATS score', weight: 5, href: 'career.html?step=cr-ats', cta: 'Improve my ATS score',
      // also done when the resume already scores 100: there is nothing to improve
      sql: "SELECT (SELECT COUNT(*) FROM career_activity WHERE customer_id = ? AND action = 'ats.improved') + (SELECT COUNT(*) FROM career_resumes WHERE customer_id = ? AND json_extract(ats_json, '$.score') >= 100)" },
    { id: 'versions', limitKey: 'roleResumes', label: 'Make a resume for a target role', weight: 5, href: 'career.html?step=cr-versions', cta: 'Create role resume',
      sql: "SELECT COUNT(*) FROM career_activity WHERE customer_id = ? AND action = 'version.created'" },
  ] },
  { id: 'jobs', label: 'AI Job Search', journey: 'Find the right jobs', weight: 25, blurb: 'Live openings ranked by how well your resume fits, with the skill gaps.', steps: [
    { id: 'search', limitKey: 'jobSearches', label: 'Run an AI job search', weight: 15, href: 'career.html?step=cr-jobs', cta: 'Find my jobs',
      sql: "SELECT COUNT(*) FROM career_job_searches WHERE customer_id = ? AND status = 'done'" },
    { id: 'match', label: 'Match your resume to a job and get a cover letter', weight: 5, href: 'career.html?step=cr-match', cta: 'Match a job',
      sql: "SELECT COUNT(*) FROM career_activity WHERE customer_id = ? AND action = 'match.created'" },
    { id: 'jobprep', limitKey: 'preps', label: 'Get a prep plan for one job', weight: 5, href: 'career.html?step=cr-jobs', cta: 'Prepare for a job',
      sql: 'SELECT COUNT(*) FROM career_job_preps WHERE customer_id = ?' },
  ] },
  { id: 'prep', label: 'Interview preparation', journey: 'Prepare your answers', weight: 20, blurb: 'Start with your introduction, the answer to "Tell me about yourself".', steps: [
    { id: 'intro-guide', label: 'Prepare your introduction', weight: 6, highlight: true, href: 'account.html?tab=interview', cta: 'Prepare my introduction',
      sql: 'SELECT COUNT(*) FROM interview_intros WHERE customer_id = ? AND guide_json IS NOT NULL' },
    { id: 'intro-practise', label: 'Practise your introduction and get feedback', weight: 8, highlight: true, href: 'account.html?tab=interview', cta: 'Practise my introduction',
      sql: "SELECT COUNT(*) FROM interview_intros WHERE customer_id = ? AND answer <> ''" },
    { id: 'questions', label: 'Make questions from your own resume', weight: 6, href: 'account.html?tab=interview', cta: 'Make my questions',
      sql: 'SELECT COUNT(*) FROM interview_sets WHERE customer_id = ?' },
  ] },
  { id: 'support', label: 'Interview support', journey: 'Get help in the interview', weight: 35, blurb: 'The desktop apps that coach you live in a mock interview or a real one.', steps: [
    { id: 'download', label: 'Download the app', weight: 8, href: 'download.html', cta: 'Get the app',
      sql: 'SELECT COUNT(*) FROM downloads WHERE customer_id = ?' },
    { id: 'activate', label: 'Sign in to the app on your computer', weight: 9, href: 'download.html', cta: 'Set up the app',
      sql: 'SELECT COUNT(*) FROM devices d JOIN licences l ON l.id = d.licence_id WHERE l.customer_id = ?' },
    { id: 'session', limitKey: 'liveSessions', label: 'Use it in a live session', weight: 18, href: 'download.html', cta: 'Start a session',
      sql: 'SELECT COUNT(*) FROM conversations v JOIN licences l ON l.id = v.licence_id WHERE l.customer_id = ?' },
  ] },
];

/**
 * { name, plan, percent, capabilities: [{id, label, journey, weight, earned, done, steps: [{id, label, weight, done, locked, lockReason, href, cta, highlight}]}], next, hasLocked }
 * A step is locked when the customer's plan does not include it or its limit is used up (the same limits entitlements.js enforces).
 */
function strengthOf(db, customerId) {
  const customer = db.prepare('SELECT name, email FROM customers WHERE id = ?').get(customerId) || {};
  const { plan, limits } = entitlements.forCustomer(db, customerId);
  const byKey = Object.fromEntries(limits.map(l => [l.key, l]));
  const lockOf = s => {
    if (!s.limitKey) return '';
    const l = byKey[s.limitKey];
    if (!l) return s.limitKey === 'liveSessions' ? `Not in your ${plan.name} plan` : '';   // only live sessions are left out of a plan entirely
    return l.limit !== null && l.left === 0 ? `You have used all ${l.limit} on your ${plan.name} plan` : '';
  };
  const capabilities = CAPABILITIES.map(c => {
    const steps = c.steps.map(s => {
      const done = Object.values(db.prepare(s.sql).get(...Array((s.sql.match(/\?/g) || []).length).fill(customerId)))[0] > 0;
      const lockReason = done ? '' : lockOf(s);
      return { id: s.id, label: s.label, weight: s.weight, done, locked: !!lockReason, lockReason, href: lockReason ? 'pricing.html' : s.href, cta: lockReason ? 'Unlock' : s.cta, highlight: !!s.highlight };
    });
    const earned = steps.filter(s => s.done).reduce((n, s) => n + s.weight, 0);
    return { id: c.id, label: c.label, journey: c.journey, weight: c.weight, blurb: c.blurb, earned, done: earned === c.weight, steps };
  });
  const percent = capabilities.reduce((n, c) => n + c.earned, 0);
  const open = capabilities.flatMap(c => c.steps.filter(s => !s.done && !s.locked).map(s => ({ ...s, capability: c.label }))).sort((a, b) => b.weight - a.weight);
  const first = String(customer.name || '').trim().split(/\s+/)[0] || '';
  return {
    name: first || String(customer.email || '').split('@')[0], plan: { name: plan.name, free: plan.free }, percent, capabilities,
    next: open[0] || null, hasLocked: capabilities.some(c => c.steps.some(s => s.locked)),
  };
}

module.exports = { strengthOf, CAPABILITIES };
