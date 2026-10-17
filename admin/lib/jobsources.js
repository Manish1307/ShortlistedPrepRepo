'use strict';
// Real, active job postings straight from companies' own career sites. Most companies publish their openings
// through a job-board system with a public listing API (the same data their careers page shows):
//   Greenhouse      https://boards.greenhouse.io/<board>        or job-boards.greenhouse.io/<board>
//   Lever           https://jobs.lever.co/<company>
//   SmartRecruiters https://careers.smartrecruiters.com/<company> or jobs.smartrecruiters.com/<company>
//   Ashby           https://jobs.ashbyhq.com/<org>
//   Workday         https://<tenant>.wd<N>.myworkdayjobs.com/<site>  (optionally with /en-US/)
// The admin adds a company by its careers URL; parseBoardUrl() finds the system and the board name.
// Every job keeps the company's own link, so candidates always apply on the real site.

const MAX_JOBS = 1000;            // per company
const TIMEOUT = 30000;

/** {provider, board, tenant?, wd?, site?} from a careers URL, or null when the system is not supported. */
function parseBoardUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const board = host.startsWith('boards-api.') ? parts[2] : (u.searchParams.get('for') || parts[0]);
    return board ? { provider: 'greenhouse', board } : null;
  }
  if (host === 'jobs.lever.co' || host === 'api.lever.co') {
    const board = host === 'api.lever.co' ? parts[2] : parts[0];
    return board ? { provider: 'lever', board } : null;
  }
  if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    const board = host === 'api.smartrecruiters.com' ? parts[2] : parts[0];
    return board ? { provider: 'smartrecruiters', board } : null;
  }
  if (host === 'jobs.ashbyhq.com') return parts[0] ? { provider: 'ashby', board: parts[0] } : null;
  const wd = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const site = parts.filter(p => !/^[a-z]{2}-[A-Z]{2}$/.test(p))[0];
    return site ? { provider: 'workday', board: `${wd[1]}/${site}`, tenant: wd[1], wd: wd[2], site } : null;
  }
  return null;
}

// ---- country from a location ----
const COUNTRY_CODES = { IN: 'India', US: 'United States', GB: 'United Kingdom', UK: 'United Kingdom', CA: 'Canada', AU: 'Australia', DE: 'Germany',
  FR: 'France', NL: 'Netherlands', IE: 'Ireland', SG: 'Singapore', AE: 'United Arab Emirates', JP: 'Japan', ES: 'Spain', PL: 'Poland', BR: 'Brazil',
  MX: 'Mexico', IL: 'Israel', SE: 'Sweden', CH: 'Switzerland', PH: 'Philippines', MY: 'Malaysia', NZ: 'New Zealand', PT: 'Portugal', IT: 'Italy',
  RO: 'Romania', CZ: 'Czechia', AR: 'Argentina', CO: 'Colombia', ZA: 'South Africa', KR: 'South Korea', CN: 'China', HK: 'Hong Kong', SA: 'Saudi Arabia', QA: 'Qatar' };
