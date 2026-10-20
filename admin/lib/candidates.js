'use strict';
const { SECTORS } = require('./jobcatalogue');
// Dashboard → Candidates: what each customer does with My account and the Career toolkit. Progress through the
// steps (resume, ATS check, role resumes, job matches, AI job searches), their documents to download, the job
// search results, AI use per day and an activity log (activity.js). Every signed-in admin may look; downloads
// are written to the audit log.

const { ApiError, likeTerm } = require('./http');
const career = require('./career');

const DAY = 86400000;
const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
const latest = (...dates) => dates.filter(Boolean).sort().pop() || null;

function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;

  const rows = q => all(`
    SELECT c.id, c.email, c.name, c.organisation, c.sector, c.created_at,
           a.customer_id IS NOT NULL AS has_login, a.disabled AS login_disabled, a.last_login,
           r.customer_id IS NOT NULL AS has_resume, r.file_name, r.uploaded_at, r.ats_at, json_extract(r.ats_json, '$.score') AS ats_score,
           (SELECT COUNT(*) FROM career_versions v WHERE v.customer_id = c.id) AS versions,
           (SELECT COUNT(*) FROM career_matches m WHERE m.customer_id = c.id) AS matches,
           (SELECT COUNT(*) FROM career_job_searches s WHERE s.customer_id = c.id AND s.status = 'done') AS searches,
           (SELECT MAX(created_at) FROM career_job_searches s WHERE s.customer_id = c.id) AS last_search,
           (SELECT MAX(at) FROM career_activity x WHERE x.customer_id = c.id) AS last_activity,
           (SELECT COALESCE(SUM(count), 0) FROM career_usage u WHERE u.customer_id = c.id) AS ai_total
    FROM customers c
    LEFT JOIN customer_accounts a ON a.customer_id = c.id
    LEFT JOIN career_resumes r ON r.customer_id = c.id
    WHERE (a.customer_id IS NOT NULL OR r.customer_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM career_job_searches s WHERE s.customer_id = c.id)
           OR EXISTS (SELECT 1 FROM career_activity x WHERE x.customer_id = c.id))
      ${q ? "AND (c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.organisation LIKE ? ESCAPE '\\')" : ''}
    ORDER BY c.id DESC`, ...(q ? [likeTerm(q), likeTerm(q), likeTerm(q)] : []));

  const steps = r => ({ resume: !!r.has_resume, ats: r.ats_score != null, versions: r.versions > 0, matches: r.matches > 0, searches: r.searches > 0 });
  const present = r => {
    const s = steps(r);
    return {
      id: r.id, email: r.email, name: r.name, organisation: r.organisation, sector: r.sector || '', sectorLabel: (SECTORS.find(x => x.id === r.sector) || {}).label || '', joinedAt: r.created_at,
      login: { exists: !!r.has_login, disabled: !!r.login_disabled, lastLogin: r.last_login },
      resume: r.has_resume ? { fileName: r.file_name, uploadedAt: r.uploaded_at, atsScore: r.ats_score, atsAt: r.ats_at } : null,
      versions: r.versions, matches: r.matches, searches: r.searches, aiActions: r.ai_total,
      steps: s, done: Object.values(s).filter(Boolean).length,
      lastActive: latest(r.last_activity, r.last_login, r.uploaded_at, r.ats_at, r.last_search),
    };
  };

  add('GET', '/admin/api/candidates', { admin: true }, (req, res, { query }) => {
    const list = rows(String(query.get('q') || '').trim()).map(present);
    const week = new Date(Date.now() - 7 * DAY).toISOString();
    const filter = String(query.get('filter') || '');
    const shown = list.filter(c => filter === 'resume' ? c.resume : filter === 'noresume' ? !c.resume : filter === 'active' ? c.lastActive >= week
      : filter === 'searching' ? c.searches > 0 : true);
    return {
      candidates: shown,
      stats: {
        total: list.length, withResume: list.filter(c => c.resume).length, atsDone: list.filter(c => c.steps.ats).length,
        activeWeek: list.filter(c => c.lastActive && c.lastActive >= week).length,
        searchesWeek: one("SELECT COUNT(*) AS n FROM career_job_searches WHERE created_at >= ?", week).n,
      },
    };
  });

  const customerOr404 = id => { const c = one('SELECT * FROM customers WHERE id = ?', id); if (!c) throw new ApiError(404, 'Candidate not found'); return c; };

  add('GET', '/admin/api/candidates/:id', { admin: true }, (req, res, { params }) => {
    const c = customerOr404(params.id);
    const row = rows('').find(r => r.id === c.id);
    const r = one('SELECT * FROM career_resumes WHERE customer_id = ?', c.id);
    const ats = r && parse(r.ats_json);
    const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    return {
      candidate: row ? present(row) : { id: c.id, email: c.email, name: c.name, organisation: c.organisation, sector: c.sector || '', sectorLabel: (SECTORS.find(x => x.id === c.sector) || {}).label || '', joinedAt: c.created_at, login: { exists: false }, resume: null, steps: {}, done: 0 },
      resume: r ? {
        fileName: r.file_name, uploadedAt: r.uploaded_at, chars: r.source_text.length, preview: r.source_text.slice(0, 1500),
        ats: ats ? { score: ats.score, verdict: ats.verdict, checkedAt: r.ats_at, checks: ats.checks || [], keywords: ats.keywords || { present: [], missing: [] },
          fixes: ats.fixes || [], suggestedRoles: ats.suggestedRoles || [] } : null,
      } : null,
      versions: all('SELECT id, role, content_json, created_at FROM career_versions WHERE customer_id = ? ORDER BY id DESC', c.id)
        .map(v => { const x = parse(v.content_json) || {}; return { id: v.id, role: v.role, fitScore: x.fitScore, fitNote: x.fitNote, createdAt: v.created_at }; }),
      matches: all('SELECT id, job_title, company, result_json, created_at FROM career_matches WHERE customer_id = ? ORDER BY id DESC', c.id)
        .map(m => { const x = parse(m.result_json) || {}; return { id: m.id, jobTitle: m.job_title, company: m.company, score: x.score, verdict: x.verdict, hasLetter: !!x.coverLetter, createdAt: m.created_at }; }),
      searches: all('SELECT id, params_json, status, error, result_json, created_at, finished_at FROM career_job_searches WHERE customer_id = ? ORDER BY id DESC', c.id)
        .map(s => {
          const x = parse(s.result_json), p = parse(s.params_json) || {};
          const count = b => (x ? x.jobs.filter(j => j.bucket === b).length : 0);
          return { id: s.id, status: s.status, error: s.error, createdAt: s.created_at, finishedAt: s.finished_at,
            params: { role: p.role, country: p.country, city: p.city, level: p.level, companies: p.companies, resumeLabel: p.resumeLabel, days: p.days },
            counts: { high: count('high'), medium: count('medium'), stretch: count('stretch') }, level: x ? x.profile.level : '' };
        }),
      preps: all('SELECT id, search_id, job_title, company, location, url, fit, prep_json, created_at FROM career_job_preps WHERE customer_id = ? ORDER BY id DESC', c.id)
        .map(x => { const pr = parse(x.prep_json) || {}; return { id: x.id, searchId: x.search_id, jobTitle: x.job_title, company: x.company, location: x.location, url: x.url, fit: x.fit,
          skillScore: pr.matrix ? pr.matrix.score : null, gaps: (pr.gaps || []).length, gapPoints: pr.gapPoints || 0, createdAt: x.created_at }; }),
      entitlements: require('./entitlements').forCustomer(db, c.id),
      planOrders: all('SELECT id, number, plan_name, amount_paise, status, created_at, ends_at FROM plan_orders WHERE customer_id = ? ORDER BY id DESC LIMIT 20', c.id),
      usage: all('SELECT day, count FROM career_usage WHERE customer_id = ? AND day >= ? ORDER BY day', c.id, since),
      activity: all('SELECT at, action, detail FROM career_activity WHERE customer_id = ? ORDER BY id DESC LIMIT 200', c.id),
    };
  });

  add('GET', '/admin/api/candidates/:id/searches/:sid', { admin: true }, (req, res, { params }) => {
    const s = one('SELECT * FROM career_job_searches WHERE id = ? AND customer_id = ?', params.sid, params.id);
    if (!s) throw new ApiError(404, 'Search not found');
    return { search: { id: s.id, status: s.status, error: s.error, createdAt: s.created_at, params: parse(s.params_json) || {}, result: parse(s.result_json) } };
  });

  add('GET', '/admin/api/candidates/:id/preps/:pid', { admin: true }, (req, res, { params }) => {
    const x = one('SELECT * FROM career_job_preps WHERE id = ? AND customer_id = ?', params.pid, params.id);
    if (!x) throw new ApiError(404, 'Plan not found');
    return { prep: { id: x.id, jobTitle: x.job_title, company: x.company, location: x.location, url: x.url, fit: x.fit, createdAt: x.created_at, plan: parse(x.prep_json) } };
  });

  add('GET', '/admin/api/candidates/:id/download', { admin: true }, (req, res, { params, query, admin }) => {
    const c = customerOr404(params.id);
    const doc = career.careerDocument(db, c.id, query.get('kind'), Number(query.get('id')));
    audit(admin, 'candidate.download', c.email, doc.label);
    career.sendDocument(res, doc);
  });
}

module.exports = { addRoutes };
