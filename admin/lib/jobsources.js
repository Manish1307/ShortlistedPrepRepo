'use strict';
// Real, active job postings straight from companies' own career sites. Most companies publish their openings
// through a job-board system with a public listing API (the same data their careers page shows):
//   Greenhouse      https://boards.greenhouse.io/<board>        or job-boards.greenhouse.io/<board>
//   Lever           https://jobs.lever.co/<company>
//   SmartRecruiters https://careers.smartrecruiters.com/<company> or jobs.smartrecruiters.com/<company>
//   Ashby           https://jobs.ashbyhq.com/<org>
//   Workday         https://<tenant>.wd<N>.myworkdayjobs.com/<site>  (optionally with /en-US/)
//   Oracle Recruiting Cloud  https://<host>.oraclecloud.com/hcmUI/CandidateExperience/en/sites/<site>
//   Amazon          https://www.amazon.jobs (board: a country code, e.g. IND)
//   Capgemini       https://careers.capgemini.com (board: a country site, e.g. in-en)
// SAP SuccessFactors career sites have no recognisable address, so they are only used from the built-in list
// (jobcatalogue.js): "sfunified" for the newer design (a JSON search service), "sfclassic" for the older one (pages).
// A careers URL is turned into {provider, board} by parseBoardUrl(); the built-in list gives it directly.
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
  if (/(^|\.)oraclecloud\.com$/.test(host)) {
    const i = parts.indexOf('sites');
    const site = i >= 0 ? parts[i + 1] : null;
    return site ? { provider: 'oraclehcm', board: `${host}/${site}` } : null;
  }
  if (host === 'www.amazon.jobs' || host === 'amazon.jobs') return { provider: 'amazon', board: 'IND' };
  if (host === 'careers.capgemini.com' || (host === 'www.capgemini.com' && /careers|job/i.test(u.pathname))) return { provider: 'capgemini', board: 'in-en' };
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

