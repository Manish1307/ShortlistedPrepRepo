'use strict';
// News and trainings: the public page, "For you" from a resume, items written by the team, and drafts suggested from feeds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const news = require('../admin/lib/news');

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Acme newsroom</title>
<item><title>Acme opens a free Java and Spring Boot bootcamp</title><link>https://acme.example.com/news/java-bootcamp</link><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>Free for students. Learn &amp; build.</p>]]></description></item>
<item><title>Acme quarterly results</title><link>https://acme.example.com/news/results</link><pubDate>Fri, 30 Oct 2026 09:00:00 GMT</pubDate><description>Revenue up.</description></item>
<item><title>No link here</title></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Beta &amp; Co hiring drive</title><link rel="alternate" href="https://beta.example.com/a"/><updated>2026-10-01T10:00:00Z</updated><summary>Walk-in drive</summary></entry></feed>`;

test('feeds: RSS and Atom entries are read, newest first, tags and entities removed, entries without a link skipped', () => {
  const rss = news.parseFeed(RSS);
  assert.deepEqual(rss.map(e => e.title), ['Acme opens a free Java and Spring Boot bootcamp', 'Acme quarterly results']);
  assert.equal(rss[0].summary, 'Free for students. Learn & build.');
  assert.equal(rss[0].publishedAt, '2026-11-02T09:00:00.000Z');
  const atom = news.parseFeed(ATOM);
  assert.equal(atom[0].title, 'Beta & Co hiring drive');
  assert.equal(atom[0].url, 'https://beta.example.com/a');
  assert.deepEqual(news.parseFeed('<html>not a feed</html>'), []);
});

test('feeds: private and local addresses are refused', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', 'intranet.local', '::1']) assert.ok(news.privateHost(h), h);
  for (const h of ['example.com', '172.32.0.1', '8.8.8.8']) assert.ok(!news.privateHost(h), h);
});

test('matching: the company counts most, a skill in the title more than one in the summary, and a different field scores nothing', () => {
  const me = { skills: ['java', 'spring boot'], roles: ['java backend developer'], companies: ['Acme'] };
  const item = (o) => ({ title: '', summary: '', tags: [], company: '', kind: 'news', cost: 'unknown', ...o });
  const a = news.match(item({ title: 'Free Java bootcamp', company: 'Acme', kind: 'training', cost: 'free' }), me);
  const b = news.match(item({ title: 'Free Java bootcamp', company: 'Other' }), me);
  const c = news.match(item({ title: 'Cloud news', summary: 'We use Java daily', company: 'Other' }), me);
  const d = news.match(item({ title: 'Nursing scholarships', summary: 'For the ward', company: 'Other' }), me);
  assert.ok(a.score > b.score && b.score > c.score && c.score > d.score, [a, b, c, d].map(x => x.score).join(' '));
  assert.equal(d.score, 0);
  assert.ok(a.reasons.some(r => /Acme/.test(r)) && b.reasons.some(r => /java/i.test(r)));
  assert.equal(news.match(item({ title: 'JavaScript trends' }), me).score, 0, 'java is not javascript');
});

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const feed = http.createServer((req, res) => {
    if (req.url === '/rss') { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); return res.end(RSS); }
    if (req.url === '/atom') { res.writeHead(200, { 'Content-Type': 'application/atom+xml' }); return res.end(ATOM); }
    res.writeHead(404); res.end('no');
  });
  const feedBase = await listen(feed);
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-news-')), newsAllowLocal: true });
  const base = await listen(app.server);
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES ('boss@example.com', 'owner', 'owner', ?, datetime('now'))").run(hashPassword('correct-horse-battery'));
  app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES ('helper@example.com', 'support', 'support', ?, datetime('now'))").run(hashPassword('correct-horse-battery'));
  const jar = { cookie: '' };
  const call = async (method, url, body, o = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(o.admin ? { 'X-Requested-With': 'admin', Cookie: jar.cookie } : {}), ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) jar.cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  const login = email => call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' }, { admin: true });
  await login('boss@example.com');
  const a = (method, url, body) => call(method, url, body, { admin: true });
  const signup = await call('POST', '/api/account/signup', { name: 'Asha', email: 'asha@example.com', password: 'Correct-Horse-9', terms: true });
  return { app, call, a, login, feedBase, token: signup.json.token, close: async () => { await app.close(); feed.close(); feed.closeAllConnections(); } };
}

test('admin: an item is written, published, shown to everyone with its filters, and hidden again', async () => {
  const s = await start();
  try {
    assert.equal((await s.a('POST', '/admin/api/news', { title: '', url: 'https://x.example.com' })).status, 400, 'a title is needed');
    assert.equal((await s.a('POST', '/admin/api/news', { title: 'x', url: 'javascript:alert(1)' })).status, 400, 'only web links');
    const free = (await s.a('POST', '/admin/api/news', { title: 'Free cloud training by Acme', url: 'https://acme.example.com/cloud', company: 'Acme', kind: 'training', cost: 'free', tags: 'AWS, Cloud', summary: 'Eight weeks, online.' })).json;
    const paid = (await s.a('POST', '/admin/api/news', { title: 'Beta certification course', url: 'https://beta.example.com/cert', company: 'Beta', kind: 'training', cost: 'paid', priceNote: 'Rs 4,999' })).json;
    await s.a('POST', '/admin/api/news', { title: 'Draft only', url: 'https://acme.example.com/draft', publish: false });
    assert.equal((await s.a('POST', '/admin/api/news', { title: 'Again', url: 'https://acme.example.com/cloud' })).status, 409, 'one item per link');
    assert.deepEqual([free.state, paid.cost, paid.priceNote], ['published', 'paid', 'Rs 4,999']);

    const pub = (await s.call('GET', '/api/news')).json;
    assert.equal(pub.total, 2, 'a draft is not public');
    assert.deepEqual(pub.items[0].tags.length + pub.items[1].tags.length, 2);
    assert.ok(!JSON.stringify(pub).includes('"status"'), 'no internal fields');
    assert.deepEqual(pub.companies.map(c => c.name).sort(), ['Acme', 'Beta']);
    assert.deepEqual((await s.call('GET', '/api/news?cost=free')).json.items.map(i => i.company), ['Acme']);
    assert.deepEqual((await s.call('GET', '/api/news?q=certification')).json.items.map(i => i.company), ['Beta']);
    assert.equal((await s.call('GET', '/api/news?q=%25')).json.total, 0, 'a percent sign is not a wildcard');

    await s.a('PATCH', `/admin/api/news/${free.id}`, { status: 'rejected' });
    assert.equal((await s.call('GET', '/api/news')).json.total, 1);
    assert.equal((await s.a('DELETE', `/admin/api/news/${paid.id}`)).status, 200);
    assert.equal((await s.call('GET', '/api/news')).json.total, 0);
  } finally { await s.close(); }
});

test('admin: only an owner or admin can change items; the helper account can read them', async () => {
  const s = await start();
  try {
    await s.login('helper@example.com');
    assert.equal((await s.a('GET', '/admin/api/news')).status, 200);
    assert.equal((await s.a('POST', '/admin/api/news', { title: 'x', url: 'https://x.example.com' })).status, 403);
    assert.ok([401, 403].includes((await s.call('POST', '/admin/api/news', { title: 'x', url: 'https://x.example.com' })).status), 'and not without signing in');
  } finally { await s.close(); }
});

test('feeds: a listed feed adds drafts that are not public until published, once only, and one broken feed does not stop the rest', async () => {
  const s = await start();
  try {
    assert.equal((await s.a('POST', '/admin/api/news-sources', { name: 'Acme', feedUrl: 'ftp://x' })).status, 400);
    const src = (await s.a('POST', '/admin/api/news-sources', { name: 'Acme newsroom', company: 'Acme', feedUrl: s.feedBase + '/rss', kind: 'news' })).json;
    await s.a('POST', '/admin/api/news-sources', { name: 'Broken', feedUrl: s.feedBase + '/missing' });
    await s.a('POST', '/admin/api/news-sources', { name: 'Beta', company: 'Beta', feedUrl: s.feedBase + '/atom', kind: 'training', cost: 'free' });
    assert.equal((await s.a('POST', '/admin/api/news-sources', { name: 'Acme again', feedUrl: s.feedBase + '/rss' })).status, 409);

    const first = (await s.a('POST', '/admin/api/news-sources/fetch')).json;
    assert.deepEqual([first.added, first.failed], [3, 1]);
    assert.equal((await s.call('GET', '/api/news')).json.total, 0, 'drafts are not public');
    const list = (await s.a('GET', '/admin/api/news?status=pending')).json;
    assert.equal(list.items.length, 3);
    assert.deepEqual(list.items.map(i => i.company).sort(), ['Acme', 'Acme', 'Beta']);
    assert.ok(list.sources.find(x => x.name === 'Broken').lastError, 'the failure is shown');
    assert.equal(list.sources.find(x => x.id === src.id).lastAdded, 2);

    assert.equal((await s.a('POST', '/admin/api/news-sources/fetch')).json.added, 0, 'the same entries are not added twice');
    const bootcamp = list.items.find(i => /bootcamp/.test(i.title));
    await s.a('PATCH', `/admin/api/news/${bootcamp.id}`, { status: 'published', kind: 'training', cost: 'free', tags: 'java, spring boot' });
    assert.deepEqual((await s.call('GET', '/api/news')).json.items.map(i => [i.title, i.cost]), [['Acme opens a free Java and Spring Boot bootcamp', 'free']]);

    await s.a('PATCH', `/admin/api/news-sources/${src.id}`, { enabled: false });
    await s.a('DELETE', `/admin/api/news-sources/${src.id}`);
    assert.equal((await s.a('GET', '/admin/api/news')).json.sources.length, 2);
  } finally { await s.close(); }
});

test('For you: sign in and upload a resume first; then the items that fit its skills and the companies searched come first, with the reason', async () => {
  const s = await start();
  try {
    const put = (title, company, o = {}) => s.a('POST', '/admin/api/news', { title, url: 'https://x.example.com/' + encodeURIComponent(title), company, ...o });
    await put('Free Java and Spring Boot bootcamp', 'Acme', { kind: 'training', cost: 'free' });
    await put('Nursing scholarships open', 'MediCare');
    await put('Beta launches a new cloud region', 'Beta');
    assert.equal((await s.call('GET', '/api/news/for-you')).status, 401);
    const none = await s.call('GET', '/api/news/for-you', undefined, { token: s.token });
    assert.equal(none.json.code, 'no-resume');

    const resume = `AARAV MEHTA
