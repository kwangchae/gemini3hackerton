const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);

  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  startLiveSession: () => ipcRenderer.invoke('live-session-start'),
  getDesktopSource: () => ipcRenderer.invoke('desktop-source-id'),
  sendAudioChunk: (chunk, mimeType = 'audio/webm;codecs=opus') => {
    ipcRenderer.send('live-audio-chunk', { chunk, mimeType });
  },
  endLiveSession: () => ipcRenderer.send('live-session-end'),
  onLiveCaption: (callback) => subscribe('live-caption', callback),
  onLiveError: (callback) => subscribe('live-error', callback),
  onLiveStatus: (callback) => subscribe('live-status', callback),
  onLiveDebug: (callback) => subscribe('live-debug', callback)
});