const COUNTRY_NAMES = [...new Set(Object.values(COUNTRY_CODES).concat(['Taiwan', 'Israel', 'Vietnam', 'Indonesia', 'Thailand', 'Egypt', 'Turkey', 'Hungary', 'Austria', 'Belgium', 'Denmark', 'Finland', 'Norway', 'Greece', 'Costa Rica', 'Chile', 'Peru', 'Kenya', 'Nigeria', 'Pakistan', 'Bangladesh', 'Sri Lanka']))];
const INDIA_CITIES = /\b(india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|gurugram|gurgaon|noida|new delhi|delhi|kolkata|ahmedabad|kochi|cochin|coimbatore|trivandrum|thiruvananthapuram|jaipur|indore|chandigarh|mohali|nagpur|vadodara|bhubaneswar|visakhapatnam|mysuru|mysore|mangaluru|lucknow)\b/i;
const NAME_HINTS = [
  [INDIA_CITIES, 'India'],
  [/\b(united states|usa|u\.s\.|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta|remote[ ,-]+us)\b/i, 'United States'],
  [/\b(united kingdom|uk|london|manchester|edinburgh|england|scotland)\b/i, 'United Kingdom'],
  [/\b(canada|toronto|vancouver|montreal)\b/i, 'Canada'],
  [/\b(australia|sydney|melbourne|brisbane)\b/i, 'Australia'],
  [/\b(germany|berlin|munich|münchen|hamburg)\b/i, 'Germany'],
  [/\b(ireland|dublin)\b/i, 'Ireland'], [/\b(singapore)\b/i, 'Singapore'], [/\b(netherlands|amsterdam)\b/i, 'Netherlands'],
  [/\b(france|paris)\b/i, 'France'], [/\b(dubai|abu dhabi|united arab emirates|uae)\b/i, 'United Arab Emirates'],
  [/\b(poland|warsaw|krakow|kraków)\b/i, 'Poland'], [/\b(spain|madrid|barcelona)\b/i, 'Spain'], [/\b(japan|tokyo)\b/i, 'Japan'],
  [/\b(philippines|manila)\b/i, 'Philippines'], [/\b(mexico|ciudad de méxico|guadalajara)\b/i, 'Mexico'], [/\b(brazil|são paulo|sao paulo)\b/i, 'Brazil'],
];
function countryOf(location, code) {
  const c = String(code || '').trim().toUpperCase();
  if (COUNTRY_CODES[c]) return COUNTRY_CODES[c];
  if (c.length > 3) return code;                 // already a country name
  const text = String(location || '');
  // Workday style: "US, CA, Santa Clara" (a country code first) or "Taiwan, Taipei" (a country name first)
  const first = text.split(',')[0].trim();
  if (/^[A-Z]{2}$/.test(first) && COUNTRY_CODES[first]) return COUNTRY_CODES[first];
  const named = COUNTRY_NAMES.find(n => n.toLowerCase() === first.toLowerCase());
  if (named) return named;
  for (const [re, name] of NAME_HINTS) if (re.test(text)) return name;
  return /remote/i.test(text) ? 'Remote' : '';
}

