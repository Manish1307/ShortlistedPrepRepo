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
          if (!r.ok) throw new Error(j.error || 'Something went wrong (' + r.status + ')');
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
    el.hidden = false;
    el.textContent = 'AI actions left today: ' + Math.max(0, u.limit - u.used) + ' of ' + u.limit;
  }
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
  var searchForm = { resume: 'all', level: '', role: '', country: 'India', city: '', companies: '', days: '', remote: true };
  var pollTimer = null, cardGen = 0;

  function ago(s) {
    if (!s) return '—';
    var d = Math.floor((Date.now() - Date.parse(s)) / 86400000);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 30 ? d + ' days ago' : new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fitBadge(n) { return h('span', { class: 'ac-badge js-fit ' + (n >= 75 ? 'good' : n >= 50 ? 'warn' : 'bad') }, String(n)); }
  function paramsLine(p) {
    return [p.role || 'Roles from my resume', [p.city, p.country].filter(Boolean).join(', ') || 'Any location', p.level, p.companies ? p.companies.split(/[\n,;]+/).filter(function (x) { return x.trim(); }).length + ' companies' : 'Well-known companies', p.resumeLabel].filter(Boolean).join(' · ');
  }

  // ---------- "Prepare for this job": gaps to a full fit, learning links, revision and interview prep ----------
  var LINK_ICON = { youtube: '▶', 'udemy-free': '🎓', 'udemy-paid': '🎓', coursera: '📘', official: '🏛', articles: '📰', cert: '🏅' };
  function linkRow(links) {
    return h('div', { class: 'pp-links' }, links.map(function (l) {
      return h('a', { class: 'pp-link ' + l.kind, href: l.url, target: '_blank', rel: 'noopener noreferrer' }, (LINK_ICON[l.kind] || '↗') + ' ' + l.label);
    }));
  }
  function prepView(p, job) {
    var reach = Math.min(100, p.fit + p.gapPoints);
    var section = function (cls, icon, title, intro, body) {
      return h('section', { class: 'pp-sec ' + cls }, h('h4', {}, h('span', { 'aria-hidden': 'true' }, icon), ' ', title), intro ? h('p', { class: 'ac-muted pp-intro' }, intro) : null, body);
    };
    return h('div', { class: 'pp' },
      h('div', { class: 'pp-head' },
        h('div', { class: 'pp-meter', role: 'img', 'aria-label': 'Fit now ' + p.fit + ', up to ' + reach + ' after closing the gaps' },
          h('i', { class: 'now', style: 'width:' + p.fit + '%' }), h('i', { class: 'gain', style: 'left:' + p.fit + '%;width:' + (reach - p.fit) + '%' })),
        h('div', { class: 'pp-scores' }, h('span', {}, 'Fit now ', h('b', {}, String(p.fit))), h('span', {}, 'After closing the gaps ', h('b', { class: 'up' }, String(reach)))),
        p.summary ? h('p', { class: 'pp-summary' }, p.summary) : null),

      h('div', { class: 'pp-grid' },
        section('gaps', '🎯', 'Close the gaps to reach ' + reach + '/100',
          p.gaps.length ? 'What this job wants that your resume does not show yet, biggest first, with where to learn it.' : null,
          p.gaps.length ? h('div', { class: 'pp-gaps' }, p.gaps.map(function (g) {
            return h('div', { class: 'pp-gap ' + g.importance },
              h('div', { class: 'pp-gap-head' }, h('b', {}, g.skill), h('span', { class: 'pp-pts' }, '+' + g.points + ' fit'),
                g.hours ? h('span', { class: 'ac-muted pp-hours' }, '~' + g.hours + ' h study') : null),
              g.why ? h('p', { class: 'pp-why' }, g.why) : null,
              g.howToClose ? h('p', { class: 'pp-how' }, h('b', {}, 'How: '), g.howToClose) : null,
              linkRow(g.links.concat(g.certification ? [{ kind: 'cert', label: g.certification.name + ' certification', url: g.certification.url }] : [])));
          })) : h('p', { class: 'ac-muted' }, 'No real gaps: you already match what this job asks for.')),

        h('div', { class: 'pp-side' },
          p.matched.length ? section('match', '✅', 'You already match', null, chips(p.matched)) : null,
          p.plan.length ? section('plan', '🗓', 'Your plan to a full fit', null, h('ol', { class: 'pp-list' }, p.plan.map(function (x) { return h('li', {}, x); }))) : null)),

      p.revise.length ? section('revise', '📚', 'Revise before the interview', 'Topics you know but should brush up for this job: videos and articles.',
        h('div', { class: 'pp-revise' }, p.revise.map(function (r) { return h('div', { class: 'pp-rev' }, h('b', {}, r.topic), linkRow(r.links)); }))) : null,

      h('div', { class: 'pp-grid two' },
        p.interviewQuestions.length ? section('questions', '🎤', 'Likely interview questions', null,
          h('ol', { class: 'pp-list' }, p.interviewQuestions.map(function (x) { return h('li', {}, x); }))) : null,
        section('help', '💡', 'More help', null, h('div', {},
          p.tips.length ? h('ul', { class: 'pp-list' }, p.tips.map(function (x) { return h('li', {}, x); })) : null,
          h('div', { class: 'pp-actions' },
            h('a', { class: 'btn btn-sm', href: '#cr-match', onclick: function (e) { e.preventDefault(); goTo('cr-match'); } }, '✉️ Write a cover letter for this job'),
            h('a', { class: 'btn btn-sm', href: '#cr-versions', onclick: function (e) { e.preventDefault(); goTo('cr-versions'); } }, '🧩 Make a resume for this role'),
            h('a', { class: 'btn btn-sm', href: 'https://www.google.com/search?q=' + encodeURIComponent(job.company + ' ' + job.title + ' interview questions'), target: '_blank', rel: 'noopener noreferrer' }, '🔎 Interview experiences at ' + job.company),
            h('a', { class: 'btn btn-sm', href: 'https://www.google.com/search?q=' + encodeURIComponent(job.title + ' salary India ' + job.company), target: '_blank', rel: 'noopener noreferrer' }, '₹ Salary for this role'))))),
      h('p', { class: 'ac-muted pp-note' }, 'Links open a search on YouTube, Udemy, Coursera, official documentation and article sites, so you always see current material. Prepared ' + dateTime(p.createdAt) + '.'));
  }
  function prepRow(searchId, job, cols) {
    var cell = h('td', { colspan: String(cols), class: 'pp-cell' });
    var row = h('tr', { class: 'pp-row' }, cell);
    function load() {
      if (job.prep) { cell.replaceChildren(prepView(job.prep, job)); return; }
      var status = h('p', { class: 'js-status busy' }, h('span', { class: 'js-status-in' }, h('span', { class: 'js-spin', 'aria-hidden': 'true' }), h('span', {}, 'Finding your skill gaps and the best ways to learn them… (about 20 seconds)')));
      cell.replaceChildren(status);
      call('POST', '/api/career/jobsearch/' + searchId + '/prep', { jobId: job.id }).then(function (d) {
        job.prep = d.prep; setUsage(d.usage); cell.replaceChildren(prepView(d.prep, job));
      }).catch(function (e) {
        var retry = h('button', { class: 'btn btn-sm', type: 'button', onclick: load }, 'Try again');
        cell.replaceChildren(h('p', { class: 'form-result bad' }, e.message, ' ', retry));
      });
    }
    return { row: row, load: load };
  }

  function groupTable(list, withResume, startAt, searchId) {
    var head = ['#', 'Role', 'Company', 'Location', 'Posted', 'Fit', 'Why / gap'].concat(withResume ? ['Send'] : []).concat(['']);
    return h('div', { class: 'jb-scroll' }, h('table', { class: 'jb-table js-table' },
      h('thead', {}, h('tr', {}, head.map(function (t) { return h('th', {}, t); }))),
      h('tbody', {}, list.map(function (j, i) {
        var prep = null;
        var toggle = h('button', { class: 'btn btn-sm pp-toggle' + (j.prep ? ' ready' : ''), type: 'button', 'aria-expanded': 'false' }, j.prep ? '📘 Prepare ▾' : '📘 Prepare');
        toggle.addEventListener('click', function () {
          var row = toggle.closest('tr');
          if (prep && prep.row.parentNode) { prep.row.remove(); toggle.setAttribute('aria-expanded', 'false'); return; }
          prep = prep || prepRow(searchId, j, head.length);
          row.parentNode.insertBefore(prep.row, row.nextSibling);
          toggle.setAttribute('aria-expanded', 'true');
          prep.load();
        });
        return h('tr', {},
          h('td', { class: 'js-num', 'data-label': '#' }, String(startAt + i + 1)),
          h('td', { 'data-label': 'Role' }, h('b', {}, j.title)),
          h('td', { 'data-label': 'Company' }, j.company),
          h('td', { 'data-label': 'Location' }, j.location || j.country || '—'),
          h('td', { 'data-label': 'Posted', title: j.postedAt ? new Date(j.postedAt).toLocaleString() : '' }, ago(j.postedAt)),
          h('td', { 'data-label': 'Fit' }, fitBadge(j.score)),
          h('td', { 'data-label': 'Why' }, j.why ? h('div', { class: 'jb-reason' }, j.why) : null,
            j.gap && !/^none\.?$/i.test(j.gap) ? h('div', { class: 'jb-gap' }, 'Gap: ' + j.gap) : null),
          withResume ? h('td', { 'data-label': 'Send' }, j.resume || '—') : null,
          h('td', { class: 'jb-open' }, h('a', { class: 'btn btn-primary btn-sm', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Apply ↗'), toggle));
      }))));
  }

  function searchResult(s) {
    var r = s.result, p = r.profile, cov = r.coverage;
    var withResume = s.params.resume === 'all';
    var n = 0;
    var notes = [];
    if (cov.notFound.length) notes.push('Could not find the careers site of: ' + cov.notFound.join(', ') + '. Paste the link of their careers page instead.');
    if (cov.notSupported.length) notes.push('These careers sites cannot be read yet: ' + cov.notSupported.join(', ') + '. Sites on Greenhouse, Lever, SmartRecruiters, Ashby and Workday work.');
    if (cov.failed.length) notes.push('These careers sites did not answer: ' + cov.failed.join(', ') + '. Try again later.');
    if (cov.loading) notes.push(cov.loading + ' careers site' + (cov.loading === 1 ? ' was' : 's were') + ' still loading. Search again in a few minutes to include them.');
    if (r.jobs.length < 20) notes.push('Fewer than 20 matches: try a wider location, another role, a longer date range or more companies.');
    return h('div', { class: 'js-result' },
      h('div', { class: 'js-profile' },
        h('div', { class: 'ac-subhead' }, 'Your profile'),
        p.level ? h('p', { class: 'js-level' }, h('b', {}, 'Level: '), p.level) : null,
        p.summary ? h('p', {}, p.summary) : null,
        p.strengths.length ? h('div', { class: 'js-line' }, h('span', { class: 'ac-muted' }, 'Strongest areas: '), chips(p.strengths)) : null,
        p.targetRoles.length ? h('div', { class: 'js-line' }, h('span', { class: 'ac-muted' }, 'Best-fit roles: '), chips(p.targetRoles.map(function (t, i) { return (i + 1) + '. ' + t; }))) : null),
      h('p', { class: 'jb-info' }, r.jobs.length + ' matches from ' + cov.live.toLocaleString() + ' live jobs at ' + cov.companies + ' compan' + (cov.companies === 1 ? 'y' : 'ies') +
        ' · searched ' + dateTime(s.finishedAt) + ' · ' + paramsLine(s.params)),
      GROUPS.map(function (g) {
        var list = r.jobs.filter(function (j) { return j.bucket === g[0]; });
        if (!list.length) return null;
        var block = h('div', { class: 'js-group ' + g[0] },
          h('div', { class: 'js-group-head' }, h('h3', {}, g[1] + ' (' + list.length + ')'), h('span', { class: 'ac-muted' }, g[2])),
          groupTable(list, withResume, n, s.id));
        n += list.length;
        return block;
      }),
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
    var role = bind(h('input', { type: 'text', maxlength: '120', placeholder: 'Role or keywords, e.g. Power Platform, Project Manager (optional)', 'aria-label': 'Role or keywords' }), 'role');
    var country = bind(h('input', { type: 'text', maxlength: '80', list: 'js-countries', placeholder: 'Country, e.g. India', 'aria-label': 'Country' }), 'country');
    var city = bind(h('input', { type: 'text', maxlength: '80', placeholder: 'City, e.g. Noida (optional)', 'aria-label': 'City' }), 'city');
    var companies = bind(h('textarea', { rows: '2', maxlength: '4000', 'aria-label': 'Companies',
      placeholder: 'Companies (optional): names or careers-page links, separated by commas. e.g. Mastercard, Bosch, https://jobs.lever.co/acme' }), 'companies');
    var days = bind(h('select', { 'aria-label': 'Posted within' }, [['', 'Posted: any time'], ['7', 'Posted: last 7 days'], ['14', 'Posted: last 14 days'], ['30', 'Posted: last 30 days']].map(function (o) { return h('option', { value: o[0] }, o[1]); })), 'days');
    var remote = bind(h('input', { type: 'checkbox', id: 'js-remote' }), 'remote', 'check');
    var run = h('button', { class: 'btn btn-primary js-run', type: 'button', disabled: !state.resume }, '✦ Search jobs with AI');
    var hint = h('p', { class: 'ac-muted js-small' }, 'Leave "Companies" empty to search well-known companies hiring in India and worldwide.');

    function setRunning(on) { run.disabled = on || !state.resume; run.textContent = on ? 'Searching…' : '✦ Search jobs with AI'; }
    function showStatus(text, kind) {
      status.className = 'js-status' + (kind ? ' ' + kind : '');
      status.replaceChildren();
      if (text) status.appendChild(h('span', { class: 'js-status-in' }, kind === 'busy' ? h('span', { class: 'js-spin', 'aria-hidden': 'true' }) : null, h('span', {}, text)));
    }
    function poll(id) {
      clearTimeout(pollTimer);
      if (gen !== cardGen) return;
      call('GET', '/api/career/jobsearch/' + id).then(function (d) {
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
        searches = d.searches;
        if (d.builtInCompanies) hint.textContent = 'Leave "Companies" empty to search ' + d.builtInCompanies + ' well-known companies hiring in India and worldwide.';
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
          h('div', { class: 'js-row two' }, resumeSel, levelSel),
          h('div', { class: 'js-row three' }, role, country, city),
          companies,
          h('div', { class: 'js-row actions' }, days, h('label', { class: 'js-check', for: 'js-remote' }, remote, ' Include remote jobs'), run)),
        hint, status, result, history));
  }

  // ---------- one tab per step (the address keeps the step: career.html#cr-jobs) ----------
  var STEPS = [['cr-resume', 'Upload resume'], ['cr-ats', 'ATS check'], ['cr-versions', 'Role-based resumes'], ['cr-match', 'Job match & cover letter'], ['cr-jobs', 'AI Job search']];
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
    return id === 'cr-resume' ? !!r : id === 'cr-ats' ? !!(r && r.ats) : id === 'cr-versions' ? state.versions.length > 0 : id === 'cr-match' ? state.matches.length > 0 : false;
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
    var cards = [resumeCard(), atsCard(), versionsCard(), matchCard(), jobsCard()];
    cards.forEach(function (c, i) { c.appendChild(stepNav(i)); });
    content.replaceChildren.apply(content, cards.concat([
      h('p', { class: 'ac-muted cr-privacy' }, '🔒 Your resume is private: it is used only to create your documents and is never shared. ',
        'The AI rewrites what your resume says and never adds experience you do not have, so always review documents before sending.')]));
    showStep(activeStep || startStep());
  }
  load();
})();
