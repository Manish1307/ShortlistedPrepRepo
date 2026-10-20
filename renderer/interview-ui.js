// Mock interview window: set up -> questions one by one (spoken answer or typed) -> feedback per answer -> report.
// Everything shown is inserted as TEXT (never as HTML): nothing the AI writes can inject markup into the page.
(function () {
  'use strict';
  const api = window.interviewAPI;
  const $ = id => document.getElementById(id);
  const B = window.Brand;
  /** A heading with an icon in front of its text. */
  const heading = (name, text) => { const h = document.createElement('h3'); h.append(B.icon(name), document.createTextNode(text)); return h; };

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  let introActive = false;   // practising "Tell me about yourself"
  function show(view) { ['viewSetup', 'viewSet', 'viewInterview', 'viewReport'].forEach(v => $(v).classList.toggle('hidden', v !== view)); if (view !== 'viewInterview') introActive = false; window.scrollTo(0, 0); }
  function banner(text, kind) { const b = $('banner'); b.textContent = text || ''; b.className = 'banner' + (kind === 'info' ? ' info' : '') + (text ? '' : ' hidden'); }
  function chip(id, kind, text) { const c = $(id); c.className = 'chip ' + kind; c.lastChild.textContent = text; }
  const scoreClass = s => (s >= 7 ? 'good' : s >= 5 ? 'mid' : 'bad');
  const fmtTime = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  let info = null;
  let speech = { state: 'starting' };
  const setup = { company: 'Any', role: '', round: 'technical', level: 'junior', count: 5, focus: '', speak: true, followups: true };
  let items = [];          // finished questions: { question, topic, points, answer, seconds, skipped, followUpOf, score, verdict, ... }
  let queue = [];          // questions still to ask
  let current = null;      // the question on screen
  let asked = [];          // every question asked in this app session (so "Practise again" gets new ones)
  let startedAt = null;
  let busy = false;
  let mode = 'generic';    // 'generic': a company, role and round | 'resume': questions made from the candidate's own resume
  let resumeSet = null;    // the personalised question set on screen
  const isLicensed = () => !!(info && info.licence && info.licence.state === 'active');

  // ---- setup ---------------------------------------------------------------------------------------

  function segmented(host, options, key) {
    host.textContent = '';
    for (const [value, label] of Object.entries(options)) {
      const b = el('button', value === setup[key] ? 'on' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => { setup[key] = value; [...host.children].forEach(c => c.classList.toggle('on', c === b)); });
      host.appendChild(b);
    }
  }

  function readSetup() {
    setup.company = $('company').value;
    setup.role = $('role').value.trim();
    setup.count = Number($('count').value) || 5;
    setup.focus = $('focus').value.trim();
    setup.speak = $('speak').checked;
    setup.followups = $('followups').checked;
  }

  function paintChips() {
    if (info) chip('aiChip', isLicensed() && info.hasKey ? 'ok' : 'bad', !isLicensed() ? 'Licence needed' : info.hasKey ? `AI: ${info.provider}` : 'AI: not ready');
    const s = { ready: ['ok', 'Voice answers on'], starting: ['warn', 'Voice: loading…'], missing: ['warn', 'Voice: type answers'], error: ['bad', 'Voice: unavailable'] }[speech.state] || ['warn', 'Voice'];
    chip('speechChip', s[0], s[1]);
    $('btnMic').disabled = speech.state !== 'ready' || busy;
    $('micHint').textContent = speech.state === 'ready' ? '' : speech.message || '';
  }

  // ---- interview -------------------------------------------------------------------------------------

  const LICENCE_TEXT = {
    checking: 'Checking your ClassCue licence…',
    none: 'Mock Interview needs a ClassCue licence. Enter your licence key to activate this computer.',
    expired: 'Your licence has expired. Renew it, or enter a new licence key.',
    revoked: 'This licence has been cancelled. Please contact support, or enter another licence key.',
    removed: 'This computer was removed from the licence. Enter the key again to activate it.',
    'check-needed': 'The licence could not be checked for a while. Connect to the internet and press "Check again".',
  };
  function applyLicence(l) {
    if (l) info.licence = l;
    const lic = info.licence || { state: 'checking' };
    const gate = $('gate');
    gate.classList.toggle('hidden', isLicensed());
    if (!isLicensed()) {
      $('gateMsg').textContent = lic.message || LICENCE_TEXT[lic.state] || 'Mock Interview needs an active licence.';
      $('gateKey').parentElement.classList.toggle('hidden', lic.state === 'checking');
      $('gateActivate').classList.toggle('hidden', lic.state === 'check-needed');
    }
    paintChips();
    if (isLicensed() && mode !== 'generic') loadResumes();
  }
  async function activateLicence() {
    const key = $('gateKey').value.trim().toUpperCase();
    $('gateErr').textContent = '';
    if (!/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) { $('gateErr').textContent = 'A licence key looks like CC-XXXX-XXXX-XXXX.'; return; }
    $('gateActivate').disabled = true;
    const slot = el('div'); slot.id = 'gatePg'; $('gate').appendChild(slot);
    B.progress(slot, { title: 'Checking your licence', expectedSec: 6, compact: true });
    try {
      const res = await api.activateLicence(key);
      if (!res) return;
      if (!res.ok) $('gateErr').textContent = res.message || 'The key was not accepted.';
      else { $('gateKey').value = ''; info = await api.info(); }
      applyLicence(res.licence);
    } finally { $('gateActivate').disabled = false; slot.remove(); }
  }
  async function checkLicence() {
    $('gateErr').textContent = '';
    const slot = el('div'); slot.id = 'gatePg'; $('gate').appendChild(slot);
    B.progress(slot, { title: 'Checking your licence', expectedSec: 6, compact: true });
    const l = await api.checkLicence();
    info = await api.info();
    slot.remove();
    applyLicence(l);
    if (!isLicensed()) $('gateErr').textContent = 'Still not active.';
  }

  // ---- questions made from the candidate's resume -------------------------------------------------------

  function setMode(next) {
    mode = next;
    [...$('modes').children].forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    $('genericForm').classList.toggle('hidden', mode !== 'generic');
    $('resumeForm').classList.toggle('hidden', mode !== 'resume');
    $('introForm').classList.toggle('hidden', mode !== 'intro');
    $('genericNote').classList.toggle('hidden', mode !== 'generic');
    $('btnStart').textContent = mode === 'resume' ? 'Get my personalised questions →' : mode === 'intro' ? 'Start: Tell me about yourself →' : 'Start interview →';
    banner('');
    if (mode !== 'generic' && isLicensed()) loadResumes();
  }

  let resumesLoaded = false;
  async function loadResumes() {
    if (resumesLoaded) return;
    const sel = $('resume');
    sel.textContent = '';
    sel.appendChild(el('option', '', 'Loading your resumes…'));
    const pgR = B.progress($('pgHost'), { title: 'Loading your resumes', expectedSec: 4, compact: true });
    const res = await api.resumes();
    pgR.stop();
    if (!res || !res.ok) { sel.textContent = ''; sel.appendChild(el('option', '', 'Could not load your resumes')); banner(res ? res.message : 'Could not load your resumes.'); return; }
    resumesLoaded = true;
    sel.textContent = '';
    if (!res.resumes.length) {
      sel.appendChild(el('option', '', 'No resume yet'));
      banner('You have no resume yet. Upload it in the Career toolkit on the website (step 1), then come back here.');
    } else res.resumes.forEach(r => { const o = el('option', '', r.label); o.value = r.key; sel.appendChild(o); });
    $('introResume').replaceChildren(...[...$('resume').options].map(o => o.cloneNode(true)));
    const prev = $('prevSets');
    prev.textContent = '';
    prev.classList.toggle('hidden', !res.sets.length);
    if (res.sets.length) {
      prev.appendChild(el('h3', '', 'Your earlier question sets'));
      res.sets.forEach(x => {
        const b = el('button');
        b.type = 'button';
        b.appendChild(document.createTextNode(`${x.resumeLabel}${x.role ? ' · ' + x.role : ''}`));
        b.appendChild(el('small', '', `${new Date(x.createdAt).toLocaleString()} · ${x.count} questions`));
        b.addEventListener('click', async () => {
          const r = await api.getSet(x.id);
          if (!r || !r.ok) { banner(r ? r.message : 'Could not open this set.'); return; }
          banner(''); showSet(r.set);
        });
        prev.appendChild(b);
      });
    }
  }

  async function makeResumeSet() {
    if (!$('resume').value) { banner('Choose a resume first.'); return; }
    banner('');
    $('btnStart').disabled = true;
    const pg = B.progress($('pgHost'), { title: 'Making your personalised questions', expectedSec: 35, stages: ['Reading your resume', 'Writing your questions', 'Checking the answers'] });
    const res = await api.makeSet({ resumeKey: $('resume').value, role: $('resumeRole').value.trim() });
    $('btnStart').disabled = false;
    if (!res || !res.ok) { pg.stop(); banner(res ? res.message : 'Could not make the questions.'); return; }
    pg.done('Your questions are ready');
    resumesLoaded = false;   // the new set is in the list next time
    showSet(res.set);
  }

  const SET_GROUPS = [['personal', 'Questions from your resume', 'About things your resume says: your projects, tools and results.'], ['scenario', 'Scenario-based questions', 'Situations your roles would meet. Say what you would do, step by step.']];

  /** An answer behind a "Show answer" button. inline: under the interview question instead of in a list. */
  function answerBlock(q, inline) {
    const box = el('div', 'answerBox' + (inline ? ' inline' : '') + ' hidden');
    box.appendChild(el('div', '', q.answer));
    if (q.points && q.points.length) { const ul = el('ul'); q.points.forEach(p => ul.appendChild(el('li', '', p))); box.appendChild(ul); }
    return box;
  }
  function toggleButton(box, inline) {
    const b = el('button', 'btn ghost sm reveal' + (inline ? ' inline' : ''));
    B.setButton(b, 'eye', 'Show answer');
    b.type = 'button';
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => {
      const open = box.classList.contains('hidden');
      box.classList.toggle('hidden', !open);
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      B.setButton(b, open ? 'eye-off' : 'eye', open ? 'Hide answer' : 'Show answer');
    });
    return b;
  }

  function showSet(set) {
    resumeSet = set;
    $('setTitle').textContent = 'Your personalised questions';
    $('setSub').textContent = `${set.questions.length} questions made only from "${set.resumeLabel}"${set.role ? ' for ' + set.role : ''}. Saved to your ClassCue account. Read them, open the answers, or practise them with the interviewer.`;
    const list = $('setList');
    list.textContent = '';
    let n = 0;
    SET_GROUPS.forEach(([kind, title, hint]) => {
      const qs = set.questions.filter(q => q.kind === kind);
      if (!qs.length) return;
      const group = el('div', 'qgroup');
      group.appendChild(el('h3', '', `${title} (${qs.length})`));
      group.appendChild(el('div', 'hint', hint));
      const wrap = el('div', 'qlist');
      qs.forEach(q => {
        const item = el('div', 'qitem');
        const t = el('div', 'qt');
        t.appendChild(el('span', 'qn', String(++n)));
        t.appendChild(el('span', '', q.question));
        item.appendChild(t);
        if (q.resumeRef) item.appendChild(el('div', 'ref', `From your resume: "${q.resumeRef}"`));
        const box = answerBlock(q, false);
        item.appendChild(toggleButton(box, false));
        item.appendChild(box);
        wrap.appendChild(item);
      });
      group.appendChild(wrap);
      list.appendChild(group);
    });
    show('viewSet');
  }

  function practiseSet() {
    if (!resumeSet) return;
    readSetup();
    setup.speak = $('speakR').checked;
    Object.assign(setup, { company: 'Any', role: resumeSet.role || 'the role on my resume', round: 'resume', level: 'resume' });
    items = []; startedAt = new Date().toISOString();
    queue = resumeSet.questions.map(q => ({ question: q.question, topic: q.topic, points: q.points || [], reference: q.answer, resumeRef: q.resumeRef || '', kind: q.kind }));
    $('whoLine').textContent = `Questions from your resume · ${resumeSet.role || resumeSet.resumeLabel}`;
    show('viewInterview');
    nextQuestion();
  }

  async function startInterview() {
    readSetup();
    if (!isLicensed()) { banner(LICENCE_TEXT[(info.licence || {}).state] || 'Activate your ClassCue licence first.'); return; }
    if (mode === 'intro') return startIntro();
    if (mode === 'resume') return makeResumeSet();
    if (!info.hasKey) { banner('AI is not available for this licence yet. Check the licence, then try again.'); return; }
    banner('');
    $('btnStart').disabled = true;
    const pg = B.progress($('pgHost'), { title: 'Preparing your questions', expectedSec: 12, stages: ['Choosing topics', 'Writing questions', 'Checking them'] });
    const res = await api.questions({ ...setup, avoid: asked });
    $('btnStart').disabled = false;
    if (!res || !res.ok) { pg.stop(); banner(res ? res.message : 'Could not prepare the questions.'); show('viewSetup'); return; }
    pg.done('Your questions are ready');
    items = []; queue = res.questions.slice(); startedAt = new Date().toISOString();
    $('whoLine').textContent = `${setup.company === 'Any' ? 'Practice' : setup.company} · ${setup.role || 'Software engineer'} · ${info.rounds[setup.round].split(':')[0]}`;
    show('viewInterview');
    nextQuestion();
  }

  function paintProgress() {
    const host = $('progress');
    host.textContent = '';
    const total = items.length + (current ? 1 : 0) + queue.length;
    for (let i = 0; i < total; i++) host.appendChild(el('i', i < items.length ? 'done' : i === items.length ? 'now' : ''));
  }

  let timerId = null, seconds = 0;
  function startTimer() { stopTimer(); seconds = 0; $('timer').textContent = '0:00'; timerId = setInterval(() => { seconds++; $('timer').textContent = fmtTime(seconds); introTimerTick(); }, 1000); }
  function stopTimer() { clearInterval(timerId); timerId = null; }

  function nextQuestion() {
    $('feedback').textContent = '';
    if (!queue.length) return finish();
    current = queue.shift();
    asked.push(current.question);
    const n = items.length + 1;
    $('qnum').textContent = current.followUpOf ? `Question ${n} · follow-up` : `Question ${n}`;
    $('question').textContent = current.question;
    const tags = $('qtags');
    tags.textContent = '';
    tags.appendChild(el('span', 'tag', current.topic || 'General'));
    if (current.kind && current.kind !== 'intro') tags.appendChild(el('span', 'tag fu', current.kind === 'scenario' ? 'Scenario' : 'From your resume'));
    if (current.followUpOf) tags.appendChild(el('span', 'tag fu', 'Follow-up'));
    $('qref').textContent = current.resumeRef ? `From your resume: "${current.resumeRef}"` : '';
    $('qref').classList.toggle('hidden', !current.resumeRef);
    const hasModel = !!current.reference;
    $('btnShow').classList.toggle('hidden', !hasModel);
    B.setButton($('btnShow'), 'eye', 'Show model answer');
    $('btnShow').setAttribute('aria-expanded', 'false');
    const model = $('modelAnswer');
    model.textContent = '';
    model.classList.add('hidden');
    if (hasModel) {
      model.appendChild(el('div', '', current.reference));
      if (current.points && current.points.length) { const ul = el('ul'); current.points.forEach(p => ul.appendChild(el('li', '', p))); model.appendChild(ul); }
    }
    $('answer').value = '';
    $('answer').readOnly = false;
    $('btnSubmit').disabled = false; $('btnSkip').disabled = false;
    busy = false; paintChips();
    paintProgress();
    startTimer();
    introQuestionSetup();
    if (setup.speak) say(current.question);
    $('answer').focus();
  }

  async function submitAnswer() {
    if (!current || busy) return;
    busy = true;
    await stopMic(true);
    stopTimer(); hush();
    const answer = $('answer').value.trim();
    $('answer').readOnly = true;
    $('btnSubmit').disabled = true; $('btnSkip').disabled = true; paintChips();
    const fb = $('feedback');
    fb.textContent = '';
    if (current.kind === 'intro') { if (await reviewIntro(answer, fb)) current = null; return; }
    const loading = el('div', 'card');
    fb.appendChild(loading);
    const pg = B.progress(loading, { title: 'The interviewer is reviewing your answer', expectedSec: 10, stages: ['Reading your answer', 'Scoring it', 'Writing feedback'] });
    fb.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const res = await api.evaluate({ ...setup, question: current.question, points: current.points || [], reference: current.reference || '', answer });
    pg.stop();
    if (!res || !res.ok) {
      fb.textContent = '';
      const card = el('div', 'card');
      card.appendChild(el('p', 'verdict', res ? res.message : 'Could not get feedback.'));
      const row = el('div', 'row');
      const retry = el('button', 'btn primary', 'Try again');
      retry.addEventListener('click', () => { busy = false; submitAnswer(); });
      const edit = el('button', 'btn ghost', 'Edit my answer');
      edit.addEventListener('click', () => { busy = false; fb.textContent = ''; $('answer').readOnly = false; $('btnSubmit').disabled = false; $('btnSkip').disabled = false; paintChips(); startTimer(); });
      row.appendChild(retry); row.appendChild(edit); card.appendChild(row);
      fb.appendChild(card);
      return;
    }
    const f = res.feedback;
    const item = { ...current, answer, seconds, skipped: false, ...f };
    items.push(item);
    if (setup.followups && f.followUp && !current.followUpOf && f.score >= 3) {
      queue.unshift({ question: f.followUp, topic: current.topic, points: [], followUpOf: current.question });
    }
    current = null;
    paintProgress();
    renderFeedback(item);
  }

  function skipQuestion() {
    if (!current || busy) return;
    stopMic(false); stopTimer(); hush();
    items.push({ ...current, answer: '', seconds, skipped: true, score: null });
    current = null;
    nextQuestion();
  }

  /** Text with ``` code blocks: plain text in one element, code in <pre>. */
  function richText(host, text) {
    const parts = String(text || '').split(/```[a-zA-Z0-9+#-]*\n?/);
    parts.forEach((part, i) => {
      if (!part.trim()) return;
      host.appendChild(i % 2 ? el('pre', '', part.replace(/\n$/, '')) : el('div', 'text', part.trim()));
    });
  }

  function list(title, entries, kind, iconName) {
    const box = el('div', 'box ' + kind);
    box.appendChild(heading(iconName || 'list', title));
    if (!entries.length) box.appendChild(el('div', 'hint', kind === 'good' ? 'Nothing to highlight this time.' : 'Nothing important missing.'));
    else { const ul = el('ul'); entries.forEach(t => ul.appendChild(el('li', '', t))); box.appendChild(ul); }
    return box;
  }

  function renderFeedback(item) {
    const fb = $('feedback');
    fb.textContent = '';
    const card = el('div', 'card');
    const head = el('div', 'fbHead');
    const score = el('div', 'score ' + scoreClass(item.score));
    score.appendChild(document.createTextNode(String(item.score)));
    score.appendChild(el('small', '', '/ 10'));
    head.appendChild(score);
    const words = el('div');
    words.appendChild(el('p', 'verdict', item.verdict || ''));
    words.appendChild(el('div', 'hint', `Answered in ${fmtTime(item.seconds)}`));
    head.appendChild(words);
    card.appendChild(head);
    const cols = el('div', 'cols');
    cols.appendChild(list('What was good', item.strengths, 'good', 'check'));
    cols.appendChild(list('To improve', item.missing, 'fix', 'chart'));
    card.appendChild(cols);
    if (item.betterAnswer) {
      const better = el('div', 'box better');
      better.appendChild(heading('bulb', 'A stronger answer'));
      richText(better, item.betterAnswer);
      card.appendChild(better);
    }
    const row = el('div', 'row');
    row.style.marginTop = '18px';
    const next = el('button', 'btn primary big', queue.length ? (queue[0].followUpOf ? 'Answer the follow-up →' : 'Next question →') : 'Finish and see report →');
    next.addEventListener('click', nextQuestion);
    row.appendChild(next);
    card.appendChild(row);
    fb.appendChild(card);
    fb.scrollIntoView({ behavior: 'smooth', block: 'start' });
    next.focus();
  }

  async function finish() {
    await stopMic(false); stopTimer(); hush();
    if (current) { current = null; }
    const summary = await api.summary(items);
    $('overallScore').className = 'score ' + scoreClass(summary.average);
    $('overallScore').textContent = String(summary.average);
    $('readiness').textContent = summary.readiness;
    $('stAnswered').textContent = summary.answered;
    $('stSkipped').textContent = summary.skipped;
    const chips = (host, list, empty) => { const h = $(host); h.textContent = ''; (list.length ? list : [empty]).forEach(t => h.appendChild(el('span', 'tag', t))); };
    chips('strong', summary.strongTopics, '—');
    chips('weak', summary.weakTopics, '—');
    $('saved').textContent = '';
    const rows = $('rows');
    rows.textContent = '';
    if (!items.length) rows.appendChild(el('p', 'hint', 'No questions were answered.'));
    items.forEach((i, n) => {
      const d = el('details', 'qrow');
      const s = el('summary');
      s.appendChild(el('span', 'mini score ' + (i.skipped ? '' : scoreClass(i.score)), i.skipped ? '–' : String(i.score)));
      s.appendChild(el('span', '', `Q${n + 1}. ${i.question}`));
      d.appendChild(s);
      const body = el('div', 'body');
      if (i.skipped) body.appendChild(el('p', 'hint', 'Skipped.'));
      else {
        body.appendChild(el('p', 'verdict', i.verdict || ''));
        body.appendChild(el('h3', '', 'You said'));
        body.appendChild(el('p', 'said', i.answer || '(nothing)'));
        const cols = el('div', 'cols');
        cols.appendChild(list('Good', i.strengths, 'good', 'check'));
        cols.appendChild(list('To improve', i.missing, 'fix', 'chart'));
        body.appendChild(cols);
        if (i.betterAnswer) { const b = el('div', 'box better'); b.appendChild(heading('bulb', 'A stronger answer')); richText(b, i.betterAnswer); body.appendChild(b); }
        if (i.reference) { const b = el('div', 'box better'); b.appendChild(heading('doc', 'Model answer from your resume')); b.appendChild(el('div', 'text', i.reference)); body.appendChild(b); }
      }
      d.appendChild(body);
      rows.appendChild(d);
    });
    show('viewReport');
  }

  // ---- voice answers ---------------------------------------------------------------------------------

  let capture = null, listening = false, transcribing = false, lastPaint = 0;

  async function startMic() {
    if (listening || speech.state !== 'ready') return;
    hush();
    try {
      capture = await window.LiveCapture.start('mic', {
        onFrame: buf => api.sendAudio(buf),
        onLevel: rms => { const now = performance.now(); if (now - lastPaint > 60) { lastPaint = now; $('meter').style.width = Math.min(100, Math.round(Math.sqrt(rms) * 220)) + '%'; } },
        onEnded: () => stopMic(false),
      });
      listening = true;
      api.setListening(true);
      $('btnMic').classList.add('on');
      B.setButton($('btnMic'), 'x', 'Stop recording');
      $('micHint').textContent = 'Speak your answer. The text appears in the box; you can edit it before submitting.';
    } catch (err) {
      banner('Could not use the microphone: ' + (err && err.message ? err.message : err));
    }
  }

  /** Stop the microphone; with wait = true, also wait until the last phrase has been turned into text. */
  async function stopMic(wait) {
    if (listening) {
      listening = false;
      api.setListening(false);
      if (capture) { const c = capture; capture = null; await c.stop(); }
      $('btnMic').classList.remove('on');
      B.setButton($('btnMic'), 'mic', 'Answer by voice');
      $('meter').style.width = '0%';
      $('micHint').textContent = '';
    }
    if (wait) {
      const until = Date.now() + 10000;
      await new Promise(r => setTimeout(r, 250));
      while (transcribing && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    }
  }

  function onSpeechEvent(m) {
    if (m.type === 'status') transcribing = !!m.transcribing;
    else if (m.type === 'transcript' && current) {
      const box = $('answer');
      box.value = (box.value.trim() ? box.value.replace(/\s+$/, '') + ' ' : '') + m.text;
      box.scrollTop = box.scrollHeight;
    } else if (m.type === 'error' || m.type === 'warning') $('micHint').textContent = m.message;
  }

  // ---- the interviewer's voice (Windows speech, offline) ---------------------------------------------

  function say(text) {
    if (!window.speechSynthesis) return;
    hush();
    const u = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, ' (see the code on screen) '));
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => /en-(IN|GB|US)/i.test(v.lang) && /natural|online/i.test(v.name)) || voices.find(v => /^en/i.test(v.lang));
    if (voice) u.voice = voice;
    u.rate = 1;
    u.onstart = () => $('avatar').classList.add('talking');
    u.onend = u.onerror = () => $('avatar').classList.remove('talking');
    speechSynthesis.speak(u);
  }
  function hush() { if (window.speechSynthesis) speechSynthesis.cancel(); $('avatar').classList.remove('talking'); }

  // ---- "Tell me about yourself": answer it, then see it checked against your resume ----------------------

  const INTRO_QUESTION = 'Tell me about yourself.';
  let intro = null;   // { resumeKey, role, company, guide }

  /** The talking points: a label, one sentence to say, and the resume line it comes from. */
  function pointsList(points) {
    const ul = el('ul', 'pts');
    points.forEach(p => {
      const li = el('li');
      li.appendChild(el('span', 'ptlabel', p.label));
      li.appendChild(el('span', 'ptbullet', p.bullet));
      if (p.resumeRef) li.appendChild(el('div', 'ptref', `From your resume: "${p.resumeRef}"`));
      ul.appendChild(li);
    });
    return ul;
  }

  function startIntro() {
    if (!$('introResume').value) { banner('Choose a resume first.'); return; }
    banner('');
    intro = { resumeKey: $('introResume').value, role: $('introRole').value.trim(), company: $('introCompany').value.trim(), guide: null };
    Object.assign(setup, { company: 'Any', role: intro.role || 'the role on my resume', round: 'resume', level: 'resume', speak: $('speakI').checked });
    items = []; startedAt = new Date().toISOString();
    queue = [{ question: INTRO_QUESTION, topic: 'Introduction', kind: 'intro', points: [], reference: '' }];
    $('whoLine').textContent = `Tell me about yourself · ${intro.role || 'checked against your resume'}`;
    show('viewInterview');
    introActive = true;
    nextQuestion();
  }

  /** Per-question set-up for the introduction: no skipping, a timer that shows the 60 to 90 second target, and a peek button for the talking points. */
  function introQuestionSetup() {
    const on = !!(current && current.kind === 'intro');
    $('btnSkip').classList.toggle('hidden', on);
    $('timer').className = 'timer';
    if (on) {
      $('qref').textContent = 'Aim for 60 to 90 seconds: who you are now, two or three achievements, your strengths, and why this role. We check every fact against your resume.';
      $('qref').classList.remove('hidden');
      $('btnShow').classList.remove('hidden');
      B.setButton($('btnShow'), 'eye', 'Peek at my talking points');
    }
  }
  function introTimerTick() {
    if (!(current && current.kind === 'intro')) return;
    $('timer').className = 'timer ' + (seconds < 45 ? 'short' : seconds <= 120 ? 'good' : 'long');
  }

  async function peekPoints() {
    const box = $('modelAnswer');
    const open = box.classList.contains('hidden');
    if (!open) { box.classList.add('hidden'); $('btnShow').setAttribute('aria-expanded', 'false'); B.setButton($('btnShow'), 'eye', 'Peek at my talking points'); return; }
    box.classList.remove('hidden');
    $('btnShow').setAttribute('aria-expanded', 'true');
    B.setButton($('btnShow'), 'eye-off', 'Hide my talking points');
    if (!intro.guide) {
      box.textContent = '';
      const pg = B.progress(box, { title: 'Preparing your talking points', expectedSec: 20, compact: true, stages: ['Reading your resume', 'Choosing what to say'] });
      const res = await api.introGuide(intro);
      pg.stop();
      if (!res || !res.ok) { box.textContent = res ? res.message : 'Could not get your talking points.'; return; }
      intro.guide = res.intro.guide;
    }
    box.textContent = '';
    box.appendChild(el('div', 'ptitle', 'Cover these points, in this order'));
    box.appendChild(pointsList(intro.guide.points));
    if (intro.guide.script) {
      const d = el('details', 'script');
      d.appendChild(el('summary', '', 'See a suggested 90-second introduction'));
      d.appendChild(el('div', 'text', intro.guide.script));
      box.appendChild(d);
    }
  }

  async function reviewIntro(answer, fb) {
    const loading = el('div', 'card');
    fb.appendChild(loading);
    const pg = B.progress(loading, { title: 'Checking your introduction against your resume', expectedSec: 28, stages: ['Reading your answer', 'Checking every fact', 'Writing your suggestions'] });
    fb.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const res = await api.introReview({ ...intro, answer, seconds });
    pg.stop();
    if (!res || !res.ok) {
      fb.textContent = '';
      const card = el('div', 'card');
      card.appendChild(el('p', 'verdict', res ? res.message : 'Could not review your answer.'));
      const row = el('div', 'row');
      const retry = el('button', 'btn primary', 'Try again');
      retry.addEventListener('click', () => { busy = false; submitAnswer(); });
      const edit = el('button', 'btn ghost', 'Edit my answer');
      edit.addEventListener('click', () => { busy = false; fb.textContent = ''; $('answer').readOnly = false; $('btnSubmit').disabled = false; paintChips(); startTimer(); introQuestionSetup(); });
      row.append(retry, edit); card.appendChild(row); fb.appendChild(card);
      return false;
    }
    intro.last = res.intro;
    if (res.intro.guide) intro.guide = res.intro.guide;
    renderIntroReview(res.intro);
    return true;
  }

  function retryIntro() {
    $('feedback').textContent = '';
    queue = [{ question: INTRO_QUESTION, topic: 'Introduction', kind: 'intro', points: [], reference: '' }];
    nextQuestion();
    window.scrollTo(0, 0);
  }

  const STATUS = { supported: ['ok', 'check', 'In your resume'], partly: ['part', 'alert', 'Only partly in your resume'], not_in_resume: ['no', 'x', 'Not in your resume'] };
  const SUBSCORES = [['structure', 'Structure'], ['relevance', 'Relevance'], ['impact', 'Impact'], ['authenticity', 'Matches your resume'], ['delivery', 'Delivery']];

  function renderIntroReview(r) {
    const rv = r.review;
    const fb = $('feedback');
    fb.textContent = '';
    const card = el('div', 'card review');

    // score and verdict
    const head = el('div', 'fbHead');
    const sc = el('div', 'score ' + scoreClass(rv.score));
    sc.appendChild(document.createTextNode(String(rv.score)));
    sc.appendChild(el('small', '', '/ 10'));
    head.appendChild(sc);
    const words = el('div');
    words.appendChild(el('p', 'verdict', rv.verdict || ''));
    const m = rv.metrics || {};
    words.appendChild(el('div', 'hint', `${m.words || 0} words · about ${m.estSeconds || 0} seconds when spoken${m.fillers ? ' · ' + m.fillers + ' filler word' + (m.fillers === 1 ? '' : 's') : ''}. ${m.note || ''}`));
    head.appendChild(words);
    card.appendChild(head);

    // the five scores
    const bars = el('div', 'bars5');
    SUBSCORES.forEach(([key, label]) => {
      const row = el('div', 'bar-row');
      row.appendChild(el('span', '', label));
      const track = el('div', 'bar-track'); const fill = el('div', 'bar-fill');
      fill.style.width = (rv.scores[key] * 10) + '%';
      track.appendChild(fill); row.appendChild(track);
      row.appendChild(el('b', '', String(rv.scores[key])));
      bars.appendChild(row);
    });
    card.appendChild(bars);

    // every fact, checked against the resume
    const check = el('div', 'box');
    check.appendChild(heading('shield', 'Checked against your resume'));
    const v = rv.verified || {};
    const chips = el('div', 'vchips');
    chips.appendChild(el('span', 'ok', `${v.supported || 0} in your resume`));
    chips.appendChild(el('span', 'part', `${v.partly || 0} partly`));
    chips.appendChild(el('span', 'no', `${v.notInResume || 0} not in your resume`));
    check.appendChild(chips);
    rv.claims.forEach(c => {
      const [cls, icon, label] = STATUS[c.status] || STATUS.partly;
      const row = el('div', 'claim');
      const st = el('span', 'st ' + cls); st.appendChild(B.icon(icon)); st.title = label;
      row.appendChild(st);
      const body = el('div');
      body.appendChild(el('div', 'ctext', c.claim));
      body.appendChild(el('small', 'clabel ' + cls, label + (c.note ? ': ' + c.note : '')));
      if (c.evidence) body.appendChild(el('div', 'ptref', `From your resume: "${c.evidence}"`));
      row.appendChild(body);
      check.appendChild(row);
    });
    (rv.numberFlags || []).forEach(f => {
      const row = el('div', 'claim');
      const st = el('span', 'st part'); st.appendChild(B.icon('alert')); row.appendChild(st);
      const body = el('div');
      body.appendChild(el('div', 'ctext', `You said "${f.text}"`));
      body.appendChild(el('small', 'clabel part', f.note));
      row.appendChild(body);
      check.appendChild(row);
    });
    card.appendChild(check);

    // what worked, what to change
    const cols = el('div', 'cols');
    cols.appendChild(list('What worked', rv.strengths, 'good', 'check'));
    cols.appendChild(list('Change this', rv.improvements.concat(rv.trim.map(t => 'Cut or shorten: ' + t)), 'fix', 'chart'));
    card.appendChild(cols);

    // what the resume has that you did not say
    if (rv.missing.length) {
      const miss = el('div', 'box better');
      miss.appendChild(heading('spark', 'Your resume has strong points you left out'));
      const ul = el('ul', 'pts');
      rv.missing.forEach(x => {
        const li = el('li');
        li.appendChild(el('span', 'ptbullet', x.point));
        if (x.why) li.appendChild(el('div', 'hint', x.why));
        if (x.resumeRef) li.appendChild(el('div', 'ptref', `From your resume: "${x.resumeRef}"`));
        ul.appendChild(li);
      });
      miss.appendChild(ul);
      card.appendChild(miss);
    }

    // a more impressive version, built only from the resume
    if (rv.impressive) {
      const better = el('div', 'box better');
      better.appendChild(heading('bulb', 'A more impressive version, using only what your resume shows'));
      better.appendChild(el('div', 'text', rv.impressive));
      const copy = el('button', 'btn sm', '');
      B.setButton(copy, 'copy', 'Copy');
      copy.addEventListener('click', () => { try { navigator.clipboard.writeText(rv.impressive); B.setButton(copy, 'check', 'Copied'); setTimeout(() => B.setButton(copy, 'copy', 'Copy'), 1500); } catch (_) { /* no clipboard */ } });
      better.appendChild(copy);
      card.appendChild(better);
    }

    // personalised bullets to cover
    if (rv.points.length) {
      const pts = el('div', 'box');
      pts.appendChild(heading('list', 'Points to cover in your introduction'));
      pts.appendChild(pointsList(rv.points));
      card.appendChild(pts);
    }
    if (rv.followUps.length) {
      const f = el('div', 'box');
      f.appendChild(heading('chat', 'Questions to expect next'));
      const ul = el('ul'); rv.followUps.forEach(q => ul.appendChild(el('li', '', q))); f.appendChild(ul);
      card.appendChild(f);
    }
    const note = el('p', 'hint');
    note.textContent = 'Saved to your ClassCue account (My account → Interview prep).';
    card.appendChild(note);

    const row = el('div', 'row');
    row.style.marginTop = '18px';
    const again = el('button', 'btn primary big', 'Try again with these tips');
    again.addEventListener('click', retryIntro);
    const done = el('button', 'btn ghost', 'Finish');
    done.addEventListener('click', () => { $('feedback').textContent = ''; stopTimer(); current = null; show('viewSetup'); });
    row.append(again, done);
    card.appendChild(row);
    fb.appendChild(card);
    fb.scrollIntoView({ behavior: 'smooth', block: 'start' });
    again.focus();
  }

  // ---- start up ------------------------------------------------------------------------------------

  async function init() {
    info = await api.info();
    speech = info.speech || speech;
    const company = $('company');
    company.appendChild(el('option', '', 'Any'));
    info.companies.forEach(c => company.appendChild(el('option', '', c)));
    segmented($('rounds'), Object.fromEntries(Object.entries(info.rounds).map(([k, v]) => [k, v.split(':')[0]])), 'round');
    segmented($('levels'), Object.fromEntries(Object.entries(info.levels).map(([k, v]) => [k, v.split(' / ')[0].replace(' of experience', '')])), 'level');
    paintChips();
    applyLicence();
    api.onLicence(async l => { info = await api.info(); applyLicence(l); });
    $('gateActivate').addEventListener('click', activateLicence);
    $('gateCheck').addEventListener('click', checkLicence);
    $('gateKey').addEventListener('keydown', e => { if (e.key === 'Enter') activateLicence(); });
    [...$('modes').children].forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('btnPractise').addEventListener('click', practiseSet);
    $('btnSetBack').addEventListener('click', () => { banner(''); show('viewSetup'); loadResumes(); });
    $('btnShowAll').addEventListener('click', () => {
      const buttons = [...$('setList').querySelectorAll('button.reveal')];
      const anyClosed = buttons.some(b => b.getAttribute('aria-expanded') === 'false');
      buttons.forEach(b => { if ((b.getAttribute('aria-expanded') === 'false') === anyClosed) b.click(); });
      B.setButton($('btnShowAll'), anyClosed ? 'eye-off' : 'eye', anyClosed ? 'Hide all answers' : 'Show all answers');
    });
    $('btnShow').addEventListener('click', () => {
      if (current && current.kind === 'intro') return peekPoints();
      const box = $('modelAnswer');
      const open = box.classList.contains('hidden');
      box.classList.toggle('hidden', !open);
      $('btnShow').setAttribute('aria-expanded', open ? 'true' : 'false');
      B.setButton($('btnShow'), open ? 'eye-off' : 'eye', open ? 'Hide model answer' : 'Show model answer');
    });

    api.onSpeech(s => { speech = s; paintChips(); });
    api.onSpeechEvent(onSpeechEvent);
    $('btnStart').addEventListener('click', startInterview);
    $('btnSubmit').addEventListener('click', submitAnswer);
    $('btnSkip').addEventListener('click', skipQuestion);
    $('btnEnd').addEventListener('click', () => { if (busy) return; if (introActive) { stopMic(false); stopTimer(); hush(); $('feedback').textContent = ''; current = null; show('viewSetup'); } else finish(); });
    $('btnRepeat').addEventListener('click', () => { if (current) say(current.question); });
    $('btnMic').addEventListener('click', () => (listening ? stopMic(false) : startMic()));
    $('answer').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAnswer(); } });
    $('btnSave').addEventListener('click', async () => {
      const res = await api.save({ ...setup, startedAt, items });
      $('saved').textContent = res && res.ok ? `Saved to ${res.path}` : (res ? res.message : 'Could not save.');
    });
    $('btnAgain').addEventListener('click', startInterview);
    $('btnNew').addEventListener('click', () => { banner(''); show('viewSetup'); });
  }

  init();
})();
