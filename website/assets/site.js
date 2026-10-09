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

  // pricing: monthly / yearly switch
  var billing = document.getElementById('billing');
  if (billing) {
    billing.addEventListener('change', function () {
      document.body.setAttribute('data-billing', billing.checked ? 'yearly' : 'monthly');
    });
  }

  // contact form: no server yet, so it opens the visitor's email app with the message filled in
  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      var subject = encodeURIComponent('[' + data.get('topic') + '] message from ' + data.get('name'));
      var body = encodeURIComponent(data.get('message') + '\n\n' + data.get('name') + '\n' + data.get('email'));
      location.href = 'mailto:' + form.getAttribute('data-to') + '?subject=' + subject + '&body=' + body;
    });
  }
})();

// The sign-in and sign-up pages are a design preview: they never send anything anywhere.
document.querySelectorAll('.demo-form').forEach(function (form) {
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var out = form.querySelector('.demo-result');
    if (out) out.textContent = form.getAttribute('data-demo-message') || 'Demo only: nothing was sent.';
    form.querySelectorAll('input[type=password]').forEach(function (i) { i.value = ''; });
  });
});
