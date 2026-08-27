const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Keep the renderer running at full speed while the window is minimized or
// hidden behind other apps — the normal state during a screen share. Without
// this, Chromium throttles timers/rAF/compositing when the window isn't
// visible, which stalls the local stats readout (the capture and the WebRTC
// stream to viewers are never throttled, only the in-app measurement).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

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
      backgroundThrottling: false,
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

// Chrome/Edge show their own "choose what to share" picker for
// getDisplayMedia(); Electron doesn't and resolves the request through this
// handler instead. The renderer runs our themed picker *before* calling
// getDisplayMedia (screen-picker:sources + screen-picker:choose below) and
// stashes the choice here — the handler just applies it. This ordering
// matters: Electron can't capture a single window's audio, so a window
// share must call getDisplayMedia with audio:false, and the renderer can
// only know that once the picker has resolved. Requesting audio for a
// window aborts the whole capture with "Invalid capture constraints".
let pendingPick = null;

function registerScreenPicker() {
  ipcMain.handle('screen-picker:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
      isScreen: source.id.startsWith('screen:'),
    }));
  });

  // Awaited by the renderer before getDisplayMedia() so the choice is in
  // place by the time the handler runs. Null clears a stale pick.
  ipcMain.handle('screen-picker:choose', (_event, pick) => {
    pendingPick = pick || null;
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const pick = pendingPick;
    pendingPick = null;
    if (!pick) {
      // No pick staged (cancelled, or getDisplayMedia called outside our
      // flow) — empty response makes it reject with NotAllowedError, which
      // share.js already handles.
      callback({});
      return;
    }

    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const chosen = sources.find((source) => source.id === pick.sourceId);
    if (!chosen) {
      callback({});
      return;
    }

    // 'loopback' captures whole-system audio (Windows/macOS). Only ever for
    // a full screen — see the comment on pendingPick above.
    callback({ video: chosen, audio: pick.withAudio ? 'loopback' : undefined });
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
    // Any failure (network, no releases yet) surfaces through the 'error'
    // event below — don't also reject here or the renderer double-reports it.
    autoUpdater.checkForUpdates().catch(() => {});
    return { state: 'checking' };
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
