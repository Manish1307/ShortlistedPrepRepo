const { app, BrowserWindow, globalShortcut, ipcMain, screen, session, desktopCapturer } = require('electron');
const fs = require('fs');
const exporter = require('./src/export');
const os = require('os');
const path = require('path');

const config = require('./src/config');
const { Answerer } = require('./src/ai/answerer');
const { GeminiAnswerer } = require('./src/ai/gemini');
const { GroqAnswerer } = require('./src/ai/groq');
const { AnswerRouter } = require('./src/ai/router');
const { Pipeline } = require('./src/pipeline');
const { WhisperServer } = require('./src/stt/whisperServer');

const WHISPER_DIR = process.env.TNA_WHISPER_DIR || path.join(__dirname, 'whisper');
const BIN_DIR = path.join(WHISPER_DIR, 'bin');
const MODELS_DIR = path.join(WHISPER_DIR, 'models');

let mainWindow;
let notesWindow;
let whisper = null;
let answerer = null;
let pipeline = null;
let engine = { state: 'starting', message: '' };

// ---- windows ---------------------------------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    title: 'Teaching Content (this is what you share)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('main-window.html');
}

function createNotesWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  notesWindow = new BrowserWindow({
    width: 880,
    height: 640,
    x: Math.max(0, width - 900),
    y: 40,
    frame: false,          // no title bar - custom UI instead
    alwaysOnTop: true,
    resizable: false,       // the window is resized with its own corner mark: Windows draws its own (capturable) pointer on the edges
    skipTaskbar: true,     // don't show in taskbar/alt-tab either
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  notesWindow.loadFile('notes-window.html');
  notesWindow.setOpacity(config.load().opacity / 100);   // how see-through the window is

  // THIS is the key line: excludes this window from screen capture
  // (WDA_EXCLUDEFROMCAPTURE on Windows, NSWindow.sharingType = .none on macOS)
  notesWindow.setContentProtection(true);

  // Keep it above fullscreen apps/screen-share overlays too
  notesWindow.setAlwaysOnTop(true, 'screen-saver');
  notesWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

/** Send a message to the private notes window (never to the shared one). */
function toNotes(channel, payload) {
  if (notesWindow && !notesWindow.isDestroyed()) notesWindow.webContents.send(channel, payload);
}

// ---- audio capture permission ---------------------------------------------------------------------

function isNotesFrame(frame) {
  return !!(frame && /notes-window\.html$/.test(frame.url || ''));
}

function setupMediaPermissions() {
  const ses = session.defaultSession;

  // "What the meeting plays": Windows system-audio loopback. Only the private notes page may ask for it.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isNotesFrame(request.frame)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      callback({ video: sources[0], audio: 'loopback' }); // the page drops the video track straight away
    } catch (_) { callback({}); }
  });

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const ours = notesWindow && !notesWindow.isDestroyed() && wc === notesWindow.webContents;
    callback(ours && ['media', 'display-capture'].includes(permission));
  });
}

// ---- speech + AI engine ---------------------------------------------------------------------------

function setEngine(state, message = '') {
  engine = { state, message };
  toNotes('engine', engine);
}

function pickThreads() {
  return Math.max(2, Math.min(8, os.cpus().length - 4)); // leave cores for the meeting app
}

