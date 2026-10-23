'use strict';
// ShortlistPrep.AI overlay: a floating toolbar, live transcript strip and question/answer card for use while teaching.
// It hears questions with the same offline speech engine and answers them with the same AI service, model, subject
// and prompts as Mock Interview (saved settings are shared between the ShortlistPrep apps).
// It needs an active ShortlistPrep licence (the same one as the assistant), checked with the licence server. The AI runs
// through that server's AI proxy: Groq for answers and Gemini for screenshots, with the keys chosen per licence in the
// admin dashboard (AI keys), and the keys never reach this computer (only a short-lived access token does).
// A server without the proxy sends the keys instead (kept in memory only); without either, the key saved on this
// computer is used.
// While developing, SP_LICENCE=off skips the licence check (local keys only).
// It is a normal window: it is NOT hidden from screen sharing or recording.   npm run shortlistprep-ai

const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./src/config');
const { Answerer } = require('./src/ai/answerer');
const { GeminiAnswerer } = require('./src/ai/gemini');
const { GroqAnswerer } = require('./src/ai/groq');
const { AnswerRouter } = require('./src/ai/router');
const { ProxyAnswerer } = require('./src/ai/proxy');
const { Pipeline } = require('./src/pipeline');
const { WhisperServer } = require('./src/stt/whisperServer');
const { LicenceClient, computerId } = require('./src/licence/client');
const licenceSettings = require('./src/licence/settings');
const { ConversationOutbox } = require('./src/conversations/outbox');

// Tuned for a live class (Mock Interview keeps its own, more patient settings), measured on this PC:
// - a phrase ends after a 0.6 s pause (0.8 s in the assistant) and long speech is cut into pieces of at most 8 s;
// - the speech engine looks at ~10 s of audio instead of ~15 s and decodes in one pass: about 2 s per phrase instead
//   of 3+ s, with the same words (a smaller window started losing punctuation, so question marks, on 8 s phrases);
// - a finished question is handed to the AI after 0.5 s of quiet (1 s in the assistant).
const LIVE_VAD = { hangMs: 600, softMaxMs: 5000, softGapMs: 120, maxUtteranceMs: 8000 };
const LIVE_WHISPER_ARGS = ['-ac', '512', '-bo', '1', '-nf'];
const LIVE_QUIET_MS = 500;
// The smaller base.en model: ~0.7 s per phrase instead of ~2.6 s with small.en, about 3 points less word accuracy
// (98.5% -> 95.5% on Power Platform test questions). Mock Interview keeps the model from its Settings.
// If base.en is not downloaded (npm run setup:whisper -- --model base.en-q5_1 --model-only), that model is used instead.
const LIVE_MODEL = 'ggml-base.en-q5_1.bin';
// How often the licence and the AI keys are fetched again while ShortlistPrep.AI runs.
const CONFIG_REFRESH_MS = 30 * 60 * 1000;

// started as "electron shortlistprep-ai-main.js": use the same name, settings and keys as Mock Interview
app.setName('ShortlistPrep');
app.setPath('userData', process.env.SP_USER_DATA || path.join(app.getPath('appData'), 'ShortlistPrep'));   // SP_USER_DATA: a separate folder for tests

// Installed: the speech engine sits next to the app (resources/whisper), because programs cannot run from inside app.asar.
const WHISPER_DIR = process.env.SP_WHISPER_DIR || (app.isPackaged ? path.join(process.resourcesPath, 'whisper') : path.join(__dirname, 'whisper'));
const BIN_DIR = path.join(WHISPER_DIR, 'bin');
const MODELS_DIR = path.join(WHISPER_DIR, 'models');

let win = null;
let answerer = null;
let whisper = null;
let pipeline = null;
let engine = { state: 'starting', message: '' };
let speechModel = '';
let licence = null;
let serverKeys = {};                       // { groq?: {apiKey, source, label}, gemini?: {...} } from an older licence server
let proxyGrant = null;                     // { token, expiresAt, services: {groq, gemini} }: AI through the licence server
let keySources = { groq: 'none', gemini: 'none' };
let serverProfile = null;                  // { topics, resume } for this customer, from the admin dashboard (Topics and resume)
let outbox = null;                        // finished classes waiting to be saved on the licence server (Conversations)

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const fromWin = event => !!(win && !win.isDestroyed() && event.sender === win.webContents);
function setEngine(state, message = '') { engine = { state, message }; send('engine', engine); }
const activeModel = s => (s.provider === 'gemini' ? s.geminiModel : s.provider === 'groq' || s.provider === 'proxy' ? s.groqModel : s.model);

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 680, minWidth: 560, minHeight: 120,
    title: 'ShortlistPrep.AI',
    icon: path.join(__dirname, 'build', 'ai', 'icon.png'),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'shortlistprep-ai-preload.js'), contextIsolation: true },
  });
  // the Dashboard link opens in the normal browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile('shortlistprep-ai-window.html');
  win.on('closed', () => { win = null; });
}

