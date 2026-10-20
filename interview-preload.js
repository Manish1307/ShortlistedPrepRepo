const { contextBridge, ipcRenderer } = require('electron');

// What the mock interview window may do. AI keys never reach the page.
const subscribe = (channel, callback) => {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('interviewAPI', {
  info: () => ipcRenderer.invoke('iv:info'),
  questions: p => ipcRenderer.invoke('iv:questions', p),
  evaluate: p => ipcRenderer.invoke('iv:evaluate', p),
  summary: items => ipcRenderer.invoke('iv:summary', items),
  activateLicence: key => ipcRenderer.invoke('iv:licence-activate', key),
  checkLicence: () => ipcRenderer.invoke('iv:licence-check'),
  onLicence: callback => subscribe('licence', callback),
  resumes: () => ipcRenderer.invoke('iv:resumes'),
  makeSet: p => ipcRenderer.invoke('iv:make-set', p),
  getSet: id => ipcRenderer.invoke('iv:get-set', { id }),
  introGuide: p => ipcRenderer.invoke('iv:intro-guide', p),
  introReview: p => ipcRenderer.invoke('iv:intro-review', p),
  save: s => ipcRenderer.invoke('iv:save', s),
  sendAudio: buffer => ipcRenderer.send('iv:audio', buffer),
  setListening: on => ipcRenderer.send('iv:listening', !!on),
  onSpeech: callback => subscribe('speech', callback),
  onSpeechEvent: callback => subscribe('speech-event', callback),
});