// What happened and when (heard text, questions asked, errors), to help find problems. Never contains audio or keys.
const LOG_FILE = () => path.join(app.getPath('userData'), 'debug.log');
function debugLog(type, data) {
  try {
    const d = data || {};
    if (type === 'status') { fs.appendFileSync(LOG_FILE(), `${new Date().toISOString()} status listening=${d.listening} transcribing=${d.transcribing} queued=${d.queued} answering=${d.answering}\n`); return; }
    if (type === 'segment') { fs.appendFileSync(LOG_FILE(), `${new Date().toISOString()} segment ${(d.ms / 1000).toFixed(1)}s peak ${d.peakDb} dB -> ${d.outcome}${d.raw ? ': "' + String(d.raw).slice(0, 120) + '"' : ''}\n`); return; }
    const detail = d.firstWordMs !== undefined ? `first words after ${d.firstWordMs} ms, finished after ${d.totalMs} ms` : d.decision ? `${d.decision}: ${d.text}` : d.question || d.text || d.message || (d.delta ? '(streaming)' : '');
    if (type === 'answer-delta') return;
    require('fs').appendFileSync(LOG_FILE(), `${new Date().toISOString()} ${type}${d.id ? ' #' + d.id : ''} ${String(detail).slice(0, 300)}
`);
  } catch (_) { /* logging must never break the app */ }
}

// ---- the session: every question, answer and response time, for the "Export" button -------------------

const session_ = { startedAt: new Date().toISOString(), entries: new Map(), transcript: [], lastHeardAt: 0 };

function activeModel(s) { return s.provider === 'gemini' ? s.geminiModel : s.provider === 'groq' ? s.groqModel : s.model; }

function recordSession(type, d) {
  const now = Date.now();
  const entries = session_.entries;
  if (type === 'transcript') {
    session_.transcript.push({ at: new Date().toISOString(), text: d.text });
    session_.lastHeardAt = now;
  } else if (type === 'answer-start') {
    const s = config.load();
    entries.set(d.id, {
      id: d.id, askedAt: new Date().toISOString(), question: d.question, answer: '', status: 'answering',
      waitMs: session_.lastHeardAt ? now - session_.lastHeardAt : null,   // from the last words heard to the answer starting
      firstWordMs: null, totalMs: null, provider: s.provider, model: activeModel(s),
    });
  } else if (entries.has(d.id)) {
    const e = entries.get(d.id);
    if (type === 'timing') { e.firstWordMs = d.firstWordMs; e.totalMs = d.totalMs; }
    else if (type === 'answer-done') { e.answer = d.text; e.status = 'done'; }
    else if (type === 'answer-error') { e.status = 'error'; e.error = d.message; }
    else if (type === 'answer-skip' || type === 'answer-cancelled') entries.delete(d.id);
  }
}

function sessionData() {
  const s = config.load();
  return {
    startedAt: session_.startedAt, exportedAt: new Date().toISOString(), subject: s.subject, provider: s.provider, model: activeModel(s),
    entries: [...session_.entries.values()].sort((a, b) => a.id - b.id), transcript: session_.transcript,
  };
}

let logCleared = false;
let restarting = false;

async function startEngine() {
  const settings = config.load();
  answerer = new AnswerRouter({
    provider: settings.provider,
    gemini: new GeminiAnswerer({ apiKey: config.getApiKey('gemini'), model: settings.geminiModel, effort: settings.effort, subject: settings.subject }),
    groq: new GroqAnswerer({ apiKey: config.getApiKey('groq'), model: settings.groqModel, effort: settings.effort, subject: settings.subject }),
    claude: new Answerer({ apiKey: config.getApiKey('claude'), model: settings.model, effort: settings.effort, subject: settings.subject }),
  });

  const modelPath = path.join(MODELS_DIR, settings.whisperModel);
  const problem = WhisperServer.problem(BIN_DIR, modelPath);
  if (problem) {
    setEngine('setup-needed', `${problem}. Run "npm run setup:whisper" once to download the offline speech engine.`);
    return;
  }

  setEngine('starting', 'Loading the speech model...');
  whisper = new WhisperServer({
    binDir: BIN_DIR,
    modelPath,
    threads: pickThreads(),
    language: settings.language,
    prompt: settings.subject ? `Topic: ${settings.subject}.` : '',
  });
  whisper.on('exit', code => { if (engine.state === 'ready') setEngine('error', `The speech engine stopped (code ${code}). Restart the app.`); });
  try {
    await whisper.start();
  } catch (err) {
    setEngine('error', `Could not start the speech engine: ${err.message}`);
    return;
  }

  pipeline = new Pipeline({
    whisper,
    answerer,
    subject: settings.subject,
    autoAnswer: settings.autoAnswer,
  });
  if (!logCleared) { logCleared = true; try { require('fs').writeFileSync(LOG_FILE(), ''); } catch (_) { /* ignore */ } }
  pipeline.pause(); // listening starts when the teacher presses the button
  for (const type of ['transcript', 'status', 'warning', 'error',
    'gate', 'timing', 'segment', 'answer-start', 'answer-delta', 'answer-done', 'answer-skip', 'answer-cancelled', 'answer-error']) {
    pipeline.on(type, data => { debugLog(type, data); recordSession(type, data); toNotes('pipeline', { type, ...data }); });
  }
  setEngine('ready');
}