/** Run fn over the items a few at a time (pages of one board), keeping the order of the results. */
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}
/** "10/18/26" (SuccessFactors) → ISO date. */
function mdyDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(text || '').trim());
  if (!m) return iso(text);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return iso(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
}
const first = v => (Array.isArray(v) ? v[0] : v) || '';
const decode = t => String(t || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ');
const BIG_SITE = 500;   // newest jobs read from the very large career sites (HCLTech, Wipro, EY: thousands of openings)

async function getText(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.text();
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
  const job = j => ({ ...j, title: String(j.title || '').replace(/\s+/g, ' ').trim(), country: j.country || countryOf(j.location) || source.defaultCountry || '', description: String(j.description || '').slice(0, 8000) });
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
    let appliedFacets = {};
    const fetchPage = offset => getJson(fetchImpl, `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets, limit: 20, offset, searchText: '' }),
    });
    const page = offset => fetchPage(offset).then(data => data.jobPostings || []);
    // Workday only sends the total with the first page; the other pages are fetched a few at a time
    let first = await fetchPage(0);
    if (source.country) {
      // a global site (e.g. Accenture): keep to one country with the site's own location filter, when it has one
      const want = source.country.toLowerCase();
      // a value is either in the facet itself or in a nested group (Location → Country), which has its own parameter
      const options = (first.facets || []).flatMap(f => (f.values || []).flatMap(x => (x.values ? x.values.map(v => [x.facetParameter, v]) : [[f.facetParameter, x]])));
      const hit = options.find(([, v]) => String(v.descriptor || '').toLowerCase() === want);
      if (hit) { appliedFacets = { [hit[0]]: [hit[1].id] }; first = await fetchPage(0); }
    }
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
      externalId: String((j.bulletFields || [])[0] || j.externalPath), title: j.title,
      location: j.locationsText || decodeURIComponent((/^\/job\/([^/]+)\//.exec(j.externalPath || '') || [])[1] || '').replace(/-/g, ' '),   // some sites leave locationsText empty
      department: '', employmentType: '', postedAt: workdayDate(j.postedOn, now()),
      url: `https://${tenant}.${wd}.myworkdayjobs.com/${site}${j.externalPath}`, description: '',
      ...(appliedFacets && Object.keys(appliedFacets).length && source.country ? { country: source.country } : {}),
    }));
  }
  if (p === 'sfunified') {
    // newer SAP SuccessFactors career sites: POST /services/recruiting/v1/jobs, 10 jobs a page
    const host = source.board;
    const origin = base.sfunified ? `${base.sfunified}/${host}` : `https://${host}`;
    const page = n => getJson(fetchImpl, `${origin}/services/recruiting/v1/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ locale: 'en_US', pageNumber: n, sortBy: 'date', keywords: '', location: source.location || '', facetFilters: source.facets || {}, brand: '', skills: [], categoryId: 0, alertId: '', rcmCandidateId: '' }),
    });
    const firstPage = await page(0);
    const pages = Math.min(Math.ceil(Math.min(firstPage.totalJobs || 0, BIG_SITE) / 10), BIG_SITE / 10);
    const rest = await inBatches(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 1), 5, page);
    return [firstPage, ...rest].flatMap(d => d.jobSearchResult || []).map(x => x.response || {}).filter(r => r.id).slice(0, BIG_SITE).map(r => job({
      externalId: String(r.id), title: decode(r.unifiedStandardTitle || r.title),
      location: decode(r.custprimecity || first(r.jobLocationShort)).replace(/<br\s*\/?>/gi, ' ').replace(/,\s*\d{4,6}\s*$/, '').trim(),
      country: first(r.custCountryRegion) || first(r.jobLocationCountry), department: first(r.custRMKMappingPicklist), employmentType: '',
      postedAt: mdyDate(r.unifiedStandardStart), url: `https://${host}/job/${encodeURIComponent(r.urlTitle || r.unifiedUrlTitle || 'job')}/${r.id}-en_US`, description: '',
    }));
  }
  if (p === 'sfclassic') {
    // older SAP SuccessFactors career sites: /search/ pages of 25 jobs (board: host plus an optional path, e.g. careers.ey.com/ey)
    const host = source.board.split('/')[0];
    const origin = base.sfclassic ? `${base.sfclassic}/${source.board}` : `https://${source.board}`;
    const page = row => getText(fetchImpl, `${origin}/search/?q=&locationsearch=${encodeURIComponent(source.location || '')}&startrow=${row}`, { headers: { Accept: 'text/html' } });
    const html0 = await page(0);
    const total = Number(((/of\s*<b>\s*([\d,]+)\s*<\/b>/i.exec(html0) || [])[1] || '0').replace(/,/g, '')) || 0;
    const rows = [];
    for (let r = 25; r < Math.min(total, BIG_SITE); r += 25) rows.push(r);
    const pages = [html0, ...(await inBatches(rows, 5, page))];
    const seen = new Set(), out = [];
    for (const html of pages) {
      for (const tr of html.split('<tr class="data-row"').slice(1)) {
        const a = /<a[^>]*href="([^"]+)"[^>]*class="jobTitle-link"[^>]*>([^<]+)<\/a>|<a[^>]*class="jobTitle-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(tr);
        if (!a) continue;
        const href = a[1] || a[3], title = a[2] || a[4];
        const id = (/\/(\d+)\/?$/.exec(href) || [])[1] || href;
        if (seen.has(id)) continue;
        seen.add(id);
        const loc = decode(((/<span class="jobLocation">([\s\S]*?)<\/span>/.exec(tr) || [])[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\+\d+ more…?/, '').replace(/\s+/g, ' ').replace(/,\s*\d{4,6}\s*$/, '').trim();
        const date = ((/<span class="jobDate[^"]*">([^<]+)<\/span>/.exec(tr) || [])[1] || '').trim();
        out.push(job({ externalId: String(id), title: decode(title).trim(), location: loc, department: '', employmentType: '', postedAt: iso(date),
          url: href.startsWith('http') ? href : `https://${host}${href}`, description: '' }));
      }
    }
    return out.slice(0, BIG_SITE);
  }
  if (p === 'oraclehcm') {
    // Oracle Recruiting Cloud: the public requisitions REST service, 25 jobs a page (board: host/site)
    const [host, site] = source.board.split('/');
    const origin = base.oraclehcm ? `${base.oraclehcm}/${host}` : `https://${host}`;
    const page = offset => getJson(fetchImpl, `${origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${encodeURIComponent(site)},limit=25,offset=${offset},sortBy=POSTING_DATES_DESC`, { headers: { Accept: 'application/json' } })
      .then(d => ((d.items || [])[0]) || {});
    const p0 = await page(0);
    const total = Math.min(p0.TotalJobsCount || 0, MAX_JOBS);
    const offsets = [];
    for (let o = 25; o < total; o += 25) offsets.push(o);
    const all = [p0, ...(await inBatches(offsets, 5, page))].flatMap(x => x.requisitionList || []);
    return all.slice(0, MAX_JOBS).map(r => job({
      externalId: String(r.Id), title: r.Title, location: r.PrimaryLocation || '', country: r.PrimaryLocationCountry ? countryOf(r.PrimaryLocation, r.PrimaryLocationCountry) : '',
      department: r.JobFamily || r.Department || '', employmentType: r.JobSchedule || '', postedAt: iso(r.PostedDate),
      url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${encodeURIComponent(r.Id)}`, description: stripHtml(r.ShortDescriptionStr || ''),
    }));
  }
  if (p === 'amazon') {
    // Amazon's own job search: 100 jobs a page, newest first (board: a country code, e.g. IND)
    const origin = base.amazon || 'https://www.amazon.jobs';
    const page = offset => getJson(fetchImpl, `${origin}/en/search.json?country=${encodeURIComponent(source.board || 'IND')}&result_limit=100&offset=${offset}&sort=recent`, { headers: { Accept: 'application/json' } });
    const p0 = await page(0);
    const offsets = [];
    for (let o = 100; o < Math.min(p0.hits || 0, MAX_JOBS); o += 100) offsets.push(o);
    const all = [p0, ...(await inBatches(offsets, 5, page))].flatMap(d => d.jobs || []);
    return all.slice(0, MAX_JOBS).map(j => job({
      externalId: String(j.id_icims || j.id), title: j.title, location: j.location || [j.city, j.country_code].filter(Boolean).join(', '),
      department: j.job_category || '', employmentType: j.job_schedule_type || '', postedAt: iso(j.posted_date),
      url: `https://www.amazon.jobs${j.job_path}`, description: [j.description || j.description_short, j.basic_qualifications && 'Basic qualifications\n' + j.basic_qualifications,
        j.preferred_qualifications && 'Preferred qualifications\n' + j.preferred_qualifications].filter(Boolean).map(stripHtml).join('\n'),
    }));
  }
  if (p === 'capgemini') {
    // Capgemini's job search service: 100 jobs a page (board: a country site, e.g. in-en)
    const origin = base.capgemini || 'https://cg-job-search-microservices.azurewebsites.net';
    const page = n => getJson(fetchImpl, `${origin}/api/job-search?country_code=${encodeURIComponent(source.board || 'in-en')}&size=100&page=${n}`, { headers: { Accept: 'application/json' } });
    const p0 = await page(1);
    const pages = [];
    for (let n = 2; n <= Math.ceil(Math.min(p0.total || 0, MAX_JOBS) / 100); n++) pages.push(n);
    const all = [p0, ...(await inBatches(pages, 5, page))].flatMap(d => d.data || []);
    const india = /-in$|^in-/.test(source.board || 'in-en');
    return all.slice(0, MAX_JOBS).filter(j => j.apply_job_url || j.wp_url).map(j => job({
      externalId: String(j.id), title: j.title, location: j.location || '', country: india ? 'India' : '',
      department: [j.department, j.experience_level].filter(Boolean).join(' · '), employmentType: j.contract_type || '', postedAt: iso(j.updated_at),
      url: String(j.apply_job_url || j.wp_url).replace(/[?&](utm_[^&]+|tcsource=[^&]+|feedId=[^&]+)/g, '').replace(/\?$/, ''), description: j.description_stripped || stripHtml(j.description),
    }));
  }
  throw new Error('Unsupported job board');
}