Java Backend Developer | 4 years of experience

SKILLS
Java 17, Spring Boot, Kafka, Docker

EXPERIENCE
Java Backend Developer, Beta (2020 - Present)
- Built payment microservices handling two million requests a day with Kafka and Docker
- Cut API latency by 38 percent with caching and tuned PostgreSQL queries for the payments team

EDUCATION
B.Tech Computer Science, VIT Vellore, 2020. Certified in cloud fundamentals and secure coding practices.`;
    assert.equal((await s.call('POST', '/api/career/resume', { text: resume, fileName: 'cv.txt' }, { token: s.token })).status, 200);
    const r = (await s.call('GET', '/api/news/for-you', undefined, { token: s.token })).json;
    assert.deepEqual(r.items.map(i => i.company), ['Acme', 'Beta'], 'the nursing item is left out; a company on the resume counts');
    assert.ok(r.items[0].reasons.some(x => /skills/.test(x)));
    assert.ok(r.items[1].reasons.some(x => /Beta/.test(x)));
    assert.ok(r.basedOn.skills.includes('java'));
  } finally { await s.close(); }
});

const site = f => fs.readFileSync(path.join(__dirname, '..', 'website', f), 'utf8');

test('website: the News page, its menu links and the home section are in place, and the home section stays hidden until there are items', () => {
  const page = site('pages/news.html');
  assert.match(page, /^<!-- title: News and trainings \|/);
  assert.match(page, /id="nw-tab-you"/);
  assert.match(page, /id="nw-form"/);
  assert.match(page, /assets\/news\.js/);
  const layout = site('layout.html');
  assert.ok((layout.match(/href="news\.html"/g) || []).length >= 2, 'the Resources menu and the footer');
  const home = site('pages/index.html');
  assert.match(home, /<section class="hn" id="hn"[^>]*\bhidden>/);
  assert.match(home, /assets\/home-news\.js/);
  assert.match(site('assets/home-news.js'), /box\.hidden = false/);
  const js = site('assets/news.js');
  assert.match(js, /\/api\/news\/for-you/);
  assert.ok(!/innerHTML/.test(js + site('assets/home-news.js')), 'items are inserted as text');
  assert.match(site('assets/polish.css'), /\.hn\[hidden\] \{ display: none; \}/);
});

test('admin: the News page is in the menu with its permission', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'admin', 'public', 'app.js'), 'utf8');
  assert.match(app, /\['news', 'News',/);
  assert.match(app, /news: newsPage/);
  assert.match(app, /'news\.write': \['owner', 'admin'\]/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'admin', 'lib', 'auth.js'), 'utf8'), /'news\.write': \['owner', 'admin'\]/);
});
