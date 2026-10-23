'use strict';
// Renders docs/presentation/deck.html to ShortlistPrep-Stakeholder-Presentation.pdf (12 slides, 16:9).
//   node_modules\.bin\electron docs\presentation\render.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false });
  await win.loadURL(pathToFileURL(path.join(__dirname, 'deck.html')).href);
  await new Promise(r => setTimeout(r, 1200));
  const pdf = await win.webContents.printToPDF({ pageSize: { width: 1280 / 96, height: 720 / 96 }, printBackground: true, margins: { marginType: 'none' } });
  fs.writeFileSync(path.join(__dirname, 'ShortlistPrep-Stakeholder-Presentation.pdf'), pdf);
  console.log('saved', pdf.length);
  app.quit();
});