const FULL_DESCRIPTION = 15000;   // characters of one job's full description

/** The inside of each <span itemprop="description">…</span>, with the spans nested in it (some sites have two: the company, then the job). */
function describedSpans(html) {
  const out = [], open = /<span[^>]*itemprop="description"[^>]*>/gi;
  let o;
  while ((o = open.exec(html))) {
    const tag = /<(\/?)span\b[^>]*>/gi;
    tag.lastIndex = o.index + o[0].length;
    let depth = 1, m, end = html.length;
    while ((m = tag.exec(html))) { depth += m[1] ? -1 : 1; if (depth === 0) { end = m.index; break; } }
    out.push(html.slice(o.index + o[0].length, end));
    open.lastIndex = end;
  }
  return out;
}

/** Boards whose single-job pages fetchDescription() reads; the others keep a longer description from their job list. */
const DETAIL_PAGES = new Set(['greenhouse', 'lever', 'smartrecruiters', 'ashby', 'workday', 'sfclassic', 'sfunified', 'oraclehcm']);

/**
 * One job's whole description, for its skill matrix. The job lists keep only the start of each description (and
 * SmartRecruiters and Workday lists have none), so the job's own page on the board is read when a candidate opens it.
 * job: {externalId, url}. Returns the text, or null when the board has no single-job API we can read.
 */
