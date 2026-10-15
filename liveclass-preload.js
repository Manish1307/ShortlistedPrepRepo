const { contextBridge, ipcRenderer } = require('electron');

// What the Live Class window may do. AI keys never reach the page.
const subscribe = (channel, callback) => {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('liveClassAPI', {
  info: () => ipcRenderer.invoke('lc:info'),
  sendAudio: buffer => ipcRenderer.send('lc:audio', buffer),
  setListening: on => ipcRenderer.send('lc:listening', !!on),
  askLast: () => ipcRenderer.send('lc:ask-last'),
  askTyped: (text, corrected) => ipcRenderer.send('lc:ask-typed', String(text || ''), corrected === true),
  captureScreen: () => ipcRenderer.send('lc:capture'),
  setAutoAnswer: on => ipcRenderer.send('lc:auto-answer', !!on),
  close: () => ipcRenderer.send('lc:close'),
  onEngine: callback => subscribe('engine', callback),
  onPipeline: callback => subscribe('pipeline', callback),
});
