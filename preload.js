const { contextBridge, ipcRenderer } = require('electron');

// The only things the web pages may do. The API key can be SET from the page but is never sent back to it.
function subscribe(channel, callback) {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('notesAPI', {
  hide: () => ipcRenderer.send('notes:hide'),

  // audio in
  sendAudio: buffer => ipcRenderer.send('audio:chunk', buffer),
  setListening: on => ipcRenderer.send('listening:set', !!on),
  askLast: () => ipcRenderer.send('ask:last'),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  setApiKey: (provider, key) => ipcRenderer.invoke('apikey:set', provider, key),
  testAI: () => ipcRenderer.invoke('ai:test'),
  resetAssistant: () => ipcRenderer.invoke('assistant:reset'),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  exportSession: format => ipcRenderer.invoke('session:export', format),
  dragStart: () => ipcRenderer.send('win:drag-start'),
  drag: d => ipcRenderer.send('win:drag', { mode: d.mode === 'resize' ? 'resize' : 'move', dx: Number(d.dx), dy: Number(d.dy) }),
  dragEnd: () => ipcRenderer.send('win:drag-end'),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  getEngine: () => ipcRenderer.invoke('engine:status'),

  // events from the speech / AI engine
  onPipeline: callback => subscribe('pipeline', callback),
  onEngine: callback => subscribe('engine', callback),
  onUi: callback => subscribe('ui', callback),
});
