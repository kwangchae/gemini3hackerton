const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startAudioStream: (sampleRate) => ipcRenderer.send('audio-stream-start', sampleRate),
  sendAudioData: (chunk) => ipcRenderer.send('audio-stream-data', chunk),
  endAudioStream: () => ipcRenderer.send('audio-stream-end'),
  onTranscriptResult: (callback) => ipcRenderer.on('transcript-result', (event, data) => callback(data)),
  onTranslationResult: (callback) => ipcRenderer.on('translation-result', (event, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('error', (event, error) => callback(error)),
});
