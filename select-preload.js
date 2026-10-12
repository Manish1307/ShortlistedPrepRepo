const { contextBridge, ipcRenderer } = require('electron');

// The selection screen (screen capture) may only receive its picture and send back the box that was drawn.
contextBridge.exposeInMainWorld('selectAPI', {
  onImage: callback => ipcRenderer.on('select:image', (_event, url) => callback(url)),
  ready: () => ipcRenderer.send('select:ready'),
  done: r => ipcRenderer.send('select:done', !r ? null : r.full ? { full: true }
    : { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) }),
});
