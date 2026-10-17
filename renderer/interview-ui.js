// Mock interview window: set up -> questions one by one (spoken answer or typed) -> feedback per answer -> report.
// Everything shown is inserted as TEXT (never as HTML): nothing the AI writes can inject markup into the page.
(function () {
  'use strict';
  const api = window.interviewAPI;
  const $ = id => document.getElementById(id);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function show(view) { ['viewSetup', 'viewInterview', 'viewReport'].forEach(v => $(v).classList.toggle('hidden', v !== view)); window.scrollTo(0, 0); }
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
    if (info) chip('aiChip', info.hasKey ? 'ok' : 'bad', info.hasKey ? `AI: ${info.provider}` : 'AI: no key');
    const s = { ready: ['ok', 'Voice answers on'], starting: ['warn', 'Voice: loading…'], missing: ['warn', 'Voice: type answers'], error: ['bad', 'Voice: unavailable'] }[speech.state] || ['warn', 'Voice'];
    chip('speechChip', s[0], s[1]);
    $('btnMic').disabled = speech.state !== 'ready' || busy;
    $('micHint').textContent = speech.state === 'ready' ? '' : speech.message || '';
  }

  // ---- interview -------------------------------------------------------------------------------------

  async function startInterview() {
    readSetup();
    if (!info.hasKey) { banner('No AI key is saved. Open the teacher assistant (npm start), Settings, and add a key.'); return; }
    banner('Preparing your questions…', 'info');
    $('btnStart').disabled = true;
    $('btnStart').textContent = 'Preparing your questions…';
    const res = await api.questions({ ...setup, avoid: asked });
    $('btnStart').disabled = false;
    $('btnStart').textContent = 'Start interview →';
    if (!res || !res.ok) { banner(res ? res.message : 'Could not prepare the questions.'); show('viewSetup'); return; }
    banner('');
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
  function startTimer() { stopTimer(); seconds = 0; $('timer').textContent = '0:00'; timerId = setInterval(() => { seconds++; $('timer').textContent = fmtTime(seconds); }, 1000); }
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
    if (current.followUpOf) tags.appendChild(el('span', 'tag fu', 'Follow-up'));
    $('answer').value = '';
    $('answer').readOnly = false;
    $('btnSubmit').disabled = false; $('btnSkip').disabled = false;
    busy = false; paintChips();
    paintProgress();
    startTimer();
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
    const loading = el('div', 'card loading');
    loading.appendChild(el('div', 'spinner'));
    loading.appendChild(el('span', '', 'The interviewer is reviewing your answer…'));
    fb.appendChild(loading);
    fb.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const res = await api.evaluate({ ...setup, question: current.question, points: current.points || [], answer });
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

  function list(title, entries, kind) {
    const box = el('div', 'box ' + kind);
    box.appendChild(el('h3', '', title));
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
    cols.appendChild(list('✓ What was good', item.strengths, 'good'));
    cols.appendChild(list('↗ To improve', item.missing, 'fix'));
    card.appendChild(cols);
    if (item.betterAnswer) {
      const better = el('div', 'box better');
      better.appendChild(el('h3', '', '💡 A stronger answer'));
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
        cols.appendChild(list('✓ Good', i.strengths, 'good'));
        cols.appendChild(list('↗ To improve', i.missing, 'fix'));
        body.appendChild(cols);
        if (i.betterAnswer) { const b = el('div', 'box better'); b.appendChild(el('h3', '', '💡 A stronger answer')); richText(b, i.betterAnswer); body.appendChild(b); }
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
      $('btnMic').textContent = '■ Stop recording';
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
      $('btnMic').textContent = '🎙 Answer by voice';
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
    if (!info.hasKey) banner('No AI key is saved yet. Open the teacher assistant (npm start), Settings, and add a Groq, Gemini or Claude key.');

    api.onSpeech(s => { speech = s; paintChips(); });
    api.onSpeechEvent(onSpeechEvent);
    $('btnStart').addEventListener('click', startInterview);
    $('btnSubmit').addEventListener('click', submitAnswer);
    $('btnSkip').addEventListener('click', skipQuestion);
    $('btnEnd').addEventListener('click', () => { if (!busy) finish(); });
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
