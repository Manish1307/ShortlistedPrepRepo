// Pricing page: the active plans from the server (Admin → Pricing), and buying one. Payment is by UPI or bank transfer
// until an online gateway is connected: the customer pays, enters the reference (UTR), and the team confirms it.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var box = document.getElementById('pr-plans');
  if (!box) return;

  function session() {
    for (var i = 0; i < 2; i++) {
      try { var s = JSON.parse((i ? localStorage : sessionStorage).getItem('sp_account') || 'null'); if (s && s.token && Date.parse(s.expiresAt) > Date.now()) return s; } catch (e) { /* blocked */ }
    }
    return null;
  }
  function call(method, path, body) {
    var s = session();
    var headers = { 'Content-Type': 'application/json' };
    if (s) headers.Authorization = 'Bearer ' + s.token;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .catch(function () { throw new Error('Cannot reach the server. Check your internet connection and try again.'); })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); });
  }
  function h(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { var v = attrs[k]; if (v == null || v === false) return; if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v); });
    (function add(list) { list.forEach(function (c) { if (Array.isArray(c)) add(c); else if (c != null && c !== false) e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); }); })([].slice.call(arguments, 2));
    return e;
  }
  function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function date(s) { return new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  var signedIn = !!session();
  var info = null;

  function render() {
    var plans = info.plans;
    document.getElementById('pr-gst').textContent = info.gst.rate ? (info.gst.included ? 'All prices are in INR and include ' + info.gst.rate + '% GST.' : 'All prices are in INR; ' + info.gst.rate + '% GST is added at checkout.') : 'All prices are in INR.';
    if (!plans.length) { box.replaceChildren(h('div', { class: 'card center' }, h('h3', {}, 'Plans are coming soon'), h('p', { class: 'muted' }, 'You can start free today.'), h('a', { class: 'btn btn-primary', href: 'signup.html' }, 'Start free'))); return; }
    box.replaceChildren(h('div', { class: 'grid pr-grid pr-n' + Math.min(plans.length, 4) }, plans.map(function (p) {
      var btn = h('button', { class: 'btn' + (p.featured ? ' btn-primary' : ''), type: 'button' }, p.cta || (p.price ? 'Buy ' + p.name : 'Start free'));
      btn.addEventListener('click', function () { buy(p, btn); });
      return h('div', { class: 'card plan' + (p.featured ? ' featured' : '') },
        p.badge ? h('span', { class: 'tag' }, p.badge) : null,
        h('h3', {}, p.name),
        p.tagline ? h('p', { class: 'muted small pr-tagline' }, p.tagline) : null,
        h('div', { class: 'price' }, p.price ? inr(p.price) : 'Free', p.mrp ? h('s', { class: 'pr-mrp' }, inr(p.mrp)) : null,
          p.price ? h('small', {}, ' / ' + p.durationDays + ' days') : null),
        p.price && p.durationDays ? h('p', { class: 'muted small pr-perday' }, 'About ' + inr(Math.round(p.price / p.durationDays)) + ' a day') : null,
        h('ul', { class: 'check-list' }, p.features.map(function (f) { return h('li', {}, f); })),
        btn);
    })));
  }

  function showCurrent(plan) {
    var el = document.getElementById('pr-current');
    if (!plan) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = '✓ Your plan: ' + plan.name + ', until ' + date(plan.endsAt) + '. Buying the same pass again adds the days.';
  }

  function buy(plan, btn) {
    if (!signedIn) { location.href = plan.price ? 'login.html' : 'signup.html'; return; }
    btn.disabled = true;
    call('POST', '/api/account/plans/checkout', { planId: plan.id }).then(function (d) {
      if (d.free) { showCurrent(d.plan); alert('Your free plan has started.'); return; }
      payDialog(d.order, d.payment);
    }).catch(function (e) { alert(e.message); }).then(function () { btn.disabled = false; });
  }

  function payDialog(order, pay) {
    var dlg = h('dialog', { class: 'modal pr-dialog', 'aria-labelledby': 'pr-title' });
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var ref = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. 412345678901', 'aria-label': 'Payment reference (UTR)' });
    var method = h('select', { 'aria-label': 'How you paid' }, (pay.upi ? [['upi', 'UPI']] : []).concat(pay.bank ? [['bank_transfer', 'Bank transfer (NEFT / IMPS)']] : []).map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    var done = h('button', { class: 'btn btn-primary', type: 'button' }, 'I have paid');
    done.addEventListener('click', function () {
      if (ref.value.trim().length < 6) { out.className = 'form-result bad'; out.textContent = 'Enter the payment reference (UTR / transaction ID) from your UPI app or bank.'; ref.focus(); return; }
      done.disabled = true;
      call('POST', '/api/account/orders/' + order.id + '/paid', { reference: ref.value.trim(), method: method.value }).then(function () {
        out.className = 'form-result ok'; out.textContent = 'Thank you! We will confirm your payment and start your plan, usually within a few hours. You will see it on this page.';
        done.hidden = true;
      }).catch(function (e) { out.className = 'form-result bad'; out.textContent = e.message; done.disabled = false; });
    });
    var copy = function (t, b) { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { b.textContent = 'Copied ✓'; }, function () { alert(t); }); };
    var upiCopy = pay.upi ? h('button', { class: 'btn btn-sm', type: 'button' }, 'Copy UPI ID') : null;
    if (upiCopy) upiCopy.addEventListener('click', function () { copy(pay.upi.upiId, upiCopy); });
    dlg.append(h('div', { class: 'stack' },
      h('div', { class: 'modal-head' }, h('h2', { id: 'pr-title' }, 'Pay ' + inr(order.amount)), h('button', { type: 'button', class: 'modal-x', 'aria-label': 'Close', onclick: function () { dlg.close(); } }, '×')),
      h('p', { class: 'muted small', style: 'margin:0' }, order.planName + ' · order ' + order.number + (order.gst ? ' · includes GST ' + inr(order.gst) : '')),
      pay.type === 'gateway' ? h('p', {}, 'Online checkout is opening…') : null,
      pay.upi ? h('div', { class: 'pr-pay' }, h('b', {}, '1. Pay by UPI'),
        h('p', { class: 'small', style: 'margin:4px 0' }, 'UPI ID: ', h('b', {}, pay.upi.upiId), ' (' + pay.upi.payeeName + ')'),
        h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-primary btn-sm', href: pay.upi.link }, 'Open my UPI app'), upiCopy),
        h('p', { class: 'muted small', style: 'margin:4px 0 0' }, '"Open my UPI app" works on your phone; on a computer, pay to the UPI ID from your phone.')) : null,
      pay.bank ? h('div', { class: 'pr-pay' }, h('b', {}, (pay.upi ? 'Or pay' : 'Pay') + ' by bank transfer'),
        h('p', { class: 'small', style: 'margin:4px 0' }, pay.bank.accountName + ' · ' + pay.bank.bankName),
        h('p', { class: 'small', style: 'margin:0' }, 'Account ', h('b', {}, pay.bank.accountNumber), ' · IFSC ', h('b', {}, pay.bank.ifsc))) : null,
      !pay.upi && !pay.bank ? h('p', { class: 'form-result bad' }, 'Payment details are not set up yet. Please write to us and we will help you pay.') : null,
      h('div', { class: 'pr-pay' }, h('b', {}, (pay.upi || pay.bank) ? '2. Tell us you have paid' : 'Payment reference'),
        h('p', { class: 'muted small', style: 'margin:4px 0' }, pay.instructions || ''),
        h('div', { class: 'pr-ref' }, method, ref), done, out)));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  call('GET', '/api/pricing').then(function (d) {
    info = d; render();
    if (signedIn) call('GET', '/api/account/plan').then(function (p) { showCurrent(p.plan); }).catch(function () { /* not signed in any more */ });
  }).catch(function (e) { box.replaceChildren(h('p', { class: 'form-result bad center' }, e.message)); });
})();