async function fetchDescription(source, job, { fetchImpl = fetch, base = {} } = {}) {
  const p = source.provider, board = encodeURIComponent(source.board || ''), id = encodeURIComponent(job.externalId || '');
  let text = null;
  if (p === 'greenhouse') {
    const d = await getJson(fetchImpl, `${base.greenhouse || 'https://boards-api.greenhouse.io/v1/boards'}/${board}/jobs/${id}`);
    text = stripHtml(d.content);
  } else if (p === 'lever') {
    const d = await getJson(fetchImpl, `${base.lever || 'https://api.lever.co/v0/postings'}/${board}/${id}?mode=json`);
    text = [d.descriptionPlain || stripHtml(d.description), ...(d.lists || []).map(l => `${l.text || ''}\n${stripHtml(l.content)}`), d.additionalPlain || stripHtml(d.additional)].filter(Boolean).join('\n');
  } else if (p === 'smartrecruiters') {
    const d = await getJson(fetchImpl, `${base.smartrecruiters || 'https://api.smartrecruiters.com/v1/companies'}/${board}/postings/${id}`);
    const sections = (d.jobAd && d.jobAd.sections) || {};
    text = ['jobDescription', 'qualifications', 'additionalInformation'].map(k => sections[k]).filter(s => s && s.text).map(s => `${s.title || ''}\n${stripHtml(s.text)}`).join('\n');
  } else if (p === 'ashby') {
    const d = await getJson(fetchImpl, `${base.ashby || 'https://api.ashbyhq.com/posting-api/job-board'}/${board}`);
    const j = (d.jobs || []).find(x => String(x.id) === String(job.externalId));
    text = j ? (j.descriptionPlain || stripHtml(j.descriptionHtml)) : '';
  } else if (p === 'sfclassic' || p === 'sfunified') {
    // SAP SuccessFactors job pages (both designs) carry the whole description in <span itemprop="description">
    const u = new URL(job.url);
    const url = base[p] ? `${base[p]}/${u.host}${u.pathname}` : job.url;
    text = describedSpans(await getText(fetchImpl, url, { headers: { Accept: 'text/html' } })).map(stripHtml).filter(Boolean).join('\n');
  } else if (p === 'oraclehcm') {
    const [host, site] = String(source.board || '').split('/');
    const origin = base.oraclehcm ? `${base.oraclehcm}/${host}` : `https://${host}`;
    const d = await getJson(fetchImpl, `${origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${encodeURIComponent(site || '')}`);
    const r = (d.items || [])[0] || {};
    text = ['ExternalDescriptionStr', 'ExternalResponsibilitiesStr', 'ExternalQualificationsStr'].map(k => stripHtml(r[k])).filter(Boolean).join('\n');
  } else if (p === 'workday') {
    // the job's link is https://<tenant>.<wd>.myworkdayjobs.com/<site>/job/...; its JSON is at /wday/cxs/<tenant>/<site>/job/...
    const [tenant, site] = String(source.board || '').split('/');
    const path = new URL(job.url).pathname.replace(new RegExp('^/' + site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
    const origin = base.workday || `https://${tenant}.${source.wd || 'wd1'}.myworkdayjobs.com`;
    const d = await getJson(fetchImpl, `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}${path}`, { headers: { Accept: 'application/json' } });
    text = stripHtml((d.jobPostingInfo || {}).jobDescription);
  }
  return text == null ? null : text.slice(0, FULL_DESCRIPTION);
}

module.exports = { parseBoardUrl, fetchJobs, fetchDescription, DETAIL_PAGES, countryOf, workdayDate, stripHtml, MAX_JOBS };
