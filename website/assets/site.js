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
