// The offer strip at the top of every page. What it says, its coupon code and its end time are set in the admin portal (Offer bar).
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  if (!API || !window.fetch) return;

  function dismissed(id) { try { return sessionStorage.getItem('sp_offer_closed') === String(id); } catch (e) { return false; } }
  function remember(id) { try { sessionStorage.setItem('sp_offer_closed', String(id)); } catch (e) { /* storage blocked */ } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }

  function left(ms) {
    var mins = Math.floor(ms / 60000), d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    return d > 0 ? d + 'd ' + String(h).padStart(2, '0') + 'h' : h > 0 ? h + 'h ' + String(m).padStart(2, '0') + 'm' : Math.max(m, 1) + 'm';
  }

  fetch(API + '/api/offer').then(function (r) { return r.json(); }).then(function (j) {
    var o = j && j.offer;
    if (!o || (o.dismissible && dismissed(o.id))) return;
    var bar = el('div', 'offer-bar offer-' + o.theme);
    bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Offer');
    var row = el('div', 'offer-row');
    row.appendChild(el('span', 'offer-ico', '📣'));
    row.appendChild(el('span', 'offer-msg', o.message));

    var timer = null;
    if (o.endsAt) {
      timer = el('span', 'offer-time');
      var tick = function () {
        var ms = Date.parse(o.endsAt) - Date.now();
        if (ms <= 0) { bar.remove(); document.documentElement.classList.remove('has-offer'); return false; }
        timer.textContent = 'ends in ' + left(ms); return true;
      };
      if (!tick()) return;
      setInterval(tick, 30000);
      row.appendChild(timer);
    }
    if (o.code) {
      var copy = el('button', 'offer-code'); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy coupon code ' + o.code);
      copy.appendChild(el('span', '', o.code)); var ic = el('span', 'offer-copy', '⧉'); copy.appendChild(ic);
      copy.addEventListener('click', function () {
        var done = function () { ic.textContent = '✓'; setTimeout(function () { ic.textContent = '⧉'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(o.code).then(done, function () {});
      });
      row.appendChild(copy);
    }
    if (o.ctaUrl && o.ctaLabel) { var a = el('a', 'offer-cta', o.ctaLabel); a.href = o.ctaUrl; row.appendChild(a); }
    if (o.dismissible) {
      var x = el('button', 'offer-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close this offer');
      x.addEventListener('click', function () { remember(o.id); bar.remove(); });
      row.appendChild(x);
    }
    bar.appendChild(row);
    document.body.insertBefore(bar, document.body.firstChild);
  }).catch(function () { /* no offer bar is better than a broken page */ });
})();
