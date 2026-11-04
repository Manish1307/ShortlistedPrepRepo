// Records docs/video/intro.html to docs/video/shortlistprep-intro.webm.   Run: npx electron docs/video/record.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'intro.html'));
  const bytes = await win.webContents.executeJavaScript('window.startRecording()');
  const out = path.join(__dirname, 'shortlistprep-intro.webm');
  fs.writeFileSync(out, Buffer.from(bytes));
  console.log('Saved ' + out + ' (' + Math.round(bytes.length / 1024) + ' KB)');
  app.quit();
});
