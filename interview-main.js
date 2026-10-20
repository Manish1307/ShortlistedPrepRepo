'use strict';
// AI Mock Interviewer: a separate, normal window (NOT hidden from screen sharing) for practising interviews.
// The AI asks questions for a chosen company, role and round; the candidate answers by voice (offline speech
// engine) or by typing; the AI scores each answer with feedback and builds a report.
// Needs a ClassCue licence (activated here, checked with the licence server). AI comes through the licence server (no key
// on this computer), and the candidate can pick one of their resumes to get personalised and scenario questions made only
// from it: they are saved on the server, so they also show in My account and in the dashboard.   npm run interview

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./src/config');
const { Answerer } = require('./src/ai/answerer');
const { GeminiAnswerer } = require('./src/ai/gemini');
const { GroqAnswerer } = require('./src/ai/groq');
const { AnswerRouter } = require('./src/ai/router');
const { ProxyAnswerer } = require('./src/ai/proxy');
const { LicenceClient, computerId } = require('./src/licence/client');
const licenceSettings = require('./src/licence/settings');
const { InterviewPrepClient } = require('./src/interview/prep');
const { Pipeline } = require('./src/pipeline');
const { WhisperServer } = require('./src/stt/whisperServer');
const coach = require('./src/interview/coach');

// started as "electron interview-main.js": use the same name, settings and keys as the teacher assistant
app.setName('teacher-notes-app');
app.setPath('userData', process.env.TNA_USER_DATA || path.join(app.getPath('appData'), 'teacher-notes-app'));   // TNA_USER_DATA: a separate folder for tests

const WHISPER_DIR = process.env.TNA_WHISPER_DIR || path.join(__dirname, 'whisper');
const AI_TIMEOUT_MS = 60000;

let win = null;
let ai = null;
let whisper = null;
let pipeline = null;
let speech = { state: 'starting', message: '' };
let licence = null;
let serverKeys = {};      // keys sent by an older licence server
let proxyGrant = null;    // { token, expiresAt, services }: AI through the licence server
let prep = null;          // personalised questions from the candidate's resume (licence server)

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const fromWin = event => !!(win && !win.isDestroyed() && event.sender === win.webContents);

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 640,
    title: 'Mock Interview',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'interview-preload.js'), contextIsolation: true },
  });
  win.loadFile('interview-window.html');
}

function buildAI() {
  const s = config.load();
  ai = new AnswerRouter({
    provider: s.provider,
    gemini: new GeminiAnswerer({ apiKey: config.getApiKey('gemini'), model: s.geminiModel, effort: 'low' }),
    groq: new GroqAnswerer({ apiKey: config.getApiKey('groq'), model: s.groqModel, effort: 'low' }),
    claude: new Answerer({ apiKey: config.getApiKey('claude'), model: s.model, effort: 'low' }),
    proxy: new ProxyAnswerer({ serverUrl: licenceSettings.SERVER_URL, getToken: proxyToken, model: s.groqModel, effort: 'low' }),
  });
  applyKeys();
}

// ---- licence and AI from the licence server -------------------------------------------------------------

const licenceSkipped = () => !app.isPackaged && process.env.TNA_LICENCE === 'off';

function setupLicence() {
  const dir = app.getPath('userData');
  licence = new LicenceClient({
    serverUrl: licenceSettings.SERVER_URL,
    publicKeyPem: fs.readFileSync(licenceSettings.PUBLIC_KEY_FILE, 'utf8'),
    dir, deviceId: computerId(dir), deviceName: os.hostname(), appVersion: app.getVersion(), graceDays: licenceSettings.GRACE_DAYS,
  });
}

function licenceStatus() {
  if (licenceSkipped()) return { state: 'active', kind: 'development', plan: 'development', dev: true };
  return licence ? licence.status() : { state: 'none' };
}
const licensed = () => licenceStatus().state === 'active';