const stripHtml = html => String(html || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const iso = v => { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/** Workday shows "Posted Today", "Posted Yesterday", "Posted 5 Days Ago", "Posted 30+ Days Ago". */
function workdayDate(text, nowMs) {
  const s = String(text || '').toLowerCase();
  const day = 86400000;
  if (/today/.test(s)) return new Date(nowMs).toISOString();
  if (/yesterday/.test(s)) return new Date(nowMs - day).toISOString();
  const m = /(\d+)\+?\s*days?/.exec(s);
  return m ? new Date(nowMs - Number(m[1]) * day).toISOString() : null;
}

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

/**
 * The company's open jobs, normalised to {externalId, title, location, country, department, employmentType, postedAt,
 * url, description}. source: {provider, board, defaultCountry?}. Throws with a readable message when the board fails.
 */
async function fetchJobs(source, { fetchImpl = fetch, base = {}, now = Date.now } = {}) {
  const job = j => ({ ...j, title: String(j.title || '').replace(/\s+/g, ' ').trim(), country: j.country || countryOf(j.location) || source.defaultCountry || '', description: String(j.description || '').slice(0, 4000) });
  const p = source.provider;
  if (p === 'greenhouse') {
    const data = await getJson(fetchImpl, `${base.greenhouse || 'https://boards-api.greenhouse.io/v1/boards'}/${encodeURIComponent(source.board)}/jobs?content=true`);
    return (data.jobs || []).slice(0, MAX_JOBS).map(j => job({
      externalId: String(j.id), title: j.title, location: (j.location && j.location.name) || '',
      department: ((j.departments || [])[0] || {}).name || '', employmentType: '',
      postedAt: iso(j.first_published || j.updated_at), url: j.absolute_url, description: stripHtml(j.content),
    }));
  }
  if (p === 'lever') {
    const data = await getJson(fetchImpl, `${base.lever || 'https://api.lever.co/v0/postings'}/${encodeURIComponent(source.board)}?mode=json`);
    return (Array.isArray(data) ? data : []).slice(0, MAX_JOBS).map(j => job({
      externalId: String(j.id), title: j.text, location: (j.categories && j.categories.location) || '',
      country: j.country ? countryOf('', j.country) : '', department: (j.categories && j.categories.team) || '',
      employmentType: (j.categories && j.categories.commitment) || '', postedAt: iso(j.createdAt), url: j.hostedUrl,
      description: j.descriptionPlain || stripHtml(j.description),
    }));
  }
  if (p === 'smartrecruiters') {
    const out = [];
    for (let offset = 0; offset < MAX_JOBS; offset += 100) {
      const data = await getJson(fetchImpl, `${base.smartrecruiters || 'https://api.smartrecruiters.com/v1/companies'}/${encodeURIComponent(source.board)}/postings?limit=100&offset=${offset}`);
      const page = data.content || [];
      for (const j of page) {
        const loc = j.location || {};
        out.push(job({
          externalId: String(j.id), title: j.name, location: [loc.city, loc.region].filter(Boolean).join(', ') + (loc.remote ? ' (Remote)' : ''),
          country: loc.country ? countryOf('', loc.country) : '', department: (j.department && j.department.label) || '',
          employmentType: (j.typeOfEmployment && j.typeOfEmployment.label) || '', postedAt: iso(j.releasedDate),
          url: `https://jobs.smartrecruiters.com/${encodeURIComponent(source.board)}/${j.id}`, description: '',
        }));
      }
      if (page.length < 100 || out.length >= (data.totalFound || 0)) break;
    }
    return out;
  }
  if (p === 'ashby') {
    const data = await getJson(fetchImpl, `${base.ashby || 'https://api.ashbyhq.com/posting-api/job-board'}/${encodeURIComponent(source.board)}`);
    return (data.jobs || []).filter(j => j.isListed !== false).slice(0, MAX_JOBS).map(j => job({
      externalId: String(j.id), title: j.title, location: j.location || '',
      country: (((j.address || {}).postalAddress || {}).addressCountry) ? countryOf('', j.address.postalAddress.addressCountry) : '',
      department: j.department || '', employmentType: j.employmentType || '', postedAt: iso(j.publishedAt),
      url: j.jobUrl || j.applyUrl, description: j.descriptionPlain || stripHtml(j.descriptionHtml),
    }));
  }
  if (p === 'workday') {
    const [tenant, site] = source.board.split('/');
    const wd = source.wd || 'wd1';
    const origin = base.workday ? base.workday : `https://${tenant}.${wd}.myworkdayjobs.com`;
    const fetchPage = offset => getJson(fetchImpl, `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
    });
    const page = offset => fetchPage(offset).then(data => data.jobPostings || []);
    // Workday only sends the total with the first page; the other pages are fetched a few at a time
    const first = await fetchPage(0);
    const postings = (first.jobPostings || []).slice();
    const total = Math.min(MAX_JOBS, first.total || 0);
    if (postings.length === 20) {
      const offsets = [];
      for (let o = 20; o < total; o += 20) offsets.push(o);
      for (let i = 0; i < offsets.length; i += 5) {
        const pages = await Promise.all(offsets.slice(i, i + 5).map(page));
        pages.forEach(p => postings.push(...p));
        if (pages.some(p => p.length < 20)) break;
      }
    }
    return postings.slice(0, MAX_JOBS).map(j => job({
      externalId: String((j.bulletFields || [])[0] || j.externalPath), title: j.title, location: j.locationsText || '',
      department: '', employmentType: '', postedAt: workdayDate(j.postedOn, now()),
      url: `https://${tenant}.${wd}.myworkdayjobs.com/${site}${j.externalPath}`, description: '',
    }));
  }
  throw new Error('Unsupported job board');
}

module.exports = { parseBoardUrl, fetchJobs, countryOf, workdayDate, stripHtml, MAX_JOBS };
