const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('did-fail-load', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log('renderer console:', message, `(${sourceId}:${line})`);
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
}

// Chrome/Edge show their own native "choose what to share" picker for
// getDisplayMedia(); Electron doesn't, and instead resolves the request
// through this handler. We fetch the available sources ourselves, hand
// them to the renderer to show our own themed picker, and wait for the
// user's choice (or cancellation) before resolving the request.
function registerScreenPicker() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    const serializedSources = sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
      isScreen: source.id.startsWith('screen:'),
    }));

    const selection = await new Promise((resolve) => {
      ipcMain.once('screen-picker:selection', (_event, result) => resolve(result));
      mainWindow.webContents.send('screen-picker:show', serializedSources);
    });

    if (!selection) {
      // User cancelled — resolving with no video makes getDisplayMedia()
      // reject with NotAllowedError, which share.js already handles.
      callback({});
      return;
    }

    const chosen = sources.find((source) => source.id === selection.sourceId);
    if (!chosen) {
      callback({});
      return;
    }

    // 'loopback' captures full system audio on Windows/macOS — real desktop
    // audio capture that plain getDisplayMedia() in a browser can't offer
    // for a full-screen share.
    callback({ video: chosen, audio: selection.withAudio ? 'loopback' : undefined });
  }, { useSystemPicker: false });
}

app.whenReady().then(() => {
  createWindow();
  registerScreenPicker();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
