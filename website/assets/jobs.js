// Jobs page, three tabs: Recommended for you (signed in: jobs picked from the resume, GET /api/career/recommended), Live Search
// (AI enabled: members go to the Career toolkit, guests sign in, start free or see the plans) and Latest jobs (everyone: GET
// /api/jobs with filters, latest first). Everything shown is inserted as text, never as HTML.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var KEY = 'sp_account';
  var AI_PAGE = 'career.html#cr-jobs';
  var $ = function (id) { return document.getElementById(id); };
  var form = $('jb-form');
  if (!form) return;

  function session() {
    for (var i = 0; i < 2; i++) {
      try {
        var s = JSON.parse((i ? localStorage : sessionStorage).getItem(KEY) || 'null');
        if (s && s.token && Date.parse(s.expiresAt) > Date.now()) return s;
      } catch (e) { /* storage blocked */ }
    }
    return null;
  }
  var member = !!session();
  var params = new URLSearchParams(location.search);

  // ---------- small helpers ----------
  function h(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]); });
    [].concat(children === undefined ? [] : children).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return e;
  }
  function get(path, auth) {
    var headers = {};
    if (auth) { var s = session(); if (s) headers.Authorization = 'Bearer ' + s.token; }
    return fetch(API + path, { headers: headers }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Something went wrong'); e.status = r.status; e.code = d.code; throw e; } return d; });
    });
  }
  /** "Posted 3 days ago"; when the career site gives no date, the day we first saw the job ("Added 3 days ago"). */
  function ago(j) {
    var s = j.postedAt || j.addedAt, word = j.postedAt ? 'Posted' : 'Added';
    if (!s) return '';
    var d = Math.floor((Date.now() - Date.parse(s)) / 86400000);
    if (isNaN(d)) return '';
    return d <= 0 ? word + ' today' : d === 1 ? word + ' yesterday' : d < 30 ? word + ' ' + d + ' days ago' : word + ' ' + new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function logo(name, domain) {
    var badge = h('span', { class: 'jb-initials', 'aria-hidden': 'true' }, String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase());
    var img = h('img', { class: 'jb-logo', alt: '', width: '44', height: '44', loading: 'lazy', src: API + '/api/logo?' + (domain ? 'domain=' + encodeURIComponent(domain) + '&' : '') + 'name=' + encodeURIComponent(name || '') });
    img.addEventListener('error', function () { img.replaceWith(badge); });
    return img;
  }

  /** "Show job details": the description is read from the server the first time it is opened, then kept on the page. */
  function details(j) {
    var panel = h('div', { class: 'jb-details', hidden: '' });
    var btn = h('button', { class: 'jb-more', type: 'button', 'aria-expanded': 'false' }, 'Show job details ▾');
    var loaded = false;
    function show(d) {
      var note = d.source === 'snippet' ? 'Only the start of the description is available here. Open the job on the company\'s site to read all of it.' : '';
      panel.replaceChildren(
        d.text ? h('div', { class: 'jb-jd' }, d.text) : h('p', { class: 'muted' }, 'The company has not published a readable description for this job here. Open it on the company\'s site.'),
        note ? h('p', { class: 'muted small' }, note) : null,
        d.truncated ? h('p', { class: 'muted small' }, 'This is the first part of the description.') : null,
        h('p', {}, h('a', { class: 'btn btn-primary btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Apply on the company site ↗')));
    }
    function load() {
      panel.replaceChildren(h('p', { class: 'muted' }, 'Loading the job details…'));
      get('/api/jobs/' + j.id + '/description').then(function (d) { loaded = true; show(d); })
        .catch(function (e) { panel.replaceChildren(h('p', { class: 'muted' }, e.status === 404 ? 'This job is no longer listed.' : e.message), h('p', {}, h('a', { class: 'btn btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on the company site ↗'))); });
    }
    btn.addEventListener('click', function () {
      var closed = panel.hasAttribute('hidden');
      if (closed) { panel.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Hide job details ▴'; if (!loaded) load(); }
      else { panel.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Show job details ▾'; }
    });
    return { btn: btn, panel: panel };
  }

  /** One job card: logo, title, company, place and date, tags, the details link, the match (recommended) and Apply. */
  function row(j, tags) {
    var more = details(j);
    var meta = [j.location || j.country ? '📍 ' + (j.location || j.country) : '', j.type ? '💼 ' + j.type : '', ago(j) ? '🕒 ' + ago(j) : ''].filter(Boolean);
    var chips = (tags || []).filter(Boolean);
    return h('div', { class: 'jb-row' }, [
      logo(j.company, j.domain),
      h('div', {}, [
        h('div', { class: 't' }, j.title),
        h('div', { class: 'co' }, j.company),
        meta.length ? h('div', { class: 'm' }, meta.map(function (x) { return h('span', {}, x); })) : null,
        chips.length ? h('div', { class: 'jb-tags' }, chips.map(function (c) { return h('span', { class: 'jb-tag' + (c.role ? ' role' : '') }, c.text); })) : null,
        h('div', {}, more.btn)]),
      h('div', { class: 'jb-side' }, [
        j.score !== undefined ? h('span', { class: 'jb-score ' + (j.score >= 65 ? 'good' : j.score < 45 ? 'low' : ''), title: 'How well the job fits your resume' }, j.score + '% match') : null,
        h('a', { class: 'btn btn-primary btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Apply ↗')]),
      more.panel]);
  }

  // ---------- the tabs ----------
  var TABS = ['reco', 'live', 'latest'];
  var tab = null, opened = {};
  function urlWith(tabId, query) {
    var q = query || new URLSearchParams(location.search);
    q.set('tab', tabId);
    return location.pathname + '?' + q.toString();
  }
  function select(id, focus) {
    tab = id;
    TABS.forEach(function (t) {
      var on = t === id;
      $('tab-' + t).setAttribute('aria-selected', on ? 'true' : 'false');
      $('tab-' + t).tabIndex = on ? 0 : -1;
      $('pane-' + t).hidden = !on;
    });
    if (focus) $('tab-' + id).focus();
    if (!opened[id]) { opened[id] = true; if (id === 'reco') loadReco(); if (id === 'latest') startLatest(); }
    if (id !== 'latest') history.replaceState(null, '', urlWith(id, new URLSearchParams()));
    else if (opened.latestLoaded) load(state.page);   // (rewrites the address with the filters)
  }
  TABS.forEach(function (t, i) {
    var el = $('tab-' + t);
    el.addEventListener('click', function () { select(t); });
    el.addEventListener('keydown', function (e) {
      var to = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
      if (to >= 0) { e.preventDefault(); select(TABS[to], true); }
    });
  });

  // ---------- Live Search (AI enabled): members go to the toolkit, guests sign in or choose a plan ----------
  (function () {
    var box = $('jb-ai-actions'), next = encodeURIComponent(AI_PAGE);
    if (member) box.appendChild(h('a', { class: 'btn btn-primary', href: AI_PAGE }, 'Open Live Search'));
    else {
      box.appendChild(h('a', { class: 'btn btn-primary', href: 'login.html?next=' + next }, 'Sign in to search'));
      box.appendChild(h('a', { class: 'btn', href: 'signup.html?next=' + next }, 'Start free'));
      box.appendChild(h('a', { class: 'btn', href: 'pricing.html' }, 'See plans'));
    }
  })();

  // ---------- Recommended for you: jobs picked from the resume (signed in) ----------
  var memberSector = null;
  function loadReco() {
    var box = $('jb-for-you');
    if (!member) {
      box.appendChild(h('div', { class: 'jb-teaser' }, [
        h('p', {}, [h('b', {}, '⭐ Jobs picked from your resume. '), 'Create a free account, upload your resume, and we show the jobs that fit your role and skills first.']),
        h('span', { class: 'jb-ai-actions' }, [h('a', { class: 'btn btn-primary btn-sm', href: 'signup.html?next=jobs.html%3Ftab%3Dreco' }, 'Start free'), h('a', { class: 'btn btn-sm', href: 'login.html?next=jobs.html%3Ftab%3Dreco' }, 'Sign in')])]));
      return;
    }
    var list = h('div', { class: 'jb-list' }, h('p', { class: 'muted' }, 'Finding jobs for your resume…'));
    var note = h('p', { class: 'muted' }, 'Picked from your resume among the jobs we hold. Instant and free.');
    box.appendChild(h('div', { class: 'jb-foryou' }, [h('h2', {}, '⭐ Recommended for you'), note, list]));
    var shown = 10;
    function draw(jobs) {
      var more = jobs.length > shown ? h('div', { class: 'jb-more-row' }, h('button', { class: 'btn', type: 'button', onclick: function () { shown += 10; draw(jobs); } }, 'Show more (' + (jobs.length - shown) + ' left)')) : null;
      list.replaceChildren.apply(list, jobs.slice(0, shown).map(function (j) {
        var tags = (j.role ? [{ role: true, text: 'Fits your role: ' + j.role }] : []).concat((j.skills || []).slice(0, 5).map(function (s) { return { text: s }; }));
        return row(j, tags);
      }).concat(more ? [more] : []));
    }
    get('/api/career/recommended?country=India', true).then(function (d) {
      memberSector = d.sector || null;
      var jobs = d.recommended || [];
      if (!jobs.length) { list.replaceChildren(h('div', { class: 'jb-empty' }, [d.message || 'No recommended jobs yet. ', ' ', h('a', { href: 'career.html#cr-resume' }, 'Upload or update your resume')])); return; }
      note.textContent = 'Picked from ' + Number(d.considered || 0).toLocaleString() + ' jobs we hold, matched to your resume. Instant and free.';
      draw(jobs);
    }).catch(function (e) {
      if (e.code === 'no-resume') list.replaceChildren(h('div', { class: 'jb-empty' }, [h('a', { href: 'career.html#cr-resume' }, 'Upload your resume'), ' to see jobs picked for you.']));
      else if (e.status === 401) list.replaceChildren(h('div', { class: 'jb-empty' }, [h('a', { href: 'login.html?next=jobs.html%3Ftab%3Dreco' }, 'Sign in again'), ' to see jobs picked for you.']));
      else list.replaceChildren(h('div', { class: 'jb-empty' }, e.message));
    });
  }

  // ---------- Latest jobs: the sector, the search bar, the filters and the cards ----------
  var SECTOR_KEY = 'sp_jobs_sector';   // the choice is kept in this browser; 'all' = every sector
  var SHORT = { it: 'IT & software', agri: 'Agriculture', biotech: 'Biotech & research', pharma: 'Pharma & healthcare', fmcg: 'FMCG & food', manufacturing: 'Engineering & manufacturing', finance: 'Banking & finance', other: 'Other sectors' };
  function stored() { try { return localStorage.getItem(SECTOR_KEY); } catch (e) { return null; } }
  function keep(v) { try { localStorage.setItem(SECTOR_KEY, v); } catch (e) { /* private mode */ } }
  var sector = '';          // '' = all sectors
  var chosen = false;       // said what to explore (now, earlier in this browser, or in the address)
  var pick = params.get('sector') !== null ? params.get('sector') : stored();
  if (pick !== null && pick !== undefined && pick !== '') { chosen = true; sector = pick === 'all' ? '' : pick; }
  var sectorList = [];
  var state = { page: 1 };
  var FIELDS = ['q', 'city', 'country', 'company', 'type', 'sort'];
  var sectorBox = $('jb-sector'), pager = $('jb-pager'), results = $('jb-results'), count = $('jb-count');

  function options(sel, first, items) {
    sel.replaceChildren(h('option', { value: '' }, first));
    items.forEach(function (it) { sel.appendChild(h('option', { value: it.name }, it.name + ' (' + it.count.toLocaleString() + ')')); });
  }
  function readForm() {
    var v = {};
    FIELDS.forEach(function (k) { v[k] = form.elements[k].value.trim(); });
    v.days = form.elements.days.value;
    v.remote = form.elements.remote.checked ? '1' : '';
    v.sector = sector;
    return v;
  }
  function queryOf(v, page) {
    var p = new URLSearchParams();
    Object.keys(v).forEach(function (k) { if (v[k]) p.set(k, v[k]); });
    if (page > 1) p.set('page', page);
    return p;
  }

  function load(page) {
    state.page = page || 1;
    opened.latestLoaded = true;
    if (!member && !chosen) {   // a visitor first says which sector to explore
      count.textContent = '';
      results.replaceChildren(h('div', { class: 'jb-ask' }, 'Choose a sector above to see its latest jobs.'));
      pager.replaceChildren();
      return;
    }
    var v = readForm(), q = queryOf(v, state.page);
    history.replaceState(null, '', urlWith('latest', new URLSearchParams(q)));
    count.textContent = 'Loading jobs…';
    get('/api/jobs?' + q.toString() + (q.has('page') ? '' : '&page=1') + '&size=20').then(function (d) {
      count.textContent = d.total ? d.total.toLocaleString() + ' job' + (d.total === 1 ? '' : 's') + ' found' : 'No jobs found';
      if (!d.jobs.length) results.replaceChildren(h('div', { class: 'jb-empty' }, 'No jobs match these filters. Try a different keyword or clear a filter.'));
      else results.replaceChildren(h('div', { class: 'jb-list' }, d.jobs.map(function (j) { return row(j, j.department ? [{ text: j.department }] : []); })));
      drawPager(d.page, d.pages);
    }).catch(function (e) { count.textContent = e.message; results.replaceChildren(); pager.replaceChildren(); });
  }
  function drawPager(page, pages) {
    pager.replaceChildren();
    if (pages <= 1) return;
    var btn = function (label, p, cls, disabled) {
      var b = h('button', { class: 'btn btn-sm ' + (cls || ''), type: 'button', 'aria-label': 'Page ' + p, 'aria-current': cls === 'cur' ? 'page' : null, disabled: disabled ? '' : null }, label);
      b.addEventListener('click', function () { load(p); $('pane-latest').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      return b;
    };
    pager.appendChild(btn('‹ Previous', page - 1, '', page <= 1));
    var from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
    if (from > 1) { pager.appendChild(btn('1', 1)); if (from > 2) pager.appendChild(h('span', { class: 'muted' }, '…')); }
    for (var p = from; p <= to; p++) pager.appendChild(btn(String(p), p, p === page ? 'cur' : ''));
    if (to < pages) { if (to < pages - 1) pager.appendChild(h('span', { class: 'muted' }, '…')); pager.appendChild(btn(String(pages), pages)); }
    pager.appendChild(btn('Next ›', page + 1, '', page >= pages));
  }

  function drawSectors() {
    var all = [h('button', { class: 'jb-chip', type: 'button', 'aria-pressed': chosen && !sector ? 'true' : 'false', 'data-sector': 'all' }, 'All sectors')]
      .concat(sectorList.filter(function (x) { return x.count > 0; }).map(function (x) {
        return h('button', { class: 'jb-chip', type: 'button', 'aria-pressed': sector === x.id ? 'true' : 'false', 'data-sector': x.id, title: x.label }, SHORT[x.id] || x.label);
      }));
    all.forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-sector');
        var first = !chosen;
        sector = id === 'all' ? '' : id; chosen = true; keep(id);
        drawSectors(); load(1);
        if (first) $('jb-count').scrollIntoView({ behavior: 'smooth', block: 'center' });   // the first choice shows its jobs
      });
    });
    sectorBox.replaceChildren(h('h2', {}, chosen ? 'Sector' : 'Which sector do you want to explore?'),
      h('p', { class: 'muted' }, chosen ? 'Showing the latest jobs first. Change the sector any time.' : 'Pick one and we show its latest jobs first. Choose "All sectors" to see everything.'),
      h('div', { class: 'jb-chips', role: 'group', 'aria-label': 'Sector' }, all));
  }

  // the filter lists come from what the server holds; the address can carry a search (jobs.html?tab=latest&q=java&country=India)
  var filtersReady = get('/api/jobs/filters').then(function (f) {
    sectorList = f.sectors || [];
    drawSectors();
    options(form.elements.country, 'Any country', f.countries);
    options(form.elements.company, 'Any company', f.companies);
    options(form.elements.type, 'Any job type', f.types);
    $('jb-lead').textContent = f.total.toLocaleString() + ' jobs from ' + f.companyCount.toLocaleString() + ' companies' + (f.updatedAt ? ', updated ' + new Date(f.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '') + '. The latest jobs come first. Browse free, no sign-in needed.';
    FIELDS.forEach(function (k) { if (params.get(k)) form.elements[k].value = params.get(k); });
    if (params.get('days')) form.elements.days.value = params.get('days');
    if (!params.has('country') && f.countries.some(function (c) { return c.name === 'India'; })) form.elements.country.value = 'India';
    form.elements.remote.checked = params.get('remote') === '1';
    return f;
  });
  function startLatest() {
    filtersReady.then(function () {
      // a signed-in candidate starts on their own sector, unless they already chose one
      if (member && !chosen && memberSector && sectorList.some(function (x) { return x.id === memberSector; })) { sector = memberSector; chosen = true; drawSectors(); }
      load(Math.max(1, Number(params.get('page')) || 1));
    }).catch(function (e) { count.textContent = e.message; });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); load(1); });
  form.elements.remote.addEventListener('change', function () { load(1); });
  ['country', 'company', 'type', 'sort'].forEach(function (k) { form.elements[k].addEventListener('change', function () { load(1); }); });
  [].forEach.call(form.querySelectorAll('input[name=days]'), function (r) { r.addEventListener('change', function () { load(1); }); });
  $('jb-reset').addEventListener('click', function () {
    var sectorNow = sector;
    form.reset();
    form.elements.country.value = '';
    sector = sectorNow;
    load(1);
  });
  // on a phone the filters fold away behind a button
  var toggle = $('jb-filter-toggle'), body = $('jb-filter-body');
  toggle.addEventListener('click', function () {
    var open = body.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // which tab opens first: the one in the address; else Latest jobs when a search came with it; else Recommended for a member, Latest for a visitor
  var want = params.get('tab');
  var hasSearch = ['q', 'city', 'country', 'company', 'type', 'days', 'remote', 'sector', 'page'].some(function (k) { return params.has(k); });
  if (TABS.indexOf(want) < 0) want = hasSearch ? 'latest' : (member ? 'reco' : 'latest');
  select(want);
})();
