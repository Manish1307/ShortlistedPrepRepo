'use strict';
// Turns the agent's results into report.html (open it in a browser) and report.json.
const fs = require('fs');
const path = require('path');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const BADGE = { pass: ['#0a7a3d', 'PASS'], warn: ['#b36b00', 'WARN'], fail: ['#c0262d', 'FAIL'], blocked: ['#555', 'BLOCKED'] };
const badge = s => `<span class="b" style="background:${(BADGE[s] || BADGE.blocked)[0]}">${(BADGE[s] || BADGE.blocked)[1]}</span>`;

/** The action list: issues grouped by what to fix, most frequent first. */
function feedback(r) {
  const items = [];
  const add = (sev, area, msg, where) => items.push({ sev, area, msg, where });
  if (r.fatal) add('fail', 'Run', r.fatal, '');
  for (const w of r.website) for (const i of w.issues) add('fail', 'Website', `${w.page}: ${i}`, w.page);
  if (r.browser) {
    for (const c of r.browser.checks || []) if (!c.ok) add('fail', 'Browser', `${c.name}: ${c.error}`, '');
    for (const e of r.browser.consoleErrors || []) add('warn', 'Browser console', e, '');
    for (const e of r.browser.failedRequests || []) add('warn', 'Failed request', e, '');
  }
  for (const x of r.resumes) for (const i of x.issues) if (i.sev !== 'info') add(i.sev, 'Live Search', `${x.title}: ${i.msg}`, x.id);
  // group repeated messages (same text once the resume name is removed)
  const key = i => `${i.area}|${i.msg.replace(/^[^:]+:\s*/, '').replace(/\d+/g, 'N')}`;
  const groups = new Map();
  for (const i of items) { const g = groups.get(key(i)) || { ...i, n: 0, where: [] }; g.n++; if (i.where) g.where.push(i.where); groups.set(key(i), g); }
  return [...groups.values()].sort((a, b) => (a.sev === b.sev ? b.n - a.n : a.sev === 'fail' ? -1 : 1));
}

const BUCKET_NAME = { high: 'High probability', medium: 'Medium probability', stretch: 'Low probability (stretch)' };

