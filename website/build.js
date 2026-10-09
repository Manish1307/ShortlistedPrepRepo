#!/usr/bin/env node
'use strict';
// Builds the static website into website/site/ (upload that folder to any web host).
//   website/pages/*.html        the pages (each starts with <!-- title: ... | description: ... -->)
//   website/layout.html         the frame around every page
//   website/site.config.json    name, prices, contact, company
//   website/data/sample.json    TEST DATA: reviews, numbers, plans, FAQ, blog posts (replace before launch)
//   website/templates/post.html frame for one blog post
//   npm run site:build

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'site');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample.json'), 'utf8'));
const layout = fs.readFileSync(path.join(ROOT, 'layout.html'), 'utf8');
const postTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'post.html'), 'utf8');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const initials = name => String(name).split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const prettyDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const demo = config.demoContent !== false;
const sampleTag = demo ? '<span class="sample-tag">Sample</span>' : '';

// ---------- pieces made from the sample data ----------
const fragments = {
  demoBar: demo ? '<div class="demo-bar" role="note"><strong>Demo site.</strong> Reviews, numbers, prices and blog posts are sample data for the design. Sign-in and sign-up are not connected.</div>' : '',

  statsRow: `<div class="stats">${data.stats.map(s => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}</div>`,

  platformChips: `<div class="chips">${data.platforms.map(p => `<span class="chip">${esc(p)}</span>`).join('')}</div>`,

  reviewCards: reviews => `<div class="grid grid-3 reviews">${reviews.map(r => `
    <figure class="card review">
      <div class="stars" aria-label="${r.stars} out of 5">${stars(r.stars)}</div>
      <blockquote>${esc(r.text)}</blockquote>
      <figcaption><span class="avatar" aria-hidden="true">${esc(initials(r.name))}</span><span><b>${esc(r.name)}</b><br><span class="muted small">${esc(r.role)}</span></span>${sampleTag}</figcaption>
    </figure>`).join('')}</div>`,

  planCards: `<div class="grid grid-3">${data.plans.map(p => `
    <div class="card plan${p.featured ? ' featured' : ''}">
      ${p.featured ? '<span class="tag">Most popular</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <div class="price">${p.yearly
        ? `<span class="monthly">${esc(p.price)}<small> / ${esc(p.per.replace('per ', ''))}</small></span><span class="yearly">${esc(p.yearly)}<small> / ${esc(p.yearlyPer.replace('per ', ''))}</small></span>`
        : `${esc(p.price)}${p.per ? `<small> / ${esc(p.per)}</small>` : ''}`}</div>
      <ul class="check-list">${p.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      <a class="btn${p.featured ? ' btn-primary' : ''}" href="signup.html">${p.price === 'Free' ? 'Start free' : 'Get early access'}</a>
    </div>`).join('')}</div>`,

  compareTable: `<div class="table-scroll"><table class="simple compare"><thead><tr><th>Feature</th><th>Starter</th><th>Pro</th><th>Career pack</th></tr></thead><tbody>${
    data.compare.map(r => `<tr><td>${esc(r.feature)}</td><td>${esc(r.trial)}</td><td>${esc(r.personal)}</td><td>${esc(r.schools)}</td></tr>`).join('')}</tbody></table></div>`,

  blogCards: `<div class="grid grid-3">${data.posts.map(p => `
    <a class="card post-card" href="blog-${esc(p.slug)}.html">
      <span class="muted small">${esc(prettyDate(p.date))} · ${p.readMinutes} min read</span>
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.summary)}</p>
      <span class="more">Read more →</span>
    </a>`).join('')}</div>`,
};

