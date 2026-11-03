#!/usr/bin/env node
'use strict';
// Finds which candidate employers (scripts/india-candidates.js) have a careers board the app can read (Greenhouse, Lever,
// Ashby, SmartRecruiters) that returns jobs, and writes admin/lib/jobcatalogue-india.js with those only.
//   node scripts/probe-companies.js            probe everything
//   node scripts/probe-companies.js 40         probe the first 40 names (a quick check; writes nothing)
// Needs internet. A name that finds no board is simply left out: nothing is guessed into the app.

const fs = require('fs');
const path = require('path');
const sources = require('../admin/lib/jobsources');
const { BY_SECTOR, WRONG_MATCH, SECTOR_OF } = require('./india-candidates');
const catalogue = require('../admin/lib/jobcatalogue');

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const known = new Set(catalogue.CATALOGUE.concat(catalogue.SECTOR_COMPANIES).map(c => norm(c.name)));
const dns = require('dns').promises;
// a guess that does not exist must fail fast: the app's own 30 s limit would hold a worker for minutes
const quickFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
const CAREERS = {
  greenhouse: b => `https://boards.greenhouse.io/${b}`, lever: b => `https://jobs.lever.co/${b}`,
  ashby: b => `https://jobs.ashbyhq.com/${b}`, smartrecruiters: b => `https://jobs.smartrecruiters.com/${b}`,
};

// each name once, with the sector it was listed under first
const names = new Map();
for (const [sector, list] of Object.entries(BY_SECTOR)) {
  for (const raw of list.split(',')) {
    const name = raw.trim();
    if (name && !names.has(norm(name)) && !known.has(norm(name))) names.set(norm(name), { name, sector });
  }
}
const limit = Number(process.argv[2]) || 0;
const todo = [...names.values()].slice(0, limit || undefined);

/** Workday: a tenant that exists answers DNS; then the usual site names are tried. */
async function probeWorkday(name) {
  const key = norm(name), first = name.split(/[\s.]+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const pascal = name.replace(/[^A-Za-z0-9]/g, '');
  for (const tenant of [...new Set([key, first])].filter(t => t.length > 2)) {
    for (const wd of ['wd1', 'wd3', 'wd5']) {
      const host = tenant + '.' + wd + '.myworkdayjobs.com';
      try { await dns.lookup(host); } catch (_) { continue; }
      for (const site of [...new Set(['External', 'Careers', 'External_Career_Site', 'ExternalCareerSite', pascal, pascal + 'Careers', pascal + '_Careers', pascal + 'External', tenant, tenant + 'careers', 'jobs'])]) {
        try {
          const jobs = await sources.fetchJobs({ provider: 'workday', board: tenant + '/' + site, tenant, wd, site }, { fetchImpl: quickFetch });
          if (jobs.length) return { provider: 'workday', board: tenant + '/' + site, url: 'https://' + host + '/' + site, jobs: jobs.length, india: jobs.filter(j => j.country === 'India').length };
        } catch (_) { /* not this site */ }
      }
    }
  }
  return null;
}

async function probe({ name }) {
  const key = norm(name), hyphen = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), pascal = name.replace(/[^A-Za-z0-9]/g, '');
  const first = name.split(/[\s.]+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const tries = [['greenhouse', key], ['greenhouse', hyphen], ['lever', key], ['lever', hyphen], ['ashby', key], ['ashby', hyphen], ['smartrecruiters', pascal],
    ...(first.length > 3 && first !== key ? [['greenhouse', first], ['lever', first], ['ashby', first]] : [])]
    .filter(([, b], i, a) => b && a.findIndex(x => x[0] === a[i][0] && x[1] === b) === i);
  for (const [provider, board] of tries) {
    try {
      const jobs = await sources.fetchJobs({ provider, board }, { fetchImpl: quickFetch });
      if (jobs.length) return { provider, board, jobs: jobs.length, india: jobs.filter(j => j.country === 'India').length };
    } catch (_) { /* not a board of this system */ }
  }
  return probeWorkday(name);
}

(async () => {
  const hits = [];
  let i = 0, done = 0;
  const worker = async () => {
    while (i < todo.length) {
      const c = todo[i++];
      const r = await probe(c);
      done++;
      if (r && r.india < 1) { /* hires nowhere in India, or another company with the same name */ }
      else if (r) { hits.push({ ...c, ...r }); console.log(`[${done}/${todo.length}] FOUND ${c.name} -> ${r.provider}/${r.board} (${r.jobs} jobs, ${r.india} in India)`); }
      else if (done % 50 === 0) console.log(`[${done}/${todo.length}] ...`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.PROBE_WORKERS) || 40 }, worker));
  hits.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\n${hits.length} of ${todo.length} candidates have a readable board`);
  if (limit) return;
  const kept = hits.filter(h => !WRONG_MATCH.includes(h.name));
  const rows = kept.map(h => `  { name: ${JSON.stringify(h.name)}, url: ${JSON.stringify(h.url || CAREERS[h.provider](h.board))}, sector: ${JSON.stringify(SECTOR_OF[h.name] || 'it')} },   // ${h.jobs} jobs, ${h.india} in India`);
  fs.writeFileSync(path.join(__dirname, '..', 'admin', 'lib', 'jobcatalogue-india.js'),
`'use strict';
// Indian (and India-hiring) employers whose careers board the app can read. Made by scripts/probe-companies.js: each
// one answered with jobs when it was probed (${new Date().toISOString().slice(0, 10)}). Run the script again to refresh the list.
// Used to find an employer by name (a typed company, or one the AI names for the candidate); not fetched unless asked for.
const INDIA_COMPANIES = [
${rows.join('\n')}
];
module.exports = { INDIA_COMPANIES };
`);
  console.log('Wrote admin/lib/jobcatalogue-india.js');
})();
