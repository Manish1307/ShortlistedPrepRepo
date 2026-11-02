// Free ATS checker (ats-checker.html): read the resume file, send its text to the server, show the score.
(function () {
  'use strict';
  var form = document.getElementById('ats-form');
  if (!form) return;
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var $ = function (id) { return document.getElementById(id); };
  var fileEl = $('ats-file'), textEl = $('ats-text'), readMsg = $('ats-read'), msg = $('ats-msg'), go = $('ats-go'), result = $('ats-result');
  var resumeText = '', fileName = '';

  function say(el, cls, t) { el.className = 'form-result' + (cls ? ' ' + cls : ''); el.textContent = t; }
  function visitorId() { try { var id = localStorage.getItem('sp_vid'); if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id; } catch (e) { /* storage blocked */ } return ''; }
  function call(path, payload) {
    if (!API) return Promise.reject(new Error('The checker is not connected yet. Please try again later.'));
    return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.'); return j; }); });
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

  // the text of a Word .docx: word/document.xml from the zip, paragraphs as lines
  function docxText(buffer) {
    var view = new DataView(buffer), end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) return Promise.reject(new Error('This is not a valid .docx file'));
    var at = view.getUint32(end + 16, true);
    for (var n = view.getUint16(end + 10, true); n > 0; n--) {
      var method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
      var nameLen = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true), local = view.getUint32(at + 42, true);
      if (new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameLen)) === 'word/document.xml') {
        var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true), raw = new Uint8Array(buffer, start, size);
        var xml = method === 0 ? Promise.resolve(new TextDecoder().decode(raw)) : new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
        return xml.then(function (x) {
          var doc = new DOMParser().parseFromString(x, 'application/xml');
          return [].slice.call(doc.getElementsByTagName('w:p')).map(function (p) { return [].slice.call(p.getElementsByTagName('w:t')).map(function (t) { return t.textContent; }).join(''); }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        });
      }
      at += 46 + nameLen + extra + comment;
    }
    return Promise.reject(new Error('No text was found in this .docx file'));
  }
  // pdf.js (Mozilla, Apache-2.0) is our own copy in assets/ and is loaded only when a PDF is chosen
  var pdfLoading = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfLoading) pdfLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/pdf.min.js?v=3.11.174';
      s.onload = function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/pdf.worker.min.js?v=3.11.174'; resolve(window.pdfjsLib); };
      s.onerror = function () { pdfLoading = null; reject(new Error('pdf.js could not load')); };
      document.head.appendChild(s);
    });
    return pdfLoading;
  }
  function pdfText(buffer) {
    return loadPdfJs().then(function (lib) {
      return lib.getDocument({ data: buffer }).promise.then(function (pdf) {
        var pages = [], chain = Promise.resolve();
        for (var n = 1; n <= Math.min(pdf.numPages, 6); n++) (function (i) {
          chain = chain.then(function () { return pdf.getPage(i); }).then(function (page) { return page.getTextContent(); }).then(function (c) {
            var out = '', lastY = null;
            c.items.forEach(function (it) {
              var y = it.transform ? Math.round(it.transform[5]) : lastY;
              if (lastY !== null && Math.abs(y - lastY) > 3) out += '\n'; else if (out && !/\s$/.test(out) && it.str) out += ' ';
              out += it.str; lastY = y;
              if (it.hasEOL) { out += '\n'; }
            });
            pages.push(out);
          });
        })(n);
        return chain.then(function () { return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); });
      });
    });
  }
  function fileToText(file) {
    var name = file.name.toLowerCase();
    if (file.size > 6 * 1024 * 1024) return Promise.reject(new Error('The file is larger than 6 MB'));
    if (/\.(txt|md|text)$/.test(name)) return file.text();
    if (name.endsWith('.docx')) return file.arrayBuffer().then(docxText);
    if (name.endsWith('.pdf')) {
      // read in the browser (pdf.js, nothing is uploaded); a scanned PDF has no text, so then the server reads it
      return file.arrayBuffer().then(function (buf) {
        return pdfText(buf.slice(0)).catch(function () { return ''; }).then(function (t) {
          if (t.length >= 150) return t;
          var bytes = new Uint8Array(buf), bin = '';
          for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return call('/api/ats-check/pdf-text', { data: btoa(bin) }).then(function (r) { return r.text; }).catch(function (err) {
            throw new Error(t ? 'Very little text could be read from this PDF.' : 'This PDF looks like a scan or image, so its text cannot be read here. Upload a Word (.docx) version or paste the text.');
          });
        });
      });
    }
    if (name.endsWith('.doc')) return Promise.reject(new Error('Old .doc files cannot be read. Save it as .docx or PDF and upload that.'));
    return Promise.reject(new Error('Choose a PDF, Word (.docx) or text file'));
  }

  fileEl.addEventListener('change', function () {
    var f = fileEl.files && fileEl.files[0];
    resumeText = ''; fileName = '';
    if (!f) return;
    say(readMsg, '', 'Reading ' + f.name + (/\.pdf$/i.test(f.name) ? ' (a PDF takes a few seconds)…' : '…'));
    go.disabled = true;
    fileToText(f).then(function (t) { resumeText = t; fileName = f.name; textEl.value = t; say(readMsg, 'ok', 'Read ' + f.name + '. Press "Check my ATS score".'); })
      .catch(function (err) { say(readMsg, 'bad', String(err.message || err)); fileEl.value = ''; })
      .then(function () { go.disabled = false; });
  });
  textEl.addEventListener('input', function () { resumeText = textEl.value; if (!fileEl.value) fileName = ''; });

  function ring(score) {
    var box = el('div', 'ats-ring'); box.style.setProperty('--p', score + '%');
    var inner = el('div', 'ats-ring-in'); inner.appendChild(el('b', '', String(score))); inner.appendChild(el('span', '', '/ 100')); box.appendChild(inner);
    return box;
  }
  function show(r) {
    result.replaceChildren();
    var head = el('div', 'ats-head card');
    head.appendChild(ring(r.score));
    var copy = el('div', 'ats-head-copy');
    copy.appendChild(el('h2', '', 'Your ATS score: ' + r.score + ' out of 100'));
    copy.appendChild(el('p', 'lead', r.verdict));
    if (r.contact && r.contact.name) copy.appendChild(el('p', 'muted small', 'Result for ' + r.contact.name + (r.contact.email ? ' · ' + r.contact.email : '')));
    head.appendChild(copy); result.appendChild(head);

    if (r.fixFirst && r.fixFirst.length) {
      var fix = el('div', 'card'); fix.appendChild(el('h3', '', 'Fix these first'));
      var ol = el('ol', 'ats-fix'); r.fixFirst.forEach(function (t) { ol.appendChild(el('li', '', t)); }); fix.appendChild(ol); result.appendChild(fix);
    }
    var list = el('div', 'card'); list.appendChild(el('h3', '', 'All checks'));
    r.checks.forEach(function (c) {
      var row = el('div', 'ats-check ats-' + c.status);
      row.appendChild(el('span', 'ats-badge', c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'));
      var t = el('div'); t.appendChild(el('b', '', c.name + '  ' + c.points + '/' + c.weight)); t.appendChild(el('p', 'muted small', c.detail)); row.appendChild(t);
      list.appendChild(row);
    });
    result.appendChild(list);
    if (r.skills && r.skills.length) {
      var sk = el('div', 'card'); sk.appendChild(el('h3', '', 'Skills we found'));
      var chips = el('div', 'ats-chips'); r.skills.forEach(function (s) { chips.appendChild(el('span', 'ats-chip', s)); }); sk.appendChild(chips); result.appendChild(sk);
    }
    var cta = el('div', 'card ats-cta');
    cta.appendChild(el('h3', '', 'Want help fixing it?'));
    cta.appendChild(el('p', '', 'Create a free account for an AI-improved version of your resume and a match score against any job. Or book a free 1-on-1 session and we will go through it with you.'));
    var row2 = el('p', 'btn-row');
    var a1 = el('a', 'btn btn-primary', 'Start free'); a1.href = 'signup.html'; row2.appendChild(a1);
    var a2 = el('a', 'btn', 'Book a free 1-on-1 session'); a2.href = 'book-demo.html'; row2.appendChild(a2);
    cta.appendChild(row2); result.appendChild(cta);
    result.hidden = false; result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = (resumeText || textEl.value || '').trim();
    if (!t) return say(msg, 'bad', 'Choose your resume file, or paste its text, first.');
    if (!$('ats-consent').checked) return say(msg, 'bad', 'Please tick the box to continue.');
    go.disabled = true; say(msg, '', 'Checking your resume…');
    call('/api/ats-check', { text: t, consent: true, fileName: fileName, website: $('ats-hp').value, email: $('ats-email').value, phone: $('ats-phone').value, visitor: visitorId(), page: location.pathname })
      .then(function (r) {
        $('ats-missing').hidden = !r.needEmail;
        if (r.needEmail) { say(msg, 'bad', 'Add your email above and press the button again to see your result.'); $('ats-email').focus(); return; }
        say(msg, 'ok', 'Done. Your result is below.'); show(r);
      })
      .catch(function (err) { say(msg, 'bad', String(err.message || err)); })
      .then(function () { go.disabled = false; });
  });
})();
