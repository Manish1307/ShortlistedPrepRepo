// download.html: the page is public, the file is not. Download needs a free account (account.js sends a visitor
// without one to sign-up and back here, with ?get=<tool> so the download then starts by itself). Every download is
// counted by the server, which also holds the release link: it is never in this page.
(function () {
  'use strict';
  var A = window.SPAccount;
  if (!A) return;
  var cards = [].slice.call(document.querySelectorAll('[data-tool]'));
  var note = document.getElementById('dl-note');

  function say(card, text, bad) {
    var out = card.querySelector('.form-result');
    out.className = 'form-result' + (bad ? ' bad' : ''); out.textContent = text;
  }
  function start(card, auto) {
    var id = card.getAttribute('data-tool'), btn = card.querySelector('[data-download]');
    say(card, A.saved() ? 'Starting your download…' : 'Taking you to create your free account…');
    btn.disabled = true;
    A.startDownload(id).then(function () {
      if (A.saved()) say(card, 'Your download should start now. If it does not, click Download again.');
      btn.disabled = false;
    }).catch(function (err) { say(card, err.message, true); btn.disabled = false; });
  }

  A.call('GET', '/api/downloads').then(function (r) {
    r.tools.forEach(function (t) {
      var card = document.querySelector('[data-tool="' + t.id + '"]');
      if (!card) return;
      var meta = card.querySelector('[data-meta]');
      meta.textContent = t.platform + (t.version ? ' · version ' + t.version : '') + (t.sizeMb ? ' · ' + Math.round(t.sizeMb) + ' MB' : '');
      var btn = card.querySelector('[data-download]');
      if (!t.available) { btn.disabled = true; btn.textContent = 'Coming soon'; }
    });
    var want = new URLSearchParams(location.search).get('get');
    var card = want && document.querySelector('[data-tool="' + want.replace(/[^a-z-]/g, '') + '"]');
    if (card && A.saved() && !card.querySelector('[data-download]').disabled) {
      note.hidden = false; note.textContent = 'Welcome! Your account is ready. Your download is starting.';
      start(card, true);
    }
  }).catch(function () { /* the buttons still work: the server answers when clicked */ });

  cards.forEach(function (card) {
    card.querySelector('[data-download]').addEventListener('click', function () { start(card, false); });
  });
})();
