'use strict';
// Topics and resume per customer (dashboard: Topics and resume). ShortlistPrep.AI receives them with the licence check
// (/api/app/config) and the AI uses them to decide the area of the questions and answers.

const { ApiError, text, integer } = require('./http');
const { now } = require('./db');

const MAX_TOPICS = 30;
const MAX_RESUME = 20000;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const READ_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];   // tried in this order when one is busy
const MAX_UPLOAD = 8 * 1024 * 1024;                                  // a 5 MB PDF is ~6.7 MB as base64

/** Topics as a clean list: one per line or separated by commas, no duplicates. */
function cleanTopics(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const topic = String(t || '').trim().replace(/\s+/g, ' ');
    if (!topic || seen.has(topic.toLowerCase())) continue;
    if (topic.length > 100) throw new ApiError(400, `Topic is too long (maximum 100 characters): ${topic.slice(0, 40)}…`);
    seen.add(topic.toLowerCase());
    out.push(topic);
  }
  if (out.length > MAX_TOPICS) throw new ApiError(400, `At most ${MAX_TOPICS} topics`);
  return out;
}

/** {topics, resume, resumeName, updatedAt, updatedBy} for a customer; empty when nothing is set. */
function profileOf(db, customerId) {
  const row = db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?').get(customerId);
  if (!row) return { topics: [], resume: '', resumeName: '', updatedAt: null, updatedBy: '' };
  let topics = [];
  try { topics = JSON.parse(row.topics); } catch (_) { /* damaged: treat as none */ }
  return { topics, resume: row.resume_text, resumeName: row.resume_name, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

/** What the app receives with the licence check, or null when the customer has nothing set. */
function profileForLicence(db, licenceId) {
  const lic = db.prepare('SELECT customer_id FROM licences WHERE id = ?').get(licenceId);
  if (!lic) return null;
  const p = profileOf(db, lic.customer_id);
  return p.topics.length || p.resume ? { topics: p.topics, resume: p.resume, updatedAt: p.updatedAt } : null;
}

/** Plain text from a resume PDF: Gemini reads it, with the default Gemini key from the AI keys page. */
async function readPdf({ db, vault, data, upstream = GEMINI, meter }) {
  const key = db.prepare("SELECT * FROM api_keys WHERE provider = 'gemini' AND is_default = 1 AND disabled = 0").get();
  if (!key) throw new ApiError(400, 'Reading a PDF needs a default Gemini key (AI keys page). You can paste the resume text instead.');
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'application/pdf', data } },
      { text: 'Copy out all the text of this resume as plain text, in reading order. Keep headings, job titles, dates, skills and bullet points (start bullets with "- "). Do not add, summarise or comment on anything.' },
    ] }],
    generationConfig: { maxOutputTokens: 8192, temperature: 0 },
  });
  let lastError = 'The PDF could not be read.';
  for (const model of READ_MODELS) {
    let res;
    try {
      res = await fetch(`${upstream}/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': vault.decrypt(key.key_enc) }, body, signal: AbortSignal.timeout(90000) });
    } catch (_) { lastError = 'Gemini could not be reached from the server.'; continue; }
    if (res.status === 429 || res.status === 404 || res.status >= 500) { lastError = `Gemini is busy (${res.status}). Try again in a minute.`; continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(502, (json.error && json.error.message) || `Gemini refused the PDF (${res.status}).`);
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), key.id);
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const out = parts.map(p => p.text || '').join('').trim();
    if (!out) throw new ApiError(422, 'No text was found in the PDF. Paste the resume text instead.');
    if (meter) meter((json.usageMetadata && json.usageMetadata.totalTokenCount) || Math.ceil(data.length * 0.75 / 1000 * 258 / 3 + out.length / 4));   // about 258 tokens a page
    return out.slice(0, MAX_RESUME);
  }
  throw new ApiError(502, lastError);
}

/** Dashboard routes. ctx: { db, vault, add, audit, one, all, upstream?: {gemini} } (upstream: a fake Gemini in tests). */
function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;

  // every customer with what is set, for the Topics and resume page
  add('GET', '/admin/api/profiles', { admin: true }, () => ({
    customers: all(`SELECT c.id, c.email, c.name, c.organisation, p.topics, length(p.resume_text) AS resume_chars, p.resume_name, p.updated_at
                    FROM customers c LEFT JOIN customer_profiles p ON p.customer_id = c.id ORDER BY (p.updated_at IS NULL), p.updated_at DESC, c.id DESC LIMIT 1000`)
      .map(r => { let topics = []; try { topics = JSON.parse(r.topics || '[]'); } catch (_) { /* none */ } return { ...r, topics, resume_chars: r.resume_chars || 0 }; }),
  }));

  add('GET', '/admin/api/customers/:id/profile', { admin: true }, (req, res, { params }) => {
    const customer = one('SELECT id, email, name, organisation FROM customers WHERE id = ?', params.id);
    if (!customer) throw new ApiError(404, 'Customer not found');
    return { customer, profile: profileOf(db, customer.id) };
  });

  add('POST', '/admin/api/customers/:id/profile', { admin: true, perm: 'profiles.write', maxBody: 200 * 1024 }, (req, res, { params, body, admin }) => {
    const customer = one('SELECT id, email FROM customers WHERE id = ?', params.id);
    if (!customer) throw new ApiError(404, 'Customer not found');
    const topics = cleanTopics(body.topics);
    const resume = text(body.resume, MAX_RESUME, { field: 'Resume' });
    const resumeName = resume ? text(body.resumeName, 200, { field: 'File name' }) : '';
    db.prepare(`INSERT INTO customer_profiles (customer_id, topics, resume_text, resume_name, updated_at, updated_by) VALUES (?,?,?,?,?,?)
                ON CONFLICT (customer_id) DO UPDATE SET topics = excluded.topics, resume_text = excluded.resume_text, resume_name = excluded.resume_name,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(customer.id, JSON.stringify(topics), resume, resumeName, now(), admin.email);
    audit(admin, 'profile.updated', customer.email, `${topics.length} topics, resume ${resume ? resume.length + ' characters' : 'none'}`);
    return { profile: profileOf(db, customer.id) };
  });

  // a resume PDF -> its text, shown in the editor to check before saving (nothing is stored here)
  add('POST', '/admin/api/resume-text', { admin: true, perm: 'profiles.write', maxBody: MAX_UPLOAD }, async (req, res, { body }) => {
    const data = String(body.data || '');
    if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw new ApiError(400, 'Choose a PDF file');
    integer(Math.floor(data.length * 0.75), { min: 1, max: 6 * 1024 * 1024, field: 'File size in bytes' });
    return { text: await readPdf({ db, vault: ctx.vault, data: data.replace(/\s+/g, ''), upstream: (ctx.upstream && ctx.upstream.gemini) || GEMINI }) };
  });
}

module.exports = { addRoutes, cleanTopics, profileOf, profileForLicence, readPdf, MAX_RESUME };
