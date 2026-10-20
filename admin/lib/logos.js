'use strict';
// Company logos for AI Job search: GET /api/logo?domain=adobe.com&name=Adobe
// Each icon service misses some companies (DuckDuckGo answers adobe.com with an empty reply, Google has no icon for
// hcltech.com) and answers a miss with a placeholder picture the page cannot tell from a logo. So the server tries
// the sources in turn and checks each answer is a real picture; a company with no icon anywhere gets a plain 404 and
// the page shows its initials. When only the name is known (a company found on a job board), its web address is
// guessed from the name and kept only if that site's title names the company.
// Results are kept in memory for a day; candidates' browsers never contact the icon services themselves.
//
// The endpoint is public and makes the server fetch web addresses it is given, so: only public host names (never an
// IP address or an internal name), every address (and every redirect) must resolve to a public IP, and each visitor
// gets a limited number of new lookups an hour.

const dns = require('dns').promises;
const net = require('net');
const { ApiError } = require('./http');
const { Limiter } = require('./auth');

const DAY = 86400000;
const MAX_ICON = 200 * 1024;
const TIMEOUT = 6000;
const SOURCES = [
  'https://icons.duckduckgo.com/ip3/{domain}.ico',
  'https://www.google.com/s2/favicons?domain={domain}&sz=64',
  'https://{domain}/favicon.ico',
  'https://www.{domain}/favicon.ico',
];
const HOME = 'https://{domain}/';
// a public host name: letters in the last label, no internal suffixes
const DOMAIN = /^(?=.{4,100}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/;
const INTERNAL = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|example|invalid|arpa)$/;

const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const fill = (template, domain) => template.replace(/\{domain\}/g, domain);
/** Words that say what kind of company it is, not which: "Acme Technologies Pvt Ltd" → "acme". */
const coreName = name => norm(String(name || '').replace(/\b(pvt|private|ltd|limited|inc|llc|llp|plc|corp|corporation|company|co|group|gmbh|technologies|technology|solutions|services|software|labs|india)\b\.?/gi, ' '));
const publicName = domain => DOMAIN.test(domain) && !INTERNAL.test(domain);

/** Whether an IP address is on the public internet (not loopback, private, link-local, carrier NAT or reserved). */
function publicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return publicIp(v6.slice(7));
  return !(v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff'));
}

async function picture(res) {
  if (!res || !res.ok) return null;
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(type)) return null;
  const body = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  return body.length >= 64 && body.length <= MAX_ICON ? { type, body } : null;   // real pictures only: not empty, not huge
}
/** The icon a home page names (<link rel="apple-touch-icon"> first, else rel="icon"), as an absolute URL. */
function linkedIcon(html, pageUrl) {
  const links = String(html).match(/<link\b[^>]*>/gi) || [];
  const best = links.find(l => /rel=["'][^"']*apple-touch-icon/i.test(l)) || links.find(l => /rel=["'][^"']*\bicon\b/i.test(l));
  const href = best && (/href=["']([^"']+)["']/i.exec(best) || [])[1];
  try { return href ? new URL(href.replace(/&amp;/g, '&'), pageUrl).href : null; } catch (_) { return null; }
}
const titleOf = html => ((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '') + ' ' +
  ((/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i.exec(html) || [])[1] || '');

function addRoutes(ctx) {
  const { add } = ctx;
  const sources = ctx.logoSources || SOURCES;
  const home = ctx.logoHome || HOME;
  const lookup = ctx.logoLookup || (host => dns.lookup(host, { all: true }).then(list => list.map(x => x.address)));
  const limiter = ctx.logoLimiter || new Limiter({ max: 120, windowMs: 3600000 });
  const icons = new Map();     // domain -> { at, type, body } (body null: none found)
  const guesses = new Map();   // core name -> { at, domain } ('' : none found)
  const keep = (map, key, value) => { if (map.size > 2000) map.delete(map.keys().next().value); map.set(key, value); return value; };

  /** Fetch a URL whose host must resolve to public addresses only, following up to 3 redirects the same way. */
  async function get(url, accept) {
    for (let hop = 0; hop < 4; hop++) {
      let u;
      try { u = new URL(url); } catch (_) { return null; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      const host = u.hostname.toLowerCase();
      if (!ctx.logoSources) {   // (tests point the sources at a local fake server)
        if (net.isIP(host) || INTERNAL.test(host)) return null;
        const ips = await lookup(host).catch(() => []);
        if (!ips.length || !ips.every(publicIp)) return null;
      }
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ClassCue logo fetcher)', Accept: accept }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
      } catch (_) { return null; }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
      return res;
    }
    return null;
  }

  async function iconFor(domain) {
    const known = icons.get(domain);
    if (known && Date.now() - known.at < DAY) return known;
    for (const s of sources) {
      const hit = await picture(await get(fill(s, domain), 'image/*'));
      if (hit) return keep(icons, domain, { at: Date.now(), ...hit });
    }
    const page = await get(fill(home, domain), 'text/html');   // last: the icon the home page itself names
    if (page && page.ok) {
      const url = linkedIcon(await page.text().catch(() => ''), fill(home, domain));
      const hit = url && await picture(await get(url, 'image/*'));
      if (hit) return keep(icons, domain, { at: Date.now(), ...hit });
    }
    return keep(icons, domain, { at: Date.now(), type: '', body: null });
  }

  /** A company's web address from its name: name.com, .in, .io, .co, .ai, kept only when that site's title names it. */
  async function domainFor(name) {
    const core = coreName(name) || norm(name);
    if (core.length < 2 || core.length > 40) return '';
    const known = guesses.get(core);
    if (known && Date.now() - known.at < DAY) return known.domain;
    for (const tld of ['com', 'in', 'io', 'co', 'ai']) {
      const domain = `${core}.${tld}`;
      const page = await get(fill(home, domain), 'text/html');
      if (!page || !page.ok) continue;
      if (norm(titleOf(await page.text().catch(() => ''))).includes(core)) return keep(guesses, core, { at: Date.now(), domain }).domain;
    }
    return keep(guesses, core, { at: Date.now(), domain: '' }).domain;
  }

  add('GET', '/api/logo', { public: true }, async (req, res, { query, ip }) => {
    let domain = String(query.get('domain') || '').toLowerCase().trim().replace(/^www\./, '');
    const name = String(query.get('name') || '').trim().slice(0, 120);
    if (domain && !publicName(domain)) throw new ApiError(400, 'Not a web address');
    if (!domain && !name) throw new ApiError(400, 'Give a web address or a company name');
    const cached = domain ? icons.get(domain) : guesses.get(coreName(name) || norm(name));
    if (!cached || Date.now() - cached.at >= DAY) {   // new lookups are limited per visitor
      if (limiter.blocked(ip)) throw new ApiError(429, 'Too many requests');
      limiter.hit(ip);
    }
    if (!domain) domain = await domainFor(name);
    const hit = domain ? await iconFor(domain) : null;
    if (!hit || !hit.body) throw new ApiError(404, 'No logo');
    res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.body.length, 'Cache-Control': 'public, max-age=604800',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.end(hit.body);
  });
}

module.exports = { addRoutes, coreName, linkedIcon, publicIp, publicName };
