const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
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

// electron-updater checks the GitHub Releases feed (the "publish" block in
// package.json) for a newer version, downloads it in the background, and
// installs it on the next quit — no manual download/reinstall. It runs once
// on launch and again whenever the renderer asks (the "Verificar
// atualizações" button, over the `updater:*` IPC below). Unpackaged
// (`electron .`) there's no install to update and autoUpdater errors out,
// so the checks are skipped and the button reports that instead.
function initUpdater() {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (state, extra = {}) =>
    mainWindow?.webContents.send('updater:status', { state, ...extra });

  autoUpdater.on('update-available', (info) => send('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => send('up-to-date'));
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => send('error', { message: String(err?.message || err) }));

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return { state: 'dev' };
    try {
      await autoUpdater.checkForUpdates();
      return { state: 'checking' };
    } catch (err) {
      return { state: 'error', message: String(err?.message || err) };
    }
  });
  ipcMain.handle('updater:install', () => {
    if (app.isPackaged) autoUpdater.quitAndInstall();
  });
  ipcMain.handle('updater:version', () => app.getVersion());

  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => console.error('Auto-update check failed:', err));
  }
}

app.whenReady().then(() => {
  createWindow();
  registerScreenPicker();
  initUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
