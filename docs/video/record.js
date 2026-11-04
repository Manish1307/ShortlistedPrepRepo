// Records docs/video/intro.html to docs/video/raw.webm. Then convert it to a standard MP4 with ffmpeg: ffmpeg -i raw.webm -vf fps=30,format=yuv420p -c:v libx264 -crf 20 -movflags +faststart -an shortlistprep-intro.mp4   (run: npx electron docs/video/record.js)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'intro.html'));
  const bytes = await win.webContents.executeJavaScript('window.startRecording()');
  const out = path.join(__dirname, 'raw.webm');
  fs.writeFileSync(out, Buffer.from(bytes));
  console.log('Saved ' + out + ' (' + Math.round(bytes.length / 1024) + ' KB)');
  app.quit();
});