// Every 5 s while listening: is sound arriving, and how loud is it compared with the noise floor? (written to the log)
setInterval(() => {
  if (!audioStats.listening || !pipeline) return;
  const lvl = pipeline.lastLevel;
  const n = audioStats.chunks;
  audioStats.chunks = 0;
  try {
    fs.appendFileSync(LOG_FILE(), `${new Date().toISOString()} audio chunks=${n} level=${lvl ? Math.round(lvl.db) : '?'} dB noise-floor=${lvl ? Math.round(lvl.noiseDb) : '?'} dB speaking=${lvl ? lvl.speaking : '?'}\n`);
  } catch (_) { /* logging must never break the app */ }
  audioStats.silentChecks = n === 0 ? audioStats.silentChecks + 1 : 0;
  if (audioStats.silentChecks === 2) {
    toNotes('pipeline', { type: 'warning', message: 'No sound is reaching the app. Check that the right microphone is selected in Windows and is not muted, then press Stop listening and Start listening.' });
  }
}, 5000).unref();

/**
 * "Restart assistant": the way out when it is stuck. Stops what is running (sound capture is stopped by the page,
 * waiting answers are cancelled, the speech engine is shut down) and builds everything again from the saved settings.
 * Nothing the teacher typed is lost: settings, saved keys, the question list and the follow-up memory stay.
 */
async function restartAssistant(reason = 'restart') {
  if (restarting) return;
  restarting = true;
  try {
    debugLog('note', { message: reason + ': restarting the assistant' });
    toNotes('ui', { type: 'reset-begin' });
    const memory = pipeline ? pipeline.qa : [];
    if (pipeline) { pipeline.removeAllListeners(); pipeline.stop(); }
    if (whisper) { whisper.removeAllListeners(); whisper.on('error', () => {}); whisper.stop(); }
    pipeline = null; whisper = null;
    audioStats.listening = false; audioStats.chunks = 0; audioStats.silentChecks = 0;
    await startEngine();
    if (pipeline) pipeline.qa = memory;
  } catch (err) {
    setEngine('error', 'Could not restart the assistant: ' + err.message);
  } finally {
    restarting = false;
    toNotes('ui', { type: 'reset-done' });
  }
}

function stopEngine() {
  if (pipeline) pipeline.stop();
  if (whisper) whisper.stop();
}

// ---- `npm run smoke`: opens the windows, checks the page wiring, prints a report and exits ------------

