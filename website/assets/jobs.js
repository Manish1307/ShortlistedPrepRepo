// Jobs page. Everyone can browse the jobs the server holds, with filters (GET /api/jobs). Signed-in candidates also see jobs
// picked from their resume (GET /api/career/recommended), and the live AI search sends guests to sign in or the plans and
// members to the Career toolkit. Everything shown is inserted as text, never as HTML.
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
    if (!s) return '';
    var d = Math.floor((Date.now() - Date.parse(s)) / 86400000);
    if (isNaN(d)) return '';
    return d <= 0 ? 'Posted today' : d === 1 ? 'Posted yesterday' : d < 30 ? 'Posted ' + d + ' days ago' : 'Posted ' + new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function logo(name, domain) {
    var badge = h('span', { class: 'jb-initials', 'aria-hidden': 'true' }, String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase());
    var img = h('img', { class: 'jb-logo', alt: '', width: '40', height: '40', loading: 'lazy', src: API + '/api/logo?' + (domain ? 'domain=' + encodeURIComponent(domain) + '&' : '') + 'name=' + encodeURIComponent(name || '') });
    img.addEventListener('error', function () { img.replaceWith(badge); });
    return img;
  }
  function row(j, extra) {
    var meta = [j.company, j.location || j.country, j.type, ago(j.postedAt)].filter(Boolean).join(' · ');
    return h('div', { class: 'jb-row' }, [
      logo(j.company, j.domain),
      h('div', {}, [h('div', { class: 't' }, j.title), h('div', { class: 'm' }, meta), extra || null]),
      h('div', { class: 'jb-side' }, [j.score !== undefined ? h('span', { class: 'jb-score ' + (j.score >= 65 ? 'good' : j.score < 45 ? 'low' : ''), title: 'How well the job fits your resume' }, String(j.score)) : null,
        h('a', { class: 'btn btn-primary btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Apply ↗')])]);
  }

  // ---------- the live AI search: members go to the toolkit, guests sign in or choose a plan ----------
  (function () {
    var box = $('jb-ai-actions'), next = encodeURIComponent(AI_PAGE);
    if (member) box.appendChild(h('a', { class: 'btn btn-primary', href: AI_PAGE }, 'Open AI job search'));
    else {
      box.appendChild(h('a', { class: 'btn btn-primary', href: 'login.html?next=' + next }, 'Sign in to search'));
      box.appendChild(h('a', { class: 'btn', href: 'signup.html?next=' + next }, 'Start free'));
      box.appendChild(h('a', { class: 'btn', href: 'pricing.html' }, 'See plans'));
    }
  })();

  // ---------- jobs picked from the resume (signed in) ----------
  (function () {
    var box = $('jb-for-you');
    if (!member) {
      box.appendChild(h('div', { class: 'jb-teaser' }, [
        h('p', {}, [h('b', {}, '⭐ Jobs picked from your resume. '), 'Create a free account, upload your resume, and we show the jobs that fit your role and skills first.']),
        h('span', { class: 'jb-ai-actions' }, [h('a', { class: 'btn btn-primary btn-sm', href: 'signup.html?next=jobs.html' }, 'Start free'), h('a', { class: 'btn btn-sm', href: 'login.html?next=jobs.html' }, 'Sign in')])]));
      return;
    }
    var list = h('div', { class: 'jb-list' }, h('p', { class: 'muted' }, 'Finding jobs for your resume…'));
    box.appendChild(h('div', { class: 'jb-foryou' }, [h('h2', {}, '⭐ Recommended for you'), h('p', { class: 'muted', id: 'jb-fy-note' }, 'Picked from your resume among the jobs we hold. Instant and free.'), list]));
    get('/api/career/recommended?country=India', true).then(function (d) {
      var jobs = d.recommended || [];
      if (!jobs.length) {
        list.replaceChildren(h('div', { class: 'jb-empty' }, [d.message || 'No recommended jobs yet. ', ' ', h('a', { href: 'career.html#cr-jobs' }, 'Open the Career toolkit')]));
        return;
      }
      list.replaceChildren.apply(list, jobs.slice(0, 6).map(function (j) {
        return row(j, h('div', { class: 'why' }, [j.role ? 'Fits your role: ' + j.role : '', j.skills && j.skills.length ? 'Skills in common: ' + j.skills.slice(0, 4).join(', ') : ''].filter(Boolean).join(' · ')));
      }).concat([h('p', {}, h('a', { href: 'career.html#cr-jobs' }, 'See all ' + jobs.length + ' recommended jobs and change the filters →'))]));
    }).catch(function (e) {
      if (e.code === 'no-resume') list.replaceChildren(h('div', { class: 'jb-empty' }, [h('a', { href: 'career.html#cr-resume' }, 'Upload your resume'), ' to see jobs picked for you.']));
      else if (e.status === 401) list.replaceChildren(h('div', { class: 'jb-empty' }, [h('a', { href: 'login.html?next=jobs.html' }, 'Sign in again'), ' to see jobs picked for you.']));
      else list.replaceChildren(h('div', { class: 'jb-empty' }, e.message));
    });
  })();

  // ---------- browse all the jobs we hold ----------
  var FIELDS = ['q', 'country', 'city', 'company', 'type', 'days', 'sort'];
  var state = { page: 1 };
  var pager = $('jb-pager'), results = $('jb-results'), count = $('jb-count');

  function options(sel, first, items) {
    sel.replaceChildren(h('option', { value: '' }, first));
    items.forEach(function (it) { sel.appendChild(h('option', { value: it.name }, it.name + ' (' + it.count.toLocaleString() + ')')); });
  }
  function readForm() {
    var v = {};
    FIELDS.forEach(function (k) { v[k] = form.elements[k].value.trim(); });
    v.remote = form.elements.remote.checked ? '1' : '';
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
    var v = readForm(), q = queryOf(v, state.page);
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
    count.textContent = 'Loading jobs…';
    get('/api/jobs?' + q.toString() + (q.has('page') ? '' : '&page=1') + '&size=20').then(function (d) {
      count.textContent = d.total ? d.total.toLocaleString() + ' job' + (d.total === 1 ? '' : 's') + ' found' : 'No jobs found';
      if (!d.jobs.length) results.replaceChildren(h('div', { class: 'jb-empty' }, 'No jobs match these filters. Try a different keyword or clear a filter.'));
      else results.replaceChildren(h('div', { class: 'jb-list' }, d.jobs.map(function (j) { return row(j); })));
      drawPager(d.page, d.pages);
    }).catch(function (e) { count.textContent = e.message; results.replaceChildren(); pager.replaceChildren(); });
  }
  function drawPager(page, pages) {
    pager.replaceChildren();
    if (pages <= 1) return;
    var btn = function (label, p, cls, disabled) {
      var b = h('button', { class: 'btn btn-sm ' + (cls || ''), type: 'button', 'aria-label': 'Page ' + p, 'aria-current': cls === 'cur' ? 'page' : null, disabled: disabled ? '' : null }, label);
      b.addEventListener('click', function () { load(p); $('jb-browse-title').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      return b;
    };
    pager.appendChild(btn('‹ Previous', page - 1, '', page <= 1));
    var from = Math.max(1, page - 2), to = Math.min(pages, page + 2);
    if (from > 1) { pager.appendChild(btn('1', 1)); if (from > 2) pager.appendChild(h('span', { class: 'muted' }, '…')); }
    for (var p = from; p <= to; p++) pager.appendChild(btn(String(p), p, p === page ? 'cur' : ''));
    if (to < pages) { if (to < pages - 1) pager.appendChild(h('span', { class: 'muted' }, '…')); pager.appendChild(btn(String(pages), pages)); }
    pager.appendChild(btn('Next ›', page + 1, '', page >= pages));
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); load(1); });
  form.elements.remote.addEventListener('change', function () { load(1); });
  ['country', 'company', 'type', 'days', 'sort'].forEach(function (k) { form.elements[k].addEventListener('change', function () { load(1); }); });
  $('jb-reset').addEventListener('click', function () {
    form.reset();
    form.elements.country.value = '';
    load(1);
  });

  // the filters come from what the server holds; the address can carry a search (jobs.html?q=java&country=India)
  var params = new URLSearchParams(location.search);
  get('/api/jobs/filters').then(function (f) {
    options(form.elements.country, 'Any country', f.countries);
    options(form.elements.company, 'Any company', f.companies);
    options(form.elements.type, 'Any job type', f.types);
    $('jb-lead').textContent = f.total.toLocaleString() + ' jobs from ' + f.companyCount.toLocaleString() + ' companies' + (f.updatedAt ? ', updated ' + new Date(f.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '') + '. Browse free, no sign-in needed.';
    FIELDS.forEach(function (k) { if (params.get(k)) form.elements[k].value = params.get(k); });
    if (!params.has('country') && f.countries.some(function (c) { return c.name === 'India'; })) form.elements.country.value = 'India';
    form.elements.remote.checked = params.get('remote') === '1';
    load(Math.max(1, Number(params.get('page')) || 1));
  }).catch(function (e) { count.textContent = e.message; });
})();
