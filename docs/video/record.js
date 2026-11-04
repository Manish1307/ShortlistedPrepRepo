// Records a video page to docs/video/<name>-raw.webm. Run: npx electron docs/video/record.js intro|prep|live
// Then convert it to a standard MP4 with ffmpeg:
//   ffmpeg -i <name>-raw.webm -vf fps=30,format=yuv420p -c:v libx264 -crf 20 -movflags +faststart -an <name>.mp4
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const name = process.argv[2] || 'intro';
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, name + '.html'));
  const bytes = await win.webContents.executeJavaScript('window.startRecording()');
  const out = path.join(__dirname, name + '-raw.webm');
  fs.writeFileSync(out, Buffer.from(bytes));
  console.log('Saved ' + out + ' (' + Math.round(bytes.length / 1024) + ' KB)');
  app.quit();
});