function runSmokeTest() {
  const wc = notesWindow.webContents;
  const problems = [];
  wc.on('console-message', (_e, level, message) => { if (level >= 2) problems.push(message); });
  wc.on('preload-error', (_e, file, err) => problems.push(`preload error in ${file}: ${err.message}`));
  wc.once('did-finish-load', () => setTimeout(async () => {
    const page = await wc.executeJavaScript(`({
      bridge: Object.keys(window.notesAPI || {}),
      capture: typeof (window.LiveCapture && window.LiveCapture.start),
      listenButton: !!document.getElementById('btnListen'),
      settingsOpen: document.getElementById('settings').classList.contains('show'),
      status: document.getElementById('statusText').textContent,
      pointerHiddenEverywhere: (() => {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 80, bubbles: true }));
        const fake = document.getElementById('fakePointer');
        const ownPointer = fake ? { exists: true, shown: getComputedStyle(fake).display !== 'none', at: fake.style.transform } : { exists: false };
        const bad = [...document.querySelectorAll('body *')].filter(e => e.offsetParent !== null && getComputedStyle(e).cursor !== 'none').map(e => e.tagName + '#' + e.id + '.' + e.className);
        const titleDrag = getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('-webkit-app-region');
        fake && fake.classList.remove('on');
        return { elementsStillShowingPointer: bad, titleBarDragArea: titleDrag, ownPointer };
      })(),
      banner: document.getElementById('banner').textContent
    })`);
    // a title="..." added later must be removed straight away (Windows draws those tooltips as separate windows)
    page.elementsWithTooltip = await wc.executeJavaScript("new Promise(r => { const t = document.createElement('button'); t.title = 'late tooltip'; document.body.appendChild(t); setTimeout(() => { const left = document.querySelectorAll('[title]').length; t.remove(); r(left); }, 80); })");
    if (process.env.TNA_SMOKE_RESTART) {   // really restart the assistant and see it come back
      const before = engine.state;
      await restartAssistant('smoke test');
      page.restart = { before, after: engine.state, pipelineBack: !!pipeline, whisperBack: !!(whisper && whisper.ready) };
    }
    if (process.env.TNA_SMOKE_DEMO) { // sample events so the screenshot shows a real question and answer
      await wc.executeJavaScript("document.getElementById('btnCloseSettings').click()");
      const demo = (type, data) => toNotes('pipeline', { type, ...data });
      demo('transcript', { text: 'Today we are solving quadratic equations by completing the square.' });
      demo('transcript', { text: 'What is the discriminant of a quadratic equation?' });
      demo('answer-start', { id: 1, question: 'What is the discriminant of a quadratic equation?' });
      const answer = [
        'The discriminant is b^2 - 4ac. It tells you how many real roots ax^2 + bx + c = 0 has.',
        '',
        '- Positive: two different real roots',
        '- Zero: one repeated real root',
        '- Negative: no real roots (two complex roots)',
      ].join('\n');
      demo('answer-delta', { id: 1, delta: answer });
      demo('answer-done', { id: 1, text: answer });
      demo('answer-start', { id: 2, question: 'What is the difference between an API and a web service?' });
      demo('answer-done', { id: 2, text: 'An API is any way for two programs to talk to each other.\n\nA web service is one kind of API that works over a network, usually HTTP.' });
      demo('answer-start', { id: 3, question: 'What is custom connector? Please explain.' });
      demo('answer-done', { id: 3, text: 'A custom connector is a way to bring any external REST API into Power Platform so you can call it from Power Automate, Power Apps, or Power Virtual Agents. You define the connector by providing the API’s URL, authentication method, and the actions (operations) you want to expose. Then the connector appears like a built-in action you can drag into a flow or use in an app.' });
      await new Promise(r => setTimeout(r, 500));
    }
    const report = { page, engine, contentProtectionOn: true, problems };
    console.log('SMOKE ' + JSON.stringify(report, null, 1));
    if (process.env.TNA_SMOKE_SHOT) {
      notesWindow.setContentProtection(false); // test-only: protection also blanks our own screenshot
      notesWindow.showInactive();
      await new Promise(r => setTimeout(r, 1200));
      const image = await wc.capturePage();
      console.log('SHOT size', JSON.stringify(image.getSize()), 'visible', notesWindow.isVisible(), 'bounds', JSON.stringify(notesWindow.getBounds()));
      require('fs').writeFileSync(process.env.TNA_SMOKE_SHOT, image.toPNG());
    }
    app.quit();
  }, 3500));
}

// ---- app lifecycle --------------------------------------------------------------------------------

