'use strict';
// A job's description: the whole text from the job's own page on the careers board (kept a week), else the start of it
// from the job list. Used by Insight (jobs.js) and by "Show job details" on the Jobs page (jobboard.js).

const { now } = require('./db');
const sources = require('./jobsources');

const DESCRIPTION_FRESH = 7 * 86400000;

const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };

/** The description of a job, '' when the careers site gives none. fetchOpts: { base } for the job-board addresses. */
async function descriptionOf(db, jobId, fetchOpts = {}) {
  const j = db.prepare(`SELECT j.external_id, j.url, j.description, j.full_description, j.full_fetched_at, c.provider, c.board, c.extra
                        FROM jobs j JOIN job_companies c ON c.id = j.company_id WHERE j.id = ?`).get(jobId);
  if (!j) return '';
  if (j.full_fetched_at && Date.now() - Date.parse(j.full_fetched_at) < DESCRIPTION_FRESH) return j.full_description || j.description || '';
  let full = null;
  try {
    full = await sources.fetchDescription({ ...(parse(j.extra) || {}), provider: j.provider, board: j.board }, { externalId: j.external_id, url: j.url }, fetchOpts);
  } catch (_) { full = null; }   // the board did not answer: use the start of the description we have
  const text = full && full.length > String(j.description || '').length ? full : (j.description || '');
  if (full != null) db.prepare('UPDATE jobs SET full_description = ?, full_fetched_at = ? WHERE id = ?').run(text, now(), jobId);
  return text;
}

module.exports = { descriptionOf, DESCRIPTION_FRESH };
