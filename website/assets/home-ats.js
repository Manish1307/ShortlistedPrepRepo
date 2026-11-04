// Home page hero: drop a resume, see the ATS score. Reads the file in the browser and calls the same free checker as ats-checker.html.
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.getElementById('hz');
    var ats = window.SPAts;
    if (!box || !ats) return;
    var $ = function (id) { return document.getElementById(id); };
    var drop = $('hz-drop'), file = $('hz-file'), consent = $('hz-consent'), msg = $('hz-msg'), need = $('hz-need'), go = $('hz-go'), out = $('hz-result');
    var text = '', name = '', busy = false;

    function say(cls, t) { msg.className = 'hz-msg' + (cls ? ' ' + cls : ''); msg.textContent = t; }
    function el(tag, cls, t) { var n = document.createElement(tag); if (cls) n.className = cls; if (t !== undefined) n.textContent = t; return n; }

    function read(f) {
      if (!f || busy) return;
      text = ''; name = ''; out.hidden = true; need.hidden = true;
      say('', 'Reading ' + f.name + (/\.pdf$/i.test(f.name) ? ' (a PDF takes a few seconds)…' : '…'));
      busy = true;
      ats.fileToText(f).then(function (t) { text = t; name = f.name; })
        .catch(function (err) { say('bad', String(err.message || err)); file.value = ''; })
        .then(function () { busy = false; if (text) run(); });
    }

    function show(r) {
      out.replaceChildren();
      var head = el('div', 'hz-head');
      var ring = el('div', 'ats-ring'); ring.style.setProperty('--p', r.score + '%');
      var inner = el('div', 'ats-ring-in'); inner.appendChild(el('b', '', String(r.score))); inner.appendChild(el('span', '', '/ 100')); ring.appendChild(inner);
      var copy = el('div');
      copy.appendChild(el('h3', '', 'Your ATS score: ' + r.score + ' out of 100'));
      copy.appendChild(el('p', '', r.verdict));
      head.appendChild(ring); head.appendChild(copy); out.appendChild(head);
      if (r.fixFirst && r.fixFirst.length) {
        out.appendChild(el('p', 'hz-sub', 'Fix these first'));
        var ol = el('ol', 'hz-fix'); r.fixFirst.slice(0, 3).forEach(function (t) { ol.appendChild(el('li', '', t)); }); out.appendChild(ol);
      }
      var row = el('p', 'btn-row');
      var a1 = el('a', 'btn btn-primary', 'Start free'); a1.href = 'signup.html'; row.appendChild(a1);
      var a2 = el('a', 'btn', 'See every check'); a2.href = 'ats-checker.html'; row.appendChild(a2);
      var a3 = el('a', 'btn', 'Book a free 1-on-1'); a3.href = 'book-demo.html'; row.appendChild(a3);
      out.appendChild(row);
      out.hidden = false;
    }

    // sends the resume once it has been read and the box is ticked
    function run() {
      if (busy || !text) return;
      if (!consent.checked) return say('bad', 'Tick the box below and your score appears.');
      busy = true; go.disabled = true; say('', 'Checking your resume…');
      ats.call('/api/ats-check', { text: text, consent: true, fileName: name, website: $('hz-hp').value, email: $('hz-email').value, phone: $('hz-phone').value, visitor: ats.visitorId(), page: location.pathname })
        .then(function (r) {
          need.hidden = !r.needEmail;
          if (r.needEmail) { say('bad', 'We could not find an email in your resume. Add it below to see your score.'); $('hz-email').focus(); return; }
          say('ok', 'Done.'); show(r);
        })
        .catch(function (err) { say('bad', String(err.message || err)); })
        .then(function () { busy = false; go.disabled = false; });
    }

    file.addEventListener('change', function () { read(file.files && file.files[0]); });
    consent.addEventListener('change', run);
    go.addEventListener('click', run);
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { read(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
  });
})();
