// A floating, collapsible panel on the right for signed-in members: "{Name}, you have used X% of our features", the path of
// their journey so far, and the tools they have not tried yet (with a lock where their plan does not include a step).
// The numbers come from the server (/api/strength), worked out from their own activity. The panel updates by itself after
// the member does something on the site (an upload, an ATS check, a job search...).
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-auth') !== 'member') return;
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  if (!API || !window.fetch) return;

  var token = '';
  for (var i = 0; i < 2 && !token; i++) {
    try { var s = JSON.parse((i ? localStorage : sessionStorage).getItem('sp_account') || 'null'); if (s && s.token) token = s.token; } catch (e) { /* storage blocked */ }
  }
  if (!token) return;
  var KEY = 'sp_strength_open';
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function icon(paths, cls) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.4'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    if (cls) svg.setAttribute('class', cls);
    paths.forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    return svg;
  }
  var lock = function () { return icon(['M7 11V8a5 5 0 0 1 10 0v3', 'M5 11h14v10H5z'], 'sp-lock'); };
  var check = function () { return icon(['M5 12.5l4.5 4.5L19 7.5']); };
  function bar(done, total) { var b = el('div', 'sp-bar'); var f = el('i'); f.style.width = Math.round(done / total * 100) + '%'; b.appendChild(f); return b; }

  var box = null, tab = null, tabPct = null, body = null;

  /** The panel's content for one answer from the server. */
  function paint(d) {
    var name = d.name ? d.name.charAt(0).toUpperCase() + d.name.slice(1) : '';
    var frag = document.createDocumentFragment();

    // 1. the sentence, then the promise of more
    var head = el('div', 'sp-head');
    head.appendChild(el('div', 'sp-title', (name ? name + ', you' : 'You') + ' have used ' + d.percent + '% of our features.'));
    head.appendChild(bar(d.percent, 100));
    head.appendChild(el('p', 'sp-more', d.percent >= 100 ? 'You have tried every tool. Keep practising.' : 'But wait, we have more tools that will help you during your interview.'));
    frag.appendChild(head);

    // 2. the path of the journey: four stages, the first one not finished is open
    var current = -1;
    d.capabilities.forEach(function (c, n) { if (current < 0 && !c.done) current = n; });
    frag.appendChild(el('h3', 'sp-h3', 'Your journey'));
    var path = el('ol', 'sp-path');
    d.capabilities.forEach(function (c, n) {
      var state = c.done ? 'done' : n === current ? 'now' : 'later';
      var li = el('li', 'sp-stage ' + state);
      var node = el('span', 'sp-node');
      if (c.done) node.appendChild(check()); else node.appendChild(document.createTextNode(String(n + 1)));
      li.appendChild(node);
      var det = document.createElement('details'); det.className = 'sp-det'; if (n === current) det.open = true;
      var sum = document.createElement('summary');
      var t = el('span', 'sp-stage-title'); t.appendChild(el('b', '', c.journey)); t.appendChild(el('small', '', c.label));
      sum.appendChild(t); sum.appendChild(el('span', 'sp-pct', c.earned + ' / ' + c.weight + '%'));
      det.appendChild(sum);
      var list = el('ul', 'sp-steps');
      c.steps.forEach(function (st) {
        var row = el('li', st.done ? 'done' : st.locked ? 'locked' : '');
        row.appendChild(el('span', 'sp-tick')); row.firstChild.appendChild(st.done ? check() : st.locked ? lock() : document.createTextNode('○'));
        var a = el(st.done ? 'span' : 'a', 'sp-step-text', st.label);
        if (!st.done) a.href = st.href;
        row.appendChild(a);
        if (st.highlight && !st.done) row.appendChild(el('em', 'sp-key', 'Key'));
        if (st.locked) row.appendChild(el('span', 'sp-why', st.lockReason + '. Upgrade to unlock.'));
        list.appendChild(row);
      });
      det.appendChild(list); li.appendChild(det); path.appendChild(li);
    });
    frag.appendChild(path);

    // 3. what to do next, and the way to unlock what is locked
    if (d.next) {
      var next = el('a', 'sp-next'); next.href = d.next.href;
      next.appendChild(el('small', '', 'Your next step · +' + d.next.weight + '%')); next.appendChild(el('b', '', d.next.cta + ' →'));
      frag.appendChild(next);
    }
    if (d.hasLocked) {
      var up = el('a', 'sp-unlock'); up.href = 'pricing.html'; up.appendChild(lock());
      up.appendChild(document.createTextNode(' Some tools are locked on your ' + ((d.plan && d.plan.name) || 'current') + ' plan. See plans'));
      frag.appendChild(up);
    }
    return frag;
  }

  function show(d) {
    try { if (sessionStorage.getItem('sp_strength_off') === '1') return; } catch (e) { /* storage blocked */ }   // hidden for this visit
    if (!box) {
      var open = false;
      try { open = localStorage.getItem(KEY) === '1'; } catch (e) { /* storage blocked */ }
      box = el('aside', 'sp-strength' + (open ? ' open' : ''));
      box.setAttribute('aria-label', 'Your ShortlistPrep journey');
      tab = el('button', 'sp-tab'); tab.type = 'button'; tab.setAttribute('aria-controls', 'sp-strength-body'); tab.setAttribute('aria-expanded', open ? 'true' : 'false');
      tabPct = el('b', ''); tab.appendChild(tabPct); tab.appendChild(el('span', '', 'Your journey'));
      body = el('div', 'sp-body'); body.id = 'sp-strength-body'; body.hidden = !open;
      tab.addEventListener('click', function () {
        var now = !box.classList.contains('open');
        box.classList.toggle('open', now); body.hidden = !now; tab.setAttribute('aria-expanded', now ? 'true' : 'false');
        try { localStorage.setItem(KEY, now ? '1' : '0'); } catch (e) { /* storage blocked */ }
      });
      box.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.classList.contains('open')) tab.click(); });
      var hide = el('button', 'sp-x', '×'); hide.type = 'button'; hide.setAttribute('aria-label', 'Hide this panel for now'); hide.title = 'Hide for now';
      hide.addEventListener('click', function () { try { sessionStorage.setItem('sp_strength_off', '1'); } catch (e) { /* storage blocked */ } box.remove(); box = null; });
      box.appendChild(tab); box.appendChild(body); box.appendChild(hide);
      document.body.appendChild(box);
    }
    var before = tabPct.textContent;
    tabPct.textContent = d.percent + '%';
    var scroll = body.scrollTop;
    body.replaceChildren(paint(d));
    body.scrollTop = scroll;
    if (before && before !== tabPct.textContent) { tab.classList.add('bump'); setTimeout(function () { tab.classList.remove('bump'); }, 1600); }   // the percentage just moved
  }

  var rawFetch = window.fetch.bind(window);
  function load() {
    return rawFetch(API + '/api/strength', { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && typeof d.percent === 'number') show(d); }).catch(function () { /* the panel is optional */ });
  }

  // after anything the member saves on the site (not just reads), the percentage may have moved: ask again
  var timer = null;
  window.fetch = function (url, opts) {
    var p = rawFetch(url, opts);
    var method = String((opts && opts.method) || 'GET').toUpperCase();
    var target = typeof url === 'string' ? url : (url && url.url) || '';
    if (method !== 'GET' && target.indexOf(API) === 0 && !/\/api\/(strength|track|offer)\b/.test(target)) {
      p.then(function (r) { if (r && r.ok) { clearTimeout(timer); timer = setTimeout(load, 700); } }, function () { /* the caller handles it */ });
    }
    return p;
  };

  load();
})();
