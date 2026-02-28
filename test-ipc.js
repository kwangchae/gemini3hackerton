const { app, BrowserWindow, ipcMain } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadURL(`data:text/html,<html>
    <body>
      <script>
        const { ipcRenderer } = require('electron');
        const ab = new ArrayBuffer(10);
        ipcRenderer.send('data', ab);
        setTimeout(() => require('electron').remote.app.quit(), 1000);
      </script>
    </body>
  </html>`);

  ipcMain.on('data', (e, chunk) => {
    console.log('--- TEST RESULTS ---');
    console.log('type:', typeof chunk);
    console.log('isBuffer:', Buffer.isBuffer(chunk));
    try {
      const b64 = Buffer.from(chunk).toString('base64');
      console.log('base64 length:', b64.length);
    } catch (err) {
      console.error('Buffer.from error:', err.message);
    }
    app.quit();
  });
});
