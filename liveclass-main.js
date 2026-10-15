'use strict';
// Live Class overlay: a floating toolbar, live transcript strip and question/answer card for use while teaching.
// It hears questions with the same offline speech engine and answers them with the same AI service, model, subject
// and prompts as the teacher assistant (saved Settings are shared; change them in the assistant's Settings).
// It needs an active ClassCue licence (the same one as the assistant), checked with the licence server, which also
// sends the AI keys to use: Groq for answers and Gemini for screenshots, chosen per licence in the admin dashboard
// (AI keys). Keys from the server are kept in memory only; without one, the key saved on this computer is used.
// While developing, TNA_LICENCE=off skips the licence check (local keys only).
// It is a normal window: it is NOT hidden from screen sharing or recording.   npm run liveclass

const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./src/config');
const { Answerer } = require('./src/ai/answerer');
const { GeminiAnswerer } = require('./src/ai/gemini');
const { GroqAnswerer } = require('./src/ai/groq');
const { AnswerRouter } = require('./src/ai/router');
const { Pipeline } = require('./src/pipeline');
const { WhisperServer } = require('./src/stt/whisperServer');
const { LicenceClient, computerId } = require('./src/licence/client');
const licenceSettings = require('./src/licence/settings');

// Tuned for a live class (the teacher assistant keeps its own, more patient settings), measured on this PC:
// - a phrase ends after a 0.6 s pause (0.8 s in the assistant) and long speech is cut into pieces of at most 8 s;
// - the speech engine looks at ~10 s of audio instead of ~15 s and decodes in one pass: about 2 s per phrase instead
//   of 3+ s, with the same words (a smaller window started losing punctuation, so question marks, on 8 s phrases);
// - a finished question is handed to the AI after 0.5 s of quiet (1 s in the assistant).
const LIVE_VAD = { hangMs: 600, softMaxMs: 5000, softGapMs: 120, maxUtteranceMs: 8000 };
const LIVE_WHISPER_ARGS = ['-ac', '512', '-bo', '1', '-nf'];
const LIVE_QUIET_MS = 500;
// The smaller base.en model: ~0.7 s per phrase instead of ~2.6 s with small.en, about 3 points less word accuracy
// (98.5% -> 95.5% on Power Platform test questions). The teacher assistant keeps the model from its Settings.
// If base.en is not downloaded (npm run setup:whisper -- --model base.en-q5_1 --model-only), that model is used instead.
const LIVE_MODEL = 'ggml-base.en-q5_1.bin';
// How often the licence and the AI keys are fetched again while Live Class runs.
const CONFIG_REFRESH_MS = 30 * 60 * 1000;

// started as "electron liveclass-main.js": use the same name, settings and keys as the teacher assistant
app.setName('teacher-notes-app');
app.setPath('userData', path.join(app.getPath('appData'), 'teacher-notes-app'));

const WHISPER_DIR = process.env.TNA_WHISPER_DIR || path.join(__dirname, 'whisper');
const BIN_DIR = path.join(WHISPER_DIR, 'bin');
const MODELS_DIR = path.join(WHISPER_DIR, 'models');

let win = null;
let answerer = null;
let whisper = null;
let pipeline = null;
let engine = { state: 'starting', message: '' };
let speechModel = '';
let licence = null;
let serverKeys = {};                       // { groq?: {apiKey, source, label}, gemini?: {...} } from the licence server
let keySources = { groq: 'none', gemini: 'none' };

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const fromWin = event => !!(win && !win.isDestroyed() && event.sender === win.webContents);
function setEngine(state, message = '') { engine = { state, message }; send('engine', engine); }
const activeModel = s => (s.provider === 'gemini' ? s.geminiModel : s.provider === 'groq' ? s.groqModel : s.model);

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 680, minWidth: 560, minHeight: 120,
    title: 'Live Class',
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'liveclass-preload.js'), contextIsolation: true },
  });
  // the Dashboard link opens in the normal browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile('liveclass-window.html');
  win.on('closed', () => { win = null; });
}

// Microphone, and "what the computer plays" (Windows system-audio loopback), for this window only.
function setupMediaPermissions() {
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!win || win.isDestroyed() || !/liveclass-window\.html$/.test((request.frame && request.frame.url) || '')) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      callback({ video: sources[0], audio: 'loopback' });   // the page drops the video track straight away
    } catch (_) { callback({}); }
  });
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(!!(win && !win.isDestroyed() && wc === win.webContents && ['media', 'display-capture'].includes(permission)));
  });
}

