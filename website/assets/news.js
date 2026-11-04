// News and trainings page, two tabs: For you (signed in: GET /api/news/for-you, items that match the resume and the companies
// searched, each with the reason) and Latest (everyone: GET /api/news with filters). Everything shown is inserted as text.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var KEY = 'sp_account';
  var $ = function (id) { return document.getElementById(id); };
  if (!$('nw-form')) return;

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
  function ago(s) {
    var d = Math.floor((Date.now() - Date.parse(s)) / 86400000);
    if (isNaN(d)) return '';
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 30 ? d + ' days ago' : new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function logo(name, domain) {
    var badge = h('span', { class: 'jb-initials', 'aria-hidden': 'true' }, String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase());
    if (!name) return badge;
    var img = h('img', { class: 'jb-logo', alt: '', width: '44', height: '44', loading: 'lazy', src: API + '/api/logo?' + (domain ? 'domain=' + encodeURIComponent(domain) + '&' : '') + 'name=' + encodeURIComponent(name) });
    img.addEventListener('error', function () { img.replaceWith(badge); });
    return img;
  }
  var KIND = { news: 'News', training: 'Training', highlight: 'Highlight' };

  function card(it) {
    var cost = it.cost === 'free' ? h('span', { class: 'nw-pill free' }, 'Free') : it.cost === 'paid' ? h('span', { class: 'nw-pill paid' }, 'Paid' + (it.priceNote ? ' · ' + it.priceNote : '')) : null;
    return h('article', { class: 'nw-card card' }, [
      logo(it.company, it.domain),
      h('div', { class: 'nw-body' }, [
        h('div', { class: 'nw-meta' }, [h('span', { class: 'nw-kind' }, KIND[it.kind] || 'News'), cost, it.company ? h('span', { class: 'muted' }, it.company) : null, h('span', { class: 'muted' }, ago(it.publishedAt))]),
        h('h3', {}, h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.title)),
        it.summary ? h('p', { class: 'muted' }, it.summary) : null,
        it.reasons && it.reasons.length ? h('ul', { class: 'nw-why' }, it.reasons.map(function (r) { return h('li', {}, r); })) : null,
        it.tags && it.tags.length ? h('p', { class: 'nw-tags' }, it.tags.map(function (t) { return h('span', {}, t); })) : null,
      ]),
      h('a', { class: 'btn nw-go', href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.kind === 'training' ? 'View training' : 'Read more'),
    ]);
  }

  // ---------- tabs ----------
  var tabs = [['you', $('nw-tab-you'), $('nw-pane-you')], ['all', $('nw-tab-all'), $('nw-pane-all')]];
  var loadedYou = false, loadedAll = false;
  function select(id, focus) {
    tabs.forEach(function (t) {
      var on = t[0] === id;
      t[1].setAttribute('aria-selected', on ? 'true' : 'false'); t[1].tabIndex = on ? 0 : -1; t[2].hidden = !on;
      if (on && focus) t[1].focus();
    });
    try { history.replaceState(null, '', id === 'you' ? '?tab=you' : '?tab=all'); } catch (e) { /* ignore */ }
    if (id === 'you' && !loadedYou) { loadedYou = true; loadYou(); }
    if (id === 'all' && !loadedAll) { loadedAll = true; load(1); }
  }
  tabs.forEach(function (t, i) {
    t[1].addEventListener('click', function () { select(t[0]); });
    t[1].addEventListener('keydown', function (e) {
      var n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (n) { e.preventDefault(); select(tabs[(i + n + tabs.length) % tabs.length][0], true); }
    });
  });

  // ---------- For you ----------
  function loadYou() {
    var box = $('nw-for-you');
    if (!member) {
      box.replaceChildren(h('div', { class: 'card nw-lock' }, [
        h('h2', {}, 'Picked from your resume'),
        h('p', { class: 'muted' }, 'Sign in and add your resume to see the news and trainings that match your skills and the companies you searched. Free to join.'),
        h('p', { class: 'btn-row' }, [h('a', { class: 'btn btn-primary', href: 'signup.html' }, 'Start free'), h('a', { class: 'btn', href: 'login.html' }, 'Sign in')]),
      ]));
      return;
    }
    box.replaceChildren(h('p', { class: 'muted' }, 'Finding items for you…'));
    get('/api/news/for-you', true).then(function (d) {
      var out = [];
      var b = d.basedOn || {};
      var parts = [];
      if (b.skills && b.skills.length) parts.push('skills: ' + b.skills.slice(0, 6).join(', '));
      if (b.companies && b.companies.length) parts.push('companies: ' + b.companies.slice(0, 4).join(', '));
      if (parts.length) out.push(h('p', { class: 'muted' }, 'Based on your resume (' + parts.join('; ') + ').'));
      var latest = h('button', { class: 'btn', type: 'button' }, 'See the latest');
      latest.addEventListener('click', function () { select('all'); });
      if (!d.items.length) out.push(h('div', { class: 'card' }, [h('p', {}, d.message || 'Nothing matches yet.'), h('p', {}, latest)]));
      d.items.forEach(function (it) { out.push(card(it)); });
      box.replaceChildren.apply(box, out);
    }).catch(function (e) {
      if (e.status === 401) { member = false; loadedYou = false; loadYou(); loadedYou = true; return; }
      if (e.code === 'no-resume') {
        box.replaceChildren(h('div', { class: 'card nw-lock' }, [h('h2', {}, 'Add your resume first'), h('p', { class: 'muted' }, e.message), h('p', { class: 'btn-row' }, h('a', { class: 'btn btn-primary', href: 'career.html' }, 'Open my Career toolkit'))]));
        return;
      }
      box.replaceChildren(h('p', { class: 'form-result bad' }, e.message));
    });
  }

  // ---------- Latest ----------
  var form = $('nw-form'), companyBuilt = false, timer = null;
  function query(page) {
    var p = new URLSearchParams();
    [['q', 'nw-q'], ['kind', 'nw-kind'], ['cost', 'nw-cost'], ['company', 'nw-company']].forEach(function (f) { var v = $(f[1]).value.trim(); if (v) p.set(f[0], v); });
    if (page > 1) p.set('page', page);
    return p.toString();
  }
  function load(page) {
    var list = $('nw-list');
    $('nw-count').textContent = 'Loading…';
    get('/api/news' + (query(page) ? '?' + query(page) : '')).then(function (d) {
      if (!companyBuilt) {
        companyBuilt = true;
        var sel = $('nw-company');
        d.companies.forEach(function (c) { sel.appendChild(h('option', { value: c.name }, c.name + ' (' + c.count + ')')); });
      }
      $('nw-count').textContent = d.total ? d.total + ' item' + (d.total === 1 ? '' : 's') : '';
      list.replaceChildren.apply(list, d.items.length ? d.items.map(card) : [h('div', { class: 'card' }, [h('p', {}, d.total === 0 && !query(1) ? 'No news or trainings are published yet. Please check back soon.' : 'Nothing matches. Try fewer filters.')])]);
      var pager = $('nw-pager'); pager.replaceChildren();
      if (d.pages > 1) {
        if (d.page > 1) pager.appendChild(h('button', { class: 'btn', type: 'button', id: 'nw-prev' }, '← Newer'));
        pager.appendChild(h('span', { class: 'muted' }, 'Page ' + d.page + ' of ' + d.pages));
        if (d.page < d.pages) pager.appendChild(h('button', { class: 'btn', type: 'button', id: 'nw-next' }, 'Older →'));
        var prev = $('nw-prev'), next = $('nw-next');
        if (prev) prev.addEventListener('click', function () { load(d.page - 1); list.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        if (next) next.addEventListener('click', function () { load(d.page + 1); list.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      }
    }).catch(function (e) { $('nw-count').textContent = ''; list.replaceChildren(h('p', { class: 'form-result bad' }, e.message)); });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); });
  form.addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { load(1); }, e.target.id === 'nw-q' ? 300 : 0); });

  var want = new URLSearchParams(location.search).get('tab');
  select(want === 'you' || want === 'all' ? want : member ? 'you' : 'all');
})();
