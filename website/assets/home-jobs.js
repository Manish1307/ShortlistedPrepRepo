// Home page Jobs section: the live numbers and the three latest jobs, read from the server (the same data as the Jobs page).
// Everything shown is inserted as text, never as HTML.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var list = document.getElementById('hj-list'), stats = document.getElementById('hj-stats');
  if (!list || !API) return;
  var member = document.documentElement.getAttribute('data-auth') === 'member';

  function h(tag, cls, kids) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    [].concat(kids === undefined ? [] : kids).forEach(function (k) { if (k !== null && k !== undefined && k !== false) e.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k))); });
    return e;
  }
  function ago(j) {
    var s = j.postedAt || j.addedAt, word = j.postedAt ? 'Posted' : 'Added';
    var d = s ? Math.floor((Date.now() - Date.parse(s)) / 86400000) : NaN;
    return isNaN(d) ? '' : d <= 0 ? word + ' today' : d === 1 ? word + ' yesterday' : d < 30 ? word + ' ' + d + ' days ago' : word + ' ' + new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function logo(name, domain) {
    var badge = h('span', 'hj-initials', String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase());
    var img = document.createElement('img');
    img.className = 'hj-logo'; img.alt = ''; img.width = 44; img.height = 44; img.loading = 'lazy';
    img.src = API + '/api/logo?' + (domain ? 'domain=' + encodeURIComponent(domain) + '&' : '') + 'name=' + encodeURIComponent(name || '');
    img.addEventListener('error', function () { img.replaceWith(badge); });
    return img;
  }
  function card(j) {
    var a = h('a', 'hj-job', [logo(j.company, j.domain),
      h('div', '', [h('div', 't', j.title), h('div', 'm', [j.company, j.location || j.country, ago(j)].filter(Boolean).join(' · '))]),
      member ? null : h('span', 'hj-lock', '🔒 Fit score')]);
    a.href = 'jobs.html?tab=latest';
    return a;
  }

  list.replaceChildren(h('div', 'hj-skel'), h('div', 'hj-skel'), h('div', 'hj-skel'));
  fetch(API + '/api/jobs/filters').then(function (r) { return r.json(); }).then(function (f) {
    if (f && f.total) stats.textContent = f.total.toLocaleString('en-IN') + ' live jobs from ' + f.companyCount.toLocaleString('en-IN') + ' company career sites' + (f.updatedAt ? ', updated ' + new Date(f.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  }).catch(function () { /* the numbers are a bonus */ });
  fetch(API + '/api/jobs?country=India&size=3').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.jobs || !d.jobs.length) throw new Error('none');
    list.replaceChildren.apply(list, d.jobs.map(card));
  }).catch(function () {
    list.replaceChildren(h('a', 'hj-more', 'See the latest jobs →'));
    list.firstChild.href = 'jobs.html';
  });
})();
