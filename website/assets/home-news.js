// Home page News section: the three latest published items (GET /api/news). The section stays hidden until there is something to show.
// Everything shown is inserted as text, never as HTML.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var box = document.getElementById('hn'), list = document.getElementById('hn-list');
  if (!box || !list || !API) return;
  var KIND = { news: 'News', training: 'Training', highlight: 'Highlight' };
  function h(tag, cls, kids) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    [].concat(kids === undefined ? [] : kids).forEach(function (k) { if (k !== null && k !== undefined && k !== false) e.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k))); });
    return e;
  }
  fetch(API + '/api/news').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.items || !d.items.length) return;
    d.items.slice(0, 3).forEach(function (it) {
      var a = h('a', 'hn-card', [
        h('span', 'hn-meta', [h('b', '', KIND[it.kind] || 'News'), it.cost === 'free' ? h('i', 'free', 'Free') : it.cost === 'paid' ? h('i', 'paid', 'Paid') : null, it.company ? h('span', '', it.company) : null]),
        h('strong', '', it.title),
        it.summary ? h('span', 'hn-sum', it.summary) : null,
      ]);
      a.href = it.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      list.appendChild(a);
    });
    box.hidden = false;
  }).catch(function () { /* the section simply stays hidden */ });
})();