// ---- licence and AI keys from the licence server -------------------------------------------------------------

const licenceSkipped = () => !app.isPackaged && process.env.TNA_LICENCE === 'off';

function setupLicence() {
  const dir = app.getPath('userData');
  licence = new LicenceClient({
    serverUrl: licenceSettings.SERVER_URL,
    publicKeyPem: fs.readFileSync(licenceSettings.PUBLIC_KEY_FILE, 'utf8'),
    dir, deviceId: computerId(dir), deviceName: os.hostname(), appVersion: app.getVersion(),
    graceDays: licenceSettings.GRACE_DAYS,
  });
}

function licenceStatus() {
  if (licenceSkipped()) return { state: 'active', kind: 'development', plan: 'development', dev: true };
  return licence ? licence.status() : { state: 'none' };
}
const licensed = () => licenceStatus().state === 'active';

/** Puts the right key into each AI client: the server's key for this licence first, else the one saved here. */
function applyKeys() {
  if (!answerer) return;
  const s = config.load();
  for (const provider of ['groq', 'gemini']) {
    const fromServer = serverKeys[provider] && serverKeys[provider].apiKey;
    const local = config.getApiKey(provider);
    answerer.providers[provider].setApiKey(fromServer || local);
    keySources[provider] = fromServer ? 'server' : local ? 'local' : 'none';
  }
  // the server's keys decide the services: Groq writes the answers, Gemini reads screenshots
  answerer.setProvider(serverKeys.groq ? 'groq' : s.provider);
  answerer.setScreenProvider(serverKeys.gemini ? 'gemini' : s.screenProvider);
}

/** Re-check the licence and fetch this licence's AI keys. Tells the page what changed. */
async function syncLicence() {
  if (licenceSkipped()) { serverKeys = {}; applyKeys(); send('licence', licenceStatus()); return; }
  if (!licence) return;
  const { ai } = await licence.appConfig();
  serverKeys = licensed() ? ai : {};
  applyKeys();
  if (!licensed() && pipeline) pipeline.pause();
  send('licence', licenceStatus());
  send('info', info());
}

// ---- speech + AI engine: built exactly like the teacher assistant's, from the same saved settings ----------

async function startEngine() {
  const s = config.load();
  answerer = new AnswerRouter({
    provider: s.provider,
    screenProvider: s.screenProvider,
    gemini: new GeminiAnswerer({ apiKey: config.getApiKey('gemini'), model: s.geminiModel, effort: s.effort, subject: s.subject }),
    groq: new GroqAnswerer({ apiKey: config.getApiKey('groq'), model: s.groqModel, effort: s.effort, subject: s.subject }),
    claude: new Answerer({ apiKey: config.getApiKey('claude'), model: s.model, effort: s.effort, subject: s.subject }),
  });
  applyKeys();
  pipeline = new Pipeline({ whisper: null, answerer, subject: s.subject, autoAnswer: s.autoAnswer, vad: LIVE_VAD, quietMs: LIVE_QUIET_MS });
  pipeline.pause();   // listening starts when the teacher presses the mic button
  for (const type of ['transcript', 'status', 'warning', 'error', 'screen',
    'answer-start', 'answer-delta', 'answer-done', 'answer-skip', 'answer-cancelled', 'answer-error']) {
    pipeline.on(type, data => send('pipeline', { type, ...data }));
  }
  // "someone is speaking" / "turning it into text", the moment it happens (the words follow about 2 s after the pause)
  let speaking = false;
  pipeline.on('level', lvl => {
    if (lvl.speaking === speaking) return;
    speaking = lvl.speaking;
    send('pipeline', { type: 'speaking', on: speaking });
  });

  const liveModel = path.join(MODELS_DIR, LIVE_MODEL);
  const modelPath = WhisperServer.problem(BIN_DIR, liveModel) ? path.join(MODELS_DIR, s.whisperModel) : liveModel;
  speechModel = path.basename(modelPath);
  const problem = WhisperServer.problem(BIN_DIR, modelPath);
  if (problem) { setEngine('setup-needed', `${problem}. Run "npm run setup:whisper" once to download the offline speech engine.`); return; }

  setEngine('starting', 'Loading the speech model…');
  whisper = new WhisperServer({
    binDir: BIN_DIR, modelPath,
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
    language: s.language,
    prompt: s.subject ? `Topic: ${s.subject}.` : '',
    extraArgs: LIVE_WHISPER_ARGS,
  });
  whisper.on('exit', code => { if (engine.state === 'ready') setEngine('error', `The speech engine stopped (code ${code}). Restart Live Class.`); });
  try { await whisper.start(); } catch (err) { setEngine('error', `Could not start the speech engine: ${err.message}`); return; }
  pipeline.whisper = whisper;
  setEngine('ready');
}