/** Every job of one resume's search, grouped by probability, with the Insight (skill matrix and gaps) tested for the best job. */
function detail(x) {
  const jobs = x.allJobs || [];
  const by = b => jobs.filter(j => j.bucket === b);
  const jobRows = b => by(b).map(j => `<tr><td>${esc(j.score)}</td><td><a href="${esc(j.url)}">${esc(j.title)}</a><br><small>${esc(j.company)} · ${esc(j.location || '')}</small></td>
    <td>${esc(j.why)}${j.gap ? `<br><small>Gap: ${esc(j.gap)}</small>` : ''}</td></tr>`).join('');
  const groups = ['high', 'medium', 'stretch'].filter(b => by(b).length).map(b =>
    `<h4>${BUCKET_NAME[b]} (${by(b).length})</h4><table><tr><th>Score</th><th>Job</th><th>Why it fits</th></tr>${jobRows(b)}</table>`).join('');
  const ins = (x.insights || []).map(i => {
    if (!i.matrix) return `<div class="i ${i.blocked || i.skipped ? 'info' : 'fail'}">Insight for ${esc(i.job.title)} (${esc(i.job.company)}): ${esc(i.skipped || (i.issues[0] && i.issues[0].msg) || 'no result')}</div>`;
    const m = i.matrix;
    return `<h4>Insight: ${esc(i.job.title)} at ${esc(i.job.company)} <small>(fit ${esc(i.fit)} · matrix ${esc(m.score)} · ${esc(i.seconds)}s)</small></h4>
      <p class="m">${esc(i.summary)}</p>
      <table><tr><th>Requirement</th><th>Type</th><th>Priority</th><th>Weight</th><th>Your status</th><th>Evidence in resume</th></tr>
      ${m.rows.map(r => `<tr><td>${esc(r.skill)}</td><td>${esc(r.type)}</td><td>${esc(r.priority)}</td><td>${esc(r.weight)}</td><td>${esc(r.status)}</td><td><small>${esc(r.evidence)}</small></td></tr>`).join('')}</table>
      <p><b>Gaps (${i.gaps.length}, worth ${esc(i.gapPoints)} points):</b></p>
      ${i.gaps.length ? `<table><tr><th>Skill</th><th>Points</th><th>Importance</th><th>How to close</th><th>Hours</th></tr>${i.gaps.map(g => `<tr><td>${esc(g.skill)}</td><td>${esc(g.points)}</td><td>${esc(g.importance)}</td><td>${esc(g.howToClose)}</td><td>${esc(g.hours)}</td></tr>`).join('')}</table>` : '<p class="m">No gaps listed.</p>'}
      <p class="m">Matched: ${esc(i.matched.join(', ') || '–')} · Revise: ${esc(i.revise.map(v => v.topic).join(', ') || '–')} · Plan steps: ${i.plan.length} · Tips: ${i.tips.length} · Practice questions: ${i.questions.length}</p>
      ${i.issues.map(v => `<div class="i ${esc(v.sev)}">${esc(v.msg)}</div>`).join('')}`;
  }).join('');
  return `<details><summary>${badge(x.status)} <b>${esc(x.title)}</b> · ${x.jobs.total} jobs: ${x.jobs.high} high · ${x.jobs.medium} med · ${x.jobs.stretch} low</summary>
    ${x.profile && x.profile.summary ? `<p class="m">AI's reading of the resume: ${esc(x.profile.summary)}</p>` : ''}
    ${groups || '<p class="m">No jobs.</p>'}${ins}</details>`;
}

function writeReport(r, dir) {
  const rs = r.resumes;
  const count = s => rs.filter(x => x.status === s).length;
  const avg = rs.filter(x => x.seconds != null);
  const avgSec = avg.length ? Math.round(avg.reduce((a, x) => a + x.seconds, 0) / avg.length) : null;
  const fb = feedback(r);
  const byGroup = {};
  for (const x of rs) (byGroup[x.group] = byGroup[x.group] || []).push(x);

  const rows = rs.map(x => `<tr>
    <td>${badge(x.status)}</td><td><b>${esc(x.title)}</b><br><small>${esc(x.id)} · ${esc(x.group)}</small></td>
    <td>${esc((x.profile && x.profile.field) || '–')}<br><small>${esc(((x.profile && x.profile.targetRoles) || []).slice(0, 3).join(', '))}</small></td>
    <td>${x.ats != null ? x.ats : '–'}</td>
    <td>${x.jobs.total}<br><small>${x.jobs.high} high · ${x.jobs.medium} med · ${x.jobs.stretch} low</small></td>
    <td>${x.relevance != null ? x.relevance + '%' : '–'}</td><td>${x.seconds != null ? x.seconds + 's' : '–'}</td>
    <td>${x.top.map(j => `<a href="${esc(j.url)}">${esc(j.title)}</a> <small>${esc(j.company)} · ${esc(j.score)}</small>`).join('<br>') || '–'}
        ${x.issues.map(i => `<div class="i ${esc(i.sev)}">${esc(i.msg)}</div>`).join('')}</td></tr>`).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ShortlistPrep QA report ${esc(r.startedAt.slice(0, 16))}</title>
<style>
 :root{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--mut:#667085;--line:#e4e7ec}
 @media (prefers-color-scheme:dark){:root{--bg:#10141b;--card:#181e28;--fg:#e6e9ef;--mut:#98a2b3;--line:#2a3342}}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif;padding:24px 16px}
 .w{max-width:1200px;margin:auto} h1{margin:0 0 4px} h2{margin:28px 0 10px} small,.m{color:var(--mut)}
 .cards{display:flex;gap:12px;flex-wrap:wrap}.c{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:120px}
 .c b{display:block;font-size:26px}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top} th{font-size:12px;color:var(--mut)}
 .b{color:#fff;border-radius:5px;padding:2px 7px;font-size:11px;font-weight:700}
 .i{margin-top:4px;font-size:12px;padding:3px 6px;border-radius:5px}.i.fail{background:#c0262d22}.i.warn{background:#b36b0022}.i.info{background:#5552}
 a{color:#2563eb;word-break:break-word} .scroll{overflow-x:auto}
 details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:8px 14px} summary{cursor:pointer;padding:4px 0}
 details table{margin:6px 0 14px;font-size:13px} h4{margin:16px 0 4px}
</style></head><body><div class="w">
<h1>ShortlistPrep QA report</h1>
<div class="m">${esc(r.startedAt)} · site ${esc(r.site)} · API ${esc(r.api)}${r.account ? ' · account ' + esc(r.account.email) : ''}</div>
${r.fatal ? `<p class="i fail">The run stopped: ${esc(r.fatal)}</p>` : ''}
<div class="cards" style="margin-top:14px">
 <div class="c"><b>${rs.length}</b>resumes tested</div><div class="c"><b style="color:#0a7a3d">${count('pass')}</b>pass</div>
 <div class="c"><b style="color:#b36b00">${count('warn')}</b>warnings</div><div class="c"><b style="color:#c0262d">${count('fail')}</b>failed</div>
 <div class="c"><b>${count('blocked')}</b>blocked by limits</div><div class="c"><b>${avgSec == null ? '–' : avgSec + 's'}</b>avg job search</div>
 <div class="c"><b>${r.website.filter(w => w.ok).length}/${r.website.length}</b>website checks OK</div></div>

<h2>Feedback to incorporate</h2>
${fb.length ? `<table><tr><th></th><th>Area</th><th>What to fix</th><th>Seen</th></tr>${fb.map(f => `<tr><td>${badge(f.sev)}</td><td>${esc(f.area)}</td><td>${esc(f.msg)}</td><td>${f.n > 1 ? f.n + '×' : ''}</td></tr>`).join('')}</table>` : '<p>Nothing to fix: every check passed.</p>'}

<h2>Live Search by resume</h2>
<div class="scroll"><table><tr><th></th><th>Resume</th><th>Detected field / target roles</th><th>ATS</th><th>Jobs</th><th>Fit of top 20 titles</th><th>Time</th><th>Best jobs and notes</th></tr>${rows || '<tr><td colspan=8>No resumes were tested.</td></tr>'}</table></div>

<h2>Every job and Insight, by resume</h2>
<p class="m">Click a resume to open the full list (high, medium and low probability) and the Insight skill matrix and gaps.</p>
${rs.map(detail).join('') || '<p class="m">No resumes were tested.</p>'}

<h2>Browser: login and Career toolkit</h2>
${!r.browser ? '<p class="m">Skipped (UI=off).</p>' : r.browser.skipped ? `<p class="m">${esc(r.browser.skipped)}</p>` :
  `<table>${r.browser.checks.map(c => `<tr><td>${badge(c.ok ? 'pass' : 'fail')}</td><td>${esc(c.name)}</td><td>${esc(c.error || '')}</td></tr>`).join('')}</table>
   <p class="m">Screenshots are in the <code>screenshots</code> folder next to this report.</p>`}

<h2>Public website</h2>
<table>${r.website.map(w => `<tr><td>${badge(w.ok ? 'pass' : 'fail')}</td><td>${esc(w.page)}</td><td>${esc(w.issues.join('; '))}</td></tr>`).join('')}</table>
<p class="m">Finished ${esc(r.finishedAt)}. Full data: report.json</p>
</div></body></html>`;

  const files = { html: path.join(dir, 'report.html'), json: path.join(dir, 'report.json') };
  fs.writeFileSync(files.html, html);
  fs.writeFileSync(files.json, JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(path.dirname(dir), 'latest.html'), html);
  return files;
}

module.exports = { writeReport, feedback };