app.whenReady().then(() => {
  setupMediaPermissions();
  createMainWindow();
  createNotesWindow();
  notesWindow.webContents.once('did-finish-load', () => startEngine());
  if (process.argv.includes('--smoke')) runSmokeTest();

  // Global hotkey: Ctrl+Shift+N (Cmd+Shift+N on macOS) toggles the notes window
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  globalShortcut.register(`${mod}+Shift+N`, () => {
    if (!notesWindow) return;
    if (notesWindow.isVisible()) {
      notesWindow.hide();
    } else {
      notesWindow.show();
    }
  });
  // Ctrl+Shift+L starts / stops listening; Ctrl+Shift+A = "question finished": answer what was said so far
  // Ctrl+Alt+Shift+R restarts the assistant, even when the page does not react
  globalShortcut.register(`${mod}+Alt+Shift+R`, () => { restartAssistant('shortcut'); });
  // Ctrl+Shift+T puts the window back to fully visible (in case it was made too faint to find)
  globalShortcut.register(`${mod}+Shift+T`, () => { const next = config.save({ opacity: 100 }); if (notesWindow) notesWindow.setOpacity(1); toNotes('ui', { type: 'opacity', value: next.opacity }); });
  globalShortcut.register(`${mod}+Shift+L`, () => toNotes('ui', { type: 'toggle-listening' }));
  globalShortcut.register(`${mod}+Shift+A`, () => { if (pipeline) pipeline.completeQuestion(); });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      createNotesWindow();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopEngine();
});

// ---- messages from the notes window ---------------------------------------------------------------

// Let the notes window renderer ask to close/hide itself
ipcMain.on('notes:hide', () => {
  if (notesWindow) notesWindow.hide();
});

function fromNotes(event) {
  return notesWindow && !notesWindow.isDestroyed() && event.sender === notesWindow.webContents;
}

// 16 kHz mono Int16 audio from the page
const audioStats = { chunks: 0, since: Date.now(), listening: false, silentChecks: 0 };
ipcMain.on('audio:chunk', (event, data) => {
  if (!fromNotes(event) || !pipeline) return;
  audioStats.chunks++;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  pipeline.feed(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 2))));
});

ipcMain.on('listening:set', (event, on) => {
  if (!fromNotes(event) || !pipeline) return;
  audioStats.listening = !!on; audioStats.chunks = 0; audioStats.silentChecks = 0;
  debugLog('note', { message: on ? 'listening started' : 'listening stopped' });
  if (on) pipeline.resume(); else pipeline.pause();
});

ipcMain.on('ask:last', event => {
  if (fromNotes(event) && pipeline) pipeline.completeQuestion();   // "question finished"
});

ipcMain.handle('engine:status', event => (fromNotes(event) ? engine : null));

function publicSettings() {
  const s = config.load();
  const keys = {};
  for (const p of Object.keys(config.PROVIDERS)) keys[p] = { has: !!config.getApiKey(p), source: config.apiKeySource(p) };
  return { ...s, keys, hasKey: keys[s.provider].has, keySource: keys[s.provider].source };
}

ipcMain.handle('settings:get', event => (fromNotes(event) ? publicSettings() : null));

ipcMain.handle('settings:save', (event, patch) => {
  if (!fromNotes(event)) return null;
  const allowed = ['audioSource', 'subject', 'provider', 'geminiModel', 'groqModel', 'model', 'effort', 'autoAnswer', 'opacity'];
  const clean = {};
  for (const k of allowed) if (patch && k in patch) clean[k] = patch[k];
  const next = config.save(clean);
  if ('opacity' in clean && notesWindow) notesWindow.setOpacity(next.opacity / 100);
  if (answerer) {
    answerer.setProvider(next.provider);
    answerer.providers.gemini.setModel(next.geminiModel);
    answerer.providers.groq.setModel(next.groqModel);
    answerer.providers.claude.setModel(next.model);
    answerer.setEffort(next.effort);
  }
  if (pipeline) { pipeline.setSubject(next.subject); pipeline.setAutoAnswer(next.autoAnswer); }
  return publicSettings();
});

