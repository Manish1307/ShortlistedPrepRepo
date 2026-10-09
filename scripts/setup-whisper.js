#!/usr/bin/env node
'use strict';
// One-time setup of the OFFLINE speech engine:
//   1. whisper.cpp prebuilt Windows binaries (CPU)      from github.com/ggml-org/whisper.cpp releases (about 9 MB)
//   2. one Whisper model file                           from huggingface.co/ggerganov/whisper.cpp
// Usage:  npm run setup:whisper                (default model: small.en-q5_1, about 181 MB)
//         npm run setup:whisper -- --model medium.en-q5_0
//         npm run setup:whisper -- --model-only      (binaries already there)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'whisper');
const BIN_DIR = path.join(ROOT, 'bin');
const MODELS_DIR = path.join(ROOT, 'models');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const MODEL = option('--model', 'small.en-q5_1').replace(/^ggml-/, '').replace(/\.bin$/, '');
const MODEL_FILE = `ggml-${MODEL}.bin`;
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'teacher-notes-app-setup' } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let done = 0, lastPrint = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    done += chunk.length;
    if (Date.now() - lastPrint > 400) {
      lastPrint = Date.now();
      const mb = (done / 1048576).toFixed(0);
      process.stdout.write(`\r  ${label}: ${mb}${total ? ' / ' + (total / 1048576).toFixed(0) : ''} MB   `);
    }
  }
  await new Promise((resolve, reject) => { out.end(err => (err ? reject(err) : resolve())); });
  fs.renameSync(tmp, dest);
  process.stdout.write(`\r  ${label}: ${(done / 1048576).toFixed(0)} MB done            \n`);
  return done;
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
    else if (entry.name.toLowerCase() === name) return p;
  }
  return null;
}

async function setupBinaries() {
  if (fs.existsSync(path.join(BIN_DIR, 'whisper-server.exe'))) { console.log('whisper-server.exe already present, skipping binaries.'); return; }
  if (process.platform !== 'win32') {
    console.log('This script downloads Windows binaries. On macOS/Linux build whisper.cpp yourself (cmake) and put whisper-server in whisper/bin.');
    return;
  }
  console.log('Finding the latest whisper.cpp Windows build...');
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20', { headers: { 'User-Agent': 'teacher-notes-app-setup' } });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const releases = await res.json();
  let asset = null, tag = '';
  for (const r of releases) {
    const a = (r.assets || []).find(x => x.name === 'whisper-bin-x64.zip');
    if (a) { asset = a; tag = r.tag_name; break; }
  }
  if (!asset) throw new Error('No release with whisper-bin-x64.zip found');
  console.log(`Using ${tag}: ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zip = path.join(os.tmpdir(), `whisper-bin-x64-${Date.now()}.zip`);
  await download(asset.browser_download_url, zip, 'whisper.cpp');
  const extractTo = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-bin-'));
  // PowerShell's own unzip: always present on Windows (a "tar" on the PATH may be GNU tar, which cannot read C:\ paths)
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extractTo}' -Force`], { stdio: 'inherit' });
  const server = findFile(extractTo, 'whisper-server.exe');
  if (!server) throw new Error('whisper-server.exe was not in the download. Contents: ' + fs.readdirSync(extractTo).join(', '));
  const srcDir = path.dirname(server);
  for (const f of fs.readdirSync(srcDir)) fs.copyFileSync(path.join(srcDir, f), path.join(BIN_DIR, f));
  fs.rmSync(extractTo, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  fs.writeFileSync(path.join(BIN_DIR, 'VERSION.txt'), `whisper.cpp ${tag}\n`);
  console.log(`Installed whisper.cpp ${tag} into ${BIN_DIR}`);
}

async function setupModel() {
  const dest = path.join(MODELS_DIR, MODEL_FILE);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10 * 1048576) { console.log(`${MODEL_FILE} already present, skipping.`); return; }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  console.log(`Downloading model ${MODEL_FILE} ...`);
  const size = await download(MODEL_URL, dest, MODEL_FILE);
  if (size < 10 * 1048576) { fs.rmSync(dest, { force: true }); throw new Error('Model download looks incomplete'); }
}

(async () => {
  try {
    if (!flag('--model-only')) await setupBinaries();
    await setupModel();
    console.log('\nDone. Start the app with:  npm start');
  } catch (err) {
    console.error('\nSetup failed:', err.message);
    process.exit(1);
  }
})();
