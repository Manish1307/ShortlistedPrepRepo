// Homepage pricing teaser: shows the live plans from the server (Admin → Pricing). The static cards in the page stay if the server cannot be reached.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var box = document.getElementById('hp-plans');
  if (!box || !API) return;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  fetch(API + '/api/pricing').then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(function (d) {
    var plans = (d.plans || []).slice(0, 3);
    if (!plans.length) return;
    box.replaceChildren.apply(box, plans.map(function (p) {
      var card = el('div', 'hp-plan' + (p.featured ? ' featured' : ''));
      card.appendChild(el('h3', '', p.name));
      var price = el('p', 'hp-price', p.price ? '₹' + Number(p.price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'Free');
      if (p.price && p.durationDays) price.appendChild(el('small', '', ' / ' + p.durationDays + ' days'));
      card.appendChild(price);
      if (p.tagline) card.appendChild(el('p', 'muted small', p.tagline));
      if (p.features && p.features.length) {
        var ul = el('ul', 'hp-feat');
        p.features.slice(0, 4).forEach(function (f) { ul.appendChild(el('li', '', f)); });
        card.appendChild(ul);
      }
      return card;
    }));
  }).catch(function () { /* keep the static cards */ });
})();
