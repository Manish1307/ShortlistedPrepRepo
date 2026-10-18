// Small enhancements only: the site works without JavaScript.
(function () {
  'use strict';
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  // mobile menu
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('menu');
  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // highlight the current page in the menu
  var page = (location.pathname.split('/').pop() || 'index.html').replace('.html', '') || 'index';
  document.querySelectorAll('.menu a[data-page]').forEach(function (a) {
    if (a.getAttribute('data-page') === page) a.classList.add('current');
  });

  // signed in (see the script in <head>): calls to action go straight into the toolkit
  if (document.documentElement.getAttribute('data-auth') === 'member') {
    document.querySelectorAll('[data-member-href]').forEach(function (a) {
      a.setAttribute('href', a.getAttribute('data-member-href'));
      if (a.getAttribute('data-member-text')) a.textContent = a.getAttribute('data-member-text');
    });
  }

  // tabs with a breadcrumb, previous / next and a progress bar (home page: the candidate journey)
  document.querySelectorAll('[data-tabs]').forEach(function (box) {
    var tabs = [].slice.call(box.querySelectorAll('[role=tab]'));
    var crumbPhase = box.querySelector('[data-crumb-phase]'), crumbStep = box.querySelector('[data-crumb-step]');
    var bar = box.querySelector('[data-progress]'), prev = box.querySelector('[data-tab-prev]'), next = box.querySelector('[data-tab-next]');
    var current = 0;
    box.classList.add('js');
    function show(i, focus) {
      current = Math.max(0, Math.min(tabs.length - 1, i));
      tabs.forEach(function (t, n) {
        var on = n === current;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.classList.toggle('on', on);
      });
      var tab = tabs[current];
      if (crumbPhase) crumbPhase.textContent = tab.getAttribute('data-phase') || '';
      if (crumbStep) crumbStep.textContent = (current + 1) + '. ' + tab.textContent.replace(/^\d+/, '').trim();
      if (bar) bar.style.width = ((current + 1) / tabs.length * 100) + '%';
      if (prev) prev.disabled = current === 0;
      if (next) next.textContent = current === tabs.length - 1 ? 'Start again ↺' : 'Next step →';
      var strip = tab.parentNode;   // on phones the steps scroll sideways: keep the current one in view
      if (strip.scrollWidth > strip.clientWidth) strip.scrollLeft = tab.offsetLeft - strip.offsetLeft - 16;
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, n) {
      t.addEventListener('click', function () { show(n); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); show(current + 1, true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); show(current - 1, true); }
      });
    });
    if (prev) prev.addEventListener('click', function () { show(current - 1); });
    if (next) next.addEventListener('click', function () { show(current === tabs.length - 1 ? 0 : current + 1); });
    show(0);
  });

  // close the Resources menu when clicking elsewhere
  document.addEventListener('click', function (e) {
    document.querySelectorAll('.dropdown[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });

  // pricing: monthly / yearly switch
  var billing = document.getElementById('billing');
  if (billing) {
    billing.addEventListener('change', function () {
      document.body.setAttribute('data-billing', billing.checked ? 'yearly' : 'monthly');
    });
  }

  // ---------- talking to the ShortlistPrep server (visits and enquiries) ----------
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';

  function storage(get, key, value) {
    try { return get ? localStorage.getItem(key) : localStorage.setItem(key, value); } catch (e) { return null; }
  }
  function visitorId() {
    var id = storage(true, 'sp_vid');
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2, 12);
      storage(false, 'sp_vid', id);
    }
    return id;
  }
  function send(path, payload) {
    if (!API) return Promise.reject(new Error('not connected'));
    return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); });
  }

  // count this page view: no cookies, no IP address, and nothing at all if the visitor asked not to be tracked
  var dnt = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  if (API && !dnt && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    var ref = '';
    try { ref = document.referrer && new URL(document.referrer).hostname !== location.hostname ? document.referrer : ''; } catch (e) { ref = ''; }
    var source = new URLSearchParams(location.search).get('utm_source') || '';
    send('/api/track', { visitor: visitorId(), path: location.pathname.replace(/\/index\.html$/, '/') || '/', referrer: ref, source: source }).catch(function () { /* analytics must never get in the way */ });
  }

  // ---------- AI tokens (signed-in customers): meter at the bottom of every page, warnings, asking for more ----------
  (function () {
    var foot = document.getElementById('tok-foot');
    if (!foot || !API || document.documentElement.getAttribute('data-auth') !== 'member') return;
    function session() {
      for (var i = 0; i < 2; i++) {
        try { var s = JSON.parse((i ? localStorage : sessionStorage).getItem('sp_account') || 'null'); if (s && s.token) return s; } catch (e) { /* blocked */ }
      }
      return null;
    }
    function call(method, path, body) {
      var s = session();
      return fetch(API + path, { method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s ? s.token : '') }, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); });
    }
    function el(tag, attrs) {
      var e = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) { if (k === 'class') e.className = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); });
      (function add(list) {
        list.forEach(function (c) { if (Array.isArray(c)) add(c); else if (c != null && c !== false) e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); });
      })([].slice.call(arguments, 2));
      return e;
    }
    function short(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n); }
    function money(p, cur) { return p ? (cur === 'INR' ? '₹' : cur + ' ') + Number(p).toLocaleString('en-IN') : 'Price on request'; }
    var data = null;

    function render(t) {
      foot.hidden = false;
      var bar = el('span', { class: 'tok-meter', role: 'img', 'aria-label': t.pct + '% of today’s tokens used' }, el('i', { class: t.level, style: 'width:' + t.pct + '%' }));
      foot.replaceChildren(el('div', { class: 'tok-line ' + t.level },
        el('b', {}, '⚡ AI tokens today'), bar,
        el('span', {}, short(t.left) + ' left', el('span', { class: 'tok-sub' }, ' · used ' + short(t.used) + ' of ' + short(t.daily) + (t.bonus ? ' · ' + short(t.bonus) + ' extra' : '') + ' · renews at midnight')),
        el('button', { class: 'btn btn-sm tok-more', type: 'button', onclick: openClaim }, 'Get more tokens')));
      alertFor(t);
    }
    function alertFor(t) {
      var old = document.getElementById('tok-alert');
      if (old) old.remove();
      if (t.level === 'ok') return;
      var key = 'sp_tok_alert_' + t.day + '_' + t.level;
      try { if (sessionStorage.getItem(key)) return; } catch (e) { /* show it */ }
      var box = el('div', { id: 'tok-alert', class: 'tok-alert ' + t.level, role: 'alert' },
        el('b', {}, t.level === 'out' ? '⚠️ You have used today’s AI tokens' : '⚡ You have used ' + t.pct + '% of today’s AI tokens'),
        el('span', {}, t.level === 'out' ? 'AI features pause until midnight. Ask for more tokens to keep going today.' : 'Only ' + short(t.left) + ' tokens left today. Ask for more if you need them.'),
        el('div', { class: 'tok-alert-actions' },
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: function () { box.remove(); openClaim(); } }, 'Get more tokens'),
          el('button', { class: 'btn btn-sm', type: 'button', onclick: function () { try { sessionStorage.setItem(key, '1'); } catch (e) { /* ignore */ } box.remove(); } }, 'Dismiss')));
      document.body.appendChild(box);
    }

    function openClaim() {
      var dlg = el('dialog', { class: 'modal tok-dialog', 'aria-labelledby': 'tok-title' });
      var out = el('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
      var packs = (data && data.packs) || [];
      var choices = el('div', { class: 'tok-packs' }, packs.map(function (p, i) {
        return el('label', { class: 'tok-pack' }, el('input', { type: 'radio', name: 'pack', value: String(p.id) }),
          el('span', {}, el('b', {}, p.name), el('span', { class: 'tok-pack-what' }, p.kind === 'daily' ? short(p.tokens) + ' tokens a day for ' + p.days + ' days' : short(p.tokens) + ' extra tokens'),
            p.description ? el('small', {}, p.description) : null), el('span', { class: 'tok-price' }, money(p.price, p.currency)));
      }), el('label', { class: 'tok-pack' }, el('input', { type: 'radio', name: 'pack', value: 'custom' }),
        el('span', {}, el('b', {}, 'Custom request'), el('span', { class: 'tok-pack-what' }, 'Tell us how many tokens you need'))));
      var amount = el('input', { type: 'number', min: '10000', step: '10000', placeholder: 'e.g. 300000', 'aria-label': 'Tokens you need' });
      var custom = el('label', { class: 'tok-custom', hidden: '' }, 'Tokens you need', amount);
      var message = el('textarea', { maxlength: '1000', placeholder: 'Anything we should know? (needed for a custom request)', 'aria-label': 'Message' });
      choices.addEventListener('change', function () { var v = (choices.querySelector('input:checked') || {}).value; custom.hidden = v !== 'custom'; });
      var first = choices.querySelector('input'); if (first) first.checked = true;
      if (first && first.value === 'custom') custom.hidden = false;
      var send = el('button', { class: 'btn btn-primary', type: 'button' }, 'Send request');
      send.addEventListener('click', function () {
        var v = (choices.querySelector('input:checked') || {}).value;
        var body = v === 'custom' ? { tokens: Number(amount.value), message: message.value.trim() } : { packId: Number(v), message: message.value.trim() };
        send.disabled = true; out.className = 'form-result'; out.textContent = 'Sending…';
        call('POST', '/api/account/tokens/claim', body).then(function () {
          out.className = 'form-result ok'; out.textContent = 'Request sent. Our team will contact you about payment and add the tokens once it is approved.';
          refresh();
        }).catch(function (e) { out.className = 'form-result bad'; out.textContent = e.message; }).then(function () { send.disabled = false; });
      });
      var claims = (data && data.claims) || [];
      var t = data && data.tokens;
      dlg.append(el('div', { class: 'stack' },
        el('div', { class: 'modal-head' }, el('h2', { id: 'tok-title' }, 'Get more AI tokens'), el('button', { type: 'button', class: 'modal-x', 'aria-label': 'Close', onclick: function () { dlg.close(); } }, '×')),
        t ? el('p', { class: 'muted small', style: 'margin:0' }, 'Today: ' + short(t.used) + ' of ' + short(t.daily) + ' used, ' + short(t.left) + ' left' + (t.bonus ? ' (incl. ' + short(t.bonus) + ' extra)' : '') + '. Tokens renew at midnight.') : null,
        choices, custom, message, send, out,
        claims.length ? el('div', { class: 'tok-claims' }, el('b', {}, 'Your requests'), claims.map(function (k) {
          return el('div', { class: 'tok-claim' }, el('span', {}, k.packName + ' · ' + short(k.tokens) + (k.kind === 'daily' ? '/day' : '')),
            el('span', { class: 'tok-status ' + k.status }, k.status === 'pending' ? 'Waiting' : k.status === 'approved' ? 'Approved ✓' : 'Not approved'));
        })) : null,
        el('p', { class: 'muted small', style: 'margin:0' }, 'An ATS check uses about 8,000 tokens; an AI job search about 20,000 to 30,000.')));
      dlg.addEventListener('close', function () { dlg.remove(); });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
      document.body.appendChild(dlg);
      dlg.showModal();
    }

    function refresh() { return call('GET', '/api/account/tokens').then(function (d) { data = d; render(d.tokens); }).catch(function () { /* not signed in any more */ }); }
    window.spTokens = { update: function (t) { if (data) data.tokens = t; render(t); }, open: openClaim, refresh: refresh };
    refresh();
  })();

  // demo dialog
  var dlg = document.getElementById('demo-dialog');
  document.querySelectorAll('[data-open-demo]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      if (dlg && dlg.showModal) { e.preventDefault(); dlg.showModal(); var f = dlg.querySelector('input'); if (f) f.focus(); }
    });
  });
  if (dlg) {
    dlg.querySelectorAll('[data-close-demo]').forEach(function (b) { b.addEventListener('click', function () { dlg.close(); }); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  }

  // every enquiry form (demo, early access, newsletter-style sign-up) becomes an "opportunity" in the admin portal
  document.querySelectorAll('.opp-form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var out = form.querySelector('.form-result') || (form.parentNode && form.parentNode.querySelector('.form-result'));
      var button = form.querySelector('button[type=submit]');
      var data = new FormData(form);
      var payload = { kind: form.getAttribute('data-kind') || 'interest', visitor: visitorId(), page: location.pathname };
      data.forEach(function (v, k) { if (k !== 'terms') payload[k] = v; });
      if (out) { out.className = 'form-result'; out.textContent = 'Sending…'; }
      if (button) button.disabled = true;
      send('/api/opportunity', payload).then(function () {
        form.reset();
        if (out) { out.className = 'form-result ok'; out.textContent = form.getAttribute('data-thanks') || 'Thank you! We will email you very soon.'; }
      }).catch(function (err) {
        if (out) { out.className = 'form-result bad'; out.textContent = String(err.message || err) === 'not connected' ? 'The sign-up service is not connected yet. Please email us instead.' : String(err.message || err); }
      }).then(function () { if (button) button.disabled = false; });
    });
  });

  // contact form: sent to the support inbox in the admin portal; if the server cannot be reached it opens the visitor's email app instead
  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      var out = form.querySelector('.form-result');
      var mailto = function () {
        var subject = encodeURIComponent('[' + data.get('topic') + '] message from ' + data.get('name'));
        var body = encodeURIComponent(data.get('message') + '\n\n' + data.get('name') + '\n' + data.get('email'));
        location.href = 'mailto:' + form.getAttribute('data-to') + '?subject=' + subject + '&body=' + body;
      };
      send('/api/contact', { name: data.get('name'), email: data.get('email'), topic: data.get('topic'), message: data.get('message') }).then(function () {
        if (/early access|partnership/i.test(String(data.get('topic')))) {
          send('/api/opportunity', { kind: 'contact', name: data.get('name'), email: data.get('email'), message: '[' + data.get('topic') + '] ' + data.get('message'), visitor: visitorId(), page: location.pathname }).catch(function () {});
        }
        form.reset();
        if (out) { out.className = 'form-result ok'; out.textContent = 'Thank you! Your message has been sent. We will reply by email.'; }
      }).catch(function () { mailto(); });
    });
  }
})();