// Microphone, and "what the computer plays" (Windows system-audio loopback), for this window only.
function setupMediaPermissions() {
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!win || win.isDestroyed() || !/shortlistprep-ai-window\.html$/.test((request.frame && request.frame.url) || '')) return callback({});
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

const licenceSkipped = () => !app.isPackaged && process.env.SP_LICENCE === 'off';

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

/**
 * Chooses how each service is reached: through the licence server's AI proxy when it serves it for this licence,
 * else with the key the server sent (older server), else with the key saved here.
 */
function applyKeys() {
  if (!answerer) return;
  const s = config.load();
  const proxied = (proxyGrant && proxyGrant.services) || {};
  answerer.providers.proxy.setServices(proxied);
  for (const provider of ['groq', 'gemini']) {
    const fromServer = serverKeys[provider] && serverKeys[provider].apiKey;
    const local = config.getApiKey(provider);
    answerer.providers[provider].setApiKey(fromServer || local);
    keySources[provider] = proxied[provider] ? 'proxy' : fromServer ? 'server' : local ? 'local' : 'none';
  }
  // the server decides the services: Groq writes the answers, Gemini reads screenshots
  answerer.setProvider(proxied.groq ? 'proxy' : serverKeys.groq ? 'groq' : s.provider);
  answerer.setScreenProvider(proxied.gemini ? 'proxy' : serverKeys.gemini ? 'gemini' : s.screenProvider);
  answerer.setProfile(serverProfile);   // the topics and resume decide the area of the questions and answers
}

/** The AI proxy's access token; renewed from the licence server when it is about to expire or was refused. */
let renewing = null;
async function proxyToken(renew = false) {
  const fresh = proxyGrant && proxyGrant.expiresAt - Date.now() > 60 * 1000;
  if (fresh && !renew) return proxyGrant.token;
  if (!renewing) renewing = syncLicence().finally(() => { renewing = null; });
  await renewing;
  return proxyGrant ? proxyGrant.token : null;
}

/** Re-check the licence and fetch this licence's AI keys. Tells the page what changed. */
async function syncLicence() {
  if (licenceSkipped()) { serverKeys = {}; proxyGrant = null; serverProfile = null; applyKeys(); send('licence', licenceStatus()); return; }
  if (!licence) return;
  const { ai, proxy, profile } = await licence.appConfig({ proxy: true });
  serverKeys = licensed() ? ai : {};
  if (profile !== undefined) serverProfile = profile;   // offline: keep the topics and resume from the last check
  if (!licensed()) serverProfile = null;
  // offline for a moment: a token that is still valid keeps working
  const keep = proxyGrant && proxyGrant.expiresAt > Date.now() && !Object.keys(ai).length ? proxyGrant : null;
  proxyGrant = licensed() ? proxy || keep : null;
  applyKeys();
  if (!licensed() && pipeline) pipeline.pause();
  send('licence', licenceStatus());
  send('info', info());
}

// ---- speech + AI engine: built exactly like Mock Interview's, from the same saved settings ----------