/** AI through the licence server when it serves this licence, else a key it sent (older server), else the key saved here. */
function applyKeys() {
  if (!ai) return;
  const s = config.load();
  const proxied = (proxyGrant && proxyGrant.services) || {};
  ai.providers.proxy.setServices(proxied);
  for (const provider of ['groq', 'gemini']) {
    const fromServer = serverKeys[provider] && serverKeys[provider].apiKey;
    ai.providers[provider].setApiKey(fromServer || config.getApiKey(provider));
  }
  ai.setProvider(proxied.groq ? 'proxy' : serverKeys.groq ? 'groq' : s.provider);
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

/** Re-check the licence and get this licence's AI access. Tells the window what changed. */
async function syncLicence() {
  if (licenceSkipped()) { serverKeys = {}; proxyGrant = null; applyKeys(); send('licence', licenceStatus()); return; }
  if (!licence) return;
  const { ai: keys, proxy } = await licence.appConfig({ proxy: true });
  serverKeys = licensed() ? keys : {};
  const keep = proxyGrant && proxyGrant.expiresAt > Date.now() && !Object.keys(keys).length ? proxyGrant : null;   // offline for a moment: a valid token keeps working
  proxyGrant = licensed() ? proxy || keep : null;
  applyKeys();
  send('licence', licenceStatus());
}

/** The offline speech engine, for spoken answers. Without it the candidate types instead. */
async function startSpeech() {
  const s = config.load();
  const modelPath = path.join(WHISPER_DIR, 'models', s.whisperModel);
  const problem = WhisperServer.problem(path.join(WHISPER_DIR, 'bin'), modelPath);
  if (problem) { speech = { state: 'missing', message: 'Speech engine not installed (run "npm run setup:whisper"). You can type your answers.' }; send('speech', speech); return; }
  speech = { state: 'starting', message: 'Loading the speech engine…' }; send('speech', speech);
  whisper = new WhisperServer({
    binDir: path.join(WHISPER_DIR, 'bin'), modelPath,
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)), language: s.language, prompt: '',
  });
  try { await whisper.start(); } catch (err) {
    speech = { state: 'error', message: 'Could not start the speech engine: ' + err.message + '. You can type your answers.' }; send('speech', speech); return;
  }
  // the pipeline only turns speech into text here: it never answers anything itself
  pipeline = new Pipeline({ whisper, answerer: ai, autoAnswer: false });
  pipeline.pause();
  for (const type of ['transcript', 'status', 'warning', 'error']) pipeline.on(type, d => send('speech-event', { type, ...d }));
  speech = { state: 'ready', message: '' }; send('speech', speech);
}

function friendly(err) {
  if (err && err.code === 'no-key') return 'No AI key is saved for the selected AI service. Open the teacher assistant (npm start), Settings, and add one.';
  if (err && err.name === 'AbortError') return 'The AI took too long to reply. Try again.';
  if (err && err.status === 429) return 'The AI\'s free limit is used up for the moment (429). Wait a minute and try again.';
  if (err && (err.status === 401 || err.status === 403)) return 'The AI key was rejected. Check it in the teacher assistant\'s Settings.';
  if (err && err.status >= 500) return 'The AI service is busy (' + err.status + '). Try again.';
  return (err && err.message) || String(err);
}

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try { return { ok: true, ...(await fn(controller.signal)) }; } catch (err) { return { ok: false, message: friendly(err) }; } finally { clearTimeout(timer); }
}

// ---- messages from the window ------------------------------------------------------------------------

ipcMain.handle('iv:info', event => {
  if (!fromWin(event)) return null;
  const s = config.load();
  const names = { gemini: 'Google Gemini', groq: 'Groq', claude: 'Anthropic Claude' };
  return {
    companies: coach.COMPANIES, rounds: coach.ROUNDS, levels: coach.LEVELS,
    provider: ai && ai.provider === 'proxy' ? 'ClassCue (through your licence)' : names[s.provider] || s.provider, hasKey: !!(ai && ai.ready), speech,
    licence: licenceStatus(),
  };
});

const NEED_LICENCE = { ok: false, message: 'Activate your ClassCue licence first.' };

ipcMain.handle('iv:licence-activate', async (event, key) => {
  if (!fromWin(event) || !licence || licenceSkipped()) return null;
  const res = await licence.activate(String(key || ''));
  if (res.ok) await syncLicence();
  return { ok: res.ok, message: res.message || '', licence: licenceStatus() };
});
ipcMain.handle('iv:licence-check', async event => {
  if (!fromWin(event)) return null;
  await syncLicence();
  return licenceStatus();
});

// personalised questions from the candidate's resume (the licence server makes and keeps them)
const viaServer = fn => async (event, p) => {
  if (!fromWin(event)) return null;
  if (!licensed()) return NEED_LICENCE;
  try { return { ok: true, ...(await fn(p || {})) }; } catch (err) { return { ok: false, message: err.message || String(err) }; }
};
ipcMain.handle('iv:resumes', viaServer(() => prep.resumes()));
ipcMain.handle('iv:make-set', viaServer(async p => ({ set: await prep.makeSet({ resumeKey: String(p.resumeKey || ''), role: String(p.role || '') }) })));
ipcMain.handle('iv:get-set', viaServer(async p => ({ set: await prep.getSet(String(p.id || '')) })));

