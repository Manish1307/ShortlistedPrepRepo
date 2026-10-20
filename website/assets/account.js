// Sign in (login.html) and My account (account.html). The login is made by us in the admin portal and sent to the
// customer by email; at the first sign-in they choose their own password. The server is on another address, so the
// sign-in token is kept in this browser (sessionStorage, or localStorage with "Keep me signed in") and sent as
// Authorization: Bearer. Everything from the server is inserted as text, never as HTML.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var KEY = 'sp_account';

  // ---------- the sign-in token ----------
  function saved() {
    for (var i = 0; i < 2; i++) {
      try {
        var s = JSON.parse((i ? localStorage : sessionStorage).getItem(KEY) || 'null');
        if (s && s.token && Date.parse(s.expiresAt) > Date.now()) return s;
      } catch (e) { /* storage blocked */ }
    }
    return null;
  }
  function save(session, remember) {
    forget();
    try { (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(session)); } catch (e) { /* this page only */ }
  }
  function forget() {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* blocked */ }
    try { localStorage.removeItem(KEY); } catch (e) { /* blocked */ }
  }

  function call(method, path, body) {
    var s = saved();
    var headers = { 'Content-Type': 'application/json' };
    if (s) headers.Authorization = 'Bearer ' + s.token;
    return fetch(API + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .catch(function () { throw new Error('Cannot reach the server. Check your internet connection and try again.'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var err = new Error(j.error || 'Something went wrong (' + r.status + ')'); err.status = r.status; err.code = j.code; throw err; }
          return j;
        });
      });
  }

  // ---------- small helpers ----------
  function h(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else e.setAttribute(k, v === true ? '' : v);
    });
    (function append(list) {   // children may be nested lists
      list.forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) append(c);
        else e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      });
    })([].slice.call(arguments, 2));
    return e;
  }
  /** A small line icon (stroke drawn in the current colour). */
  var ICONS = {
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    class: '<path d="M4 5h16v11H4z"/><path d="M8 20h8M12 16v4"/><path d="M9 9l2 2 4-4"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
  };
  function icon(name, size) {
    var span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="' + (size || 22) + '" height="' + (size || 22) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';   // our own fixed markup, never server data
    return span.firstChild;
  }
  function tile(name, colour) { return h('span', { class: 'ac-ico ' + colour }, icon(name)); }

  function date(s) { return s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function dateTime(s) { return s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function time(s) { return new Date(s).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function minutes(sec) { var m = Math.max(1, Math.round((sec || 0) / 60)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  function daysLeft(s) { return s ? Math.ceil((Date.parse(s) - Date.now()) / 86400000) : null; }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function initials(name) { return String(name || '?').replace(/[._-]+/g, ' ').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
  function money(cents, cur) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format((cents || 0) / 100); }
    catch (e) { return ((cents || 0) / 100).toFixed(2) + ' ' + (cur || ''); }
  }
  var STATUS = { active: ['Active', 'good'], expired: ['Expired', 'warn'], revoked: ['Cancelled', 'bad'], paid: ['Paid', 'good'], refunded: ['Refunded', 'warn'], failed: ['Failed', 'bad'] };
  function badge(s) { var b = STATUS[s] || [cap(s), 'plain']; return h('span', { class: 'ac-badge ' + b[1] }, b[0]); }
  function goSignIn() { forget(); location.replace('login.html'); }

  // ===================== login.html =====================
  var loginForm = document.getElementById('account-login');
  if (loginForm) {
    if (saved()) { location.replace('account.html'); return; }
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var out = loginForm.querySelector('.form-result');
      var button = loginForm.querySelector('button[type=submit]');
      var email = loginForm.email.value.trim(), password = loginForm.password.value;
      if (!email || !password) { out.className = 'form-result bad'; out.textContent = 'Enter your email and password.'; return; }
      if (!API) { out.className = 'form-result bad'; out.textContent = 'Sign-in is not connected yet.'; return; }
      out.className = 'form-result'; out.textContent = 'Signing in…';
      button.disabled = true;
      call('POST', '/api/account/login', { email: email, password: password }).then(function (r) {
        save({ token: r.token, expiresAt: r.expiresAt }, loginForm.remember.checked);
        location.replace('account.html');
      }).catch(function (err) {
        out.className = 'form-result bad'; out.textContent = err.message;
        button.disabled = false;
      });
    });
    return;
  }

  // ===================== account.html =====================
  var content = document.getElementById('ac-content');
  if (!content) return;
  if (!saved()) { goSignIn(); return; }
  var errorBox = document.getElementById('ac-error');
  var tabsBar = document.getElementById('ac-tabs');
  var signOut = document.getElementById('ac-signout');
  signOut.hidden = false;
  signOut.addEventListener('click', function () {
    call('POST', '/api/account/logout', {}).catch(function () { /* signed out here anyway */ }).then(goSignIn);
  });
  function showError(err) {
    if (err.status === 401) return goSignIn();
    errorBox.hidden = false; errorBox.textContent = err.message;
  }

  function card(title, body, action) {
    return h('section', { class: 'ac-card' }, h('div', { class: 'ac-card-head' }, h('h2', {}, title), action || null), body);
  }
  function empty(title, text) { return h('div', { class: 'ac-empty' }, h('b', {}, title), text); }
  function dl(rows) {
    return h('dl', { class: 'ac-dl' }, rows.map(function (r) { return [h('dt', {}, r[0]), h('dd', {}, r[1] === '' || r[1] === null || r[1] === undefined ? '—' : r[1])]; }));
  }

  /** The password form. first: the customer must replace the password we sent before seeing anything else. */
  function passwordForm(first) {
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var form = h('form', { class: 'ac-form', novalidate: true },
      h('label', {}, first ? 'Password from our email' : 'Current password', h('input', { type: 'password', name: 'current', autocomplete: 'current-password', required: true })),
      h('label', {}, 'New password', h('input', { type: 'password', name: 'next', autocomplete: 'new-password', minlength: '10', required: true })),
      h('label', {}, 'Repeat new password', h('input', { type: 'password', name: 'again', autocomplete: 'new-password', required: true })),
      h('button', { class: 'btn btn-primary', type: 'submit' }, first ? 'Save and continue' : 'Change password'), out);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.next.value.length < 10) { out.className = 'form-result bad'; out.textContent = 'Use at least 10 characters.'; return; }
      if (form.next.value !== form.again.value) { out.className = 'form-result bad'; out.textContent = 'The two new passwords are different.'; return; }
      out.className = 'form-result'; out.textContent = 'Saving…';
      call('POST', '/api/account/password', { current: form.current.value, next: form.next.value }).then(function () {
        form.reset();
        if (first) load(); else { out.className = 'form-result ok'; out.textContent = 'Password changed. You have been signed out on your other devices.'; }
      }).catch(function (err) { if (err.status === 401) return goSignIn(); out.className = 'form-result bad'; out.textContent = err.message; });
    });
    return form;
  }

  /** The candidate's sector: required. It decides which employers AI Job search reads. */
  function sectorForm(me) {
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var sel = h('select', { name: 'sector', required: true, 'aria-label': 'Sector' },
      [h('option', { value: '' }, 'Choose your sector…')].concat((me.sectors || []).map(function (s) { return h('option', { value: s.id }, s.label); })));
    sel.value = me.customer.sector || '';
    var form = h('form', { class: 'ac-form', id: 'ac-sector-form', novalidate: true },
      h('label', {}, 'Sector (required)', sel),
      h('button', { class: 'btn btn-primary', type: 'submit' }, me.customer.sector ? 'Update sector' : 'Save sector'), out);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!sel.value) { out.className = 'form-result bad'; out.textContent = 'Please choose your sector.'; return; }
      out.className = 'form-result'; out.textContent = 'Saving…';
      call('POST', '/api/account/profile', { sector: sel.value }).then(function () { me.customer.sector = sel.value; render(me); }).catch(function (err) {
        if (err.status === 401) return goSignIn(); out.className = 'form-result bad'; out.textContent = err.message;
      });
    });
    return form;
  }

  // ---------- sections ----------
  function licenceBlock(l) {
    var left = daysLeft(l.expiresAt);
    var used = l.devices.length;
    var copy = h('button', { class: 'ac-copy', type: 'button', onclick: function () {
      (navigator.clipboard ? navigator.clipboard.writeText(l.key) : Promise.reject()).then(function () { copy.textContent = 'Copied'; }, function () { copy.textContent = 'Select to copy'; });
      setTimeout(function () { copy.textContent = 'Copy'; }, 1800);
    } }, 'Copy');
    var bar = h('div', { class: 'ac-bar' }, h('i', { style: 'width:' + Math.min(100, Math.round((used / Math.max(1, l.maxDevices)) * 100)) + '%' }));
    return h('div', { class: 'ac-licence' },
      h('div', { class: 'ac-lic-head' }, h('span', { class: 'ac-key' }, l.key, copy), badge(l.status)),
      h('div', { class: 'ac-facts' },
        h('div', { class: 'ac-fact' }, h('span', {}, 'Plan'), h('b', {}, l.plan === 'trial' ? 'Free trial' : cap(l.plan) + (l.kind === 'trial' ? ' (trial)' : ''))),
        h('div', { class: 'ac-fact' }, h('span', {}, 'Valid until'), h('b', {}, l.expiresAt ? date(l.expiresAt) : 'Lifetime'),
          l.status === 'active' && left !== null ? h('small', {}, left > 0 ? plural(left, 'day') + ' left' : 'ends today') : null),
        h('div', { class: 'ac-fact' }, h('span', {}, 'Issued'), h('b', {}, date(l.createdAt))),
        h('div', { class: 'ac-fact' }, h('span', {}, 'Computers'), h('b', {}, used + ' of ' + l.maxDevices + ' in use'), bar)),
      h('div', { class: 'ac-subhead' }, 'Machines'),
      used ? l.devices.map(function (d) {
        return h('div', { class: 'ac-machine' }, tile('laptop', 'teal'),
          h('div', { class: 'ac-machine-main' }, h('b', {}, d.name || 'Computer'), h('span', {}, 'Machine ID ' + d.machineId + (d.appVersion ? ' · App v' + d.appVersion : ''))),
          h('div', { class: 'ac-machine-side' }, h('b', {}, dateTime(d.lastSeen)), 'Activated ' + date(d.firstSeen)));
      }) : h('p', { class: 'ac-muted' }, 'Not activated on a computer yet. Open the app and enter this key to start.'));
  }

  function classList(list, limit) {
    if (!list.length) return empty('No classes yet', 'Each Live Class session is saved here when you press End.');
    return h('div', {}, list.slice(0, limit || list.length).map(function (c) {
      var d = new Date(c.started_at);
      var body = h('div', { class: 'ac-class-body' });
      var item = h('details', { class: 'ac-class' },
        h('summary', {},
          h('span', { class: 'ac-date' }, h('b', {}, String(d.getDate())), h('span', {}, d.toLocaleDateString(undefined, { month: 'short' }))),
          h('span', { class: 'ac-class-main' }, h('b', {}, c.first_question || 'Class without questions'),
            h('span', {}, time(c.started_at) + ' · ' + minutes(c.duration_sec) + ' · ' + plural(c.question_count, 'question') + (c.device_name ? ' · ' + c.device_name : ''))),
          h('span', { class: 'ac-chev' }, icon('chev', 18))),
        body);
      item.addEventListener('toggle', function () {
        if (!item.open || body.childNodes.length) return;
        body.appendChild(h('p', { class: 'ac-muted' }, 'Loading…'));
        call('GET', '/api/account/conversations/' + c.id).then(function (r) {
          body.textContent = '';
          if (!r.items.length) body.appendChild(h('p', { class: 'ac-muted' }, 'No questions were asked in this class.'));
          r.items.forEach(function (it) {
            body.appendChild(h('div', { class: 'ac-qa' },
              h('span', { class: 'ac-time' }, 'Question ' + it.position + ' · ' + time(it.asked_at)),
              h('div', { class: 'ac-q' }, it.question),
              h('div', { class: 'ac-a' }, it.status === 'done' ? it.answer : h('span', { class: 'ac-muted' }, 'Not answered'))));
          });
          if (r.conversation.transcript.length) {
            body.appendChild(h('details', { class: 'ac-transcript' }, h('summary', {}, 'Show everything that was heard (' + r.conversation.transcript.length + ' lines)'),
              r.conversation.transcript.map(function (p) { return h('div', {}, h('span', { class: 'ac-time' }, time(p.at) + '  '), p.text); })));
          }
        }).catch(function (err) { body.textContent = err.message; });
      });
      return item;
    }));
  }

  function topicsBody(p, short) {
    return h('div', {},
      p.topics.length ? h('div', { class: 'ac-chips' }, p.topics.map(function (t) { return h('span', { class: 'ac-chip' }, t); }))
        : h('p', { class: 'ac-muted' }, 'No topics set yet. Contact us to add the areas your questions are about.'),
      short ? null : (p.resume
        ? h('details', { class: 'ac-resume' }, h('summary', {}, icon('doc', 18), 'Resume' + (p.resumeName ? ' · ' + p.resumeName : '')), h('pre', {}, p.resume))
        : h('p', { class: 'ac-muted', style: 'margin-top:14px' }, 'No resume on file.')),
      p.updatedAt ? h('p', { class: 'ac-muted', style: 'margin-top:12px;font-size:13px' }, 'Last updated ' + dateTime(p.updatedAt)) : null);
  }

  // ---------- Interview prep: personalised questions made from the candidate's resume (also in the desktop app) ----------
  var IV_GROUPS = [['personal', 'Questions from your resume', 'About things your resume says: your projects, tools and results.'], ['scenario', 'Scenario-based questions', 'Situations your roles would meet. Say what you would do, step by step.']];
  function ivQuestion(q, n) {
    var ans = h('div', { class: 'pp-ans', hidden: true }, h('p', {}, q.answer),
      q.points && q.points.length ? h('ul', { class: 'iv-points' }, q.points.map(function (p) { return h('li', {}, p); })) : null);
    var btn = h('button', { class: 'pp-qa-btn', type: 'button', 'aria-expanded': 'false' }, h('span', { 'aria-hidden': 'true' }, '👁'), ' Show answer');
    btn.addEventListener('click', function () {
      var open = ans.hidden;
      ans.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.replaceChildren(h('span', { 'aria-hidden': 'true' }, open ? '🙈' : '👁'), open ? ' Hide answer' : ' Show answer');
    });
    return h('li', { class: 'pp-q' }, h('div', { class: 'pp-q-text' }, h('span', { class: 'pp-q-n' }, String(n)), h('span', {}, q.question)),
      q.resumeRef ? h('p', { class: 'iv-ref' }, 'From your resume: "' + q.resumeRef + '"') : null, btn, ans);
  }
  function ivSet(set, onDelete) {
    var n = 0;
    var del = h('button', { class: 'btn btn-sm', type: 'button' }, 'Delete');
    del.addEventListener('click', function (e) { e.preventDefault(); if (window.confirm('Delete this question set?')) onDelete(); });
    return h('details', { class: 'ac-class' },
      h('summary', {},
        h('span', { class: 'ac-class-main' }, h('b', {}, set.resumeLabel + (set.role ? ' · ' + set.role : '')),
          h('span', {}, dateTime(set.createdAt) + ' · ' + plural(set.questions.length, 'question') + (set.source === 'app' ? ' · made in the Virtual Interview app' : ''))),
        h('span', { class: 'ac-chev' }, icon('chev', 18))),
      h('div', { class: 'ac-class-body' }, IV_GROUPS.map(function (g) {
        var list = set.questions.filter(function (q) { return q.kind === g[0]; });
        return list.length ? h('div', { class: 'pp-qgroup' }, h('h5', {}, g[1] + ' (' + list.length + ')', h('span', { class: 'ac-muted' }, ' · ' + g[2])),
          h('ol', { class: 'pp-qlist' }, list.map(function (q) { return ivQuestion(q, ++n); }))) : null;
      }), h('div', { class: 'iv-actions' }, del)));
  }
  function interviewPanel() {
    var body = h('div', {}, h('p', { class: 'ac-muted' }, 'Loading…'));
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    function draw(d) {
      var sel = h('select', { 'aria-label': 'Resume' }, d.resumes.map(function (r) { return h('option', { value: r.key }, r.label); }));
      var role = h('input', { type: 'text', maxlength: '120', placeholder: 'Target role (optional), e.g. Seed Breeder', 'aria-label': 'Target role' });
      var go = h('button', { class: 'btn btn-primary', type: 'button', disabled: !d.resumes.length }, '✦ Make my questions (uses 1 AI action)');
      go.addEventListener('click', function () {
        go.disabled = true; out.className = 'form-result'; out.textContent = 'Reading your resume and writing your questions… (about 30 seconds)';
        call('POST', '/api/account/interview', { resumeKey: sel.value, role: role.value.trim() }).then(function () { return load(); })
          .catch(function (e) { go.disabled = false; out.className = 'form-result bad'; out.textContent = e.message; });
      });
      var del = function (id) { call('POST', '/api/account/interview/' + id + '/delete').then(load).catch(function (e) { out.className = 'form-result bad'; out.textContent = e.message; }); };
      body.replaceChildren(
        h('p', { class: 'ac-muted', style: 'margin-bottom:14px' }, 'Practice questions made only from your own resume, with a model answer for each. The same questions appear in the Virtual Interview app on your computer, and your support team can see them.'),
        d.resumes.length ? h('div', { class: 'iv-form' }, sel, role, go) : empty('No resume yet', 'Upload your resume in the Career toolkit (step 1) and your questions will be made from it.'),
        out,
        d.sets.length ? h('div', { class: 'iv-sets' }, d.sets.map(function (s) { return ivSet(s, function () { del(s.id); }); })) : (d.resumes.length ? h('p', { class: 'ac-muted', style: 'margin-top:14px' }, 'No question sets yet.') : null));
    }
    function load() { return call('GET', '/api/account/interview').then(draw).catch(function (e) { body.replaceChildren(h('p', { class: 'form-result bad' }, e.message)); }); }
    load();
    return card('Interview prep', body);
  }

  // ---------- page ----------
  var TABS = [['overview', 'Overview'], ['licences', 'Licences & machines'], ['classes', 'Live Class history'], ['interview', 'Interview prep'], ['topics', 'Topics & resume'], ['orders', 'Orders'], ['security', 'Security']];
  var panels = {};
  function show(id) {
    if (!panels[id]) id = 'overview';
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== id; });
    tabsBar.querySelectorAll('.ac-tab').forEach(function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === id ? 'true' : 'false'); });
    if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  }

  function render(me) {
    var c = me.customer, p = me.profile;
    var active = me.licences.filter(function (l) { return l.status === 'active'; });
    var machines = me.licences.reduce(function (n, l) { return n + l.devices.length; }, 0);
    // the licence to feature: an active paid one in use first, then any active one, then the newest
    var rank = function (l) { return (l.status === 'active' ? 4 : 0) + (l.kind === 'paid' ? 2 : 0) + (l.devices.length ? 1 : 0); };
    var main = me.licences.slice().sort(function (a, b) { return rank(b) - rank(a); })[0];
    var left = main && main.status === 'active' ? daysLeft(main.expiresAt) : null;

    document.getElementById('ac-name').textContent = c.name || c.email;
    document.getElementById('ac-avatar').textContent = initials(c.name || c.email);
    document.getElementById('ac-sub').replaceChildren(h('span', {}, c.email), c.organisation ? h('span', {}, c.organisation) : '', h('span', {}, 'Customer since ' + date(c.since)));

    var counts = { licences: me.licences.length, classes: me.conversations.length, orders: me.orders.length };
    tabsBar.replaceChildren.apply(tabsBar, TABS.filter(function (t) { return t[0] !== 'orders' || me.orders.length; }).map(function (t) {
      return h('button', { class: 'ac-tab', type: 'button', role: 'tab', 'data-tab': t[0], onclick: function () { show(t[0]); } },
        t[1], counts[t[0]] ? h('span', { class: 'ac-count' }, String(counts[t[0]])) : null);
    }));
    tabsBar.hidden = false;
    var go = function (id) { return h('button', { class: 'ac-link', type: 'button', onclick: function () { show(id); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 'View all'); };

    var stat = function (ico, colour, num, label) { return h('div', { class: 'ac-stat' }, tile(ico, colour), h('div', {}, h('b', {}, String(num)), h('span', {}, label))); };
    panels = {
      overview: h('div', { class: 'ac-panel' },
        c.sector ? null : h('section', { class: 'ac-card ac-need' }, tile('class', 'sun'), h('div', {}, h('b', {}, 'Choose your sector'),
          h('p', { class: 'ac-muted' }, 'It is required. We use it to search the right employers for you in AI Job search.'),
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: function () { var f = document.getElementById('ac-sector-form'); if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.sector.focus(); } } }, 'Choose now'))),
        h('div', { class: 'ac-stats' },
          stat('key', 'purple', active.length, active.length === 1 ? 'Active licence' : 'Active licences'),
          stat('laptop', 'teal', machines, machines === 1 ? 'Computer' : 'Computers'),
          stat('class', 'pink', me.conversations.length, me.conversations.length === 1 ? 'Saved class' : 'Saved classes'),
          stat('calendar', 'sun', left === null ? (main && main.status === 'active' ? '∞' : '—') : Math.max(0, left), left === null ? (main && main.status === 'active' ? 'Never expires' : 'No active licence') : 'Days left on licence')),
        h('div', { class: 'ac-grid' },
          h('div', { class: 'ac-stack' },
            card('Your licence', main ? licenceBlock(main) : empty('No licence yet', 'Contact us to get started.'), me.licences.length > 1 ? go('licences') : null),
            card('Recent classes', classList(me.conversations, 3), me.conversations.length > 3 ? go('classes') : null)),
          h('div', { class: 'ac-stack' },
            card('Profile', h('div', {}, dl([['Name', c.name], ['Email', c.email], ['Organisation', c.organisation], ['Country', c.country], ['Last sign-in', dateTime(me.account.lastLogin)]]), h('div', { style: 'margin-top:16px' }, sectorForm(me)))),
            card('AI focus', topicsBody(p, true), go('topics')),
            card('Get more interview calls', h('div', {},
              h('p', { class: 'ac-muted', style: 'margin-bottom:14px' }, 'Make your resume ATS-ready, create a resume for each role, and get a cover letter for every job you apply to.'),
              h('a', { class: 'btn btn-primary', href: 'career.html' }, 'Open the career toolkit')))))),
      licences: h('div', { class: 'ac-panel' }, card('Licences and machines', me.licences.length ? me.licences.map(licenceBlock) : empty('No licence yet', 'Contact us to get started.'))),
      classes: h('div', { class: 'ac-panel' }, card('Live Class history', classList(me.conversations))),
      interview: h('div', { class: 'ac-panel' }, interviewPanel()),
      topics: h('div', { class: 'ac-panel' }, card('Topics and resume', h('div', {},
        h('p', { class: 'ac-muted', style: 'margin-bottom:14px' }, 'The AI uses your topics and resume to decide the area of its answers and to fit examples to your experience.'), topicsBody(p, false)))),
      orders: h('div', { class: 'ac-panel' }, card('Orders', h('div', { class: 'ac-scroll' }, h('table', { class: 'ac-table' },
        h('thead', {}, h('tr', {}, ['Order', 'Date', 'Plan', 'Amount', 'Status'].map(function (t) { return h('th', {}, t); }))),
        h('tbody', {}, me.orders.map(function (o) {
          return h('tr', {}, h('td', {}, '#' + o.id), h('td', {}, date(o.created_at)), h('td', {}, cap(o.plan)), h('td', {}, money(o.amount_cents, o.currency)), h('td', {}, badge(o.status)));
        })))))),
      security: h('div', { class: 'ac-panel' }, h('div', { class: 'ac-grid' },
        card('Change password', h('div', {}, h('p', { class: 'ac-muted', style: 'margin-bottom:16px' }, 'Use at least 10 characters. Your other devices will be signed out.'), passwordForm(false))),
        card('Sign-in details', dl([['Signed in as', c.email], ['Last sign-in', dateTime(me.account.lastLogin)], ['Password changed', dateTime(me.account.passwordSetAt)]])))),
    };
    if (!me.orders.length) delete panels.orders;
    content.replaceChildren.apply(content, Object.keys(panels).map(function (k) { return panels[k]; }));
    show(location.hash.slice(1) || new URLSearchParams(location.search).get('tab') || '');   // account.html#interview or account.html?tab=interview
  }

  function firstPassword() {
    document.getElementById('ac-name').textContent = 'Welcome!';
    document.getElementById('ac-avatar').textContent = '👋';
    document.getElementById('ac-sub').replaceChildren(h('span', {}, 'One quick step before you start'));
    content.replaceChildren(h('section', { class: 'ac-card ac-first' }, tile('lock', 'purple'),
      h('h2', { style: 'font-size:22px;margin-bottom:6px' }, 'Choose your own password'),
      h('p', { class: 'ac-muted', style: 'margin-bottom:18px' }, 'For your security, replace the password we sent you. Use at least 10 characters.'),
      passwordForm(true)));
  }

  function load() {
    errorBox.hidden = true;
    call('GET', '/api/account/me').then(render).catch(function (err) {
      if (err.code === 'password_change') return firstPassword();
      showError(err);
    });
  }
  load();
})();