const faqItem = f => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`;
fragments.faqHome = data.faq.filter((f, i) => [0, 1, 3, 4, 5, 7].includes(i)).map(faqItem).join('');
const faqGroups = [...new Set(data.faq.map(f => f.group))];
const slug = g => g.toLowerCase().replace(/[^a-z0-9]+/g, '-');
fragments.faqToc = faqGroups.map(g => `<a href="#${slug(g)}">${g}</a>`).join('');
fragments.faqAll = faqGroups.map(g =>
  `<h2 class="faq-group" id="${slug(g)}">${g}</h2>${data.faq.filter(f => f.group === g).map(faqItem).join('')}`).join('');

const reviewsHome = fragments.reviewCards(data.reviews.slice(0, 3));
const reviewsAll = fragments.reviewCards(data.reviews);

// ---------- placeholders ----------
const values = { ...config, ...fragments, reviewsHome, reviewsAll, sampleTag };
values.downloadButton = config.downloadUrl
  ? `<a class="btn btn-primary" href="${esc(config.downloadUrl)}">Download installer (Windows)</a>`
  : '<a class="btn btn-primary" aria-disabled="true" href="#">Installer coming soon</a><a class="btn" href="contact.html">Tell me when it is ready</a>';
delete values.reviewCards;   // a function, used only above

function fill(text, extra = {}) {
  const all = { ...values, ...extra };
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in all)) throw new Error(`Unknown placeholder ${match}`);
    return String(all[key]);
  });
}

function render(body, title, description) {
  return fill(layout.replace('{{content}}', () => fill(body)), { title, description: esc(description) });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(OUT, 'assets', f));

// the standalone homepage design samples are copied as they are
if (fs.existsSync(path.join(ROOT, 'designs'))) fs.cpSync(path.join(ROOT, 'designs'), path.join(OUT, 'designs'), { recursive: true, filter: src => !src.includes('previews') });   // the preview images are for you, not for the site

const built = [];

// ---------- the pages ----------
const pagesDir = path.join(ROOT, 'pages');
for (const file of fs.readdirSync(pagesDir).filter(f => f.endsWith('.html'))) {
  let body = fs.readFileSync(path.join(pagesDir, file), 'utf8');
  const meta = body.match(/^<!--\s*title:\s*(.*?)\s*\|\s*description:\s*(.*?)\s*-->\s*/s);
  if (!meta) throw new Error(`${file}: first line must be <!-- title: ... | description: ... -->`);
  body = body.slice(meta[0].length);
  fs.writeFileSync(path.join(OUT, file), render(body, fill(meta[1]), fill(meta[2])));
  built.push(file);
}

// ---------- one page per blog post ----------
for (const post of data.posts) {
  const bodyHtml = post.body.map(b => (typeof b === 'string' ? `<p>${esc(b)}</p>` : `<h2>${esc(b.h)}</h2>`)).join('\n');
  const page = fill(postTemplate, { postTitle: esc(post.title), postDate: esc(prettyDate(post.date)), postRead: String(post.readMinutes), postBody: bodyHtml, postSummary: esc(post.summary) });
  const file = `blog-${post.slug}.html`;
  fs.writeFileSync(path.join(OUT, file), render(page, post.title, post.summary));
  built.push(file);
}

// every internal link must point at a page or asset that exists
let broken = 0;
for (const file of built) {
  const html = fs.readFileSync(path.join(OUT, file), 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"#:]+?)(?:#([^"]*))?"/g)) {
    const target = m[1];
    if (/^(https?|mailto):/.test(target) || target === '') continue;
    if (!fs.existsSync(path.join(OUT, target))) { console.error(`Broken link in ${file}: ${target}`); broken++; }
  }
  for (const m of html.matchAll(/href="([a-z0-9-]+\.html)#([^"]+)"/g)) {
    const page = fs.readFileSync(path.join(OUT, m[1]), 'utf8');
    if (!page.includes(`id="${m[2]}"`)) { console.error(`Broken anchor in ${file}: ${m[1]}#${m[2]}`); broken++; }
  }
  if (/\{\{\w+\}\}/.test(html)) { console.error(`Unfilled placeholder in ${file}`); broken++; }
}
console.log(`Built ${built.length} pages into ${OUT}: ${built.sort().join(', ')}`);
if (broken) { console.error(`${broken} problem(s)`); process.exit(1); }