ipcMain.handle('iv:questions', (event, p) => {
  if (!fromWin(event) || !p) return null;
  if (!licensed()) return NEED_LICENCE;
  return withTimeout(async signal => ({ questions: await coach.generateQuestions(ai, {
    company: String(p.company || ''), role: String(p.role || ''), round: String(p.round || ''), level: String(p.level || ''),
    count: Number(p.count) || 5, focus: String(p.focus || ''), avoid: Array.isArray(p.avoid) ? p.avoid.map(String) : [], signal,
  }) }));
});

ipcMain.handle('iv:evaluate', (event, p) => {
  if (!fromWin(event) || !p) return null;
  if (!licensed()) return NEED_LICENCE;
  return withTimeout(async signal => ({ feedback: await coach.evaluateAnswer(ai, {
    company: String(p.company || ''), role: String(p.role || ''), round: String(p.round || ''), level: String(p.level || ''),
    question: String(p.question || ''), points: Array.isArray(p.points) ? p.points.map(String) : [], answer: String(p.answer || ''), reference: String(p.reference || ''), signal,
  }) }));
});

ipcMain.handle('iv:summary', (event, items) => (fromWin(event) && Array.isArray(items) ? coach.summarize(items) : null));

// The report goes to Documents\Mock Interviews (no "Save as" window needed).
ipcMain.handle('iv:save', (event, s) => {
  if (!fromWin(event) || !s || !Array.isArray(s.items)) return null;
  const dir = path.join(app.getPath('documents'), 'Mock Interviews');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const safe = String(s.company || 'Any').replace(/[^\w-]+/g, '_').slice(0, 40);
  const file = path.join(dir, `Mock-Interview-${safe}-${stamp}.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, coach.formatReport(s).replace(/\n/g, '\r\n'), 'utf8');
    return { ok: true, path: file };
  } catch (err) { return { ok: false, message: 'Could not save the report: ' + err.message }; }
});

// spoken answers: 16 kHz audio from the window -> speech engine -> text back to the window
ipcMain.on('iv:audio', (event, data) => {
  if (!fromWin(event) || !pipeline) return;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  pipeline.feed(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 2))));
});
ipcMain.on('iv:listening', (event, on) => {
  if (!fromWin(event) || !pipeline) return;
  if (on) pipeline.resume(); else pipeline.pause();   // pause() still turns the last phrase into text
});

// ---- app lifecycle --------------------------------------------------------------------------------

// ---- "--smoke": walks through a short interview with typed answers, saves a screenshot of each step, then quits ----
// (uses the real AI with the saved key: three small requests)   electron interview-main.js --smoke
async function runSmoke() {
  const dir = process.env.TNA_IV_SHOTS || app.getPath('temp');
  const wc = win.webContents;
  const problems = [];
  wc.on('console-message', (_e, level, message) => { if (level >= 2) problems.push(message); });
  const js = code => wc.executeJavaScript(code);
  const wait = async (cond, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(cond)) return true; await new Promise(r => setTimeout(r, 300)); } return false; };
  const shot = async name => { await new Promise(r => setTimeout(r, 400)); fs.writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const report = {};
  await new Promise(r => setTimeout(r, 1500));
  await js(`document.getElementById('company').value = 'TCS'; document.getElementById('role').value = 'Java developer';
    document.getElementById('count').innerHTML = '<option>2</option>'; document.getElementById('speak').checked = false; document.getElementById('followups').checked = true;
    [...document.querySelectorAll('#levels button')][0].click(); true`);
  await shot('1-setup');
  await js("document.getElementById('btnStart').click()");
  report.question = await wait("!document.getElementById('viewInterview').classList.contains('hidden') && document.getElementById('question').textContent.length > 5");
  report.firstQuestion = await js("document.getElementById('question').textContent");
  await js(`document.getElementById('answer').value = 'A HashMap stores key value pairs. It uses the hashCode of the key to pick a bucket, and equals to find the key inside the bucket. Lookups are usually constant time.'; true`);
  await shot('2-question');
  await js("document.getElementById('btnSubmit').click()");
  report.feedback = await wait("!!document.querySelector('#feedback .fbHead') || !!document.querySelector('#feedback .verdict')");
  report.score = await js("(document.querySelector('#feedback .score') || {}).textContent || document.getElementById('feedback').textContent.slice(0, 200)");
  await shot('3-feedback');
  for (let i = 0; i < 4 && !(await js("!document.getElementById('viewReport').classList.contains('hidden')")); i++) {
    const next = await js("(() => { const b = document.querySelector('#feedback .btn.primary'); return b ? b.textContent : ''; })()");
    if (next) await js("document.querySelector('#feedback .btn.primary').click()");
    else if (await js("!document.getElementById('btnSkip').disabled")) await js("document.getElementById('btnSkip').click()");
    await new Promise(r => setTimeout(r, 800));
  }
  report.reportShown = await wait("!document.getElementById('viewReport').classList.contains('hidden')", 20000);
  report.overall = await js("document.getElementById('overallScore').textContent + ' ' + document.getElementById('readiness').textContent");
  await js("document.querySelector('.qrow').open = true; true");
  await shot('4-report');
  console.log('IV-SMOKE ' + JSON.stringify({ ...report, speech, problems }, null, 1));
  app.quit();
}

// ---- "--shots": the licence and personalised-questions flow against a test server, a screenshot of each step, then quit ----
// Needs CLASSCUE_LICENCE_SERVER, CLASSCUE_PUBLIC_KEY_FILE, TNA_USER_DATA, TNA_IV_KEY (a licence key) and TNA_IV_SHOTS (a folder).
//   electron interview-main.js --shots
async function runShots() {
  const dir = process.env.TNA_IV_SHOTS || app.getPath('temp');
  const wc = win.webContents;
  const js = code => wc.executeJavaScript(code);
  const wait = async (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(cond)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
  // saved as 1200 px wide JPEGs: small enough for the website
  const shot = async name => { await new Promise(r => setTimeout(r, 500)); const img = (await wc.capturePage()).resize({ width: 1200, quality: 'best' }); fs.writeFileSync(path.join(dir, name + '.jpg'), img.toJPEG(88)); };
  const report = {};
  await new Promise(r => setTimeout(r, 1500));
  win.setSize(1180, 860);
  // 1. before activation: the licence screen
  report.gateShown = await js("!document.getElementById('gate').classList.contains('hidden')");
  await shot('1-licence');
  // 2. activate with the key, then choose "My resume"
  await js("document.getElementById('gateKey').value = " + JSON.stringify(process.env.TNA_IV_KEY || '') + "; document.getElementById('gateActivate').click(); true");
  report.activated = await wait("document.getElementById('gate').classList.contains('hidden')", 20000);
  await js("document.querySelector('#modes [data-mode=resume]').click(); true");
  report.resumesLoaded = await wait("document.getElementById('resume').options.length > 0 && !/Loading/.test(document.getElementById('resume').options[0].textContent)", 20000);
  await js("document.getElementById('resumeRole').value = 'Seed breeder'; true");
  await shot('2-resume');
  // 3. personalised questions made from that resume
  await js("document.getElementById('btnStart').click(); true");
  report.setShown = await wait("!document.getElementById('viewSet').classList.contains('hidden')", 90000);
  report.questions = await js("document.querySelectorAll('#setList .qitem').length");
  await shot('3-questions');
  // 4. explore answers
  await js("[...document.querySelectorAll('#setList button.reveal')].slice(0, 2).forEach(b => b.click()); document.querySelector('#setList .qitem').scrollIntoView(); true");
  await shot('4-answers');
  // 5. practise: answer a question and get feedback
  await js("document.getElementById('btnPractise').click(); true");
  report.practising = await wait("!document.getElementById('viewInterview').classList.contains('hidden') && document.getElementById('question').textContent.length > 5", 20000);
  await js("document.getElementById('speak') && (document.getElementById('speak').checked = false); document.getElementById('answer').value = 'I used doubled haploid induction in maize so that fully homozygous lines were ready in one generation instead of six or seven. I validated ploidy with flow cytometry, kept records of each batch, and that cut the breeding cycle by two seasons.'; document.getElementById('btnShow').click(); true");
  await shot('5-practise');
  await js("document.getElementById('btnShow').click(); window.scrollTo(0, 0); document.getElementById('btnSubmit').click(); true");
  report.feedback = await wait("!!document.querySelector('#feedback .fbHead')", 60000);
  await shot('6-feedback');
  console.log('IV-SHOTS ' + JSON.stringify(report));
  app.quit();
}

app.whenReady().then(() => {
  // only this window may use the microphone
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(!!(win && wc === win.webContents && permission === 'media'));
  });
  setupLicence();
  buildAI();
  prep = new InterviewPrepClient({ serverUrl: licenceSettings.SERVER_URL, getToken: proxyToken });
  createWindow();
  win.webContents.once('did-finish-load', async () => {
    startSpeech();
    await syncLicence();
    if (process.argv.includes('--smoke')) runSmoke();
    if (process.argv.includes('--shots')) runShots();
  });
  setInterval(() => { syncLicence(); }, 30 * 60 * 1000).unref();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (pipeline) pipeline.stop(); if (whisper) whisper.stop(); });
