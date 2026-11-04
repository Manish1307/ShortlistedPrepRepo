'use strict';
// The design-review quick wins on the home page: contrast, honest content, plan buttons, the sticky phone bar and the journey chip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const site = f => fs.readFileSync(path.join(__dirname, '..', 'website', f), 'utf8');

function contrast(fg, bg) {
  const lum = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('the orange button passes WCAG AA with white text (it was 3.7 : 1)', () => {
  const css = site('assets/design-c.css');
  const action = /--action:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  const hover = /--action-d:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.ok(contrast('#ffffff', action) >= 4.5, `button ${action}: ${contrast('#ffffff', action).toFixed(2)}`);
  assert.ok(contrast('#ffffff', hover) >= 4.5, `button hover ${hover}`);
});

test('home page: no invented percentages, no "coming soon" in the footer, a short hero paragraph', () => {
  const home = site('pages/index.html');
  assert.ok(!/cap-pct">\d+%/.test(home) && !home.includes('cap-bar'), 'the 20 / 25 / 20 / 35 % cards are gone');
  assert.deepEqual([...home.matchAll(/<div class="cap-pct">([^<]*)</g)].map(m => m[1]), ['01', '02', '03', '04'], 'the tools in the order they are used');
  assert.ok(!/how much of ShortlistPrep each/i.test(home));
  const lead = /<p class="lead">For freshers[^<]*<\/p>/.exec(home)[0];
  assert.ok(lead.length < 280, 'hero paragraph: ' + lead.length + ' characters');
  assert.ok(!/coming soon/i.test(site('layout.html')), 'the footer');
});

test('home page: every plan card has a button, one is Most popular, and Free is shown once as ₹0', () => {
  const home = site('pages/index.html');
  const plans = home.match(/<div class="hp-plan[^"]*">[\s\S]*?<\/ul>[\s\S]*?<\/div>/g);
  assert.equal(plans.length, 3);
  for (const p of plans) assert.match(p, /<a class="btn[^"]*" href="(signup|pricing)\.html"/, 'a button on each plan');
  assert.equal((home.match(/class="hp-badge">Most popular</g) || []).length, 1);
  assert.ok(home.includes('<p class="hp-price">₹0</p>'));
  const js = site('assets/home-pricing.js');
  assert.match(js, /hp-badge/);
  assert.match(js, /'₹' \+ Number\(p\.price \|\| 0\)/, 'Free is ₹0');
  assert.match(js, /a\.href = p\.price \? 'pricing\.html'/, 'a button on each live plan');
  const css = site('assets/polish.css');
  assert.match(css, /\.hp-plans \{ max-width: none/, 'the plans use the full column');
});

test('phones: a sticky call to action after the first screen, 44 px targets, and the journey chip can be hidden', () => {
  const home = site('pages/index.html');
  assert.match(home, /<div class="m-cta" id="m-cta" hidden>/);
  assert.match(home, /assets\/polish\.js/);
  assert.match(site('assets/polish.js'), /IntersectionObserver/);
  const css = site('assets/polish.css');
  assert.match(css, /\.m-cta:not\(\[hidden\]\)\s*\{\s*display: block; position: fixed/);
  assert.match(css, /\.nav-toggle \{ min-width: 44px; min-height: 44px; \}/);
  assert.match(css, /body\.has-mcta \.sp-strength/, 'the chip moves above the bar');
  assert.match(site('layout.html'), /assets\/polish\.css/);
  const panel = site('assets/strength-panel.js');
  assert.ok(!/el\('h2'/.test(panel), 'the journey title is not an h2');
  assert.match(panel, /sp_strength_off/);
  assert.match(panel, /sp-x/);
});

test('database: plan texts written before the rename say Live Search after the server starts', () => {
  const { open } = require('../admin/lib/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plans-')), 'admin.db');
  const first = open(file);
  first.prepare("DELETE FROM pricing_plans WHERE code = 'old-wording'").run();
  first.prepare(`INSERT INTO pricing_plans (code, name, tagline, description, features_json, created_at, updated_at) VALUES ('old-wording', 'Old', 'Ten AI job searches', 'Run an AI job search', ?, datetime('now'), datetime('now'))`)
    .run(JSON.stringify(['2 AI job searches a month', 'About 30 AI job searches', 'Skill Gap Matrix']));
  first.close();
  const again = open(file);
  const row = again.prepare("SELECT tagline, description, features_json FROM pricing_plans WHERE code = 'old-wording'").get();
  assert.deepEqual(JSON.parse(row.features_json), ['2 Live Searches a month', 'About 30 Live Searches', 'Skill Gap Matrix']);
  assert.equal(row.tagline, 'Ten Live Searches');
  assert.equal(row.description, 'Run a Live Search', 'the article follows');
  again.close();
});

test('home hero: a resume drop-zone that asks consent and reuses the free ATS checker', () => {
  const home = site('pages/index.html');
  assert.match(home, /<input class="hz-file" type="file" id="hz-file" accept="\.pdf,\.docx/);
  assert.match(home, /id="hz-consent"/, 'a visible consent box');
  assert.match(home, /saves the name, email and mobile number in my resume/);
  assert.match(home, /id="hz-hp"/, 'the spam trap');
  assert.match(home, /assets\/home-ats\.js/);
  const js = site('assets/home-ats.js');
  assert.match(js, /\/api\/ats-check'/);
  assert.match(js, /consent: true/);
  assert.match(js, /if \(!consent\.checked\)/, 'nothing is sent until the box is ticked');
  assert.match(js, /needEmail/);
  const shared = site('assets/ats-check.js');
  assert.match(shared, /window\.SPAts = \{ fileToText: fileToText, call: call, visitorId: visitorId \}/);
  assert.ok(shared.indexOf('window.SPAts') < shared.indexOf('if (!form) return;'), 'exported before the checker page guard');
  assert.match(site('assets/polish.css'), /\.hz-drop/);
});

test('profile side panel: on My account and the Career toolkit, collapsible, remembered', () => {
  for (const page of ['pages/account.html', 'pages/career.html']) {
    const html = site(page);
    assert.match(html, /assets\/profile-panel\.css/, page);
    assert.match(html, /assets\/profile-panel\.js/, page);
  }
  const js = site('assets/profile-panel.js');
  assert.match(js, /\/api\/account\/me/);
  assert.match(js, /\/api\/strength/);
  assert.match(js, /aria-expanded/, 'the toggle says whether it is open');
  assert.match(js, /sp_profile_panel/, 'the choice is remembered');
  for (const label of ['View profile', 'Profile performance', 'My home', 'Career toolkit', 'Jobs']) assert.ok(js.includes(label), label);
  const css = site('assets/profile-panel.css');
  assert.match(css, /\.pp-layout\.collapsed \{ grid-template-columns: 64px/);
  assert.match(css, /@media \(max-width: 900px\)/, 'phones stack it above the page');
});
