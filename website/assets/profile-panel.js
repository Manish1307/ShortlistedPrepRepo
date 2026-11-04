// "My profile" side panel for My account and the Career toolkit: photo ring with the journey percentage, name, a short
// performance card, the next step, and links. It collapses to a narrow rail; the choice is remembered in this browser.
(function () {
  'use strict';
  var main = document.querySelector('.ac-main > .wrap');
  if (!main) return;
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var KEY = 'sp_profile_panel';

  function session() {
    var raw = '';
    try { raw = sessionStorage.getItem('sp_account') || localStorage.getItem('sp_account') || ''; } catch (e) { /* storage blocked */ }
    try { var s = JSON.parse(raw); return s && s.token ? s : null; } catch (e) { return null; }
  }
  var sess = session();
  if (!sess || !API) return;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function get(path) {
    return fetch(API + path, { headers: { Authorization: 'Bearer ' + sess.token } })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function ago(iso) {
    var t = Date.parse(iso); if (!t) return '';
    var d = Math.floor((Date.now() - t) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + 'd ago';
  }
  function initials(name) { var p = String(name || '').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  function icon(path) { var w = el('span', 'pp-ico'); w.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>'; return w; }

  var ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    kit: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
    jobs: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    prep: '<path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/>',
    plans: '<path d="M12 2l3 6 6.5 1-4.7 4.6L18 20l-6-3.2L6 20l1.2-6.4L2.5 9 9 8z"/>',
    toggle: '<path d="M15 6l-6 6 6 6"/>'
  };
  var here = location.pathname.split('/').pop() || 'index.html';
  var links = [
    ['My home', 'account.html', ICONS.home, here === 'account.html' && !/tab=interview/.test(location.search)],
    ['Career toolkit', 'career.html', ICONS.kit, here === 'career.html'],
    ['Jobs', 'jobs.html', ICONS.jobs, false],
    ['Interview prep', 'account.html?tab=interview', ICONS.prep, false],
    ['Plans', 'pricing.html', ICONS.plans, false]
  ];

  // put the page content beside the panel
  var layout = el('div', 'pp-layout'), body = el('div', 'pp-main'), side = el('aside', 'pp-side');
  side.setAttribute('aria-label', 'My profile');
  while (main.firstChild) body.appendChild(main.firstChild);
  layout.appendChild(side); layout.appendChild(body); main.appendChild(layout);
  main.classList.add('pp-wide');

  var collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch (e) { /* storage blocked */ }
  var chosen = null;
  try { chosen = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
  if (chosen === null && window.matchMedia && window.matchMedia('(max-width: 900px)').matches) collapsed = true;   // phones start with the rail

  var toggle = el('button', 'pp-toggle'); toggle.type = 'button'; toggle.appendChild(icon(ICONS.toggle));
  function apply() {
    layout.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? 'Show my profile panel' : 'Hide my profile panel');
    toggle.title = collapsed ? 'Show my profile' : 'Hide the panel';
  }
  toggle.addEventListener('click', function () {
    collapsed = !collapsed; apply();
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e) { /* storage blocked */ }
  });
  apply();

  var card = el('div', 'pp-card'); card.id = 'pp-card';
  var nav = el('nav', 'pp-nav'); nav.setAttribute('aria-label', 'Go to');
  links.forEach(function (l) {
    var a = el('a', 'pp-link' + (l[3] ? ' on' : '')); a.href = l[1]; a.title = l[0];
    if (l[3]) a.setAttribute('aria-current', 'page');
    a.appendChild(icon(l[2])); a.appendChild(el('span', 'pp-label', l[0])); nav.appendChild(a);
  });
  side.appendChild(toggle); side.appendChild(card); side.appendChild(nav);

  // the first paint uses what the sign-in already knows (name), the rest arrives from the server
  function paint(me, st, cr) {
    var c = (me && me.customer) || sess.customer || {};
    var name = c.name || (sess.customer && sess.customer.name) || 'Your profile';
    var pct = st && typeof st.percent === 'number' ? st.percent : 0;
    card.replaceChildren();

    var av = el('div', 'pp-ring'); av.style.setProperty('--p', pct + '%');
    var face = el('div', 'pp-face', initials(name)); av.appendChild(face);
    var tag = el('span', 'pp-pct', pct + '%'); tag.title = 'How much of ShortlistPrep you have used';
    var top = el('div', 'pp-top'); top.appendChild(av); top.appendChild(tag);
    card.appendChild(top);
    card.appendChild(el('h2', 'pp-name', name));
    var line = [c.organisation, c.country].filter(Boolean).join(' · ');
    if (line) card.appendChild(el('p', 'pp-line', line));
    var upd = me && me.profile && me.profile.updatedAt ? ago(me.profile.updatedAt) : '';
    if (upd) card.appendChild(el('p', 'pp-muted', 'Resume updated ' + upd));
    var view = el('a', 'btn btn-primary pp-view', 'View profile'); view.href = 'account.html#overview'; card.appendChild(view);

    var perf = el('div', 'pp-perf');
    perf.appendChild(el('h3', '', 'Profile performance'));
    var grid = el('div', 'pp-stats');
    var ats = cr && cr.resume && cr.resume.ats && typeof cr.resume.ats.score === 'number' ? cr.resume.ats.score : null;
    [['ATS score', ats === null ? '–' : String(ats), 'career.html#cr-ats'],
     ['Journey', pct + '%', 'career.html']].forEach(function (s) {
      var a = el('a', 'pp-stat'); a.href = s[2]; a.appendChild(el('span', '', s[0])); a.appendChild(el('b', '', s[1])); grid.appendChild(a);
    });
    perf.appendChild(grid);
    if (st && st.next) {
      var next = el('a', 'pp-boost'); next.href = st.next.href;
      next.appendChild(el('span', '', st.next.label));
      next.appendChild(el('b', '', st.next.cta + ' ›'));
      perf.appendChild(next);
    } else if (st && st.plan && st.plan.free) {
      var up = el('a', 'pp-boost'); up.href = 'pricing.html'; up.appendChild(el('span', '', 'Get more Live Searches and role resumes')); up.appendChild(el('b', '', 'See plans ›')); perf.appendChild(up);
    }
    card.appendChild(perf);
  }

  paint(null, null, null);
  Promise.all([get('/api/account/me'), get('/api/strength'), get('/api/career')]).then(function (r) { paint(r[0], r[1], r[2]); });
  // after the member saves something on this page, the numbers may have moved: ask again a moment later
  var rawFetch = window.fetch.bind(window), timer = null;
  window.fetch = function (url, opts) {
    var p = rawFetch(url, opts);
    var method = String((opts && opts.method) || 'GET').toUpperCase();
    var target = typeof url === 'string' ? url : (url && url.url) || '';
    if (method !== 'GET' && target.indexOf(API) === 0) {
      p.then(function (r) {
        if (r && r.ok) { clearTimeout(timer); timer = setTimeout(function () { Promise.all([get('/api/account/me'), get('/api/strength'), get('/api/career')]).then(function (x) { paint(x[0], x[1], x[2]); }); }, 900); }
      }, function () { /* the caller handles it */ });
    }
    return p;
  };
})();