// While the real pointer is invisible over the window, the page moves and resizes the window itself:
// the operating system only shows its own (capturable) pointer over a title bar or a resize edge.
let dragStart = null;
ipcMain.on('win:drag-start', event => { if (fromNotes(event) && notesWindow) dragStart = notesWindow.getBounds(); });
ipcMain.on('win:drag', (event, d) => {
  if (!fromNotes(event) || !dragStart || !notesWindow || !d) return;
  const dx = Math.round(Number(d.dx)), dy = Math.round(Number(d.dy));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  if (d.mode === 'resize') {
    notesWindow.setBounds({ x: dragStart.x, y: dragStart.y, width: Math.max(560, dragStart.width + dx), height: Math.max(420, dragStart.height + dy) });
  } else {
    notesWindow.setBounds({ x: dragStart.x + dx, y: dragStart.y + dy, width: dragStart.width, height: dragStart.height });
  }
});
ipcMain.on('win:drag-end', event => { if (fromNotes(event)) dragStart = null; });

// Save the session as a text, CSV (opens in Excel) or JSON file, wherever the teacher chooses.
ipcMain.handle('session:export', async (event, format) => {
  if (!fromNotes(event)) return null;
  const data = sessionData();
  if (!data.entries.length && !data.transcript.length) return { ok: false, message: 'Nothing to export yet.' };
  const ext = ['txt', 'csv', 'json'].includes(format) ? format : 'txt';
  // No "Save as" window: Windows dialogs are separate windows that a screen share could capture. The file goes to a fixed folder.
  const dir = path.join(app.getPath('documents'), 'ClassCue');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const filePath = path.join(dir, `ClassCue-session-${stamp}.${ext}`);
  const content = ext === 'csv' ? '﻿' + exporter.formatCsv(data)                    // BOM so Excel reads accents and symbols correctly
    : ext === 'json' ? exporter.formatJson(data)
      : exporter.formatText(data).replace(/\n/g, '\r\n');                                // Windows Notepad line breaks
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (err) { return { ok: false, message: 'Could not save the file: ' + err.message }; }
  return { ok: true, path: filePath, questions: data.entries.length };
});

ipcMain.handle('assistant:reset', async event => {
  if (!fromNotes(event)) return null;
  await restartAssistant('restart button');
  return { ok: engine.state === 'ready', engine };
});

// Every setting back to its default, the window back to its starting place and size; saved AI keys are kept.
ipcMain.handle('settings:reset', async event => {
  if (!fromNotes(event)) return null;
  const s = config.reset();
  if (notesWindow && !notesWindow.isDestroyed()) {
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    notesWindow.setBounds({ x: Math.max(0, width - 900), y: 40, width: 880, height: 640 });
    notesWindow.setOpacity(s.opacity / 100);
    notesWindow.show();
  }
  await restartAssistant('settings reset');
  return publicSettings();
});

ipcMain.handle('session:clear', event => {
  if (!fromNotes(event)) return null;
  session_.entries.clear(); session_.transcript.length = 0; session_.startedAt = new Date().toISOString();
  if (pipeline) pipeline.qa = [];        // a fresh start also forgets the earlier answers used for follow-ups
  return { ok: true };
});

ipcMain.handle('ai:test', async event => {
  if (!fromNotes(event) || !answerer) return { lines: ['The assistant is not ready yet.'] };
  try { return { lines: await answerer.diagnose() }; } catch (err) { return { lines: ['Test failed: ' + err.message] }; }
});

ipcMain.handle('apikey:set', (event, provider, key) => {
  if (!fromNotes(event) || !config.PROVIDERS[provider]) return { ok: false };
  const ok = config.setApiKey(provider, key);
  if (ok && answerer) answerer.providers[provider].setApiKey(config.getApiKey(provider));
  return { ok, ...publicSettings() };
});
