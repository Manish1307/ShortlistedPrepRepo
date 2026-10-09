'use strict';
// App settings and the AI API keys (Gemini, Claude). Electron main process only.
// A key is encrypted with the operating system (Windows DPAPI / macOS Keychain) via safeStorage and
// is never sent to a web page. GEMINI_API_KEY / ANTHROPIC_API_KEY environment variables take priority.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  audioSource: process.platform === 'win32' ? 'both' : 'mic', // 'system' = what the meeting plays; 'mic' = microphone; 'both' = mixed
  subject: '',
  provider: 'gemini',                  // 'gemini' (has a free tier) or 'claude'
  geminiModel: 'gemini-3.8-flash',
  groqModel: 'llama-3.3-70b-versatile',
  model: 'claude-opus-5-5',            // the Claude model
  effort: 'low',                       // low = fastest; medium = thinks longer; high = thinks longest and looks facts up on the web
  whisperModel: 'ggml-small.en-q5_1.bin',
  language: 'en',
  autoAnswer: true,
  opacity: 100,                        // window see-through level in percent: 10, 20 ... 100
};

const ALLOWED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
const ALLOWED_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'];
const ALLOWED_GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'];
const ALLOWED_EFFORT = ['low', 'medium', 'high'];
const PROVIDERS = {
  gemini: { env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], file: 'gemini-key.bin' },
  groq: { env: ['GROQ_API_KEY'], file: 'groq-key.bin' },
  claude: { env: ['ANTHROPIC_API_KEY'], file: 'anthropic-key.bin' },
};

const dir = () => app.getPath('userData');
const settingsFile = () => path.join(dir(), 'settings.json');
const keyFile = provider => path.join(dir(), PROVIDERS[provider].file);
const envKey = provider => {
  const name = PROVIDERS[provider].env.find(n => process.env[n]);
  return name ? process.env[name].trim() : '';
};

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) { /* first run */ }
  return sanitize({ ...DEFAULTS, ...saved });
}

function sanitize(s) {
  const out = { ...DEFAULTS, ...s };
  if (!['system', 'mic', 'both'].includes(out.audioSource)) out.audioSource = DEFAULTS.audioSource;
  if (!PROVIDERS[out.provider]) out.provider = DEFAULTS.provider;
  if (!ALLOWED_GEMINI_MODELS.includes(out.geminiModel)) out.geminiModel = DEFAULTS.geminiModel;
  if (!ALLOWED_GROQ_MODELS.includes(out.groqModel)) out.groqModel = DEFAULTS.groqModel;
  if (!ALLOWED_MODELS.includes(out.model)) out.model = DEFAULTS.model;
  if (!ALLOWED_EFFORT.includes(out.effort)) out.effort = DEFAULTS.effort;
  out.subject = String(out.subject || '').slice(0, 200);
  out.autoAnswer = !!out.autoAnswer;
  out.opacity = Math.min(100, Math.max(10, Math.round(Number(out.opacity) / 10) * 10)) || 100;
  out.whisperModel = path.basename(String(out.whisperModel || DEFAULTS.whisperModel)); // no path tricks
  return out;
}

function save(patch) {
  const next = sanitize({ ...load(), ...patch });
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

/** Back to the defaults. Saved AI keys are kept (they are stored separately). */
function reset() {
  try { fs.unlinkSync(settingsFile()); } catch (_) { /* nothing saved */ }
  return load();
}

function getApiKey(provider) {
  if (!PROVIDERS[provider]) return '';
  const env = envKey(provider);
  if (env) return env;
  try {
    const data = fs.readFileSync(keyFile(provider));
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : '';
  } catch (_) { return ''; }
}

function apiKeySource(provider) {
  if (!PROVIDERS[provider]) return 'none';
  if (envKey(provider)) return 'environment';
  return fs.existsSync(keyFile(provider)) ? 'saved' : 'none';
}

/** Store (or clear, with an empty string) a provider's key. Returns false if it cannot be stored safely. */
function setApiKey(provider, key) {
  if (!PROVIDERS[provider]) return false;
  const k = String(key || '').trim();
  fs.mkdirSync(dir(), { recursive: true });
  if (!k) { try { fs.unlinkSync(keyFile(provider)); } catch (_) { /* nothing saved */ } return true; }
  if (!safeStorage.isEncryptionAvailable()) return false; // never write a key in plain text
  fs.writeFileSync(keyFile(provider), safeStorage.encryptString(k));
  return true;
}

module.exports = { load, save, reset, getApiKey, setApiKey, apiKeySource, DEFAULTS, ALLOWED_MODELS, ALLOWED_GEMINI_MODELS, ALLOWED_GROQ_MODELS, PROVIDERS };
