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
      if (p.badge || p.featured) card.appendChild(el('span', 'hp-badge', p.badge || 'Most popular'));
      card.appendChild(el('h3', '', p.name));
      var price = el('p', 'hp-price', '₹' + Number(p.price || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }));   // Free shows ₹0, not a second "Free"
      if (p.price && p.durationDays) price.appendChild(el('small', '', ' / ' + p.durationDays + ' days'));
      card.appendChild(price);
      if (p.tagline) card.appendChild(el('p', 'muted small', p.tagline));
      if (p.features && p.features.length) {
        var ul = el('ul', 'hp-feat');
        p.features.slice(0, 4).forEach(function (f) { ul.appendChild(el('li', '', f)); });
        card.appendChild(ul);
      }
      // a button on every plan: Free goes to sign-up (or the toolkit), a paid plan to the plans page
      var member = document.documentElement.getAttribute('data-auth') === 'member';
      var a = el('a', 'btn' + (p.featured ? ' btn-primary' : ''), p.price ? (p.cta || 'Get ' + p.name) : (member ? 'Open my toolkit' : 'Start free'));
      a.href = p.price ? 'pricing.html' : (member ? 'career.html' : 'signup.html');
      card.appendChild(a);
      return card;
    }));
  }).catch(function () { /* keep the static cards */ });
})();
