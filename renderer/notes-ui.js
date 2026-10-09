// UI logic for the private notes window. Everything shown is inserted as TEXT (never as HTML),
// so nothing a student says or the AI writes can inject markup into this window.
(function () {
  'use strict';
  const api = window.notesAPI;
  const $ = id => document.getElementById(id);

  const els = {
    dot: $('dot'), statusText: $('statusText'),
    btnListen: $('btnListen'), btnAskLast: $('btnAskLast'), meter: $('meter'),
    banner: $('banner'), heard: $('heard'), qlist: $('qlist'), qEmpty: $('qEmpty'), answerPane: $('answerPane'),
    settings: $('settings'),
  };

  let settings = null;
  let engine = { state: 'starting', message: '' };
  let listening = false;
  let capture = null;
  let starting = false;
  let lastLevelPaint = 0;
  const heardLines = [];

  // ---- small helpers -------------------------------------------------------------------------------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function banner(kind, text) {
    els.banner.className = 'banner' + (text ? ` show ${kind}` : '');
    els.banner.textContent = text || '';
  }

  function setStatus(dotClass, text) {
    els.dot.className = 'dot' + (dotClass ? ' ' + dotClass : '');
    els.statusText.textContent = text;
  }

  function refreshButtons() {
    const ready = engine.state === 'ready';
    els.btnListen.disabled = !ready || starting;
    els.btnAskLast.disabled = !ready;
    els.btnListen.textContent = listening ? '■ Stop listening' : '▶ Start listening';
    els.btnListen.className = 'btn ' + (listening ? 'stop' : 'primary');
  }

  function refreshStatus(status) {
    if (engine.state === 'setup-needed') return setStatus('bad', 'Setup needed');
    if (engine.state === 'error') return setStatus('bad', 'Engine problem');
    if (engine.state === 'starting') return setStatus('busy', 'Starting speech engine…');
    if (!listening) return setStatus('', '🔒 Private Assistant · idle');
    if (status && status.answering) return setStatus('busy', 'Answering…');
    if (status && status.transcribing) return setStatus('busy', 'Transcribing…');
    setStatus('live', settings && !settings.autoAnswer ? 'Listening · press ✔ Question finished' : 'Listening');
  }

  // ---- engine state --------------------------------------------------------------------------------

  function applyEngine(next) {
    engine = next || engine;
    if (engine.state === 'setup-needed') banner('warn', engine.message);
    else if (engine.state === 'error') banner('error', engine.message);
    else if (engine.state === 'starting') banner('info', engine.message || 'Loading the speech model…');
    else if (!settings || !settings.hasKey) banner('warn', 'Add your AI API key in Settings (⚙) so questions can be answered.');
    else banner('', '');
    refreshButtons();
    refreshStatus();
  }

  // ---- listening -----------------------------------------------------------------------------------

  async function startListening() {
    if (listening || starting || engine.state !== 'ready') return;
    starting = true; refreshButtons();
    try {
      const source = (settings && settings.audioSource) || 'both';
      capture = await window.LiveCapture.start(source, {
        onFrame: buffer => api.sendAudio(buffer),
        onLevel: rms => paintLevel(rms),
        onEnded: () => { if (listening) { stopListening(); banner('warn', 'The audio source stopped. Press Start to listen again.'); } },
        onStalled: () => { if (listening) banner('warn', 'No sound is coming from the audio source. Check the microphone in Windows, then press Stop and Start.'); },
      });
      listening = true;
      api.setListening(true);
      applyEngine();
    } catch (err) {
      listening = false;
      banner('error', `Could not start listening: ${err && err.message ? err.message : err}`);
    } finally {
      starting = false; refreshButtons(); refreshStatus();
    }
  }

  async function stopListening() {
    listening = false;
    api.setListening(false);
    if (capture) { const c = capture; capture = null; await c.stop(); }
    els.meter.style.width = '0%';
    refreshButtons(); refreshStatus();
  }

  function toggleListening() { return listening ? stopListening() : startListening(); }

  function paintLevel(rms) {
    const now = performance.now();
    if (now - lastLevelPaint < 60) return;
    lastLevelPaint = now;
    const pct = Math.min(100, Math.round(Math.sqrt(rms) * 220)); // gentle curve so quiet speech is visible
    els.meter.style.width = pct + '%';
  }

  // ---- transcript + answers ------------------------------------------------------------------------

  function addHeard(text) {
    heardLines.push(text);
    while (heardLines.length > 3) heardLines.shift();
    els.heard.textContent = '';
    heardLines.forEach(t => els.heard.appendChild(el('div', '', t)));
  }

  // Left: every question that was asked (newest on top). Right: the answer to the selected question.
  // Several questions can be answered at the same time; each one fills in on its own.
  const MAX_QUESTIONS = 50;
  const questions = new Map(); // id -> { id, question, text, status: 'thinking' | 'done' | 'error', item }
  let selectedId = null;

  function selected() { return questions.get(selectedId) || null; }

  function paintItem(q) {
    q.item.className = `qitem ${q.status}${q.id === selectedId ? ' selected' : ''}${q.unseen ? ' unseen' : ''}`;
  }

  function paintAnswer() {
    const q = selected();
    els.answerPane.textContent = '';
    if (!q) { els.answerPane.appendChild(el('div', 'empty', 'Questions that are asked appear on the left. Pick one to read its answer here.')); return; }
    els.answerPane.appendChild(el('div', 'label', 'Question heard'));
    els.answerPane.appendChild(el('div', 'q', `“${q.question}”`));
    const text = q.status === 'thinking' && !q.text ? 'Thinking…' : q.text;
    if (q.status === 'error' || (q.status === 'thinking' && !q.text)) {
      answerEl = el('div', 'a' + (q.status === 'error' ? ' error' : ' pending'), text);
    } else {
      // one statement per line, each as its own block, so there is a pause between them
      answerEl = el('div', 'a lines');
      window.ReadFormat.toLines(q.text).forEach(line => answerEl.appendChild(el('div', /^([-•*–]|\d{1,2}[.)])\s/.test(line) ? 'line item' : 'line', line)));
    }
    els.answerPane.appendChild(answerEl);
  }
  let answerEl = null;

  function select(id) {
    selectedId = id;
    const q = questions.get(id);
    if (q) q.unseen = false;
    questions.forEach(paintItem);
    paintAnswer();
  }

  function newQuestion(id, question) {
    els.qEmpty.style.display = 'none';
    const item = el('div', 'qitem thinking');
    item.appendChild(el('span', 'qdot'));
    item.appendChild(el('span', 'qtext', question));
    item.addEventListener('click', () => select(id));
    els.qlist.insertBefore(item, els.qlist.firstChild);
    const q = { id, question, text: '', status: 'thinking', item, unseen: false };
    questions.set(id, q);

    const current = selected();
    if (!current || current.status !== 'thinking') select(id);   // do not pull the teacher away from an answer still being written
    else { q.unseen = true; paintItem(q); }

    while (questions.size > MAX_QUESTIONS) {                      // forget the oldest finished one
      const oldest = [...questions.values()].find(x => x.status !== 'thinking' && x.id !== selectedId);
      if (!oldest) break;
      removeQuestion(oldest.id);
    }
  }

  function removeQuestion(id) {
    const q = questions.get(id);
    if (!q) return;
    if (q.item.parentNode) q.item.parentNode.removeChild(q.item);
    questions.delete(id);
    if (selectedId === id) {
      const newest = [...questions.values()].pop();
      if (newest) select(newest.id); else { selectedId = null; paintAnswer(); }
    }
    if (!questions.size) els.qEmpty.style.display = '';
  }

  function onPipeline(m) {
    const q = questions.get(m.id);
    switch (m.type) {
      case 'transcript': addHeard(m.text); break;
      case 'status': refreshStatus(m); break;
      case 'answer-start': newQuestion(m.id, m.question); break;
      case 'answer-delta':
        if (q) {
          q.text += m.delta;
          if (q.id === selectedId) paintAnswer(); else if (!q.unseen) { q.unseen = true; paintItem(q); }
        }
        break;
      case 'answer-done':
        if (q) {
          q.text = m.text; q.status = 'done';
          if (q.id === selectedId) paintAnswer(); else q.unseen = true;
          paintItem(q);
        }
        break;
      case 'answer-skip': removeQuestion(m.id); break;       // the AI decided it was not a real question
      case 'answer-cancelled': removeQuestion(m.id); break;
      case 'answer-error':
        if (q) {
          q.status = 'error'; q.text = m.message;
          if (q.id === selectedId) paintAnswer(); else q.unseen = true;
          paintItem(q);
        } else banner('error', m.message);
        break;
      case 'error': banner('error', m.message); break;
      case 'warning': banner('warn', m.message); break;
    }
  }

  // ---- settings ------------------------------------------------------------------------------------

  /** Show only the model list, key field and key hint of the provider chosen in the dropdown. */
  function showProvider() {
    const provider = $('sProvider').value;
    const gemini = provider === 'gemini';
    const groq = provider === 'groq';
    $('rowGeminiModel').style.display = gemini ? '' : 'none';
    $('rowGroqModel').style.display = groq ? '' : 'none';
    $('rowClaudeModel').style.display = provider === 'claude' ? '' : 'none';
    $('keyLabel').textContent = gemini ? 'Google Gemini API key' : groq ? 'Groq API key' : 'Anthropic API key';
    $('sKey').placeholder = gemini ? 'AIza…' : groq ? 'gsk_…' : 'sk-ant-…';
    const key = (settings && settings.keys && settings.keys[provider]) || {};
    const env = gemini ? 'GEMINI_API_KEY' : groq ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY';
    $('keyHint').textContent = key.source === 'environment'
      ? `Using the ${env} environment variable.`
      : key.has ? 'A key is saved (encrypted). Paste a new one to replace it.'
        : gemini ? 'No key yet. Get a free one at aistudio.google.com/apikey. It is stored encrypted on this computer.'
          : groq ? 'No key yet. Get a free one at console.groq.com/keys. It is stored encrypted on this computer.'
            : 'No key yet. It is stored encrypted on this computer and is never shown again.';
  }

  function fillSettings() {
    if (!settings) return;
    $('sSubject').value = settings.subject || '';
    $('sSource').value = settings.audioSource;
    $('sProvider').value = settings.provider;
    $('sGeminiModel').value = settings.geminiModel;
    $('sGroqModel').value = settings.groqModel;
    $('sModel').value = settings.model;
    $('sEffort').value = settings.effort;
    $('sAuto').checked = !!settings.autoAnswer;
    $('sKey').value = '';
    showProvider();
  }

  async function saveSettings() {
    const patch = {
      subject: $('sSubject').value.trim(),
      audioSource: $('sSource').value,
      provider: $('sProvider').value,
      geminiModel: $('sGeminiModel').value,
      groqModel: $('sGroqModel').value,
      model: $('sModel').value,
      effort: $('sEffort').value,
      autoAnswer: $('sAuto').checked,
    };
    const sourceChanged = settings && patch.audioSource !== settings.audioSource;
    settings = await api.saveSettings(patch);
    const key = $('sKey').value.trim();
    let message = 'Saved ✓';
    if (key) {
      const res = await api.setApiKey($('sProvider').value, key);
      if (res && res.ok) settings = res; else message = 'Could not store the key securely on this computer.';
      $('sKey').value = '';
    }
    fillSettings();
    $('saved').textContent = message;
    setTimeout(() => { $('saved').textContent = ''; }, 3000);
    if (sourceChanged && listening) { await stopListening(); banner('info', 'Audio source changed. Press Start to listen again.'); }
    else applyEngine();
  }

  // ---- no tooltips ----------------------------------------------------------------------------------
  // A title="..." tooltip is drawn by Windows as a separate little window, which a screen share can capture even though
  // this window itself is hidden. So the page never keeps a title attribute: it becomes an aria-label instead.
  function stopTooltips() {
    const strip = node => {
      if (node.nodeType !== 1) return;
      const nodes = [node, ...node.querySelectorAll('[title]')];
      for (const n of nodes) {
        if (!n.hasAttribute('title')) continue;
        if (!n.hasAttribute('aria-label')) n.setAttribute('aria-label', n.getAttribute('title'));
        n.removeAttribute('title');
      }
    };
    strip(document.body);
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === 'attributes') strip(m.target);
        else m.addedNodes.forEach(strip);
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  }

  // ---- Export (a menu) and Clear (asks twice): no Windows dialogs, they are separate windows a share could capture ----
  function setupExportAndClear() {
    const menu = $('exportMenu'), btn = $('btnExport');
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    menu.querySelectorAll('button').forEach(item => item.addEventListener('click', async () => {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      const res = await api.exportSession(item.dataset.format);
      if (!res) return;
      banner(res.ok ? 'info' : 'warn', res.ok ? `Saved ${res.questions} question(s) to ${res.path}` : res.message);
      setTimeout(() => { if (els.banner.textContent.startsWith('Saved') || els.banner.textContent.startsWith('Nothing') || els.banner.textContent.startsWith('Could not save')) applyEngine(); }, 10000);
    }));

    const clear = $('btnClear');
    let armed = null;
    clear.addEventListener('click', async () => {
      if (!armed) {
        clear.textContent = 'Click again to clear';
        clear.classList.add('stop');
        armed = setTimeout(() => { armed = null; clear.textContent = 'Clear'; clear.classList.remove('stop'); }, 4000);
        return;
      }
      clearTimeout(armed); armed = null;
      clear.textContent = 'Clear'; clear.classList.remove('stop');
      await api.clearSession();
      [...questions.keys()].forEach(removeQuestion);
    });
  }

  // ---- restart / reset: the way out when something is stuck ---------------------------------------------
  let resumeAfterRestart = false;

  async function restartAssistant() {
    resumeAfterRestart = listening || resumeAfterRestart;
    banner('info', 'Restarting the assistant…');
    await api.resetAssistant();
  }

  function setupReset() {
    $('btnReset').addEventListener('click', restartAssistant);
    $('btnResetAssistant').addEventListener('click', () => { showSettings(false); restartAssistant(); });

    const hard = $('btnResetSettings');
    let armed = null;
    hard.addEventListener('click', async () => {
      if (!armed) {
        hard.textContent = 'Click again to reset everything';
        armed = setTimeout(() => { armed = null; hard.textContent = 'Reset all settings…'; }, 4000);
        return;
      }
      clearTimeout(armed); armed = null; hard.textContent = 'Reset all settings…';
      resumeAfterRestart = false;
      banner('info', 'Resetting the settings…');
      const fresh = await api.resetSettings();
      if (fresh) { settings = fresh; fillSettings(); showOpacity(settings.opacity); }
      applyEngine();
    });
  }

  /** The main process is rebuilding the assistant: stop the sound, drop what was waiting, and carry on afterwards. */
  async function onResetBegin() {
    if (listening) resumeAfterRestart = true;
    await stopListening();
    [...questions.values()].filter(q => q.status === 'thinking').forEach(q => removeQuestion(q.id));
  }
  function onResetDone() {
    applyEngine();
    if (resumeAfterRestart && engine.state === 'ready') { resumeAfterRestart = false; startListening(); }
  }

  // ---- opacity menu, drawn inside the window ----------------------------------------------------------
  function showOpacity(value) { $('opacityBtn').textContent = value + '% ▾'; document.querySelectorAll('#opacityMenu button').forEach(b => b.classList.toggle('sel', Number(b.dataset.value) === Number(value))); }

  function setupOpacityMenu() {
    const menu = $('opacityMenu'), btn = $('opacityBtn');
    for (let v = 100; v >= 10; v -= 10) {
      const item = el('button', '', v + '%');
      item.dataset.value = String(v);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', async () => {
        menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
        settings = await api.saveSettings({ opacity: v });
        showOpacity(v);
      });
      menu.appendChild(item);
    }
    btn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });
    showOpacity((settings && settings.opacity) || 100);
  }

  // ---- our own pointer + moving/resizing by hand while the real pointer is invisible -----------------
  function setupSoftPointer() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('id', 'fakePointer'); svg.setAttribute('viewBox', '0 0 14 21'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M1 1 L1 17 L5 13.3 L7.8 19.8 L10.2 18.8 L7.5 12.4 L12.8 12.4 Z');
    path.setAttribute('fill', '#ffffff'); path.setAttribute('stroke', '#111111'); path.setAttribute('stroke-width', '1.2'); path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    document.body.appendChild(svg);

    document.addEventListener('mousemove', e => { svg.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; svg.classList.add('on'); });
    document.documentElement.addEventListener('mouseleave', () => svg.classList.remove('on'));
    window.addEventListener('blur', () => svg.classList.remove('on'));

    const startDrag = (mode, e) => {
      if (!document.body.classList.contains('nocursor')) return;
      e.preventDefault();
      const sx = e.screenX, sy = e.screenY;
      api.dragStart();
      const move = ev => api.drag({ mode, dx: ev.screenX - sx, dy: ev.screenY - sy });
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); api.dragEnd(); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    };
    document.querySelector('.titlebar').addEventListener('mousedown', e => { if (!e.target.closest('button, .opmenu')) startDrag('move', e); });
    $('grip').addEventListener('mousedown', e => startDrag('resize', e));
  }

  function showSettings(show) {
    els.settings.classList.toggle('show', show);
    document.body.classList.toggle('settings-open', show);
    if (show) fillSettings();
  }

  // ---- notes tab (kept from the original app) ------------------------------------------------------

  function setupNotes() {
    const box = $('notes');
    try { box.value = localStorage.getItem('tna.notes') || ''; } catch (_) { /* storage unavailable */ }
    box.addEventListener('input', () => { try { localStorage.setItem('tna.notes', box.value); } catch (_) { /* ignore */ } });
  }

  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab.dataset.view));
    }));
  }

  // ---- start up ------------------------------------------------------------------------------------

  async function init() {
    setupTabs(); setupNotes();
    $('btnHide').addEventListener('click', () => api.hide());
    $('btnSettings').addEventListener('click', () => showSettings(!els.settings.classList.contains('show')));
    $('btnCloseSettings').addEventListener('click', () => showSettings(false));
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('sProvider').addEventListener('change', showProvider);
    setupOpacityMenu();
    setupSoftPointer();
    setupReset();
    stopTooltips();
    setupExportAndClear();
    $('btnTestAI').addEventListener('click', async () => {
      const out = $('testOut');
      out.className = 'testout show';
      out.textContent = 'Testing… (press Save first if you changed the service, model or key)';
      const res = await api.testAI();
      out.textContent = res.lines.join('\n');
    });
    els.btnListen.addEventListener('click', toggleListening);
    els.btnAskLast.addEventListener('click', () => api.askLast());

    api.onPipeline(onPipeline);
    api.onEngine(applyEngine);
    api.onUi(m => {
      if (!m) return;
      if (m.type === 'toggle-listening') toggleListening();
      if (m.type === 'reset-begin') onResetBegin();
      if (m.type === 'reset-done') onResetDone();
      if (m.type === 'opacity') { showOpacity(m.value); if (settings) settings.opacity = m.value; }   // reset by Ctrl/Cmd+Shift+T
    });

    settings = await api.getSettings();
    showOpacity(settings.opacity);
    applyEngine(await api.getEngine());
    if (settings && !settings.hasKey) showSettings(true);
  }

  init();
})();
