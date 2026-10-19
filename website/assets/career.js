// Career toolkit (career.html), for signed-in customers: upload a resume, ATS check with an improved version,
// role-based resumes, and job match with a cover letter. Talks to /api/career/... with the sign-in token from
// account.js (same storage key). Everything from the server is inserted as text, never as HTML.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var KEY = 'sp_account';
  var content = document.getElementById('cr-content');
  var errorBox = document.getElementById('cr-error');
  if (!content) return;

  // ---------- sign-in token (kept by account.js) ----------
  function saved() {
    for (var i = 0; i < 2; i++) {
      try {
        var s = JSON.parse((i ? localStorage : sessionStorage).getItem(KEY) || 'null');
        if (s && s.token && Date.parse(s.expiresAt) > Date.now()) return s;
      } catch (e) { /* storage blocked */ }
    }
    return null;
  }
  function goSignIn() { location.replace('login.html'); }
  if (!saved()) { goSignIn(); return; }

  function call(method, path, body) {
    var s = saved();
    return fetch(API + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s ? s.token : '') },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).catch(function () { throw new Error('Cannot reach the server. Check your internet connection and try again.'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401) { goSignIn(); throw new Error('Please sign in again.'); }
          if (r.status === 403 && j.code === 'password_change') { location.replace('account.html'); throw new Error(j.error); }
          if (!r.ok) { var err = new Error(j.error || 'Something went wrong (' + r.status + ')'); err.code = j.code; throw err; }
          return j;
        });
      });
  }

  /** Download a Word file from /api/career/download (needs the token, so fetch + blob). */
  function download(kind, id, fallbackName) {
    var s = saved();
    return fetch(API + '/api/career/download?kind=' + kind + (id ? '&id=' + id : ''), { headers: { Authorization: 'Bearer ' + (s ? s.token : '') } })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'Download failed'); });
        var cd = r.headers.get('Content-Disposition') || '';
        var m = /filename="([^"]+)"/.exec(cd);
        return r.blob().then(function (b) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = m ? m[1] : fallbackName;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        });
      });
  }

  // ---------- small helpers ----------
  function h(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else e.setAttribute(k, v === true ? '' : v);
    });
    (function append(list) {
      list.forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) append(c);
        else e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      });
    })([].slice.call(arguments, 2));
    return e;
  }
  function dateTime(s) { return s ? new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function card(id, step, title, intro, body) {
    return h('section', { class: 'ac-card cr-card', id: id },
      h('div', { class: 'cr-card-head' }, h('span', { class: 'cr-step' }, String(step)), h('div', {}, h('h2', {}, title), intro ? h('p', { class: 'ac-muted' }, intro) : null)),
      body);
  }
  function chips(list, cls) { return h('div', { class: 'ac-chips' }, list.map(function (t) { return h('span', { class: 'ac-chip ' + (cls || '') }, t); })); }
  function scoreRing(n, label) {
    var color = n >= 75 ? '#0a8a5c' : n >= 50 ? '#a86c00' : '#b4235e';
    var ring = h('div', { class: 'cr-ring', role: 'img', 'aria-label': label + ': ' + n + ' out of 100' }, h('span', {}, String(n)));
    ring.style.background = 'conic-gradient(' + color + ' 0 ' + n + '%, #e6def8 ' + n + '% 100%)';
    return ring;
  }
  function busy(button, textWhileBusy) {
    var old = button.textContent;
    button.disabled = true; button.textContent = textWhileBusy;
    return function () { button.disabled = false; button.textContent = old; };
  }
  function message(el, text, kind) { el.className = 'form-result' + (kind ? ' ' + kind : ''); el.textContent = text; }
  function copy(text, button) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () {
      var old = button.textContent; button.textContent = 'Copied ✓'; setTimeout(function () { button.textContent = old; }, 1600);
    }, function () { alert('Select the text and copy it.'); });
  }

  /** A structured resume as readable HTML (preview) and as plain text (copy). */
  function resumeView(r) {
    var list = function (v) { return Array.isArray(v) ? v : []; };
    var c = r.contact || {};
    return h('div', { class: 'cr-resume' },
      h('div', { class: 'cr-r-name' }, r.name || ''),
      h('div', { class: 'cr-r-line' }, [r.headline, c.email, c.phone, c.location, c.linkedin].filter(Boolean).join('  |  ')),
      r.summary ? [h('h4', {}, 'Professional summary'), h('p', {}, r.summary)] : null,
      list(r.skills).length ? [h('h4', {}, 'Skills'), list(r.skills).map(function (g) { return h('p', {}, h('b', {}, g.group ? g.group + ': ' : ''), list(g.items).join(', ')); })] : null,
      list(r.experience).length ? [h('h4', {}, 'Experience'), list(r.experience).map(function (e) {
        return h('div', { class: 'cr-r-item' },
          h('div', { class: 'cr-r-role' }, [e.title, e.company].filter(Boolean).join(', '), (e.start || e.end) ? h('span', {}, '  ' + [e.start, e.end].filter(Boolean).join(' – ')) : null),
          h('ul', {}, list(e.bullets).map(function (b) { return h('li', {}, b); })));
      })] : null,
      list(r.projects).length ? [h('h4', {}, 'Projects'), list(r.projects).map(function (p) {
        return h('div', { class: 'cr-r-item' }, h('div', { class: 'cr-r-role' }, p.name || ''), h('ul', {}, list(p.bullets).map(function (b) { return h('li', {}, b); })));
      })] : null,
      list(r.education).length ? [h('h4', {}, 'Education'), list(r.education).map(function (e) { return h('p', {}, [e.degree, e.institution, e.year].filter(Boolean).join(', ')); })] : null,
      list(r.certifications).length ? [h('h4', {}, 'Certifications'), h('ul', {}, list(r.certifications).map(function (x) { return h('li', {}, x); }))] : null);
  }
  function resumeText(r) {
    var list = function (v) { return Array.isArray(v) ? v : []; };
    var c = r.contact || {}, out = [r.name, [r.headline, c.email, c.phone, c.location, c.linkedin].filter(Boolean).join(' | ')];
    if (r.summary) out.push('', 'PROFESSIONAL SUMMARY', r.summary);
    if (list(r.skills).length) { out.push('', 'SKILLS'); list(r.skills).forEach(function (g) { out.push((g.group ? g.group + ': ' : '') + list(g.items).join(', ')); }); }
    if (list(r.experience).length) {
      out.push('', 'EXPERIENCE');
      list(r.experience).forEach(function (e) {
        out.push([e.title, e.company].filter(Boolean).join(', ') + ((e.start || e.end) ? ' (' + [e.start, e.end].filter(Boolean).join(' – ') + ')' : ''));
        list(e.bullets).forEach(function (b) { out.push('- ' + b); });
      });
    }
    if (list(r.projects).length) { out.push('', 'PROJECTS'); list(r.projects).forEach(function (p) { out.push(p.name || ''); list(p.bullets).forEach(function (b) { out.push('- ' + b); }); }); }
    if (list(r.education).length) { out.push('', 'EDUCATION'); list(r.education).forEach(function (e) { out.push([e.degree, e.institution, e.year].filter(Boolean).join(', ')); }); }
    if (list(r.certifications).length) { out.push('', 'CERTIFICATIONS'); list(r.certifications).forEach(function (x) { out.push('- ' + x); }); }
    return out.filter(function (x) { return x !== undefined; }).join('\n').trim();
  }
  function documentActions(kind, id, name, resume) {
    var dl = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Download .docx');
    dl.addEventListener('click', function () {
      var done = busy(dl, 'Preparing…');
      download(kind, id, name + '.docx').catch(function (e) { showError(e.message); }).then(done);
    });
    var cp = h('button', { class: 'btn btn-sm', type: 'button' }, 'Copy as text');
    cp.addEventListener('click', function () { copy(resumeText(resume), cp); });
    return h('div', { class: 'cr-actions' }, dl, cp);
  }

  // ---------- reading a resume file in the browser ----------
  /** The text of a Word .docx: word/document.xml from the zip, paragraphs as lines. */
  function docxText(buffer) {
    var view = new DataView(buffer);
    var end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) return Promise.reject(new Error('This is not a valid .docx file'));
    var at = view.getUint32(end + 16, true);
    for (var n = view.getUint16(end + 10, true); n > 0; n--) {
      var method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
      var nameLen = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
      var local = view.getUint32(at + 42, true);
      var fileName = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameLen));
      if (fileName === 'word/document.xml') {
        var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        var raw = new Uint8Array(buffer, start, size);
        var xmlP = method === 0 ? Promise.resolve(new TextDecoder().decode(raw))
          : new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
        return xmlP.then(function (xml) {
          var doc = new DOMParser().parseFromString(xml, 'application/xml');
          return [].slice.call(doc.getElementsByTagName('w:p')).map(function (p) {
            return [].slice.call(p.getElementsByTagName('w:t')).map(function (t) { return t.textContent; }).join('');
          }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        });
      }
      at += 46 + nameLen + extra + comment;
    }
    return Promise.reject(new Error('No text was found in this .docx file'));
  }
  function fileText(file) {
    var name = file.name.toLowerCase();
    if (file.size > 6 * 1024 * 1024) return Promise.reject(new Error('The file is larger than 6 MB'));
    if (/\.(txt|md|text)$/.test(name)) return file.text();
    if (name.endsWith('.docx')) return file.arrayBuffer().then(docxText);
    if (name.endsWith('.pdf')) {
      return file.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf), bin = '';
        for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return call('POST', '/api/career/pdf-text', { data: btoa(bin) }).then(function (r) { return r.text; });
      });
    }
    if (name.endsWith('.doc')) return Promise.reject(new Error('Old .doc files cannot be read. Save it as .docx or PDF and upload that.'));
    return Promise.reject(new Error('Choose a PDF, Word (.docx) or text file'));
  }

  // ---------- state ----------
  var state = null;
  /** Scroll to a step (also when the address already ends with its #id). */
  var goTo = function (id) { var el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };   // replaced by the step tabs below
  function showError(text) { errorBox.hidden = !text; errorBox.textContent = text || ''; if (text) errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function setUsage(u) {
    if (!u) return;
    state.usage = u;
    var el = document.getElementById('cr-usage');
    var t = u.tokens;
    if (!t) return;
    el.hidden = false;
    el.className = 'ac-badge plain cr-tokens ' + t.level;
    el.textContent = '⚡ AI tokens left today: ' + shortTokens(t.left) + (t.bonus ? ' (incl. ' + shortTokens(t.bonus) + ' extra)' : ' of ' + shortTokens(t.daily));
    if (window.spTokens) window.spTokens.update(t);   // the meter at the bottom of the page (site.js)
  }
  function shortTokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n); }
  function load() {
    return call('GET', '/api/career').then(function (d) { state = d; render(); setUsage(d.usage); })
      .catch(function (e) { content.replaceChildren(); showError(e.message); });
  }

  // ---------- 1. resume ----------
  function resumeCard() {
    var r = state.resume;
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var picker = h('input', { type: 'file', accept: '.pdf,.docx,.txt', id: 'cr-file', class: 'cr-file' });
    var paste = h('textarea', { rows: '8', placeholder: 'Or paste your whole resume here…', 'aria-label': 'Resume text' });
    var save = h('button', { class: 'btn btn-primary', type: 'button' }, r ? 'Replace my resume' : 'Save my resume');
    var fileName = '';
    picker.addEventListener('change', function () {
      var f = picker.files[0];
      if (!f) return;
      message(out, 'Reading ' + f.name + (f.name.toLowerCase().endsWith('.pdf') ? ' (a PDF takes a few seconds)…' : '…'));
      fileText(f).then(function (t) {
        paste.value = t; fileName = f.name;
        message(out, 'Read ' + f.name + '. Check the text below, then press "' + save.textContent + '".', 'ok');
      }).catch(function (e) { message(out, e.message, 'bad'); }).then(function () { picker.value = ''; });
    });
    save.addEventListener('click', function () {
      var t = paste.value.trim();
      if (t.length < 200) { message(out, 'Upload your resume file, or paste the whole resume (it looks too short).', 'bad'); return; }
      var done = busy(save, 'Saving…');
      call('POST', '/api/career/resume', { text: t, fileName: fileName || 'Pasted resume' }).then(function () {
        message(out, 'Saved. Now run the ATS check.', 'ok');
        return load().then(function () { goTo('cr-ats'); });
      }).catch(function (e) { message(out, e.message, 'bad'); }).then(done);
    });
    var uploader = h('div', { class: 'cr-upload' },
      h('label', { class: 'cr-drop', for: 'cr-file' },
        h('b', {}, 'Choose your resume file'), h('span', { class: 'ac-muted' }, 'PDF, Word (.docx) or text, up to 6 MB'), picker),
      paste, h('div', { class: 'cr-actions' }, save), out);
    return card('cr-resume', 1, 'Your resume', 'Upload your latest resume. We read the text, and you can check it before saving.',
      r ? h('div', {},
        h('div', { class: 'cr-current' }, h('span', { class: 'ac-badge good' }, 'Saved'),
          h('b', {}, r.fileName || 'Your resume'), h('span', { class: 'ac-muted' }, ' · ' + r.chars.toLocaleString() + ' characters · ' + dateTime(r.uploadedAt))),
        h('details', { class: 'cr-replace' }, h('summary', {}, 'Upload a newer resume'), uploader))
        : uploader);
  }

  // ---------- 2. ATS ----------
  var STATUS = { pass: ['✓', 'good'], warn: ['!', 'warn'], fail: ['✕', 'bad'] };
  function atsCard() {
    var r = state.resume, a = r && r.ats;
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var run = h('button', { class: 'btn btn-primary', type: 'button', disabled: !r }, a ? 'Run the check again' : 'Check my resume');
    run.addEventListener('click', function () {
      var done = busy(run, 'Checking… (up to a minute)');
      message(out, 'Reading your resume like an ATS would, and writing an improved version…');
      call('POST', '/api/career/ats').then(function (d) { state.resume.ats = d.ats; state.resume.atsAt = new Date().toISOString(); setUsage(d.usage); render(); goTo('cr-ats'); })
        .catch(function (e) { message(out, e.message, 'bad'); }).then(done);
    });
    var body = h('div', {}, !r ? h('p', { class: 'ac-muted' }, 'Upload your resume first (step 1).') : null);
    if (a) {
      body.appendChild(h('div', { class: 'cr-score' }, scoreRing(a.score, 'ATS score'),
        h('div', {}, h('b', {}, 'ATS score of your current resume'), h('p', {}, a.verdict), h('span', { class: 'ac-muted' }, 'Checked ' + dateTime(r.atsAt)))));
      body.appendChild(h('div', { class: 'cr-grid' },
        h('div', {}, h('div', { class: 'ac-subhead' }, 'What we checked'),
          h('ul', { class: 'cr-checks' }, a.checks.map(function (k) {
            var s = STATUS[k.status] || STATUS.warn;
            return h('li', {}, h('span', { class: 'cr-dot ' + s[1] }, s[0]), h('div', {}, h('b', {}, k.name), h('span', {}, k.detail)));
          }))),
        h('div', {},
          a.keywords.missing.length ? [h('div', { class: 'ac-subhead' }, 'Keywords to add (only if you have them)'), chips(a.keywords.missing, 'cr-missing')] : null,
          a.keywords.present.length ? [h('div', { class: 'ac-subhead', style: 'margin-top:14px' }, 'Keywords found'), chips(a.keywords.present)] : null,
          a.fixes.length ? [h('div', { class: 'ac-subhead', style: 'margin-top:14px' }, 'What we improved'), h('ul', { class: 'cr-list' }, a.fixes.map(function (f) { return h('li', {}, f); }))] : null)));
      body.appendChild(h('div', { class: 'cr-improved' },
        h('div', { class: 'cr-improved-head' }, h('div', {}, h('b', {}, 'Your ATS-friendly resume'),
          h('p', { class: 'ac-muted' }, 'Plain single-column format that ATS systems read correctly. Replace every "[add number]" with your real figures before sending.')),
          documentActions('ats', null, 'resume-ATS', a.resume)),
        h('details', { class: 'cr-preview' }, h('summary', {}, 'Preview'), resumeView(a.resume))));
    }
    body.appendChild(h('div', { class: 'cr-actions' }, run));
    body.appendChild(out);
    return card('cr-ats', 2, 'ATS check & fix', 'See how applicant tracking systems read your resume, and get an improved version.', body);
  }

  // ---------- 3. role-based resumes ----------
  function versionsCard() {
    var r = state.resume, a = r && r.ats;
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var role = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. .NET Developer, Scrum Master, Project Manager', 'aria-label': 'Target role' });
    var make = h('button', { class: 'btn btn-primary', type: 'button', disabled: !r }, 'Create resume');
    make.addEventListener('click', function () {
      if (!role.value.trim()) { message(out, 'Type the role you want a resume for.', 'bad'); role.focus(); return; }
      var done = busy(make, 'Writing… (up to a minute)');
      message(out, 'Writing a resume for "' + role.value.trim() + '" from your real experience…');
      call('POST', '/api/career/versions', { role: role.value.trim() }).then(function (d) { state.versions.unshift(d.version); setUsage(d.usage); render(); goTo('cr-versions'); })
        .catch(function (e) { message(out, e.message, 'bad'); }).then(done);
    });
    var suggestions = a && a.suggestedRoles.length ? h('div', { class: 'cr-suggest' }, h('span', { class: 'ac-muted' }, 'Suggested for you: '),
      a.suggestedRoles.map(function (s) { return h('button', { class: 'ac-chip cr-chip-btn', type: 'button', onclick: function () { role.value = s; role.focus(); } }, s); })) : null;
    var list = state.versions.map(function (v) {
      var del = h('button', { class: 'btn btn-sm cr-delete', type: 'button' }, 'Delete');
      del.addEventListener('click', function () {
        if (!confirm('Delete the "' + v.role + '" resume?')) return;
        call('POST', '/api/career/versions/' + v.id + '/delete').then(function () {
          state.versions = state.versions.filter(function (x) { return x.id !== v.id; }); render();
        }).catch(function (e) { showError(e.message); });
      });
      return h('div', { class: 'cr-version' },
        h('div', { class: 'cr-version-head' }, h('div', {}, h('b', {}, v.role), h('span', { class: 'ac-muted' }, ' · ' + dateTime(v.createdAt))),
          h('span', { class: 'ac-badge ' + (v.fitScore >= 70 ? 'good' : v.fitScore >= 45 ? 'warn' : 'bad') }, 'Fit ' + v.fitScore + '/100')),
        v.fitNote ? h('p', { class: 'ac-muted' }, v.fitNote) : null,
        h('div', { class: 'cr-version-actions' }, documentActions('version', v.id, 'resume-' + v.role, v.resume), del),
        h('details', { class: 'cr-preview' }, h('summary', {}, 'Preview'), resumeView(v.resume)));
    });
    return card('cr-versions', 3, 'Role-based resumes',
      'Make a separate resume for each kind of job you apply for. Each one puts your most relevant experience first; nothing is invented.',
      h('div', {}, !r ? h('p', { class: 'ac-muted' }, 'Upload your resume first (step 1).') : null,
        h('div', { class: 'cr-row' }, role, make), suggestions, out,
        list.length ? h('div', { class: 'cr-versions' }, list) : (r ? h('p', { class: 'ac-muted' }, 'No role-based resumes yet.') : null)));
  }

  // ---------- 4. job match ----------
  function matchView(m) {
    var res = m.result;
    var best = state.versions.find(function (v) { return v.id === m.versionId; });
    var copyBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Copy letter');
    copyBtn.addEventListener('click', function () { copy(res.coverLetter, copyBtn); });
    var dl = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Download letter (.docx)');
    dl.addEventListener('click', function () { var done = busy(dl, 'Preparing…'); download('letter', m.id, 'cover-letter.docx').catch(function (e) { showError(e.message); }).then(done); });
    return h('div', { class: 'cr-match' },
      h('div', { class: 'cr-score' }, scoreRing(res.score, 'Match score'),
        h('div', {}, h('b', {}, [m.jobTitle, m.company].filter(Boolean).join(' at ') || 'This job'), h('p', {}, res.verdict),
          best ? h('span', { class: 'ac-muted' }, 'Best resume to send: ', h('b', {}, best.role)) : null)),
      h('div', { class: 'cr-grid' },
        h('div', {}, res.matched.length ? [h('div', { class: 'ac-subhead' }, 'You match'), chips(res.matched)] : null,
          res.missing.length ? [h('div', { class: 'ac-subhead', style: 'margin-top:14px' }, 'Missing from your resume'), chips(res.missing, 'cr-missing')] : null),
        h('div', {}, res.suggestions.length ? [h('div', { class: 'ac-subhead' }, 'How to improve your chances'), h('ul', { class: 'cr-list' }, res.suggestions.map(function (s) { return h('li', {}, s); }))] : null)),
      res.coverLetter ? h('div', { class: 'cr-letter' }, h('div', { class: 'cr-improved-head' }, h('b', {}, 'Your cover letter'), h('div', { class: 'cr-actions' }, dl, copyBtn)),
        h('div', { class: 'cr-letter-text' }, res.coverLetter)) : null);
  }
  function matchCard() {
    var r = state.resume;
    var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
    var title = h('input', { type: 'text', maxlength: '120', placeholder: 'Job title (optional)', 'aria-label': 'Job title' });
    var company = h('input', { type: 'text', maxlength: '120', placeholder: 'Company (optional)', 'aria-label': 'Company' });
    var version = h('select', { 'aria-label': 'Resume to compare' }, h('option', { value: '' }, 'Compare with: my ATS-friendly resume (pick best version)'),
      state.versions.map(function (v) { return h('option', { value: String(v.id) }, 'Compare with: ' + v.role); }));
    var jd = h('textarea', { rows: '9', maxlength: '12000', placeholder: 'Paste the full job description here…', 'aria-label': 'Job description' });
    var run = h('button', { class: 'btn btn-primary', type: 'button', disabled: !r }, 'Check match & write cover letter');
    var result = h('div', {});
    run.addEventListener('click', function () {
      if (jd.value.trim().length < 80) { message(out, 'Paste the full job description.', 'bad'); jd.focus(); return; }
      var done = busy(run, 'Checking… (up to a minute)');
      message(out, 'Comparing your resume with the job and writing your cover letter…');
      call('POST', '/api/career/match', { jd: jd.value.trim(), jobTitle: title.value.trim(), company: company.value.trim(), versionId: version.value ? Number(version.value) : null })
        .then(function (d) {
          state.matches.unshift(d.match); setUsage(d.usage); message(out, '');
          result.replaceChildren(matchView(d.match));
          renderHistory(); result.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }).catch(function (e) { message(out, e.message, 'bad'); }).then(done);
    });
    var history = h('div', { id: 'cr-history' });
    function renderHistory() {
      var past = state.matches;
      history.replaceChildren(past.length ? h('details', { class: 'cr-history' }, h('summary', {}, 'Earlier job matches (' + past.length + ')'),
        past.map(function (m) {
          var open = h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { result.replaceChildren(matchView(m)); result.scrollIntoView({ behavior: 'smooth' }); } }, 'Open');
          var del = h('button', { class: 'btn btn-sm cr-delete', type: 'button', onclick: function () {
            call('POST', '/api/career/matches/' + m.id + '/delete').then(function () { state.matches = state.matches.filter(function (x) { return x.id !== m.id; }); renderHistory(); })
              .catch(function (e) { showError(e.message); });
          } }, 'Delete');
          return h('div', { class: 'cr-history-row' }, h('span', { class: 'ac-badge ' + (m.result.score >= 70 ? 'good' : m.result.score >= 45 ? 'warn' : 'bad') }, String(m.result.score)),
            h('span', { class: 'cr-history-name' }, [m.jobTitle, m.company].filter(Boolean).join(' at ') || 'Job', h('span', { class: 'ac-muted' }, ' · ' + dateTime(m.createdAt))), open, del);
        })) : '');
    }
    renderHistory();
    return card('cr-match', 4, 'Job match & cover letter', 'Paste a job you want. See how well you match, what to add, and get a cover letter written for that job.',
      h('div', {}, !r ? h('p', { class: 'ac-muted' }, 'Upload your resume first (step 1).') : null,
        h('div', { class: 'cr-row' }, title, company), version, jd, h('div', { class: 'cr-actions' }, run), out, result, history));
  }

  // ---------- 5. AI Job search ----------
  // The candidate says what to look for; the server reads live openings from the companies' own career sites and the
  // AI sorts the best ones into high, medium and low-probability groups. A search runs in the background, so the page
  // polls it. Each "Apply" opens the company's own job page in a new window.
  var GROUPS = [
    ['high', '🟢 High probability: apply first', 'Strong match for your resume.'],
    ['medium', '🟡 Medium probability', 'Good match with small gaps.'],
    ['stretch', '🔴 Low probability: stretch roles', 'Clear gaps, but worth a try.']
  ];
  var LEVELS = [['', 'Level: let the AI decide'], ['Fresher / entry-level', 'Fresher / entry-level'], ['Mid-level', 'Mid-level'], ['Senior', 'Senior'], ['Lead / manager', 'Lead / manager']];
  var COUNTRIES = ['India', 'United States', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'Ireland', 'Netherlands', 'Singapore', 'United Arab Emirates', 'Remote'];
  var SECTORS = [['', 'Sector: not chosen yet (set it in My account)'], ['it', 'IT, software & consulting'], ['agri', 'Agriculture, seeds & agri-biotech'], ['biotech', 'Biotech, life sciences & research labs'], ['pharma', 'Pharma, healthcare & medical devices'], ['fmcg', 'FMCG, food & beverages'], ['manufacturing', 'Manufacturing, engineering & energy'], ['finance', 'Banking, finance & accounting'], ['other', 'Other (the AI chooses employers from my resume)']];
  var searchForm = { resume: 'all', level: '', sector: '', role: '', country: 'India', city: '', companies: '', days: '', remote: true };
  var pollTimer = null, cardGen = 0;

  function ago(s) {
    if (!s) return '—';
    var d = Math.floor((Date.now() - Date.parse(s)) / 86400000);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 30 ? d + ' days ago' : new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fitBadge(n) { return h('span', { class: 'ac-badge js-fit ' + (n >= 75 ? 'good' : n >= 50 ? 'warn' : 'bad') }, String(n)); }
  function paramsLine(p) {
    return [p.role || 'Roles from my resume', [p.city, p.country].filter(Boolean).join(', ') || 'Any location', p.level, p.companies ? p.companies.split(/[\n,;]+/).filter(function (x) { return x.trim(); }).length + ' companies' : (SECTORS.filter(function (x) { return x[0] === p.sector; })[0] || ['', 'Employers for my field'])[1], p.resumeLabel].filter(Boolean).join(' · ');
  }

  // ---------- Insight: one job's skill matrices, the gaps to a full fit, learning links and interview revision ----------
  // Four tabs per job. Both matrices come from the job's own description (the server drops anything it does not state).
  var LINK_ICON = { youtube: '▶', 'udemy-free': '🎓', 'udemy-paid': '🎓', coursera: '📘', official: '🏛', articles: '📰', cert: '🏅' };
  var INSIGHT_TABS = [['gap', '📊 Skill Gap Matrix'], ['skills', '🧩 Skill matrix'], ['close', '🎯 Close the gaps'], ['revise', '📚 Revise before the interview']];
  function linkRow(links) {
    return h('div', { class: 'pp-links' }, links.map(function (l) {
      return h('a', { class: 'pp-link ' + l.kind, href: l.url, target: '_blank', rel: 'noopener noreferrer' }, (LINK_ICON[l.kind] || '↗') + ' ' + l.label);
    }));
  }
  function section(cls, icon, title, intro, body) {
    return h('section', { class: 'pp-sec ' + cls }, h('h4', {}, h('span', { 'aria-hidden': 'true' }, icon), ' ', title), intro ? h('p', { class: 'ac-muted pp-intro' }, intro) : null, body);
  }
  /** Practice questions: multiple choice, short and scenario-based, each with its answer behind a "Show answer" button. */
  var QUESTION_GROUPS = [['mcq', 'Multiple choice', 'Pick the right option.'], ['short', 'Short questions', 'Answer in two or three sentences.'], ['scenario', 'Scenario-based questions', 'Say what you would do, step by step.']];
  function answerToggle(box) {
    var btn = h('button', { class: 'pp-qa-btn', type: 'button', 'aria-expanded': 'false' }, h('span', { 'aria-hidden': 'true' }, '👁'), ' Show answer');
    btn.addEventListener('click', function () {
      var open = box.hidden;
      box.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.replaceChildren(h('span', { 'aria-hidden': 'true' }, open ? '🙈' : '👁'), open ? ' Hide answer' : ' Show answer');
      var opts = btn.parentNode && btn.parentNode.querySelector('.pp-opts');
      if (opts) opts.classList.toggle('reveal', open);
    });
    return btn;
  }
  function questionItem(q, n) {
    var letters = ['A', 'B', 'C', 'D'];
    var answer = h('div', { class: 'pp-ans', hidden: true },
      q.type === 'mcq' ? h('p', {}, h('b', {}, 'Answer: '), letters[q.correct] + '. ' + q.options[q.correct]) : null,
      h('p', {}, q.type === 'mcq' ? h('span', {}, h('b', {}, 'Why: '), q.answer) : q.answer));
    return h('li', { class: 'pp-q' }, h('div', { class: 'pp-q-text' }, h('span', { class: 'pp-q-n' }, String(n)), h('span', {}, q.question)),
      q.type === 'mcq' ? h('ul', { class: 'pp-opts' }, q.options.map(function (o, i) { return h('li', { class: i === q.correct ? 'right' : '' }, h('b', {}, letters[i] + '.'), ' ' + o); })) : null,
      answerToggle(answer), answer);
  }
  function questionsSection(p, refresh) {
    var qs = p.interviewQuestions || [];
    if (!qs.length) return null;
    // Insights made before the practice questions have only plain questions, with no answers
    if (typeof qs[0] === 'string') {
      return section('questions', '🎤', 'Likely interview questions', null, h('div', {},
        h('ol', { class: 'pp-list' }, qs.map(function (x) { return h('li', {}, x); })),
        h('div', { class: 'in-note' }, h('span', {}, 'Update this Insight to get 20 practice questions with answers: 5 multiple choice, 10 short and 5 scenarios.'),
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: refresh }, 'Update Insight (uses 1 AI action)'))));
    }
    var n = 0;
    return section('questions', '🎤', 'Practice questions (' + qs.length + ')', 'Try to answer each one first, then click Show answer.',
      h('div', { class: 'pp-qgroups' }, QUESTION_GROUPS.map(function (g) {
        var list = qs.filter(function (q) { return q.type === g[0]; });
        return list.length ? h('div', { class: 'pp-qgroup' }, h('h5', {}, g[1] + ' (' + list.length + ')', h('span', { class: 'ac-muted' }, ' · ' + g[2])),
          h('ol', { class: 'pp-qlist' }, list.map(function (q) { return questionItem(q, ++n); }))) : null;
      })));
  }
  function insightView(p, job, refresh, tab) {
    var reach = Math.min(100, p.fit + p.gapPoints);
    var exact = (p.version || 1) >= 2;     // the skill matrix comes from the job description
    var current = (p.version || 1) >= 3;   // and so do the gaps, topics and questions
    var buttons = {}, panels = {};
    var uid = 'in' + job.id;

    var oldNote = current ? null : h('div', { class: 'in-note' },
      h('span', {}, 'This Insight was made before every part of it was checked against the job description, so some of it may not fit this job.'),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: refresh }, 'Update Insight (uses 1 AI action)'));
    var noDescription = function () {
      return h('div', { class: 'in-note' }, h('span', {}, 'The careers site does not publish this job\'s description, so an exact skill matrix cannot be made for it.'),
        h('a', { class: 'btn btn-sm', href: job.url, target: '_blank', rel: 'noopener noreferrer' }, 'Read the job on the company site ↗'));
    };
    function select(id, focus) {
      INSIGHT_TABS.forEach(function (t) {
        var on = t[0] === id;
        buttons[t[0]].setAttribute('aria-selected', on ? 'true' : 'false');
        buttons[t[0]].tabIndex = on ? 0 : -1;
        panels[t[0]].hidden = !on;
      });
      if (focus) buttons[id].focus();
    }
    /** A Skill Gap Matrix row: open "Close the gaps" at that gap. */
    function toGap(skill) { select('close'); focusGap(panels.close, skill); }

    var bodies = {
      gap: function () {
        return h('div', {},
          p.matrix ? [h('p', { class: 'ac-muted pp-intro' }, 'Each requirement of this job against your resume. Click a row to see how to close that gap.'), matrixView(p.matrix, p.fit, toGap)]
            : noDescription());
      },
      skills: function () {
        return h('div', {}, exact && p.matrix ? skillsView(p.matrix) : exact ? noDescription() : h('p', { class: 'ac-muted' }, 'Update this Insight to see the job\'s technical and functional requirements.'));
      },
      close: function () {
        return h('div', {},
          h('div', { class: 'pp-head' },
            h('div', { class: 'pp-meter', role: 'img', 'aria-label': 'Fit now ' + p.fit + ', up to ' + reach + ' after closing the gaps' },
              h('i', { class: 'now', style: 'width:' + p.fit + '%' }), h('i', { class: 'gain', style: 'left:' + p.fit + '%;width:' + (reach - p.fit) + '%' })),
            h('div', { class: 'pp-scores' }, h('span', {}, 'Fit now ', h('b', {}, String(p.fit))), h('span', {}, 'After closing the gaps ', h('b', { class: 'up' }, String(reach))))),
          h('div', { class: 'pp-grid' },
            section('gaps', '🎯', 'Close the gaps to reach ' + reach + '/100',
              p.gaps.length ? 'What this job wants that your resume does not show yet, biggest first, with where to learn it.' : null,
              p.gaps.length ? h('div', { class: 'pp-gaps' }, p.gaps.map(function (g) {
                return h('div', { class: 'pp-gap ' + g.importance, 'data-skill': g.skill },
                  h('div', { class: 'pp-gap-head' }, h('b', {}, g.skill), h('span', { class: 'pp-pts' }, '+' + g.points + ' fit'),
                    g.hours ? h('span', { class: 'ac-muted pp-hours' }, '~' + g.hours + ' h study') : null),
                  g.why ? h('p', { class: 'pp-why' }, g.why) : null,
                  g.howToClose ? h('p', { class: 'pp-how' }, h('b', {}, 'How: '), g.howToClose) : null,
                  linkRow(g.links.concat(g.certification ? [{ kind: 'cert', label: g.certification.name + ' certification', url: g.certification.url }] : [])));
              })) : h('p', { class: 'ac-muted' }, 'No real gaps: you already match what this job asks for.')),
            h('div', { class: 'pp-side' },
              p.matched.length ? section('match', '✅', 'You already match', null, chips(p.matched)) : null,
              p.plan.length ? section('plan', '🗓', 'Your plan to a full fit', null, h('ol', { class: 'pp-list' }, p.plan.map(function (x) { return h('li', {}, x); }))) : null)));
      },
      revise: function () {
        return h('div', {},
          p.revise.length ? section('revise', '📚', 'Topics to revise', 'Topics you know but should brush up for this job: videos and articles.',
            h('div', { class: 'pp-revise' }, p.revise.map(function (r) { return h('div', { class: 'pp-rev' }, h('b', {}, r.topic), linkRow(r.links)); }))) : null,
          questionsSection(p, refresh),
          h('div', { class: 'pp-grid two' },
            section('help', '💡', 'More help', null, h('div', {},
              p.tips.length ? h('ul', { class: 'pp-list' }, p.tips.map(function (x) { return h('li', {}, x); })) : null,
              h('div', { class: 'pp-actions' },
                h('a', { class: 'btn btn-sm', href: '#cr-match', onclick: function (e) { e.preventDefault(); goTo('cr-match'); } }, '✉️ Write a cover letter for this job'),
                h('a', { class: 'btn btn-sm', href: '#cr-versions', onclick: function (e) { e.preventDefault(); goTo('cr-versions'); } }, '🧩 Make a resume for this role'),
                h('a', { class: 'btn btn-sm', href: 'https://www.google.com/search?q=' + encodeURIComponent(job.company + ' ' + job.title + ' interview questions'), target: '_blank', rel: 'noopener noreferrer' }, '🔎 Interview experiences at ' + job.company),
                h('a', { class: 'btn btn-sm', href: 'https://www.google.com/search?q=' + encodeURIComponent(job.title + ' salary India ' + job.company), target: '_blank', rel: 'noopener noreferrer' }, '₹ Salary for this role'))))));
      }
    };

    var tabs = h('div', { class: 'in-tabs', role: 'tablist', 'aria-label': 'Insight: ' + job.title + ' at ' + job.company }, INSIGHT_TABS.map(function (t, i) {
      var label = t[0] === 'close' ? '🎯 Close the gaps to reach ' + reach : t[1];
      var b = h('button', { class: 'in-tab', type: 'button', role: 'tab', id: uid + '-' + t[0], 'aria-controls': uid + '-' + t[0] + '-p', onclick: function () { select(t[0]); },
        onkeydown: function (e) {
          var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (step) { e.preventDefault(); select(INSIGHT_TABS[(i + step + INSIGHT_TABS.length) % INSIGHT_TABS.length][0], true); }
        } }, label);
      buttons[t[0]] = b;
      return b;
    }));
    INSIGHT_TABS.forEach(function (t) {
      panels[t[0]] = h('div', { class: 'in-panel', role: 'tabpanel', id: uid + '-' + t[0] + '-p', 'aria-labelledby': uid + '-' + t[0], tabindex: '0' }, bodies[t[0]]());
    });
    var box = h('div', { class: 'pp in' },
      oldNote,
      p.summary ? h('p', { class: 'pp-summary' }, p.summary) : null,
      p.description === 'pasted' ? h('p', { class: 'ac-muted pp-intro' }, 'Made from the job description you pasted.') : null,
      tabs, INSIGHT_TABS.map(function (t) { return panels[t[0]]; }),
      h('p', { class: 'ac-muted pp-note' }, 'Links open a search on YouTube, Udemy, Coursera, official documentation and article sites, so you always see current material. Made ' + dateTime(p.createdAt) + '.'));
    select(tab || 'gap');
    return box;
  }
  /** Highlight the gap in "Close the gaps" that matches a matrix requirement (by shared words) and scroll to it. */
  function focusGap(scope, skill) {
    var words = function (t) { return String(t).toLowerCase().split(/[^a-z0-9#+.]+/).filter(function (w) { return w.length > 1 && ['and', 'or', 'the', 'of', 'in', 'with', 'for'].indexOf(w) === -1; }); };
    var want = words(skill);
    var best = null, bestScore = 0;
    [].forEach.call(scope.querySelectorAll('.pp-gap'), function (g) {
      var have = words(g.getAttribute('data-skill'));
      var n = want.filter(function (w) { return have.some(function (x) { return x === w || x.indexOf(w) === 0 || w.indexOf(x) === 0; }); }).length;
      if (n > bestScore) { best = g; bestScore = n; }
    });
    var target = best || scope.querySelector('.pp-sec.gaps');
    if (!target) return;
    setTimeout(function () { target.scrollIntoView({ behavior: 'smooth', block: best ? 'center' : 'start' }); }, 60);   // once the tab is shown
    [].forEach.call(scope.querySelectorAll('.pp-gap.flash'), function (g) { g.classList.remove('flash'); });
    if (best) { best.classList.add('flash'); setTimeout(function () { best.classList.remove('flash'); }, 2600); }
    else {
      var note = scope.querySelector('.pp-sec.gaps .pp-intro');
      if (note) note.textContent = '"' + skill + '" is not one of the gaps below: you already match it, or a gap below covers it.';
    }
  }
  /** The Insight row under a job: made on first open (one AI action), then read again for free. */
  function insightRow(searchId, job, cols) {
    var cell = h('td', { colspan: String(cols), class: 'pp-cell' });
    var row = h('tr', { class: 'pp-row' }, cell);
    function show(p, tab) { cell.replaceChildren(insightView(p, job, function () { load(true, 'gap'); }, tab)); }
    function load(refresh, tab, description) {
      if (job.insightData && refresh !== true && !description) { show(job.insightData, tab); return; }
      var text = job.insight && refresh !== true && !description ? 'Opening Insight…' : 'Reading the job description and building your Insight… (about 20 seconds)';
      cell.replaceChildren(h('p', { class: 'js-status busy' }, h('span', { class: 'js-status-in' }, h('span', { class: 'js-spin', 'aria-hidden': 'true' }), h('span', {}, text))));
      call('POST', '/api/career/jobsearch/' + searchId + '/prep', { jobId: job.id, refresh: refresh === true, description: description || undefined }).then(function (d) {
        job.insightData = d.prep; job.insight = true; setUsage(d.usage); show(d.prep, tab);
      }).catch(function (e) {
        if (e.code === 'no-description') { cell.replaceChildren(pasteBox(e.message)); return; }
        var retry = h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { load(refresh, tab, description); } }, 'Try again');
        cell.replaceChildren(h('p', { class: 'form-result bad' }, e.message, ' ', retry));
      });
    }
    /** The careers site gave no description we can read: the candidate pastes it from the job page. */
    function pasteBox(why) {
      var area = h('textarea', { rows: '8', maxlength: '15000', placeholder: 'Paste the whole job description here: summary, responsibilities and requirements…', 'aria-label': 'Job description for ' + job.title });
      var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
      var go = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: function () {
        if (area.value.trim().length < 300) { message(out, 'Paste the whole job description (it looks too short).', 'bad'); area.focus(); return; }
        load(false, 'gap', area.value.trim());
      } }, 'Build my Insight');
      return h('div', { class: 'pp in' },
        h('div', { class: 'in-note' }, h('span', {}, why), h('a', { class: 'btn btn-sm', href: job.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the job at ' + job.company + ' ↗')),
        area, h('div', { class: 'cr-actions' }, go), out);
    }
    return { row: row, load: load };
  }

  /** Required vs. what the candidate has: each requirement's type, weight, status, evidence and the points earned. */
  var MATRIX_STATUS = { match: ['✓', 'Match', 'good'], partial: ['◐', 'Partial', 'warn'], missing: ['✕', 'Missing', 'bad'] };
  function typeLabel(r) { return (r.type === 'functional' ? 'Functional' : 'Technical') + (r.priority === 'nice' ? ' · nice to have' : ''); }
  function matrixView(m, fit, onRow) {
    var missingTotal = m.rows.reduce(function (n, r) { return n + r.missing; }, 0);
    var showEv = m.rows.some(function (r) { return r.evidence; });
    var showType = m.rows.some(function (r) { return r.type; });
    return h('div', {},
      h('div', { class: 'mx-summary' },
        h('span', { class: 'mx-chip good' }, '✓ ' + m.counts.match + ' match'),
        h('span', { class: 'mx-chip warn' }, '◐ ' + m.counts.partial + ' partial'),
        h('span', { class: 'mx-chip bad' }, '✕ ' + m.counts.missing + ' missing'),
        h('span', { class: 'mx-score' }, 'Weighted skill score ', h('b', {}, m.score + '/100'))),
      h('div', { class: 'mx-scroll' }, h('table', { class: 'mx-table' },
        h('thead', {}, h('tr', {}, ['Required for this job'].concat(showType ? ['Type'] : []).concat(['Weight', 'You']).concat(showEv ? ['Evidence in your resume'] : []).concat(['Score', 'Gap'])
          .map(function (t) { return h('th', {}, t); }))),
        h('tbody', {}, m.rows.map(function (r) {
          var s = MATRIX_STATUS[r.status];
          return h('tr', onRow ? { class: 'mx-' + r.status + ' mx-click', tabindex: '0', title: 'See how to close this gap', onclick: function () { onRow(r.skill); },
            onkeydown: function (e) { if (e.key === 'Enter') onRow(r.skill); } } : { class: 'mx-' + r.status },
            h('td', { 'data-label': 'Required' }, h('b', {}, r.skill)),
            showType ? h('td', { 'data-label': 'Type', class: 'mx-type' }, typeLabel(r)) : null,
            h('td', { 'data-label': 'Weight', class: 'mx-num' }, r.weight + '%'),
            h('td', { 'data-label': 'You' }, h('span', { class: 'mx-status ' + s[2] }, s[0] + ' ' + s[1])),
            showEv ? h('td', { 'data-label': 'Evidence', class: 'mx-ev' }, r.evidence || (r.status === 'missing' ? 'Not in your resume' : '—')) : null,
            h('td', { 'data-label': 'Score', class: 'mx-num' },
              h('div', { class: 'mx-bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + (r.weight ? r.earned / r.weight * 100 : 0) + '%' })),
              h('span', {}, fmt(r.earned) + ' / ' + r.weight)),
            h('td', { 'data-label': 'Gap', class: 'mx-num mx-gap' }, r.missing ? '−' + fmt(r.missing) : '—'));
        })),
        h('tfoot', {}, h('tr', {},
          h('td', {}, h('b', {}, 'Total')), showType ? h('td') : null, h('td', { class: 'mx-num' }, h('b', {}, '100%')), h('td'), showEv ? h('td') : null,
          h('td', { class: 'mx-num' }, h('b', {}, m.score + ' / 100')), h('td', { class: 'mx-num mx-gap' }, h('b', {}, '−' + fmt(missingTotal))))))),
      h('p', { class: 'ac-muted pp-intro mx-note' }, 'Weight = how much each requirement matters for this job (all add up to 100). A match earns the full weight, partial half, missing none. ' +
        'Your overall fit (' + fit + ') also counts experience level and location.'));
  }
  /** What the job requires, technical and functional, in the job description's own words. */
  function skillsView(m) {
    var kinds = [['technical', '⚙️ Technical requirements'], ['functional', '🤝 Functional requirements']];
    return h('div', {},
      h('p', { class: 'ac-muted pp-intro' }, 'Every requirement this job\'s description states, and nothing else' +
        (m.dropped ? ' (' + m.dropped + ' AI suggestion' + (m.dropped === 1 ? '' : 's') + ' not stated in the description ' + (m.dropped === 1 ? 'was' : 'were') + ' left out).' : '.')),
      kinds.map(function (k) {
        var rows = m.rows.filter(function (r) { return (r.type || 'technical') === k[0]; });
        if (!rows.length) return null;
        return h('div', { class: 'sk-group' }, h('h5', {}, k[1] + ' (' + rows.length + ')'),
          h('div', { class: 'mx-scroll' }, h('table', { class: 'mx-table sk-table' },
            h('thead', {}, h('tr', {}, ['Requirement', 'Priority', 'Weight', 'In the job description'].map(function (t) { return h('th', {}, t); }))),
            h('tbody', {}, rows.map(function (r) {
              return h('tr', {},
                h('td', { 'data-label': 'Required' }, h('b', {}, r.skill)),
                h('td', { 'data-label': 'Priority' }, h('span', { class: 'sk-pri ' + (r.priority === 'nice' ? 'nice' : 'must') }, r.priority === 'nice' ? 'Nice to have' : 'Must have')),
                h('td', { 'data-label': 'Weight', class: 'mx-num' }, r.weight + '%'),
                h('td', { 'data-label': 'In the description', class: 'sk-quote' }, r.quote ? '“' + r.quote + '”' : 'Stated in the description'));
            })))));
      }));
  }
  function fmt(n) { return Math.round(n * 10) / 10 % 1 ? (Math.round(n * 10) / 10).toFixed(1) : String(Math.round(n)); }

  // ---------- other job sites: searches on Naukri, LinkedIn, Indeed and big employers' own careers sites ----------
  var ELSEWHERE = [];   // big employers we cannot read automatically (from the server)
  function slug(t) { return String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function naukriUrl(q, l) { return 'https://www.naukri.com/' + (slug(q) || 'it') + '-jobs' + (l ? '-in-' + slug(l) : ''); }
  function linkedinUrl(q, l) { return 'https://www.linkedin.com/jobs/search/?keywords=' + encodeURIComponent(q || '') + '&location=' + encodeURIComponent(l || 'India'); }
  function indeedUrl(q, l) { return 'https://in.indeed.com/jobs?q=' + encodeURIComponent(q || '') + '&l=' + encodeURIComponent(l || ''); }
  function fill(url, q, l) { return url.replace('{q}', encodeURIComponent(q || '')).replace('{l}', encodeURIComponent(l || '')); }
  /** "Same job elsewhere" links for one job: Naukri and LinkedIn searches for its title at that company. */
  function jobElsewhere(j) {
    var city = String(j.location || '').split(/[,;|]/)[0].trim();
    var q = j.title + ' ' + j.company;
    return h('div', { class: 'je-links' }, h('span', {}, 'Also on: '),
      h('a', { href: naukriUrl(j.title, city), target: '_blank', rel: 'noopener noreferrer', title: 'Search Naukri for this role' }, 'Naukri'), ' · ',
      h('a', { href: linkedinUrl(q, city || j.country), target: '_blank', rel: 'noopener noreferrer', title: 'Search LinkedIn for this job' }, 'LinkedIn'));
  }
  /** Under the results: more places to search for the same roles. */
  function searchElsewhere(params, profile) {
    var roles = [params.role].concat(profile.targetRoles || []).filter(Boolean).slice(0, 3);
    var where = params.city || params.country || 'India';
    if (!roles.length) return null;
    return h('div', { class: 'je-box' },
      h('div', { class: 'ac-subhead' }, '🔎 Search other job sites too'),
      h('p', { class: 'ac-muted js-small' }, 'More openings for your best-fit roles on job portals and at big employers whose careers sites we cannot read automatically. These open a search on their site.'),
      roles.map(function (r) {
        return h('div', { class: 'je-row' }, h('b', {}, r),
          h('a', { class: 'pp-link', href: naukriUrl(r, params.city), target: '_blank', rel: 'noopener noreferrer' }, 'Naukri'),
          h('a', { class: 'pp-link', href: linkedinUrl(r, where), target: '_blank', rel: 'noopener noreferrer' }, 'LinkedIn'),
          h('a', { class: 'pp-link', href: indeedUrl(r, params.city || params.country), target: '_blank', rel: 'noopener noreferrer' }, 'Indeed'));
      }),
      ELSEWHERE.length ? h('div', { class: 'je-firms' }, h('span', { class: 'ac-muted js-small' }, 'Careers sites of: '),
        ELSEWHERE.map(function (c) { return h('a', { class: 'pp-link', href: fill(c.url, roles[0], where), target: '_blank', rel: 'noopener noreferrer' }, c.name + ' ↗'); })) : null);
  }

  /** The company's logo (from its web address) next to its name; its initials when the logo is unknown or does not load. */
  /** A company's logo: from its web address, or found from its name by the server; its initials when there is none (404). */
  function companyLogo(name, domain, size) {
    var initials = String(name || '?').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
    var badge = h('span', { class: 'jb-initials', 'aria-hidden': 'true', style: size ? 'width:' + size + 'px;height:' + size + 'px' : null }, initials);
    var logo = h('img', { class: 'jb-logo', src: API + '/api/logo?' + (domain ? 'domain=' + encodeURIComponent(domain) + '&' : '') + 'name=' + encodeURIComponent(name || ''),
      alt: '', width: String(size || 28), height: String(size || 28), loading: 'lazy' });
    logo.addEventListener('error', function () { logo.replaceWith(badge); });
    return logo;
  }
  function companyCell(j) { return h('span', { class: 'jb-co' }, companyLogo(j.company, j.domain), h('span', {}, j.company)); }
  function groupTable(list, withResume, startAt, searchId) {
    var head = ['#', 'Role', 'Company', 'Location', 'Posted', 'Fit', 'Why / gap'].concat(withResume ? ['Send'] : []).concat(['']);
    return h('div', { class: 'jb-scroll' }, h('table', { class: 'jb-table js-table' },
      h('thead', {}, h('tr', {}, head.map(function (t) { return h('th', {}, t); }))),
      h('tbody', {}, list.map(function (j, i) {
        var insight = null, jobRow = null;
        var kitRow = null, kit = h('button', { class: 'btn btn-sm pp-toggle', type: 'button', 'aria-expanded': 'false' }, '📝 Apply kit');
        kit.addEventListener('click', function () {
          if (kitRow && kitRow.row.parentNode) { kitRow.row.remove(); kit.setAttribute('aria-expanded', 'false'); kit.textContent = '📝 Apply kit'; return; }
          kitRow = kitRow || applyKitRow(searchId, j, head.length);
          jobRow.parentNode.insertBefore(kitRow.row, jobRow.nextSibling);
          kit.setAttribute('aria-expanded', 'true'); kit.textContent = '📝 Apply kit ▴';
          kitRow.load();
        });
        var toggle = h('button', { class: 'btn btn-sm pp-toggle' + (j.insight ? ' ready' : ''), type: 'button', 'aria-expanded': 'false' }, '💡 Insight');
        toggle.addEventListener('click', function () {
          if (insight && insight.row.parentNode) { insight.row.remove(); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '💡 Insight'; return; }
          insight = insight || insightRow(searchId, j, head.length);
          jobRow.parentNode.insertBefore(insight.row, jobRow.nextSibling);
          toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = '💡 Insight ▴';
          insight.load(false, 'gap');
        });
        return jobRow = h('tr', {},
          h('td', { class: 'js-num', 'data-label': '#' }, String(startAt + i + 1)),
          h('td', { 'data-label': 'Role' }, h('b', {}, j.title)),
          h('td', { 'data-label': 'Company' }, companyCell(j)),
          h('td', { 'data-label': 'Location' }, j.location || j.country || '—'),
          h('td', { 'data-label': 'Posted', title: j.postedAt ? new Date(j.postedAt).toLocaleString() : '' }, ago(j.postedAt)),
          h('td', { 'data-label': 'Fit' }, fitBadge(j.score)),
          h('td', { 'data-label': 'Why' }, j.why ? h('div', { class: 'jb-reason' }, j.why) : null,
            j.gap && !/^none\.?$/i.test(j.gap) ? h('div', { class: 'jb-gap' }, 'Gap: ' + j.gap) : null),
          withResume ? h('td', { 'data-label': 'Send' }, j.resume || '—') : null,
          h('td', { class: 'jb-open' }, h('a', { class: 'btn btn-primary btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Apply ↗'), toggle, kit, jobElsewhere(j)));
      }))));
  }

  /** One group of results, PAGE_SIZE jobs a page; each page is read from the server when it is opened. */
  var PAGE_SIZE = 5;
  function groupBlock(s, g, first, withResume) {
    var body = h('div', {}), pager = h('div', { class: 'jb-pager' });
    var block = h('div', { class: 'js-group ' + g[0] },
      h('div', { class: 'js-group-head' }, h('h3', {}, g[1] + ' (' + first.total + ')'), h('span', { class: 'ac-muted' }, g[2])), body, pager);
    function show(pg) {
      body.replaceChildren(groupTable(pg.jobs, withResume, (pg.page - 1) * pg.size, s.id));
      pager.replaceChildren();
      if (pg.pages <= 1) return;
      var button = function (label, n, current) {
        return h('button', { class: 'btn btn-sm' + (current ? ' btn-primary' : ''), type: 'button', disabled: n < 1 || n > pg.pages || current,
          'aria-current': current ? 'page' : null, 'aria-label': /^\d+$/.test(label) ? 'Page ' + label : null, onclick: function () { open(n); } }, label);
      };
      var numbers = [];
      for (var n = 1; n <= pg.pages; n++) numbers.push(button(String(n), n, n === pg.page));
      pager.append(
        h('span', { class: 'ac-muted' }, 'Showing ' + ((pg.page - 1) * pg.size + 1) + '–' + Math.min(pg.page * pg.size, pg.total) + ' of ' + pg.total),
        h('nav', { class: 'jb-pages', 'aria-label': 'Pages: ' + g[1] }, button('‹ Previous', pg.page - 1), numbers, button('Next ›', pg.page + 1)));
    }
    function open(n) {
      pager.classList.add('busy');
      call('GET', '/api/career/jobsearch/' + s.id + '/jobs?bucket=' + g[0] + '&page=' + n + '&size=' + PAGE_SIZE + (first.company ? '&company=' + encodeURIComponent(first.company) : ''))
        .then(function (pg) { show(pg); block.scrollIntoView({ behavior: 'smooth', block: 'start' }); })
        .catch(function (e) { showError(e.message); })
        .then(function () { pager.classList.remove('busy'); });
    }
    show(first);
    return block;
  }

  /** The three groups (high, medium, low) for the company chosen in the filter, or for all companies. */
  function showGroups(box, r, s, withResume) {
    var blocks = GROUPS.map(function (g) {
      var first = r.groups && r.groups[g[0]];
      return first && first.total ? groupBlock(s, g, first, withResume) : null;
    }).filter(Boolean);
    box.replaceChildren.apply(box, blocks.length ? blocks : [h('p', { class: 'ac-muted' }, 'No jobs at this company in this search.')]);
  }
  /** Company logos above the results: one click shows only that company's jobs (read from the server, 5 a page). */
  function companyFilter(s, groups) {
    var list = (s.result.companies || []);
    if (list.length < 2) return null;
    var withResume = s.params.resume === 'all';
    var row = h('div', { class: 'co-filter', role: 'group', 'aria-label': 'Show the jobs of one company' });
    function chip(c) {
      var on = (s.result.company || '') === (c ? c.name : '');
      return h('button', { class: 'co-chip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', title: c ? 'Only ' + c.name + ' jobs' : 'Jobs at every company',
        onclick: function () { pick(c ? c.name : ''); } },
        c ? companyLogo(c.name, c.domain, 22) : h('span', { class: 'co-all', 'aria-hidden': 'true' }, '★'),
        h('span', {}, c ? c.name : 'All companies'), h('span', { class: 'co-count' }, String(c ? c.count : s.result.total)));
    }
    function draw() { row.replaceChildren.apply(row, [chip(null)].concat(list.map(chip))); }
    function pick(name) {
      if ((s.result.company || '') === name) return;
      row.classList.add('busy');
      call('GET', '/api/career/jobsearch/' + s.id + (name ? '?company=' + encodeURIComponent(name) : '')).then(function (d) {
        s.result.company = d.search.result.company;
        s.result.groups = d.search.result.groups;
        draw();
        showGroups(groups, s.result, s, withResume);
      }).catch(function (e) { showError(e.message); }).then(function () { row.classList.remove('busy'); });
    }
    draw();
    return h('div', { class: 'co-box' }, h('div', { class: 'ac-subhead' }, 'Companies in your results'), row);
  }

  function searchResult(s) {
    var r = s.result, p = r.profile, cov = r.coverage;
    var withResume = s.params.resume === 'all';
    var notes = [];
    if (cov.notFound.length) notes.push('Could not find the careers site of: ' + cov.notFound.join(', ') + '. Paste the link of their careers page instead.');
    if (cov.notSupported.length) notes.push('These careers sites cannot be read yet: ' + cov.notSupported.join(', ') + '. Sites on Greenhouse, Lever, SmartRecruiters, Ashby and Workday work.');
    if (cov.failed.length) notes.push('These careers sites did not answer: ' + cov.failed.join(', ') + '. Try again later.');
    if (cov.loading) notes.push(cov.loading + ' careers site' + (cov.loading === 1 ? ' was' : 's were') + ' still loading. Search again in a few minutes to include them.');
    if (r.total < 20) notes.push('Fewer than 20 matches: try a wider location, another role, a longer date range or more companies.');
    var groups = h('div', { class: 'js-groups' });
    showGroups(groups, r, s, withResume);
    return h('div', { class: 'js-result' },
      h('div', { class: 'js-profile' },
        h('div', { class: 'ac-subhead' }, 'Your profile'),
        p.level ? h('p', { class: 'js-level' }, h('b', {}, 'Level: '), p.level) : null,
        p.summary ? h('p', {}, p.summary) : null,
        p.strengths.length ? h('div', { class: 'js-line' }, h('span', { class: 'ac-muted' }, 'Strongest areas: '), chips(p.strengths)) : null,
        p.targetRoles.length ? h('div', { class: 'js-line' }, h('span', { class: 'ac-muted' }, 'Best-fit roles: '), chips(p.targetRoles.map(function (t, i) { return (i + 1) + '. ' + t; }))) : null),
      h('p', { class: 'jb-info' }, r.total + ' matches from ' + cov.live.toLocaleString() + ' live jobs at ' + cov.companies + ' compan' + (cov.companies === 1 ? 'y' : 'ies') +
        ' · searched ' + dateTime(s.finishedAt) + ' · ' + paramsLine(s.params)),
      h('p', { class: 'ac-muted js-small' }, 'Press 💡 Insight on a job for its skill gap matrix, its technical and functional requirements, how to close each gap, and what to revise before the interview.'),
      companyFilter(s, groups),
      groups,
      searchElsewhere(s.params, p),
      p.resumeFixes.length ? h('div', { class: 'js-fixes' }, h('div', { class: 'ac-subhead' }, '⚠️ Fix your resume before you apply'),
        h('ol', { class: 'cr-list' }, p.resumeFixes.map(function (f) { return h('li', {}, f); }))) : null,
      notes.length ? h('ul', { class: 'js-notes' }, notes.map(function (x) { return h('li', {}, x); })) : null,
      h('p', { class: 'ac-muted js-small' }, 'Every job comes from the company\'s own careers site and was open when we searched. Openings close quickly, so apply to the high-probability ones soon.'));
  }

  function jobsCard() {
    var f = searchForm;
    var status = h('div', { class: 'js-status', role: 'status', 'aria-live': 'polite' });
    var result = h('div', {});
    var history = h('div', {});
    var searches = [];
    var gen = ++cardGen;   // a re-rendered card stops the polling of the old one

    var bind = function (el, key, kind) {
      if (kind === 'check') el.checked = f[key]; else el.value = f[key];
      el.addEventListener(kind === 'check' ? 'change' : 'input', function () { f[key] = kind === 'check' ? el.checked : el.value; });
      el.addEventListener('change', function () { f[key] = kind === 'check' ? el.checked : el.value; });
      return el;
    };
    var resumeOptions = [['all', 'Resume: all my resumes (' + (1 + state.versions.length) + ')'], ['ats', 'Resume: ' + (state.resume && state.resume.ats ? 'ATS-friendly resume' : 'uploaded resume')]]
      .concat(state.versions.map(function (v) { return ['v' + v.id, 'Resume: ' + v.role]; }));
    var resumeSel = bind(h('select', { 'aria-label': 'Resume to match' }, resumeOptions.map(function (o) { return h('option', { value: o[0] }, o[1]); })), 'resume');
    var levelSel = bind(h('select', { 'aria-label': 'Level' }, LEVELS.map(function (o) { return h('option', { value: o[0] }, o[1]); })), 'level');
    var sectorSel = bind(h('select', { 'aria-label': 'Sector (from My account → Profile)', disabled: true, title: 'Your sector comes from My account → Profile' }, SECTORS.map(function (o) { return h('option', { value: o[0] }, o[1]); })), 'sector');
    var role = bind(h('input', { type: 'text', maxlength: '120', placeholder: 'Role or keywords, e.g. Power Platform, Project Manager (optional)', 'aria-label': 'Role or keywords' }), 'role');
    var country = bind(h('input', { type: 'text', maxlength: '80', list: 'js-countries', placeholder: 'Country, e.g. India', 'aria-label': 'Country' }), 'country');
    var city = bind(h('input', { type: 'text', maxlength: '80', placeholder: 'City, e.g. Noida (optional)', 'aria-label': 'City' }), 'city');
    var companies = bind(h('textarea', { rows: '2', maxlength: '4000', 'aria-label': 'Companies',
      placeholder: 'Companies (optional): names or careers-page links, separated by commas. e.g. Mastercard, Bosch, https://jobs.lever.co/acme' }), 'companies');
    var days = bind(h('select', { 'aria-label': 'Posted within' }, [['', 'Posted: any time'], ['7', 'Posted: last 7 days'], ['14', 'Posted: last 14 days'], ['30', 'Posted: last 30 days']].map(function (o) { return h('option', { value: o[0] }, o[1]); })), 'days');
    var remote = bind(h('input', { type: 'checkbox', id: 'js-remote' }), 'remote', 'check');
    var run = h('button', { class: 'btn btn-primary js-run', type: 'button', disabled: !state.resume }, '✦ Search jobs with AI');
    var hint = h('p', { class: 'ac-muted js-small' }, 'Pick your sector so we search the right employers. Leave "Companies" empty to search the main employers of that sector.');

    function setRunning(on) { run.disabled = on || !state.resume || !f.sector; run.textContent = on ? 'Searching…' : '✦ Search jobs with AI'; }
    function showStatus(text, kind) {
      status.className = 'js-status' + (kind ? ' ' + kind : '');
      status.replaceChildren();
      if (text) status.appendChild(h('span', { class: 'js-status-in' }, kind === 'busy' ? h('span', { class: 'js-spin', 'aria-hidden': 'true' }) : null, h('span', {}, text)));
    }
    function poll(id) {
      clearTimeout(pollTimer);
      if (gen !== cardGen) return;
      call('GET', '/api/career/jobsearch/' + id).then(function (d) {
        if (d.elsewhere) ELSEWHERE = d.elsewhere;
        var s = d.search;
        if (s.status === 'running') { setRunning(true); showStatus(s.progress || 'Searching…', 'busy'); pollTimer = setTimeout(function () { poll(id); }, 2500); return; }
        setRunning(false);
        setUsage(d.usage);
        if (s.status === 'failed') showStatus(s.error || 'The search failed. Please try again.', 'bad');
        else { showStatus(''); result.replaceChildren(searchResult(s)); }
        loadHistory();
      }).catch(function (e) { setRunning(false); showStatus(e.message, 'bad'); });
    }
    run.addEventListener('click', function () {
      if (!f.country.trim() && !f.city.trim() && !confirm('No country or city given: search jobs everywhere?')) return;
      setRunning(true); showStatus('Starting your search…', 'busy');
      call('POST', '/api/career/jobsearch', { resume: f.resume, level: f.level, role: f.role.trim(), country: f.country.trim(), city: f.city.trim(),
        companies: f.companies.trim(), days: f.days ? Number(f.days) : 0, remote: f.remote })
        .then(function (d) { result.replaceChildren(); poll(d.search.id); })
        .catch(function (e) { setRunning(false); showStatus(e.message, 'bad'); });
    });

    function loadHistory() {
      return call('GET', '/api/career/jobsearch').then(function (d) {
        if (d.elsewhere) ELSEWHERE = d.elsewhere;
        searches = d.searches;
        f.sector = d.sector || ''; sectorSel.value = f.sector; setRunning(false);
        hint.replaceChildren(f.sector ? 'We search the main employers of your sector. Leave "Companies" empty to use them.' : h('span', {}, 'Your sector is required. ', h('a', { href: 'account.html#overview' }, 'Choose it in My account → Profile'), ' to search jobs.'));
        var past = searches.filter(function (s) { return s.status !== 'running'; });
        history.replaceChildren(past.length ? h('details', { class: 'cr-history' }, h('summary', {}, 'Earlier searches (' + past.length + ')'),
          past.map(function (s) {
            var open = h('button', { class: 'btn btn-sm', type: 'button', disabled: s.status !== 'done', onclick: function () {
              call('GET', '/api/career/jobsearch/' + s.id).then(function (x) { showStatus(''); result.replaceChildren(searchResult(x.search)); result.scrollIntoView({ behavior: 'smooth', block: 'start' }); })
                .catch(function (e) { showError(e.message); });
            } }, 'Open');
            var del = h('button', { class: 'btn btn-sm cr-delete', type: 'button', onclick: function () {
              call('POST', '/api/career/jobsearch/' + s.id + '/delete').then(loadHistory).catch(function (e) { showError(e.message); });
            } }, 'Delete');
            var counts = s.status === 'done' ? h('span', { class: 'js-counts' }, h('span', { class: 'ac-badge good' }, String(s.counts.high)), h('span', { class: 'ac-badge warn' }, String(s.counts.medium)), h('span', { class: 'ac-badge bad' }, String(s.counts.stretch)))
              : h('span', { class: 'ac-badge bad' }, 'Failed');
            return h('div', { class: 'cr-history-row' }, counts, h('span', { class: 'cr-history-name' }, paramsLine(s.params), h('span', { class: 'ac-muted' }, ' · ' + dateTime(s.createdAt))), open, del);
          })) : '');
        return searches;
      });
    }
    // on load: show the latest search (or follow it while it runs)
    setTimeout(function () {
      loadHistory().then(function (list) {
        var latest = list[0];
        if (latest && (latest.status === 'running' || latest.status === 'done')) poll(latest.id);
      }).catch(function (e) { showStatus(e.message, 'bad'); });
    }, 0);

    return card('cr-jobs', 5, 'AI Job search',
      'Tell us what you are looking for. We read live openings from the companies\' own career sites, and the AI matches each one to your resume and sorts them into high, medium and low-probability jobs.',
      h('div', {}, !state.resume ? h('p', { class: 'ac-muted' }, 'Upload your resume first (step 1).') : null,
        h('datalist', { id: 'js-countries' }, COUNTRIES.map(function (c) { return h('option', { value: c }); })),
        h('div', { class: 'js-form' },
          h('div', { class: 'js-row three' }, resumeSel, levelSel, sectorSel),
          h('div', { class: 'js-row three' }, role, country, city),
          companies,
          h('div', { class: 'js-row actions' }, days, h('label', { class: 'js-check', for: 'js-remote' }, remote, ' Include remote jobs'), run)),
        hint, status, result, history));
  }

  // ---------- 6. Apply: the application profile, the Apply kit on each job, the tracker, and the browser extension ----------
  // The profile holds everything a company's form asks for (jobs and education as lists with exact dates). The candidate
  // checks it once; then each job's "Apply kit" has every field one click away, and the extension fills company portals.
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DATE_FORMATS = ['MM/YYYY', 'Month YYYY', 'MMM YYYY', 'YYYY-MM', 'DD/MM/YYYY'];
  var apply = { profile: null, problems: [], confirmedAt: null, apps: [], promise: null, extension: false, format: 'MM/YYYY' };

  function emptyProfile() {
    return { personal: {}, summary: '', work: [], education: [], skills: [], certifications: [], languages: [], preferences: {} };
  }
  function fmtDate(m, y, f) {
    if (!y) return '';
    var mm = m ? (m < 10 ? '0' : '') + m : '';
    if (f === 'Month YYYY') return m ? MONTHS[m - 1] + ' ' + y : String(y);
    if (f === 'MMM YYYY') return m ? MONTHS[m - 1].slice(0, 3) + ' ' + y : String(y);
    if (f === 'YYYY-MM') return m ? y + '-' + mm : String(y);
    if (f === 'DD/MM/YYYY') return '01/' + (mm || '01') + '/' + y;
    return m ? mm + '/' + y : String(y);
  }
  function takeApply(d) {
    apply.profile = d.profile; apply.problems = d.problems || []; apply.confirmedAt = d.confirmedAt || null;
    tellExtension();
  }
  /** The checked profile goes to the browser extension (when installed) through the page; nothing leaves the browser. */
  function tellExtension() {
    try { window.postMessage({ source: 'shortlistprep-site', type: 'profile', profile: apply.profile && apply.confirmedAt ? apply.profile : null }, location.origin); } catch (e) { /* ignore */ }
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.source !== 'shortlistprep-extension') return;
    apply.extension = true;
    tellExtension();
    document.querySelectorAll('.ap-ext-state').forEach(function (n) { n.textContent = 'Browser extension connected'; n.classList.add('ok'); });
  });

  function loadApply(force) {
    if (!apply.promise || force) {
      apply.promise = Promise.all([call('GET', '/api/career/app-profile'), call('GET', '/api/career/applications')]).then(function (r) {
        takeApply(r[0]); apply.apps = r[1].applications || [];
      }).catch(function (e) { apply.promise = null; throw e; });
    }
    return apply.promise;
  }

  function copyText(text, btn) {
    var done = function (ok) {
      var old = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', old); btn.textContent = ok ? 'Copied' : 'Select and copy';
      setTimeout(function () { btn.textContent = old; }, 1300);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    else done(false);
  }
  function copyRow(label, value, multiline) {
    var btn = h('button', { class: 'btn btn-sm ap-copy', type: 'button', disabled: !value }, 'Copy');
    btn.addEventListener('click', function () { copyText(value, btn); });
    return h('div', { class: 'ap-crow' }, h('span', { class: 'ap-k' }, label),
      h('span', { class: 'ap-v' + (multiline ? ' multi' : '') }, value || '—'), btn);
  }

  /** The Apply kit for one job: every field one click away, a job or education entry at a time. */
  function applyKit(j, redraw) {
    var p = apply.profile, per = p.personal, pref = p.preferences, f = apply.format;
    var box = h('div', { class: 'ap-kit' });
    var fmt = h('select', { 'aria-label': 'Date format' }, DATE_FORMATS.map(function (x) { return h('option', { value: x }, 'Dates: ' + x); }));
    fmt.value = f;
    fmt.addEventListener('change', function () { apply.format = fmt.value; redraw(); });
    var group = function (title, rows, all) {
      var head = h('div', { class: 'ap-ghead' }, h('b', {}, title));
      if (all) { var b = h('button', { class: 'btn btn-sm', type: 'button' }, 'Copy all'); b.addEventListener('click', function () { copyText(all, b); }); head.appendChild(b); }
      return h('div', { class: 'ap-group' }, head, rows);
    };
    var lines = function (pairs) { return pairs.filter(function (x) { return x[1]; }).map(function (x) { return x[0] + ': ' + x[1]; }).join('\n'); };
    box.appendChild(h('div', { class: 'ap-bar' }, fmt));
    box.appendChild(group('About you', [
      copyRow('Full name', per.fullName), copyRow('First name', per.firstName), copyRow('Last name', per.lastName), copyRow('Email', per.email), copyRow('Phone', per.phone),
      copyRow('City', per.city), copyRow('State', per.state), copyRow('Country', per.country), copyRow('Postal code', per.postalCode), copyRow('Address', per.address),
      copyRow('LinkedIn', per.linkedin), copyRow('GitHub', per.github), copyRow('Website', per.portfolio)],
    lines([['Name', per.fullName], ['Email', per.email], ['Phone', per.phone], ['City', per.city], ['Country', per.country], ['LinkedIn', per.linkedin]])));
    p.work.forEach(function (w, i) {
      var start = fmtDate(w.startMonth, w.startYear, f), end = w.current ? '' : fmtDate(w.endMonth, w.endYear, f);
      box.appendChild(group('Job ' + (i + 1) + ' of ' + p.work.length + ': ' + (w.company || 'Untitled') + (w.current ? ' (current)' : ''), [
        copyRow('Company', w.company), copyRow('Job title', w.title), copyRow('Location', w.location), copyRow('Start date', start),
        copyRow('End date', w.current ? '' : end), w.current ? h('p', { class: 'ap-note' }, 'This is your current job: tick "I currently work here" and leave the end date empty.') : null,
        copyRow('Responsibilities', w.responsibilities, true)],
      lines([['Company', w.company], ['Title', w.title], ['Location', w.location], ['Start', start], ['End', w.current ? 'Present' : end], ['Responsibilities', w.responsibilities ? '\n' + w.responsibilities : '']])));
    });
    p.education.forEach(function (e, i) {
      var start = e.startYear ? String(e.startYear) : '', end = e.endYear ? String(e.endYear) : '';
      box.appendChild(group('Education ' + (i + 1) + ' of ' + p.education.length + ': ' + (e.school || 'Untitled'), [
        copyRow('College or university', e.school), copyRow('Degree', e.degree), copyRow('Field of study', e.field), copyRow('Start year', start), copyRow('End year', end), copyRow('Grade', e.grade)],
      lines([['College', e.school], ['Degree', e.degree], ['Field', e.field], ['Start', start], ['End', end], ['Grade', e.grade]])));
    });
    box.appendChild(group('Other questions', [
      copyRow('Total experience', pref.totalExperience), copyRow('Notice period', pref.noticePeriod), copyRow('Current salary', pref.currentCtc), copyRow('Expected salary', pref.expectedCtc),
      copyRow('Work authorisation', pref.workAuthorization), copyRow('Skills', (p.skills || []).join(', '), true)], ''));
    return box;
  }

  /** The Apply kit under a job in the results. */
  function applyKitRow(searchId, j, cols) {
    var cell = h('td', { colspan: String(cols) });
    var row = h('tr', { class: 'pp-row' }, cell);
    var track = function (note) {
      call('POST', '/api/career/applications', { url: j.url, title: j.title, company: j.company, jobId: j.id, searchId: searchId, status: 'applied' }).then(function (d) {
        apply.apps = apply.apps.filter(function (a) { return a.url !== j.url; }); apply.apps.unshift(d.application);
        note.textContent = 'Saved: marked as applied. Find it in step 6 under "Your applications".'; note.className = 'form-result ok';
      }).catch(function (e) { note.textContent = e.message; note.className = 'form-result bad'; });
    };
    function draw() {
      var note = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
      var mark = h('button', { class: 'btn btn-sm', type: 'button' }, '✔ Mark as applied');
      mark.addEventListener('click', function () { track(note); });
      var open = h('a', { class: 'btn btn-primary btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the application ↗');
      var done = apply.apps.some(function (a) { return a.url === j.url; });
      var ready = apply.profile && apply.confirmedAt;
      cell.replaceChildren(h('div', { class: 'pp in ap' },
        h('div', { class: 'ap-top' }, h('b', {}, '📝 Apply kit: ' + j.title + ' at ' + j.company), h('span', { class: 'ac-muted' }, done ? 'Marked as applied' : '')),
        ready ? [h('p', { class: 'ac-muted' }, 'Open the company\'s application in a new tab and copy each field from here, one at a time. With the browser extension the form fills itself.'), applyKit(j, draw)]
          : h('div', { class: 'in-note' }, h('span', {}, apply.profile ? 'Check and confirm your application profile first, so these details are right.' : 'Create your application profile first: it is filled from your resume and takes about a minute.'),
            h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: function () { goTo('cr-apply'); } }, 'Open step 6: Apply')),
        h('div', { class: 'ap-actions' }, open, mark), note));
    }
    return { row: row, load: function () {
      cell.replaceChildren(h('p', { class: 'js-status busy' }, h('span', { class: 'js-status-in' }, h('span', { class: 'js-spin', 'aria-hidden': 'true' }), h('span', {}, 'Opening your Apply kit…'))));
      loadApply().then(draw).catch(function (e) { cell.replaceChildren(h('p', { class: 'form-result bad' }, e.message)); });
    } };
  }

  /** Step 6 */
  function applyCard() {
    var body = h('div', {}, h('p', { class: 'ac-muted' }, 'Loading…'));
    var section = card('cr-apply', 6, 'Apply faster', 'Keep your details once, checked by you. Copy them into any company\'s form from the job\'s Apply kit, or let the browser extension fill the form.', body);
    var draft = null;

    function field(label, obj, key, opts) {
      opts = opts || {};
      var input = opts.area ? h('textarea', { rows: String(opts.rows || 4), maxlength: String(opts.max || 2500) }) : h('input', { type: opts.number ? 'number' : 'text', maxlength: String(opts.max || 200), placeholder: opts.placeholder || '' });
      input.value = obj[key] ? String(obj[key]) : '';
      input.addEventListener('input', function () { obj[key] = opts.number ? (input.value === '' ? 0 : Number(input.value)) : input.value; });
      return h('label', { class: 'ap-f' + (opts.wide ? ' wide' : '') }, label, input);
    }
    function monthSel(label, obj, key) {
      var sel = h('select', {}, [h('option', { value: '0' }, '—')].concat(MONTHS.map(function (m, i) { return h('option', { value: String(i + 1) }, m); })));
      sel.value = String(obj[key] || 0);
      sel.addEventListener('change', function () { obj[key] = Number(sel.value); });
      return h('label', { class: 'ap-f' }, label, sel);
    }
    function listText(label, obj, key, hint) {
      var input = h('input', { type: 'text', maxlength: '800', placeholder: hint });
      input.value = (obj[key] || []).join(', ');
      input.addEventListener('input', function () { obj[key] = input.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean); });
      return h('label', { class: 'ap-f wide' }, label, input);
    }
    function entryCard(title, onRemove, fields) {
      var rm = h('button', { class: 'btn btn-sm', type: 'button' }, 'Remove');
      rm.addEventListener('click', onRemove);
      return h('div', { class: 'ap-entry' }, h('div', { class: 'ap-ehead' }, h('b', {}, title), rm), h('div', { class: 'ap-grid' }, fields));
    }

    function draw() {
      var out = h('p', { class: 'form-result', role: 'status', 'aria-live': 'polite' });
      var node = [];
      node.push(h('div', { class: 'ap-ext' }, h('span', { class: 'ap-ext-state' + (apply.extension ? ' ok' : '') }, apply.extension ? 'Browser extension connected' : 'Browser extension not detected'),
        h('span', { class: 'ac-muted' }, ' · It fills sign-up, sign-in and application forms from this profile. You always review and press Submit yourself. ',
          h('a', { href: 'apply-extension.html' }, 'How to install it'))));

      if (!apply.profile) {
        var gen = h('button', { class: 'btn btn-primary', type: 'button', disabled: !state.resume }, '✦ Fill my profile from my resume (uses 1 AI action)');
        var blank = h('button', { class: 'btn', type: 'button' }, 'Start empty');
        gen.addEventListener('click', function () {
          gen.disabled = true; message(out, 'Reading your resume… (about 20 seconds)');
          call('POST', '/api/career/app-profile/generate').then(function (d) { takeApply(d); setUsage(d.usage); draft = null; draw(); })
            .catch(function (e) { gen.disabled = false; message(out, e.message, 'bad'); });
        });
        blank.addEventListener('click', function () { apply.profile = emptyProfile(); apply.problems = []; draft = null; draw(); });
        node.push(h('div', { class: 'ap-start' }, h('p', {}, state.resume ? 'No application profile yet. We read your resume and fill in your details, every job and every education entry with its dates. You then check it once.' : 'Upload your resume first (step 1), then we can fill your profile from it.'),
          h('div', { class: 'cr-actions' }, gen, blank), out));
      } else {
        draft = draft || JSON.parse(JSON.stringify(apply.profile));
        draft.personal = draft.personal || {}; draft.preferences = draft.preferences || {};
        var per = draft.personal, pref = draft.preferences;
        if (apply.problems.length) node.push(h('div', { class: 'in-note ap-problems' }, h('div', {}, h('b', {}, 'To check before you apply'), h('ul', {}, apply.problems.map(function (x) { return h('li', {}, x); })))));
        node.push(h('p', { class: 'ap-status' }, apply.confirmedAt ? '✔ Checked by you on ' + new Date(apply.confirmedAt).toLocaleDateString() + '. The Apply kit and the extension use this.' : 'Not confirmed yet. Check everything below, then press "Save and confirm".'));
        node.push(h('h3', { class: 'ap-h' }, 'About you'), h('div', { class: 'ap-grid' }, [
          field('Full name', per, 'fullName'), field('Email', per, 'email'), field('Phone', per, 'phone'), field('City', per, 'city'), field('State', per, 'state'), field('Country', per, 'country'),
          field('Postal code', per, 'postalCode', { max: 20 }), field('Address', per, 'address'), field('LinkedIn', per, 'linkedin'), field('GitHub', per, 'github'), field('Website or portfolio', per, 'portfolio')]));
        node.push(h('h3', { class: 'ap-h' }, 'Work experience (' + draft.work.length + ')'));
        draft.work.forEach(function (w, i) {
          var end = [monthSel('End month', w, 'endMonth'), field('End year', w, 'endYear', { number: true, max: 4 })];
          if (w.current) end.forEach(function (n) { n.querySelector('input,select').disabled = true; });
          var cur = h('input', { type: 'checkbox' }); cur.checked = !!w.current;
          cur.addEventListener('change', function () { w.current = cur.checked; if (w.current) { w.endMonth = 0; w.endYear = 0; } draw(); });
          node.push(entryCard('Job ' + (i + 1), function () { draft.work.splice(i, 1); draw(); }, [
            field('Company', w, 'company'), field('Job title', w, 'title'), field('Location', w, 'location'),
            monthSel('Start month', w, 'startMonth'), field('Start year', w, 'startYear', { number: true, max: 4 })].concat(end,
            [h('label', { class: 'ap-f ap-check' }, cur, ' I currently work here'), field('Responsibilities (one per line)', w, 'responsibilities', { area: true, rows: 5, wide: true })])));
        });
        var addJob = h('button', { class: 'btn btn-sm', type: 'button' }, '+ Add a job');
        addJob.addEventListener('click', function () { draft.work.push({ company: '', title: '', location: '', startMonth: 0, startYear: 0, endMonth: 0, endYear: 0, current: false, responsibilities: '' }); draw(); });
        node.push(addJob);
        node.push(h('h3', { class: 'ap-h' }, 'Education (' + draft.education.length + ')'));
        draft.education.forEach(function (e, i) {
          node.push(entryCard('Education ' + (i + 1), function () { draft.education.splice(i, 1); draw(); }, [
            field('College or university', e, 'school', { wide: true }), field('Degree', e, 'degree'), field('Field of study', e, 'field'), field('Location', e, 'location'),
            field('Start year', e, 'startYear', { number: true, max: 4 }), field('End year', e, 'endYear', { number: true, max: 4 }), field('Grade or percentage', e, 'grade', { max: 40 })]));
        });
        var addEdu = h('button', { class: 'btn btn-sm', type: 'button' }, '+ Add education');
        addEdu.addEventListener('click', function () { draft.education.push({ school: '', degree: '', field: '', location: '', startYear: 0, endYear: 0, grade: '' }); draw(); });
        node.push(addEdu);
        node.push(h('h3', { class: 'ap-h' }, 'Skills and answers to common questions'), h('div', { class: 'ap-grid' }, [
          listText('Skills (separated by commas)', draft, 'skills', 'e.g. Tissue culture, Doubled haploid'), listText('Languages', draft, 'languages', 'e.g. English, Hindi'),
          field('Total experience', pref, 'totalExperience', { max: 40, placeholder: 'e.g. 6 years' }), field('Notice period', pref, 'noticePeriod', { max: 60, placeholder: 'e.g. 60 days' }),
          field('Current salary', pref, 'currentCtc', { max: 40 }), field('Expected salary', pref, 'expectedCtc', { max: 40 }),
          field('Work authorisation', pref, 'workAuthorization', { max: 100, placeholder: 'e.g. Indian citizen' }), field('Willing to relocate', pref, 'willingToRelocate', { max: 20, placeholder: 'Yes or No' })]));
        var saveBtn = h('button', { class: 'btn', type: 'button' }, 'Save changes');
        var confirmBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save and confirm');
        var regen = h('button', { class: 'btn btn-sm', type: 'button' }, 'Fill again from my resume (1 AI action)');
        var save = function (confirmed) {
          saveBtn.disabled = confirmBtn.disabled = true; message(out, 'Saving…');
          call('POST', '/api/career/app-profile', { profile: draft, confirm: confirmed }).then(function (d) { takeApply(d); draft = null; draw(); })
            .catch(function (e) { saveBtn.disabled = confirmBtn.disabled = false; message(out, e.message, 'bad'); });
        };
        saveBtn.addEventListener('click', function () { save(false); });
        confirmBtn.addEventListener('click', function () { save(true); });
        regen.addEventListener('click', function () {
          if (!window.confirm('Fill your profile again from your resume? Your edits will be replaced.')) return;
          regen.disabled = true; message(out, 'Reading your resume… (about 20 seconds)');
          call('POST', '/api/career/app-profile/generate').then(function (d) { takeApply(d); setUsage(d.usage); draft = null; draw(); }).catch(function (e) { regen.disabled = false; message(out, e.message, 'bad'); });
        });
        node.push(h('div', { class: 'cr-actions ap-save' }, saveBtn, confirmBtn, regen), out);
      }

      node.push(h('h3', { class: 'ap-h' }, 'Your applications (' + apply.apps.length + ')'));
      node.push(apply.apps.length ? h('div', { class: 'jb-scroll' }, h('table', { class: 'jb-table ap-table' },
        h('thead', {}, h('tr', {}, ['Company', 'Role', 'Status', ''].map(function (t) { return h('th', {}, t); }))),
        h('tbody', {}, apply.apps.map(function (a) {
          var sel = h('select', { 'aria-label': 'Status' }, [['applied', 'Applied'], ['interview', 'Interview'], ['offer', 'Offer'], ['rejected', 'Not selected']].map(function (o) { return h('option', { value: o[0] }, o[1]); }));
          sel.value = a.status;
          sel.addEventListener('change', function () { call('POST', '/api/career/applications', { url: a.url, title: a.title, company: a.company, status: sel.value }).then(function (d) { a.status = d.application.status; }); });
          var del = h('button', { class: 'btn btn-sm', type: 'button' }, 'Remove');
          del.addEventListener('click', function () { call('POST', '/api/career/applications/' + a.id + '/delete').then(function () { apply.apps = apply.apps.filter(function (x) { return x.id !== a.id; }); draw(); }); });
          return h('tr', {}, h('td', { 'data-label': 'Company' }, h('b', {}, a.company || '—')), h('td', { 'data-label': 'Role' }, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.title || 'Job')),
            h('td', { 'data-label': 'Status' }, sel), h('td', {}, del));
        })))) : h('p', { class: 'ac-muted' }, 'Jobs you mark as applied appear here, so you can keep track.'));
      body.replaceChildren.apply(body, node);
    }
    loadApply().then(draw).catch(function (e) { body.replaceChildren(h('p', { class: 'form-result bad' }, e.message)); });
    return section;
  }

  // ---------- one tab per step (the address keeps the step: career.html#cr-jobs) ----------
  var STEPS = [['cr-resume', 'Upload resume'], ['cr-ats', 'ATS check'], ['cr-versions', 'Role-based resumes'], ['cr-match', 'Job match & cover letter'], ['cr-jobs', 'AI Job search'], ['cr-apply', 'Apply']];
  var activeStep = null;
  function stepIndex(id) { for (var i = 0; i < STEPS.length; i++) if (STEPS[i][0] === id) return i; return -1; }
  /** Where to start: the step in the address, else the first one not done yet. */
  function startStep() {
    var fromHash = location.hash.slice(1) || new URLSearchParams(location.search).get('step');   // career.html#cr-jobs or ?step=cr-jobs
    if (stepIndex(fromHash) !== -1) return fromHash;
    if (!state.resume) return 'cr-resume';
    if (!state.resume.ats) return 'cr-ats';
    return 'cr-jobs';
  }
  function stepDone(id) {
    var r = state.resume;
    return id === 'cr-resume' ? !!r : id === 'cr-ats' ? !!(r && r.ats) : id === 'cr-versions' ? state.versions.length > 0 : id === 'cr-match' ? state.matches.length > 0 : id === 'cr-apply' ? !!apply.confirmedAt : false;
  }
  function showStep(id, scroll) {
    if (stepIndex(id) === -1) id = 'cr-resume';
    activeStep = id;
    STEPS.forEach(function (s) { var el = document.getElementById(s[0]); if (el) el.hidden = s[0] !== id; });
    document.querySelectorAll('.cr-steps a').forEach(function (a) {
      var target = a.getAttribute('href').slice(1);
      if (target === id) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current');
      a.classList.toggle('done', stepDone(target));
    });
    var crumb = document.getElementById('cr-crumb');
    if (crumb) crumb.textContent = (stepIndex(id) + 1) + '. ' + STEPS[stepIndex(id)][1];
    if (location.hash.slice(1) !== id || location.search) history.replaceState(null, '', location.pathname + '#' + id);
    if (scroll) document.querySelector('.cr-steps').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  goTo = function (id) { showStep(id, true); };
  document.querySelectorAll('.cr-steps a').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); showStep(a.getAttribute('href').slice(1)); });
  });
  window.addEventListener('hashchange', function () { if (stepIndex(location.hash.slice(1)) !== -1) showStep(location.hash.slice(1)); });

  /** Previous / next buttons under each step. */
  function stepNav(i) {
    var prev = STEPS[i - 1], next = STEPS[i + 1];
    return h('div', { class: 'cr-stepnav' },
      prev ? h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { showStep(prev[0], true); } }, '← ' + (i) + '. ' + prev[1]) : h('span'),
      next ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: function () { showStep(next[0], true); } }, 'Next: ' + (i + 2) + '. ' + next[1] + ' →') : null);
  }

  function render() {
    showError('');
    var cards = [resumeCard(), atsCard(), versionsCard(), matchCard(), jobsCard(), applyCard()];
    cards.forEach(function (c, i) { c.appendChild(stepNav(i)); });
    content.replaceChildren.apply(content, cards.concat([
      h('p', { class: 'ac-muted cr-privacy' }, '🔒 Your resume is private: it is used only to create your documents and is never shared. ',
        'The AI rewrites what your resume says and never adds experience you do not have, so always review documents before sending.')]));
    showStep(activeStep || startStep());
  }
  load();
})();
