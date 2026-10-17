'use strict';
// AI Mock Interviewer: a separate, normal window (NOT hidden from screen sharing) for practising interviews.
// The AI asks questions for a chosen company, role and round; the candidate answers by voice (offline speech
// engine) or by typing; the AI scores each answer with feedback and builds a report.
// Uses the same saved settings and AI keys as the teacher assistant.   npm run interview

const { app, BrowserWindow, ipcMain, session } = require('electron');
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
const coach = require('./src/interview/coach');

// started as "electron interview-main.js": use the same name, settings and keys as the teacher assistant
app.setName('teacher-notes-app');
app.setPath('userData', path.join(app.getPath('appData'), 'teacher-notes-app'));

const WHISPER_DIR = process.env.TNA_WHISPER_DIR || path.join(__dirname, 'whisper');
const AI_TIMEOUT_MS = 60000;

let win = null;
let ai = null;
let whisper = null;
let pipeline = null;
let speech = { state: 'starting', message: '' };

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
  });
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
    provider: names[s.provider] || s.provider, hasKey: !!(ai && ai.ready), speech,
  };
});

ipcMain.handle('iv:questions', (event, p) => {
  if (!fromWin(event) || !p) return null;
  return withTimeout(async signal => ({ questions: await coach.generateQuestions(ai, {
    company: String(p.company || ''), role: String(p.role || ''), round: String(p.round || ''), level: String(p.level || ''),
    count: Number(p.count) || 5, focus: String(p.focus || ''), avoid: Array.isArray(p.avoid) ? p.avoid.map(String) : [], signal,
  }) }));
});

ipcMain.handle('iv:evaluate', (event, p) => {
  if (!fromWin(event) || !p) return null;
  return withTimeout(async signal => ({ feedback: await coach.evaluateAnswer(ai, {
    company: String(p.company || ''), role: String(p.role || ''), round: String(p.round || ''), level: String(p.level || ''),
    question: String(p.question || ''), points: Array.isArray(p.points) ? p.points.map(String) : [], answer: String(p.answer || ''), signal,
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

app.whenReady().then(() => {
  // only this window may use the microphone
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(!!(win && wc === win.webContents && permission === 'media'));
  });
  buildAI();
  createWindow();
  win.webContents.once('did-finish-load', () => { startSpeech(); if (process.argv.includes('--smoke')) runSmoke(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (pipeline) pipeline.stop(); if (whisper) whisper.stop(); });
