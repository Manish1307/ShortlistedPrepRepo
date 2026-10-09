#!/usr/bin/env node
'use strict';
// Builds the website, then runs the website preview (4173) and the admin dashboard (4180) together.
// Press Ctrl+C once to stop both.   npm run web

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const build = spawnSync(process.execPath, ['website/build.js'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);

const children = [
  spawn(process.execPath, ['website/serve.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['--no-warnings', 'admin/server.js'], { cwd: root, stdio: 'inherit' }),
];
console.log('\n  Website : http://localhost:4173\n  Admin   : http://localhost:4180\n  Stop both with Ctrl+C\n');

const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', code => { if (code) { console.error(`A server stopped (code ${code}).`); stop(); } });
