/* ShortlistPrep Autofill: runs on every page.
 *  - On the ShortlistPrep website it receives the candidate's CHECKED application profile and keeps it in the browser.
 *  - On a company's portal it shows a small panel: "Fill this page". It recognises create-account, sign-in and
 *    application pages (also each new step of a multi-step application) and fills only what the candidate asks for.
 * It never fills a password and never presses Submit or Next.
 */
(function () {
  'use strict';
  if (window.__spAutofill) return;
  window.__spAutofill = true;

  var SITE_HOSTS = ['shortlistprep.com', 'www.shortlistprep.com'];
  var SITE_URL = 'https://shortlistprep.com/career.html#cr-apply';
  var store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  if (!store) return;
  // the ShortlistPrep website: its own address, or (when run locally) any page that carries the site's api-url tag
  var onSite = SITE_HOSTS.indexOf(location.hostname) !== -1 || !!document.querySelector('meta[name="api-url"]');

  // ---------- the website hands over the checked profile ----------
  if (onSite) {
    var hello = function () { try { window.postMessage({ source: 'shortlistprep-extension', type: 'hello' }, location.origin); } catch (e) { /* ignore */ } };
    window.addEventListener('message', function (e) {
      if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== 'shortlistprep-site' || e.data.type !== 'profile') return;
      if (e.data.profile && typeof e.data.profile === 'object') store.set({ profile: e.data.profile, syncedAt: Date.now() });
      else store.remove(['profile', 'syncedAt']);          // the candidate has not confirmed it (or signed out)
    });
    hello(); setTimeout(hello, 1500); setTimeout(hello, 4000);
    return;
  }

  // ---------- a company's portal ----------
  var profile = null, auto = false, done = new WeakSet(), lastKey = '', dismissed = false, host = null, ui = null, busy = false;

  function load() {
    store.get(['profile', 'auto'], function (d) { profile = d.profile || null; auto = !!d.auto; refresh(); });
  }
  if (chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (c) {
    if (c.profile) profile = c.profile.newValue || null;
    if (c.auto) auto = !!c.auto.newValue;
    refresh();
  });

  var KIND = { signup: 'Create-account page', login: 'Sign-in page', application: 'Application form', other: 'Form' };

  function build() {
    host = document.createElement('div');
    host.setAttribute('data-sp-autofill', '');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#1c1b22}' +
      '.p{width:290px;background:#fff;border:1px solid #d9d4ec;border-radius:14px;box-shadow:0 8px 28px rgba(60,30,120,.22);padding:12px 14px}' +
      '.h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}.h b{font-size:14px;color:#5b21b6}' +
      '.x{all:unset;cursor:pointer;color:#6b6880;font-size:18px;line-height:1;padding:0 4px}' +
      '.s{color:#5a566b;font-size:13px;margin:0 0 8px}.s b{color:#1c1b22}' +
      'button.go{all:unset;box-sizing:border-box;display:block;width:100%;text-align:center;cursor:pointer;background:#6d28d9;color:#fff;font-weight:600;padding:9px 12px;border-radius:10px}' +
      'button.go:disabled{opacity:.55;cursor:default}' +
      'label{display:flex;gap:6px;align-items:center;font-size:12.5px;color:#5a566b;margin-top:8px}' +
      '.r{font-size:12.5px;margin:8px 0 0;color:#1c1b22}.r.ok{color:#137a4b}.n{font-size:12px;color:#8a5a00;margin:4px 0 0}' +
      'a{color:#6d28d9}' +
      '</style><div class="p"><div class="h"><b>ShortlistPrep Autofill</b><button class="x" title="Hide" aria-label="Hide">×</button></div>' +
      '<p class="s"></p><button class="go" type="button"></button>' +
      '<label><input type="checkbox" class="auto"> Fill each new step for me</label><p class="r"></p><div class="notes"></div></div>';
    ui = {
      root: root, status: root.querySelector('.s'), go: root.querySelector('.go'), result: root.querySelector('.r'),
      notes: root.querySelector('.notes'), auto: root.querySelector('.auto'),
    };
    root.querySelector('.x').addEventListener('click', function () { dismissed = true; host.remove(); host = null; });
    ui.go.addEventListener('click', function () { run(false); });
    ui.auto.addEventListener('change', function () { store.set({ auto: ui.auto.checked }); });
    document.documentElement.appendChild(host);
  }

  function describe(a) {
    var parts = [a.fields + ' field' + (a.fields === 1 ? '' : 's') + ' I can fill'];
    if (a.counts.work) parts.push(a.counts.work + ' job row' + (a.counts.work === 1 ? '' : 's'));
    if (a.counts.edu) parts.push(a.counts.edu + ' education row' + (a.counts.edu === 1 ? '' : 's'));
    return '<b>' + KIND[a.kind] + '</b><br>' + parts.join(' · ');
  }

  /** Look at the page; show or hide the panel; in "each step" mode fill a new step by itself. */
  function refresh() {
    if (dismissed || busy || !window.SPFill) return;
    var a = window.SPFill.analyze(document);
    if (a.fields < 2 && a.kind !== 'login') { if (host) { host.remove(); host = null; } return; }
    if (!host) build();
    ui.auto.checked = auto;
    ui.status.innerHTML = describe(a);
    ui.go.disabled = !profile;
    ui.go.textContent = profile ? 'Fill this page' : 'Profile not synced yet';
    if (!profile) {
      ui.notes.innerHTML = '<p class="n">Open <a href="' + SITE_URL + '" target="_blank" rel="noopener">ShortlistPrep → Apply</a>, check your profile and press "Save and confirm". Then come back here.</p>';
    } else if (ui.notes.querySelector('a')) ui.notes.innerHTML = '';
    var key = a.kind + ':' + a.fields + ':' + a.counts.work + ':' + a.counts.edu;
    if (profile && auto && key !== lastKey && (a.fields >= 2 || a.kind === 'login' || a.kind === 'signup')) { lastKey = key; run(true); }
    lastKey = key;
  }

  function run(fromAuto) {
    if (!profile || busy) return;
    busy = true; ui.go.disabled = true; ui.result.className = 'r'; ui.result.textContent = 'Filling…';
    window.SPFill.fillPage(document, profile, { done: done }).then(function (r) {
      ui.result.className = 'r ok';
      ui.result.textContent = r.filled ? 'Filled ' + r.filled + ' field' + (r.filled === 1 ? '' : 's') + (r.added.work + r.added.edu ? ' and added ' + (r.added.work + r.added.edu) + ' row(s)' : '') + '. Check everything, then continue yourself.'
        : (fromAuto ? '' : 'Nothing new to fill here.');
      ui.notes.innerHTML = '';
      r.notes.forEach(function (n) { var p = document.createElement('p'); p.className = 'n'; p.textContent = n; ui.notes.appendChild(p); });
    }).catch(function () { ui.result.className = 'r'; ui.result.textContent = 'Something went wrong on this page. Fill it by hand.'; })
      .then(function () { busy = false; if (ui) ui.go.disabled = !profile; });
  }

  // watch for new steps (single-page portals change the page without reloading)
  var timer = null;
  new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(refresh, 700); }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', function () { setTimeout(refresh, 500); });
  load();
})();