async function startEngine() {
  const s = config.load();
  answerer = new AnswerRouter({
    provider: s.provider,
    screenProvider: s.screenProvider,
    gemini: new GeminiAnswerer({ apiKey: config.getApiKey('gemini'), model: s.geminiModel, effort: s.effort, subject: s.subject }),
    groq: new GroqAnswerer({ apiKey: config.getApiKey('groq'), model: s.groqModel, effort: s.effort, subject: s.subject }),
    claude: new Answerer({ apiKey: config.getApiKey('claude'), model: s.model, effort: s.effort, subject: s.subject }),
    proxy: new ProxyAnswerer({ serverUrl: licenceSettings.SERVER_URL, getToken: proxyToken, model: s.groqModel, effort: s.effort, subject: s.subject }),
  });
  applyKeys();
  pipeline = new Pipeline({ whisper: null, answerer, subject: s.subject, autoAnswer: s.autoAnswer, vad: LIVE_VAD, quietMs: LIVE_QUIET_MS, livePartials: true, mergeMaxMs: 9000 });
  pipeline.pause();   // listening starts when the teacher presses the mic button
  for (const type of ['transcript', 'partial', 'status', 'warning', 'error', 'screen',
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
  whisper.on('exit', code => { if (engine.state === 'ready') setEngine('error', `The speech engine stopped (code ${code}). Restart ShortlistPrep.AI.`); });
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
    profile: serverProfile ? { topics: serverProfile.topics, hasResume: !!serverProfile.resume } : null,
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
// Log out: this computer leaves the licence, listening stops and the AI access is dropped, so the login screen shows again
/** The other ShortlistPrep app (they share the licence file) logged in or out: follow it at once, not 30 minutes later. */
async function onLicenceFileChanged() {
  if (licenceSkipped() || !licence) return;
  if (!licensed()) {
    serverKeys = {}; proxyGrant = null; serverProfile = null;
    try { applyKeys(); } catch (_) { /* the engine is not built yet */ }
    if (pipeline) pipeline.pause();
    send('licence', licenceStatus());
  } else {
    await syncLicence();
  }
}
ipcMain.handle('lc:licence-logout', async event => {
  if (!fromWin(event) || !licence || licenceSkipped()) return null;
  const res = await licence.signOut();
  if (pipeline) pipeline.pause();
  serverKeys = {}; proxyGrant = null; serverProfile = null; applyKeys();
  send('licence', licenceStatus());
  return { ok: true, freed: res.freed, licence: licenceStatus() };
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
// Auto Answer here applies to this ShortlistPrep.AI session only; the assistant's saved setting is left as it is
ipcMain.on('lc:auto-answer', (event, on) => { if (fromWin(event) && pipeline) pipeline.setAutoAnswer(!!on); });
ipcMain.on('lc:close', event => { if (fromWin(event)) app.quit(); });   // Quit: closes the window and stops the speech engine
// The see-through parts of the window let clicks reach the app behind it; mouse moves are still forwarded so the
// page can switch back as soon as the pointer is over the toolbar, transcript or answer card.
ipcMain.on('lc:click-through', (event, on) => {
  if (fromWin(event)) { if (on) win.setIgnoreMouseEvents(true, { forward: true }); else win.setIgnoreMouseEvents(false); }
});

// ---- End: the whole class goes to the licence server, shown in the dashboard under Conversations ----------
// It is written to a file on this computer first, so a class is never lost when the server cannot be reached.

const isoOr = (value, fallback) => (Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : fallback);
ipcMain.handle('lc:save-conversation', async (event, c) => {
  if (!fromWin(event) || !outbox || !c || typeof c !== 'object') return null;
  const endedAt = isoOr(c.endedAt, new Date().toISOString());
  const list = value => (Array.isArray(value) ? value : []);
  outbox.add({
    uid: /^[A-Za-z0-9-]{8,64}$/.test(String(c.uid || '')) ? c.uid : crypto.randomUUID(),
    app: 'liveclass', subject: config.load().subject || '',
    startedAt: isoOr(c.startedAt, endedAt), endedAt,
    transcript: list(c.transcript).map(p => ({ at: p && p.at, text: String((p && p.text) || '') })),
    items: list(c.items).map(it => ({
      at: it && it.at, question: String((it && it.question) || ''), answer: String((it && it.answer) || ''),
      status: it && it.status, error: String((it && it.error) || ''), source: String((it && it.source) || ''), vote: it && it.vote,
    })),
  });
  const result = await outbox.flush();
  return { saved: !result.error, message: result.error };
});

// ---- app lifecycle -----------------------------------------------------------------------------------

app.whenReady().then(() => {
  setupMediaPermissions();
  setupLicence();
  if (licence) licence.onFileChange(() => { onLicenceFileChanged(); });
  outbox = new ConversationOutbox({ dir: path.join(app.getPath('userData'), 'conversations-outbox'), serverUrl: licenceSettings.SERVER_URL, getToken: proxyToken });
  createWindow();

  win.webContents.once('did-finish-load', async () => {
    startEngine();          // builds the AI clients straight away, then loads the speech model
    await syncLicence();
    if (outbox.pending().length) outbox.flush();   // classes that could not be sent last time
  });
  setInterval(() => { syncLicence(); }, CONFIG_REFRESH_MS).unref();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (pipeline) pipeline.stop(); if (whisper) whisper.stop(); });
