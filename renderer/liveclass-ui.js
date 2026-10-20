// Live Class overlay: toolbar, live transcript strip, question/answer card and a settings menu.
// In the app (npm run liveclass) it listens with the offline speech engine and answers with the same AI, model,
// subject and prompts as the teacher assistant. Opened in a plain browser it runs a demo with sample data instead.
// Everything shown is inserted as TEXT (never as HTML): nothing the AI writes can inject markup into the page.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const live = !!window.liveClassAPI;
  const api = window.liveClassAPI || demoAPI();
  if (!/Electron/i.test(navigator.userAgent)) document.body.classList.add('web');

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtClock = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtElapsed = sec => {
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };
  const isQuestion = text => /\?\s*$/.test(text) && text.trim().split(/\s+/).length > 2;
  const newUid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));

  const B = window.Brand;
  /** A small rounded icon badge (kind 'q' for questions, 'a' for answers). */
  const badge = (name, kind) => { const s = el('span', 'ico ' + kind); s.appendChild(B.icon(name)); return s; };

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  const DASHBOARD_URL = 'https://shortlistprep.com/account.html';   // My account on the ShortlistPrep website
  const SOURCES = { mic: 'Mic', system: 'System', both: 'Mic + System' };
  const PROVIDERS = { groq: 'Groq', gemini: 'Gemini', claude: 'Claude', demo: 'Demo', proxy: 'Groq' };   // proxy: Groq through the licence server

  // ---- state ---------------------------------------------------------------------------------------
  const DEFAULTS = { zoom: 100, opacity: 100, font: 15 };
  const state = {
    startedAt: Date.now(), ended: false, collapsed: false,
    listening: false, starting: false, source: 'both', theme: 'light', zoom: DEFAULTS.zoom, opacity: DEFAULTS.opacity, font: DEFAULTS.font,
    autoAnswer: false, editing: false,
    engine: { state: 'starting', message: '' }, info: null, notice: null, reading: 0,
    licence: { state: live ? 'checking' : 'active', dev: !live },
    heard: [],         // { text, isQuestion }: the latest phrases, shown in the strip
    log: [],           // { at, text }: everything heard this class, saved when it ends
    uid: newUid(),     // this class's id on the server (sending it twice does not make two copies)
    partial: '',       // the words of the phrase still being spoken
    speaking: false, transcribing: false,
    items: [],         // { id, question, text, status: 'thinking' | 'done' | 'error', error, at: Date, vote }
    index: -1,
  };
  let capture = null;
  const current = () => state.items[state.index];

  // ---- rendering -----------------------------------------------------------------------------------
  function renderPhrases() {
    const box = $('phrases');
    box.textContent = '';
    if (!state.heard.length && !state.partial && !(state.listening && (state.speaking || state.transcribing))) {
      if (state.engine.state === 'starting') B.progress(box, { title: 'Loading the speech engine', expectedSec: 10, compact: true, startedAt: state.startedAt, stages: ['Starting', 'Loading the model', 'Warming up'] });
      else box.appendChild(el('span', '', stripStatus()));
      return;
    }
    for (const h of state.heard.slice(-12)) {
      const s = el('span', h.isQuestion ? 'q' : '', h.text);
      if (h.isQuestion) s.addEventListener('click', () => ask(h.text));
      box.appendChild(s);
    }
    if (state.partial) box.appendChild(el('span', 'partial', state.partial));   // still being spoken
    else if (state.listening && state.speaking) box.appendChild(el('span', 'partial', 'speaking'));
    else if (state.listening && state.transcribing) box.appendChild(el('span', 'partial', 'writing it down'));
    box.scrollLeft = box.scrollWidth;
  }

  function stripStatus() {
    const e = state.engine;
    if (e.state === 'starting') return e.message || 'Loading the speech model…';
    if (e.state !== 'ready') return 'Speech engine not available. You can still type questions with Chat (Ctrl+Shift+Space).';
    if (state.starting) return 'Starting the microphone…';
    return state.listening ? 'Listening… questions will appear here.' : 'Press the mic button to start listening.';
  }

  // the answer text, shown the way the assistant shows it: one statement per line, list items as bullets
  function renderAnswer(body, item) {
    const al = el('div', 'aline');
    al.append(badge('spark', 'a'), el('b', '', 'Answer: '));
    body.appendChild(al);
    if (item.status === 'error') { al.appendChild(el('span', 'err', item.error || 'Could not answer this question.')); return; }
    const lines = window.ReadFormat ? window.ReadFormat.toLines(item.text) : String(item.text || '').split(/\n+/).filter(Boolean);
    if (!lines.length) {
      // the same bar stays at the same point when the card is redrawn: it counts from when the question was asked
      B.progress(body, { title: item.source === 'screen' ? 'Reading the screen and writing your answer' : 'Preparing your answer', expectedSec: item.source === 'screen' ? 14 : 8, compact: true, startedAt: item.at.getTime(),
        stages: item.source === 'screen' ? ['Reading', 'Thinking', 'Writing'] : [] });
      return;
    }
    let first = true, list = null, code = null;
    for (const line of lines) {
      if (window.ReadFormat && window.ReadFormat.isCodeFence(line)) {
        if (code) { code = null; } else { code = el('pre', 'code'); body.appendChild(code); list = null; }
        continue;
      }
      if (code) { code.textContent += (code.textContent ? '\n' : '') + line; continue; }
      const bullet = /^[-•*–]\s+/.exec(line);
      if (bullet) {
        if (!list) { list = el('ul'); body.appendChild(list); }
        list.appendChild(el('li', '', line.slice(bullet[0].length)));
        first = false;
        continue;
      }
      list = null;
      if (first) { al.appendChild(document.createTextNode(line)); first = false; }
      else body.appendChild(el('p', 'line', line));
    }
    if (item.status === 'thinking') body.appendChild(el('span', 'pending', ' …'));   // the text is still arriving
  }

  function renderCard() {
    const body = $('body');
    const keepScroll = body.scrollTop;
    body.textContent = '';
    const item = current();
    $('btnPrev').disabled = state.index <= 0;
    $('btnNext').disabled = state.index >= state.items.length - 1;
    $('pos').textContent = state.items.length ? `${state.index + 1} / ${state.items.length}` : '';
    $('stamp').textContent = item ? fmtClock(item.at) : '–';
    $('thumbUp').classList.toggle('on', !!item && item.vote === 1);
    $('thumbDown').classList.toggle('on', !!item && item.vote === -1);
    const n = $('notice');
    n.hidden = !state.notice;
    if (state.notice) { n.textContent = state.notice.text; n.className = 'notice ' + state.notice.kind; }

    if (state.reading) B.progress(body, { title: 'Reading the question on screen', expectedSec: 10, compact: true, startedAt: state.reading, stages: ['Capturing', 'Reading', 'Understanding'] });
    if (!item) {
      body.appendChild(el('div', 'empty', 'No questions yet. Questions heard in class are answered here (Auto Answer), or press Answer (Ctrl+Enter) when a question is finished. Chat (Ctrl+Shift+Space) to type one.'));
      return;
    }

    if (state.editing) {
      const wrap = el('div', 'editwrap');
      const ta = el('textarea');
      ta.value = item.question;
      const row = el('div', 'row');
      const cancel = el('button', 'sbtn', 'Cancel');
      const save = el('button', 'sbtn primary', 'Save & re-answer');
      cancel.addEventListener('click', () => { state.editing = false; renderCard(); });
      save.addEventListener('click', () => saveEdit(ta.value));
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); saveEdit(ta.value); }
        if (e.key === 'Escape') { state.editing = false; renderCard(); }
      });
      row.append(cancel, save);
      wrap.append(el('b', '', 'Edit question'), ta, row);
      body.appendChild(wrap);
      setTimeout(() => ta.focus(), 0);
    } else {
      const ql = el('div', 'qline');
      ql.append(badge('chat', 'q'), el('b', '', 'Question: '), document.createTextNode(item.question));
      body.appendChild(ql);
    }
    renderAnswer(body, item);
    body.scrollTop = item.status === 'thinking' ? keepScroll : 0;
  }

  function applyView() {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    const overlay = $('overlay');
    overlay.style.zoom = state.zoom / 100;
    overlay.style.opacity = state.opacity / 100;
    root.style.setProperty('--card-font', state.font + 'px');
    overlay.classList.toggle('collapsed', state.collapsed);
    $('zoomVal').textContent = state.zoom + '%';
    $('opacityVal').textContent = state.opacity + '%';
    $('fontVal').textContent = state.font + 'px';
    $('themeLight').classList.toggle('sel', state.theme === 'light');
    $('themeDark').classList.toggle('sel', state.theme === 'dark');
    $('autoAnswer').setAttribute('aria-checked', String(state.autoAnswer));
    $('sourceLabel').textContent = SOURCES[state.source] || state.source;
    $('btnMic').classList.toggle('muted', !state.listening);
    $('btnMic').title = state.listening ? 'Stop listening' : 'Start listening';
    $('bars').classList.toggle('off', !state.listening || state.ended);
    $('btnListen2').textContent = state.listening ? 'Stop listening' : 'Start listening';
    for (const b of document.querySelectorAll('#srcMenu [data-src]')) b.classList.toggle('sel', b.dataset.src === state.source);
    $('btnCollapse').classList.toggle('on', state.collapsed);
    $('btnChat').classList.toggle('on', !$('chatRow').hidden);
  }

  function notice(kind, text) {
    state.notice = text ? { kind, text } : null;
    renderCard();
  }

  // ---- licence ------------------------------------------------------------------------------------
  const isLicensed = () => state.licence.state === 'active';
  const LICENCE_TEXT = {
    checking: 'Checking your ShortlistPrep licence…',
    none: 'Live Class needs a ShortlistPrep licence. Enter your licence key to activate this computer.',
    expired: 'Your licence has expired. Renew it, or enter a new licence key.',
    revoked: 'This licence has been cancelled. Please contact support, or enter another licence key.',
    removed: 'This computer was removed from the licence. Enter the key again to activate it.',
    'check-needed': 'The licence could not be checked for a while. Connect to the internet and press "Check again".',
  };
  function needLicence() {
    if (isLicensed()) return false;
    toast(state.licence.state === 'checking' ? 'Checking the licence…' : 'Activate a licence first');
    return true;
  }
  function applyLicence(l) {
    if (l) state.licence = l;
    const l2 = state.licence;
    const gate = $('gate');
    gate.hidden = isLicensed();
    const oldBar = $('gatePg');
    if (oldBar && l2.state !== 'checking') oldBar.remove();
    if (!gate.hidden) {
      if (l2.state === 'checking' && !$('gatePg')) { const slot = el('div'); slot.id = 'gatePg'; gate.insertBefore(slot, gate.children[1]); B.progress(slot, { title: 'Checking your licence', expectedSec: 6, compact: true }); }
      $('gateMsg').textContent = l2.message || LICENCE_TEXT[l2.state] || 'Live Class needs an active licence.';
      $('gateKey').parentElement.hidden = l2.state === 'checking';
      $('gateActivate').hidden = l2.state === 'check-needed';
      if (state.listening) stopListening();
    }
    $('licenceRow').textContent = l2.dev ? (live ? 'Licence: not checked (development)' : 'Licence: demo')
      : l2.state === 'active' ? `Licence: ${l2.plan}${l2.kind === 'trial' ? ' trial' : ''}${l2.daysLeft !== null && l2.daysLeft !== undefined ? ` · ${l2.daysLeft} days left` : ' · lifetime'}`
        : 'Licence: ' + (l2.state === 'checking' ? 'checking…' : l2.state.replace('-', ' '));
    $('licenceRow').parentElement.title = l2.maskedKey ? 'Key ' + l2.maskedKey : '';
  }
  async function activate() {
    const key = $('gateKey').value.trim();
    $('gateErr').textContent = '';
    if (!/^CC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(key)) { $('gateErr').textContent = 'A licence key looks like CC-XXXX-XXXX-XXXX.'; return; }
    $('gateActivate').disabled = true;
    try {
      const res = await api.activateLicence(key);
      if (!res) return;
      if (!res.ok) $('gateErr').textContent = res.message || 'The key was not accepted.';
      else { $('gateKey').value = ''; toast('Licence activated'); }
      applyLicence(res.licence);
    } finally { $('gateActivate').disabled = false; }
  }
  async function checkAgain() {
    $('gateErr').textContent = '';
    applyLicence(await api.checkLicence());
    if (!isLicensed()) $('gateErr').textContent = 'Still not active.';
  }

  // ---- listening -----------------------------------------------------------------------------------
  async function startListening() {
    if (state.listening || state.starting || state.ended) return;
    if (needLicence()) return;
    if (state.engine.state !== 'ready') { toast(state.engine.state === 'starting' ? 'The speech engine is still loading…' : 'The speech engine is not available'); return; }
    state.starting = true; renderPhrases();
    try {
      if (live) {
        capture = await window.LiveCapture.start(state.source, {
          onFrame: buffer => api.sendAudio(buffer),
          onLevel: rms => paintLevel(rms),
          onEnded: () => { if (state.listening) { stopListening(); notice('warn', 'The audio source stopped. Press the mic button to listen again.'); } },
          onStalled: () => { if (state.listening) notice('warn', 'No sound is coming from the audio source. Check the microphone in Windows, then stop and start listening.'); },
        });
      }
      state.listening = true;
      api.setListening(true);
      if (state.notice && state.notice.kind !== 'error') notice();
    } catch (err) {
      notice('error', 'Could not start listening: ' + (err && err.message ? err.message : err));
    } finally {
      state.starting = false;
      applyView(); renderPhrases();
    }
  }

  async function stopListening() {
    state.listening = false;
    api.setListening(false);
    if (capture) { const c = capture; capture = null; await c.stop(); }
    applyView(); renderPhrases();
  }
  const toggleListening = () => (state.listening ? stopListening() : startListening());

  let level = 0;
  function paintLevel(rms) { level = Math.min(1, Math.sqrt(rms) * 2.2); }
  setInterval(() => {   // mic activity bars
    const on = state.listening && !state.ended;
    if (!live && on) level = Math.random() * 0.8;
    for (const b of $('bars').children) b.style.height = (on ? 3 + Math.round(level * 13 * (0.55 + Math.random() * 0.45)) : 4) + 'px';
    if (live) level *= 0.7;
  }, 110);
  setInterval(() => { if (!state.ended) $('timer').textContent = fmtElapsed(Math.floor((Date.now() - state.startedAt) / 1000)); }, 500);

  // ---- events from the speech / AI engine ------------------------------------------------------------
  function applyEngine(e) {
    state.engine = e || state.engine;
    if (state.engine.state === 'setup-needed' || state.engine.state === 'error') notice('error', state.engine.message);
    else if (state.info && !state.info.hasKey && isLicensed()) notice('warn', `No ${PROVIDERS[state.info.provider] || state.info.provider} key for answers. Ask your administrator to give your licence one (admin dashboard, AI keys), or add it in the teacher assistant's Settings (npm start).`);
    else if (state.notice && state.notice.kind === 'warn' && state.info && state.info.hasKey) notice();
    renderPhrases();
  }

  let partialTimer = null;
  function onPipeline(m) {
    const find = id => state.items.find(i => i.id === id);
    switch (m.type) {
      case 'speaking': state.speaking = m.on; renderPhrases(); break;
      case 'status': state.transcribing = !!m.transcribing; renderPhrases(); break;
      case 'partial': {   // the words so far of a phrase still being spoken (demo)
        state.partial = m.text;
        clearTimeout(partialTimer);
        partialTimer = setTimeout(() => { state.partial = ''; renderPhrases(); }, 4000);
        renderPhrases();
        break;
      }
      case 'transcript': {
        state.partial = '';
        state.heard.push({ text: m.text, isQuestion: isQuestion(m.text) });
        if (state.heard.length > 60) state.heard.shift();
        if (!state.ended) state.log.push({ at: new Date().toISOString(), text: m.text });
        renderPhrases();
        break;
      }
      case 'answer-start': {
        state.reading = 0;
        state.items.push({ id: m.id, question: m.question, text: '', status: 'thinking', at: new Date(), vote: 0, source: m.source });
        if (!state.editing) { state.index = state.items.length - 1; }
        if (state.collapsed) { state.collapsed = false; applyView(); }
        renderCard();
        break;
      }
      case 'answer-delta': { const it = find(m.id); if (it) { it.text += m.delta; if (it === current()) renderCard(); } break; }
      case 'answer-done': { const it = find(m.id); if (it) { it.text = m.text; it.status = 'done'; if (it === current()) renderCard(); } break; }
      case 'answer-error': { const it = find(m.id); if (it) { it.status = 'error'; it.error = m.message; if (it === current()) renderCard(); } break; }
      case 'answer-skip': case 'answer-cancelled': removeItem(m.id); break;
      case 'screen':
        if (m.state === 'reading') { state.reading = Date.now(); renderCard(); }
        else if (m.state === 'error' || m.state === 'none') { state.reading = 0; notice('warn', m.message); }
        break;
      case 'error': notice('error', m.message); break;
      case 'warning': toast(m.message); break;
    }
  }

  function removeItem(id) {
    const at = state.items.findIndex(i => i.id === id);
    if (at < 0) return;
    state.items.splice(at, 1);
    if (state.index >= at) state.index = Math.max(state.items.length ? 0 : -1, state.index - 1);
    state.index = Math.min(state.index, state.items.length - 1);
    renderCard();
  }

  // ---- actions -------------------------------------------------------------------------------------
  function ask(question, corrected) {
    question = String(question || '').trim();
    if (!question || state.ended || needLicence()) return;
    if (state.notice && state.notice.kind === 'warn') notice();
    api.askTyped(question, corrected);
  }

  function answerLatest() {   // "question finished": answer what was said since the last answer
    if (state.ended || needLicence()) return;
    api.askLast();
  }

  function screenshot() {
    if (state.ended || needLicence()) return;
    state.reading = Date.now();   // the bar shows until the answer starts
    renderCard();
    api.captureScreen();
  }

  function toggleChat(force) {
    const row = $('chatRow');
    const open = force === undefined ? row.hidden : force;
    row.hidden = !open;
    if (open) { state.collapsed = false; setTimeout(() => $('chatInput').focus(), 0); }
    applyView();
  }

  function sendChat() {
    const input = $('chatInput');
    if (!input.value.trim()) return;
    ask(input.value);
    input.value = '';
    toggleChat(false);
  }

  function saveEdit(text) {
    const item = current();
    text = String(text || '').trim();
    state.editing = false;
    if (!item || !text || text === item.question) { renderCard(); return; }
    removeItem(item.id);           // the corrected question replaces the old one
    ask(text, true);
  }

  function go(step) {
    if (!state.items.length) return;
    state.index = clamp(state.index + step, 0, state.items.length - 1);
    state.editing = false;
    renderCard();
  }

  function vote(v) {
    const item = current();
    if (!item) return;
    item.vote = item.vote === v ? 0 : v;
    renderCard();
  }

  function setting(act) {
    switch (act) {
      case 'zoom+': state.zoom = clamp(state.zoom + 10, 50, 200); break;
      case 'zoom-': state.zoom = clamp(state.zoom - 10, 50, 200); break;
      case 'zoom0': state.zoom = DEFAULTS.zoom; break;
      case 'op+': state.opacity = clamp(state.opacity + 10, 30, 100); break;
      case 'op-': state.opacity = clamp(state.opacity - 10, 30, 100); break;
      case 'op0': state.opacity = DEFAULTS.opacity; break;
      case 'font+': state.font = clamp(state.font + 1, 11, 28); break;
      case 'font-': state.font = clamp(state.font - 1, 11, 28); break;
      case 'font0': state.font = DEFAULTS.font; break;
      case 'light': case 'dark': state.theme = act; break;
    }
    applyView();
  }

  async function setSource(src) {
    state.source = src;
    closeMenus(); applyView();
    toast('Listening to: ' + SOURCES[src]);
    if (state.listening) { await stopListening(); await startListening(); }
  }

  function endClass() {
    if (state.ended) return;
    stopListening();
    state.ended = true;
    $('endedTime').textContent = fmtElapsed(Math.floor((Date.now() - state.startedAt) / 1000));
    const done = state.items.filter(i => i.status === 'done').length;
    $('endedCount').textContent = `${done} question${done === 1 ? '' : 's'} answered`;
    $('strip').hidden = true;
    $('card').hidden = true;
    $('ended').hidden = false;
    closeMenus();
    applyView();
    saveConversation();
  }

  /** Sends the finished class to the dashboard (Conversations). Kept on this computer if the server cannot be reached. */
  async function saveConversation() {
    const line = $('endedSave');
    line.textContent = '';
    if (!live || !api.saveConversation || (!state.log.length && !state.items.length)) return;
    line.textContent = 'Saving to the dashboard…';
    const conversation = {
      uid: state.uid, startedAt: new Date(state.startedAt).toISOString(), endedAt: new Date().toISOString(),
      transcript: state.log,
      items: state.items.map(i => ({ at: i.at.toISOString(), question: i.question, answer: i.text, status: i.status === 'thinking' ? 'unanswered' : i.status, error: i.error || '', source: i.source || '', vote: i.vote })),
    };
    try {
      const r = await api.saveConversation(conversation);
      line.textContent = r && r.saved ? '✓ Saved to the dashboard' : (r && r.message) || 'Not saved';
    } catch (err) { line.textContent = 'Not saved: ' + err.message; }
  }

  function restart() {
    Object.assign(state, { startedAt: Date.now(), ended: false, heard: [], log: [], uid: newUid(), partial: '', items: [], index: -1, editing: false, collapsed: false, notice: null });
    $('endedSave').textContent = '';
    $('strip').hidden = false;
    $('card').hidden = false;
    $('ended').hidden = true;
    applyEngine();
    renderPhrases(); renderCard(); applyView();
  }

  // ---- menus ---------------------------------------------------------------------------------------
  function closeMenus() { $('settings').hidden = true; $('srcMenu').hidden = true; }
  function toggleMenu(id) { const m = $(id); const open = m.hidden; closeMenus(); m.hidden = !open; }

  // ---- wiring --------------------------------------------------------------------------------------
  $('btnMic').addEventListener('click', toggleListening);
  $('btnListen2').addEventListener('click', () => { closeMenus(); toggleListening(); });
  $('btnSource').addEventListener('click', e => { e.stopPropagation(); toggleMenu('srcMenu'); });
  for (const b of document.querySelectorAll('#srcMenu [data-src]')) b.addEventListener('click', () => setSource(b.dataset.src));
  $('btnAnswer').addEventListener('click', answerLatest);
  $('btnShot').addEventListener('click', screenshot);
  $('btnChat').addEventListener('click', () => toggleChat());
  $('chatSend').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape') toggleChat(false);
  });
  $('btnCollapse').addEventListener('click', () => { state.collapsed = !state.collapsed; applyView(); });
  $('btnMenu').addEventListener('click', e => { e.stopPropagation(); toggleMenu('settings'); });
  $('btnEnd').addEventListener('click', endClass);
  $('btnRestart').addEventListener('click', restart);
  function quit() {
    if (!live) { toast('Quit closes the Live Class window in the app (npm run liveclass)'); return; }
    stopListening();
    api.close();
  }
  $('btnQuit').addEventListener('click', quit);
  $('btnClose').addEventListener('click', quit);
  $('btnPrev').addEventListener('click', () => go(-1));
  $('btnNext').addEventListener('click', () => go(1));
  $('thumbUp').addEventListener('click', () => vote(1));
  $('thumbDown').addEventListener('click', () => vote(-1));

  for (const b of document.querySelectorAll('#settings [data-act]')) b.addEventListener('click', () => setting(b.dataset.act));
  $('autoAnswer').addEventListener('click', () => {
    state.autoAnswer = !state.autoAnswer;
    api.setAutoAnswer(state.autoAnswer);
    applyView();
    toast(state.autoAnswer ? 'Auto Answer on: questions are answered as soon as they are heard' : 'Auto Answer off: press Answer (Ctrl+Enter) when a question is finished');
  });
  $('btnDashboard').addEventListener('click', () => { closeMenus(); window.open(DASHBOARD_URL, '_blank', 'noopener'); });
  $('btnEdit').addEventListener('click', () => {
    closeMenus();
    if (!current()) { toast('No question to edit yet'); return; }
    state.editing = true; state.collapsed = false; applyView(); renderCard();
  });
  $('settings').addEventListener('click', e => e.stopPropagation());
  $('srcMenu').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', closeMenus);

  // The window is larger than what it shows (transparent around the panels, and most of it when collapsed):
  // clicks on those empty parts go to the app behind it. Never switched in the middle of a drag or text selection.
  if (live && api.setClickThrough) {
    let through = null;
    document.addEventListener('mousemove', e => {
      if (e.buttons) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const empty = !target || target === document.documentElement || target === document.body || target === $('overlay');
      if (empty !== through) { through = empty; api.setClickThrough(empty); }
    });
  }

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') { closeMenus(); return; }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!e.shiftKey && (e.key === 'q' || e.key === 'Q')) { e.preventDefault(); quit(); }
    else if (e.shiftKey && e.key === 'Enter') { e.preventDefault(); screenshot(); }
    else if (e.shiftKey && (e.code === 'Space' || e.key === ' ')) { e.preventDefault(); toggleChat(); }
    else if (!e.shiftKey && e.key === 'Enter' && !typing) { e.preventDefault(); answerLatest(); }
    else if (!typing && e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (!typing && e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });

  // ---- start ---------------------------------------------------------------------------------------
  const SOURCE_TEXT = { proxy: 'through your licence (no key on this computer)', server: 'key from your licence', local: 'key saved on this computer', none: 'no key' };
  function applyInfo(info) {
    state.info = info;
    const ai = `${PROVIDERS[info.provider] || info.provider} · ${info.model}`;
    const ks = info.keySources || {};
    $('account').textContent = ai;
    $('account').parentElement.title = (info.subject ? 'Subject: ' + info.subject + '\n' : '') + 'AI: ' + ai +
      (ks.groq ? `\nGroq: ${SOURCE_TEXT[ks.groq]}\nGemini (screenshots): ${SOURCE_TEXT[ks.gemini]}` : '');
    if (info.licence) applyLicence(info.licence);
    // the topics and resume set for this customer in the admin dashboard
    const p = info.profile;
    $('focusRowWrap').hidden = !p;
    if (p) {
      const focus = [p.topics.length ? p.topics.join(', ') : '', p.hasResume ? 'resume' : ''].filter(Boolean).join(' · ');
      $('focusRow').textContent = 'Focus: ' + focus;
      $('focusRowWrap').title = 'Set in the admin dashboard (Topics and resume). The AI answers within these areas.' +
        (p.topics.length ? '\nTopics: ' + p.topics.join(', ') : '') + (p.hasResume ? '\nUses the resume to fit the answers to the person\'s experience.' : '');
    }
  }

  $('gateActivate').addEventListener('click', activate);
  $('gateCheck').addEventListener('click', checkAgain);
  $('gateKey').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); activate(); } });
  api.onEngine(applyEngine);
  api.onPipeline(onPipeline);
  if (api.onLicence) api.onLicence(l => { applyLicence(l); applyEngine(); });
  if (api.onInfo) api.onInfo(info => { if (info) { applyInfo(info); applyEngine(); } });
  api.info().then(info => {
    if (!info) return;
    state.source = info.audioSource || state.source;
    state.autoAnswer = !!info.autoAnswer;
    applyInfo(info);
    applyEngine(info.engine);
    applyView();
  });
  renderPhrases(); renderCard(); applyView(); applyLicence();

  // ---- demo: a stand-in for the app's engine when the page is opened in a plain browser ----------------
  function demoAPI() {
    const handlers = { engine: [], pipeline: [] };
    const emit = (ch, m) => handlers[ch].forEach(h => h(m));
    const pipe = (type, d) => emit('pipeline', { type, ...d });
    const SPEECH = [
      'Okay, settle down everyone.', 'Today we continue with plants.', 'What is photosynthesis?', 'Can you hear me at the back?',
      'Why are leaves green?', 'Turn to page 42.', 'Um, sorry, what is chlorophyll?', 'Let us look at the diagram.', 'Do plants breathe at night?',
    ];
    const KNOWLEDGE = [
      { keys: ['photosynthesis'], text: 'Photosynthesis is how green plants make their own food from light.\n- Plants take in carbon dioxide from the air and water from the soil.\n- Chlorophyll in the leaves traps energy from sunlight.\n- That energy turns carbon dioxide and water into glucose and oxygen.' },
      { keys: ['green', 'leaves'], text: 'Leaves look green because of a pigment called chlorophyll.\n- It absorbs red and blue light.\n- It reflects green light, so that is the colour we see.' },
      { keys: ['chlorophyll'], text: 'Chlorophyll is the green pigment in chloroplasts that captures light energy.\n- It is found mainly in leaf cells.\n- Without it a plant cannot carry out photosynthesis.' },
      { keys: ['breathe', 'night'], text: 'Yes. Plants respire all the time, day and night.\n- During the day photosynthesis is faster, so they give out more oxygen than they use.\n- At night they only take in oxygen.' },
      { keys: ['screen', 'diagram'], text: 'The diagram on screen shows a leaf cross-section.\n- Palisade cells are packed with chloroplasts.\n- Stomata on the underside let gases in and out.' },
    ];
    let id = 0, timer = null, next = 0, auto = false, lastAnswered = -1;
    const heard = [];
    function answer(question, source) {
      const n = ++id;
      const hit = KNOWLEDGE.find(k => k.keys.some(key => question.toLowerCase().includes(key)));
      const text = hit ? hit.text : 'Sample answer (open Live Class with "npm run liveclass" for real AI answers).\n- Restate the question simply.\n- Give one clear fact and an example.';
      pipe('answer-start', { id: n, question, source });
      setTimeout(() => pipe('answer-delta', { id: n, delta: text.split('\n')[0] }), 350);
      setTimeout(() => pipe('answer-done', { id: n, text }), 800);
    }
    function hear() {
      const text = SPEECH[next++ % SPEECH.length];
      const words = text.split(' ');
      if (words.length > 2) pipe('partial', { text: words.slice(0, Math.ceil(words.length / 2)).join(' ') });
      setTimeout(() => finish(text), 700);
    }
    function finish(text) {
      heard.push(text);
      pipe('transcript', { text });
      if (auto && isQuestion(text)) { lastAnswered = heard.length - 1; answer(text, 'speech'); }
    }
    setTimeout(() => {
      emit('engine', { state: 'ready', message: '' });
      answer('What is photosynthesis?', 'typed');
    }, 300);
    return {
      info: () => Promise.resolve({ engine: { state: 'starting', message: 'Loading the speech model…' }, provider: 'demo', model: 'sample data', subject: 'Science: plants', hasKey: true, audioSource: 'mic', autoAnswer: false, language: 'en' }),
      sendAudio() {}, close() {},
      setListening(on) { clearInterval(timer); if (on) { timer = setInterval(hear, 2600); hear(); } },
      askLast() {
        const at = heard.length - 1;
        if (at <= lastAnswered) { pipe('warning', { message: 'Nothing new has been heard since the last answer.' }); return; }
        lastAnswered = at;
        answer(heard[at], 'speech');
      },
      askTyped: text => answer(text, 'typed'),
      captureScreen: () => { pipe('screen', { state: 'reading' }); setTimeout(() => answer('Explain the diagram on my screen.', 'screen'), 500); },
      setAutoAnswer: on => { auto = on; },
      onEngine: cb => handlers.engine.push(cb),
      onPipeline: cb => handlers.pipeline.push(cb),
    };
  }
})();
