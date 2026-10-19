/* ShortlistPrep Autofill: the fill engine.
 * Reads a page's form fields, works out what each one asks for, and fills it from the candidate's checked application
 * profile. It handles the three kinds of page a company portal shows: create account, sign in, and the application
 * itself (several steps, with repeating "Work experience" and "Education" entries that have an "Add" button).
 *
 * It never fills a password, never presses Submit, and never touches a field that already has a value.
 * Plain browser JavaScript with no dependencies, so the same file runs in the extension and in a test page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SPFill = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var MAX_ROWS = { work: 15, edu: 8 };

  // ---------- what does a field ask for? ----------
  // [key, pattern, not]: the first rule whose pattern matches the field's label text (and whose "not" does not) wins.
  var RULES = [
    ['current', /(currently|still)\s*(work|employ|study)|current(ly)?\s*(job|role|position|employer)|work here|till date|present\b/, null],
    ['company', /(company|employer|organi[sz]ation)(\s*name)?\b|current employer/, /email|website|size|type|industry/],
    ['school', /school|college|university|institut(e|ion)/, /email|website/],
    ['field', /field of study|major\b|specia?li[sz]ation|discipline|stream|course name/, null],
    ['degree', /degree|qualification|education level|level of education/, null],
    ['grade', /\bgpa\b|cgpa|percentage|grade|marks|score/, null],
    ['job_title', /job\s*title|position title|designation|current title|role title|current role|your title/, null],
    ['responsibilities', /responsibilit|role description|job description|duties|what did you do|work summary|description/, /company|school/],
    ['first_name', /(first|given|fore)[\s_-]*name|\bfname\b/, null],
    ['last_name', /(last|sur|family)[\s_-]*name|\blname\b/, null],
    ['email', /e-?mail/, null],
    ['phone', /phone|mobile|contact number|telephone|\btel\b/, /country code|extension|device|type|code/],
    ['linkedin', /linkedin/, null],
    ['github', /github/, null],
    ['website', /website|portfolio|personal site|\bblog\b|web\s*address/, null],
    ['postal', /\bzip\b|postal|pin\s*code|postcode/, null],
    ['city', /\bcity\b|\btown\b/, null],
    ['state', /\bstate\b|province/, /united/],
    ['country', /country/, /code|phone/],
    ['address', /address|street/, /e-?mail|web/],
    ['notice', /notice/, null],
    ['exp_total', /total (work )?experience|years of (work )?experience|experience in years|how many years/, null],
    ['ctc_current', /current (ctc|salary|compensation|package)/, null],
    ['ctc_expected', /expected (ctc|salary|compensation|package)|desired (salary|compensation)|salary expectation/, null],
    ['authorization', /authori[sz]ation|eligible to work|work permit|right to work|\bvisa\b/, null],
    ['relocate', /relocat/, null],
    ['summary', /professional summary|about (you|yourself)|profile summary|\bsummary\b/, null],
    ['location', /location|place of work/, null],
    ['start', /\b(start(ing)?|from|begin(ning)?|joining|joined)\b/, null],
    ['end', /\b(end(ing)?|to|until|leaving|left)\b/, null],
    ['full_name', /full[\s_-]*name|your name|candidate name|applicant name|legal name|^name\b|\bname$/, /company|school|file|user/],
  ];
  var WORK_KEYS = { company: 1, job_title: 1, responsibilities: 1 }, EDU_KEYS = { school: 1, field: 1, degree: 1, grade: 1 };
  var PERSONAL_KEYS = { first_name: 1, last_name: 1, full_name: 1, email: 1, phone: 1, city: 1, state: 1, country: 1, postal: 1, address: 1, linkedin: 1, github: 1, website: 1 };

  function text(el) { return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim(); }

  /** Everything a person would read to know what the field is for, lower-cased. */
  function signature(el) {
    var doc = el.ownerDocument, parts = [];
    var push = function (v) { if (v) parts.push(String(v)); };
    push(el.getAttribute('aria-label'));
    var by = el.getAttribute('aria-labelledby');
    if (by) by.split(/\s+/).forEach(function (id) { var n = doc.getElementById(id); if (n) push(text(n)); });
    if (el.id) { var l = doc.querySelector('label[for="' + String(el.id).replace(/"/g, '\\"') + '"]'); if (l) push(text(l)); }
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap) push(text(wrap).slice(0, 120));
    push(el.getAttribute('placeholder'));
    push(el.getAttribute('autocomplete'));
    push(el.getAttribute('data-automation-id'));
    push(el.getAttribute('data-qa'));
    push(el.name); push(el.id);
    if (parts.length < 3) {            // fall back on the text just before the field
      var p = el.parentElement;
      for (var i = 0; i < 3 && p; i++, p = p.parentElement) {
        var t = text(p);
        if (t && t.length < 80) { push(t); break; }
      }
    }
    return parts.join(' ').toLowerCase().replace(/[_\-./]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  function classify(sig) {
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (r[1].test(sig) && !(r[2] && r[2].test(sig))) return r[0];
    }
    return null;
  }

  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    var s = el.ownerDocument.defaultView.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  /** Every field on the page we may fill, in page order, each with what it asks for. */
  function scan(doc) {
    var out = [];
    var els = doc.querySelectorAll('input, textarea, select');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'search', 'radio', 'range', 'color'].indexOf(type) !== -1) continue;
      if (!visible(el)) continue;
      var sig = signature(el);
      var key = classify(sig);
      if (type === 'checkbox' && key !== 'current') continue;
      if (type !== 'checkbox' && key === 'current') key = null;
      if (!key) continue;
      var comp = /\bmonth\b/.test(sig) ? 'month' : /\byear\b/.test(sig) ? 'year' : null;
      out.push({ el: el, key: key, sig: sig, type: type, tag: el.tagName.toLowerCase(), comp: comp, section: null, index: -1 });
    }
    return out;
  }

  /** The nearest heading text above an element (used when a field is not inside its own entry). */
  function headingAbove(el) {
    for (var node = el, hops = 0; node && hops < 12; node = node.parentElement, hops++) {
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        var t = text(sib);
        if (/^h[1-6]$/i.test(sib.tagName) || sib.getAttribute('role') === 'heading' || sib.tagName === 'LEGEND' || (t && t.length < 60 && /(experience|employment|education|academic|qualification|work history)/i.test(t))) return t.toLowerCase();
      }
    }
    return '';
  }
  function sectionFromText(t) { return /education|academic|qualification|school|degree/.test(t) ? 'edu' : /experience|employ|work history|job|position|company/.test(t) ? 'work' : null; }

  /**
   * Group the fields into entries: each "company" field starts a job and each "school" field starts an education entry;
   * the entry is the smallest block around it that holds no other entry's fields and nothing from another section.
   */
  function group(fields) {
    var anchors = { work: fields.filter(function (f) { return f.key === 'company'; }), edu: fields.filter(function (f) { return f.key === 'school'; }) };
    var other = { work: function (f) { return EDU_KEYS[f.key] || PERSONAL_KEYS[f.key]; }, edu: function (f) { return WORK_KEYS[f.key] || PERSONAL_KEYS[f.key] || f.key === 'company'; } };
    var boxes = { work: [], edu: [] };
    ['work', 'edu'].forEach(function (sec) {
      anchors[sec].forEach(function (a) {
        var best = a.el.parentElement, node = best;
        while (node && node.parentElement && node !== a.el.ownerDocument.body) {
          var inside = fields.filter(function (f) { return node.contains(f.el); });
          var anotherAnchor = inside.some(function (f) { return f !== a && f.key === (sec === 'work' ? 'company' : 'school'); });
          var foreign = inside.some(other[sec]);
          if (anotherAnchor || foreign) break;
          best = node; node = node.parentElement;
        }
        boxes[sec].push({ anchor: a, box: best });
      });
    });
    fields.forEach(function (f) {
      ['work', 'edu'].forEach(function (sec) {
        boxes[sec].forEach(function (b, i) { if (!f.section && b.box.contains(f.el)) { f.section = sec; f.index = i; } });
      });
      if (!f.section && (WORK_KEYS[f.key] || EDU_KEYS[f.key])) { f.section = WORK_KEYS[f.key] ? 'work' : 'edu'; f.index = 0; }
      if (!f.section && ['location', 'start', 'end', 'current', 'responsibilities'].indexOf(f.key) !== -1) {
        // a loose date or location: which section is it under?
        f.section = sectionFromText(headingAbove(f.el)); f.index = f.section ? 0 : -1;
      }
    });
    return { fields: fields, counts: { work: boxes.work.length, edu: boxes.edu.length } };
  }

  // ---------- what page is this? ----------
  function pageKind(doc, fields) {
    var pw = Array.prototype.filter.call(doc.querySelectorAll('input[type="password"]'), visible);
    var t = String(doc.body.innerText || '').replace(/\s+/g, ' ').slice(0, 4000).toLowerCase();   // what a person sees (not script text)
    if (pw.length >= 2 || (pw.length === 1 && /(create|new|register|sign up|signup).{0,20}(account|password)/.test(t) && !/forgot/.test(t.slice(0, 200)))) return 'signup';
    if (pw.length === 1) return 'login';
    return fields.length ? 'application' : 'other';
  }

  // ---------- values ----------
  function monthName(m) { return m ? MONTHS[m - 1] : ''; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateText(el, m, y) {
    if (!y) return '';
    var hint = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('pattern') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'month') return m ? y + '-' + pad(m) : '';
    if (type === 'date') return y + '-' + pad(m || 1) + '-01';
    if (/dd\s*[\/.-]\s*mm\s*[\/.-]\s*y/.test(hint)) return pad(1) + '/' + pad(m || 1) + '/' + y;
    if (/mm\s*[\/.-]\s*dd/.test(hint)) return pad(m || 1) + '/01/' + y;
    if (/yyyy\s*-\s*mm/.test(hint)) return m ? y + '-' + pad(m) : String(y);
    if (/month yyyy|mmm yyyy|month year/.test(hint)) return m ? monthName(m).replace(/^./, function (c) { return c.toUpperCase(); }) + ' ' + y : String(y);
    if (/mm\s*[\/.-]\s*y/.test(hint) || !hint) return m ? pad(m) + '/' + y : String(y);
    return m ? pad(m) + '/' + y : String(y);
  }
  /** The value for one field. "profile" is the application profile; f.index picks the job or education entry. */
  function valueFor(f, profile) {
    var per = profile.personal || {}, pref = profile.preferences || {};
    var job = f.section === 'work' ? (profile.work || [])[f.index] : null;
    var edu = f.section === 'edu' ? (profile.education || [])[f.index] : null;
    switch (f.key) {
      case 'first_name': return per.firstName;
      case 'last_name': return per.lastName;
      case 'full_name': return per.fullName;
      case 'email': return per.email;
      case 'phone': return per.phone;
      case 'city': return per.city; case 'state': return per.state; case 'country': return per.country;
      case 'postal': return per.postalCode; case 'address': return per.address;
      case 'linkedin': return per.linkedin; case 'github': return per.github; case 'website': return per.portfolio;
      case 'summary': return f.section ? '' : profile.summary;
      case 'notice': return pref.noticePeriod; case 'exp_total': return pref.totalExperience;
      case 'ctc_current': return pref.currentCtc; case 'ctc_expected': return pref.expectedCtc;
      case 'authorization': return pref.workAuthorization; case 'relocate': return pref.willingToRelocate;
      case 'company': return job && job.company;
      case 'job_title': return job && job.title;
      case 'responsibilities': return job && job.responsibilities;
      case 'location': return job ? job.location : edu ? edu.location : per.city;
      case 'school': return edu && edu.school;
      case 'degree': return edu && edu.degree;
      case 'field': return edu && edu.field;
      case 'grade': return edu && edu.grade;
      case 'current': return job ? !!job.current : undefined;
      case 'start':
        if (job) return f.comp === 'year' ? job.startYear : f.comp === 'month' ? job.startMonth : { m: job.startMonth, y: job.startYear };
        if (edu) return edu.startYear ? (f.comp === 'month' ? 0 : edu.startYear) : '';
        return undefined;
      case 'end':
        if (job) { if (job.current) return ''; return f.comp === 'year' ? job.endYear : f.comp === 'month' ? job.endMonth : { m: job.endMonth, y: job.endYear }; }
        if (edu) return edu.endYear ? (f.comp === 'month' ? 0 : edu.endYear) : '';
        return undefined;
    }
    return undefined;
  }

  // ---------- writing into a field ----------
  function setNative(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype : el.ownerDocument.defaultView.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;   // works with React-style controlled inputs
  }
  function fire(el) {
    ['input', 'change', 'blur'].forEach(function (name) { el.dispatchEvent(new el.ownerDocument.defaultView.Event(name, { bubbles: true })); });
  }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  function pickOption(select, want, f) {
    var opts = Array.prototype.slice.call(select.options).filter(function (o) { return !o.disabled && o.value !== '' || o.text.trim() !== ''; });
    var w = norm(want), found = null;
    if (f.comp === 'month' || /^\d{1,2}$/.test(String(want)) && f.comp !== 'year') {
      var m = Number(want);
      found = opts.filter(function (o) { var t = norm(o.text), v = norm(o.value); return t === monthName(m) || t === monthName(m).slice(0, 3) || Number(o.value) === m && /^\d+$/.test(o.value.trim()) || /^\d+$/.test(t) && Number(t) === m; })[0];
    } else if (f.comp === 'year') {
      found = opts.filter(function (o) { return norm(o.text) === w || norm(o.value) === w; })[0];
    } else {
      found = opts.filter(function (o) { return norm(o.text) === w || norm(o.value) === w; })[0]
        || opts.filter(function (o) { var t = norm(o.text); return t && w && (t.indexOf(w) !== -1 || w.indexOf(t) !== -1) && t.length > 2; })[0];
    }
    if (!found) return false;
    select.value = found.value;
    fire(select);
    return true;
  }

  /** Fill one field. Returns true when something was written. */
  function writeField(f, profile) {
    var el = f.el, v = valueFor(f, profile);
    if (v === undefined || v === null) return false;
    if (f.type === 'checkbox') {
      var want = !!v;
      if (el.checked !== want) el.click();
      return true;
    }
    if (typeof v === 'object') {                 // a start or end date, to fill as text
      v = dateText(el, v.m, v.y);
    }
    if (v === '' || v === 0) return false;
    v = String(v);
    if (f.tag === 'select') return pickOption(el, v, f);
    if (String(el.value || '').trim()) return false;                 // never overwrite what is already there
    if (el.maxLength > 0 && v.length > el.maxLength) {
      if (f.key === 'phone') v = v.replace(/\D/g, '').slice(-el.maxLength);
      else v = v.slice(0, el.maxLength);
    }
    if (f.type === 'number' && !/^\d+(\.\d+)?$/.test(v)) return false;
    setNative(el, v);
    fire(el);
    return true;
  }

  // ---------- "Add another" for repeating entries ----------
  function addButtons(doc) {
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll('button, a, [role="button"]'), function (b) {
      var t = (b.getAttribute('aria-label') || text(b)).replace(/^\+\s*/, '').trim();
      if (!t || t.length > 40 || !/^add\b/i.test(t) || !visible(b)) return;
      var sec = sectionFromText(t.toLowerCase()) || sectionFromText(headingAbove(b));
      if (sec) out.push({ el: b, section: sec });
    });
    return out;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /** Click the section's "Add" button until the form has a row for every job and education entry in the profile. */
  async function ensureRows(doc, profile, report) {
    for (var sec in MAX_ROWS) {
      var need = Math.min(((sec === 'work' ? profile.work : profile.education) || []).length, MAX_ROWS[sec]);
      for (var tries = 0; tries < need; tries++) {
        var have = group(scan(doc)).counts[sec];
        if (have >= need) break;
        var btn = addButtons(doc).filter(function (b) { return b.section === sec; })[0];
        if (!btn) { report.notes.push('Could not find an "Add" button for ' + (sec === 'work' ? 'work experience' : 'education') + '. Add the rows yourself, then press Fill again.'); break; }
        btn.el.click();
        var grew = false;
        for (var i = 0; i < 20 && !grew; i++) { await wait(150); grew = group(scan(doc)).counts[sec] > have; }
        if (!grew) break;
        report.added[sec]++;
      }
    }
  }

  // ---------- the whole thing ----------
  /** What is on the page right now (no changes made). */
  function analyze(doc) {
    var g = group(scan(doc));
    return { kind: pageKind(doc, g.fields), fields: g.fields.length, counts: g.counts, hasPassword: !!doc.querySelector('input[type="password"]') };
  }

  /** Fill the page from the profile. */
  async function fillPage(doc, profile, opts) {
    opts = opts || {};
    var report = { kind: 'other', filled: 0, skipped: 0, added: { work: 0, edu: 0 }, notes: [], rows: { work: 0, edu: 0 } };
    var kind = analyze(doc).kind;
    report.kind = kind;
    if (kind === 'application' || kind === 'other') await ensureRows(doc, profile, report);
    var g = group(scan(doc));
    report.rows = g.counts;
    // on sign-up and sign-in pages only the identity fields are filled: never anything else, never a password
    var onlyIdentity = kind === 'signup' || kind === 'login';
    g.fields.forEach(function (f) {
      if (onlyIdentity && ['email', 'first_name', 'last_name', 'full_name', 'phone'].indexOf(f.key) === -1) return;
      if (opts.done && opts.done.has(f.el)) return;
      var ok = false;
      try { ok = writeField(f, profile); } catch (e) { ok = false; }
      if (ok) {
        report.filled++;
        if (opts.done) opts.done.add(f.el);
        f.el.setAttribute('data-sp-filled', '1');
        if (f.el.style) { f.el.style.boxShadow = '0 0 0 2px #1f9d63'; }
      } else report.skipped++;
    });
    if (kind === 'signup') report.notes.push('Passwords are never filled. Choose a strong one and let your browser save it.');
    if ((profile.work || []).length > report.rows.work && g.counts.work) report.notes.push('The form has ' + report.rows.work + ' work row(s) for your ' + profile.work.length + ' jobs. Add the others yourself.');
    return report;
  }

  return { analyze: analyze, fillPage: fillPage, scan: scan, group: group, classify: classify, signature: signature, pageKind: pageKind, dateText: dateText, valueFor: valueFor };
});
