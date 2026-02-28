const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-test.js')
    }
  });
  win.loadURL('data:text/html,<html><body><script>window.api.send(new ArrayBuffer(10)); setTimeout(()=>window.api.send(new Uint8Array([1,2,3])), 100);</script></body></html>');
  let count = 0;
  ipcMain.on('data', (e, chunk) => {
    try {
      console.log('--- TEST ---');
      console.log('type:', typeof chunk);
      console.log('isBuffer:', Buffer.isBuffer(chunk));
      console.log('byteLength:', chunk.byteLength || (chunk.length ? chunk.length : 0));
      const b64 = Buffer.from(chunk).toString('base64');
      console.log('b64 length:', b64.length);
    } catch (err) {
      console.error(err);
    }
    count++;
    if (count === 2) app.quit();
  });
});