function info() {
  const s = config.load();
  const provider = answerer ? answerer.provider : s.provider;
  const screenProvider = answerer ? answerer.screenProvider : s.screenProvider;
  return {
    engine, speechModel, subject: s.subject, provider, model: activeModel({ ...s, provider }), screenProvider,
    hasKey: answerer ? answerer.ready : !!config.getApiKey(s.provider), audioSource: s.audioSource, autoAnswer: s.autoAnswer, language: s.language,
    keySources, licence: licenceStatus(),
  };
}

// ---- screen capture: the whole screen the mouse is on, read by the screen-capture AI ------------------------
// This window is not hidden from capture, so it is hidden for a moment while the picture is taken.

let capturing = false;
async function captureScreen() {
  if (capturing || !pipeline) return;
  capturing = true;
  let shot = null;
  const wasVisible = win && !win.isDestroyed() && win.isVisible();
  try {
    if (wasVisible) { win.hide(); await new Promise(r => setTimeout(r, 250)); }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const source = sources.find(x => String(x.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Windows did not return a picture of the screen');
    shot = source.thumbnail;
  } catch (err) {
    send('pipeline', { type: 'screen', state: 'error', message: 'Could not capture the screen: ' + err.message });
  } finally {
    if (wasVisible && win && !win.isDestroyed()) win.showInactive();
    capturing = false;
  }
  if (!shot) return;
  let img = shot;
  const { width, height } = img.getSize();
  if (Math.max(width, height) > 2000) img = img.resize(width >= height ? { width: 2000, quality: 'best' } : { height: 2000, quality: 'best' });
  let data = img.toPNG(), mimeType = 'image/png';
  if (data.length > 3500000) { data = img.toJPEG(90); mimeType = 'image/jpeg'; }   // AI services limit picture size
  await pipeline.askFromScreen({ image: data.toString('base64'), mimeType });
}

// ---- messages from the page ----------------------------------------------------------------------------

ipcMain.handle('lc:info', event => (fromWin(event) ? info() : null));
// licence: everything that hears or answers is locked without an active licence
const allowed = event => fromWin(event) && licensed();
ipcMain.handle('lc:licence-activate', async (event, key) => {
  if (!fromWin(event) || !licence || licenceSkipped()) return null;
  const res = await licence.activate(String(key || ''));
  if (res.ok) await syncLicence();
  return { ok: res.ok, message: res.message || '', licence: licenceStatus() };
});
ipcMain.handle('lc:licence-check', async event => {
  if (!fromWin(event)) return null;
  await syncLicence();
  return licenceStatus();
});
ipcMain.on('lc:audio', (event, data) => {
  if (!fromWin(event) || !pipeline || !pipeline.whisper) return;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  pipeline.feed(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 2))));
});
ipcMain.on('lc:listening', (event, on) => { if (fromWin(event) && pipeline) { if (on && licensed()) pipeline.resume(); else pipeline.pause(); } });
ipcMain.on('lc:ask-last', event => { if (allowed(event) && pipeline) pipeline.completeQuestion(); });
ipcMain.on('lc:ask-typed', (event, text, corrected) => {
  if (allowed(event) && pipeline && typeof text === 'string') pipeline.askTyped(text, { corrected: corrected === true });
});
ipcMain.on('lc:capture', event => { if (allowed(event)) captureScreen(); });
// Auto Answer here applies to this Live Class session only; the assistant's saved setting is left as it is
ipcMain.on('lc:auto-answer', (event, on) => { if (fromWin(event) && pipeline) pipeline.setAutoAnswer(!!on); });
ipcMain.on('lc:close', event => { if (fromWin(event)) app.quit(); });   // Quit: closes the window and stops the speech engine

// ---- app lifecycle -----------------------------------------------------------------------------------

app.whenReady().then(() => {
  setupMediaPermissions();
  setupLicence();
  createWindow();
  win.webContents.once('did-finish-load', async () => {
    startEngine();          // builds the AI clients straight away, then loads the speech model
    await syncLicence();
  });
  setInterval(() => { syncLicence(); }, CONFIG_REFRESH_MS).unref();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (pipeline) pipeline.stop(); if (whisper) whisper.stop(); });
