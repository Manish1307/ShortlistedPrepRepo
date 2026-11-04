'use strict';
// Renders docs/linkedin/jobs-slides.html to PNG files (1080 x 1350 slides, saved at 1.5x = 1620 x 2025).
//   node_modules\.bin\electron docs\linkedin\render-jobs.js        (writes docs/linkedin/jobs-*.png)
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAMES = { 1: 'jobs-1-cover', 2: 'jobs-2-latest-first', 3: 'jobs-3-three-ways' };
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const n of Object.keys(NAMES)) {
    const win = new BrowserWindow({ width: 1620, height: 900, show: false, webPreferences: { offscreen: true } });
    await win.loadURL(pathToFileURL(path.join(__dirname, 'jobs-slides.html')).href + '?s=' + n + '&z=1.5');
    await sleep(700);
    win.setContentSize(1620, 2025);   // taller than the screen is fine for an offscreen window
    await sleep(1200);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, NAMES[n] + '.png'), img.toPNG());
    console.log('saved ' + NAMES[n]);
    win.destroy();
  }
  app.quit();
});
