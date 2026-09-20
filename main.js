const { app, BrowserWindow, Menu, Tray, session, desktopCapturer, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The app runs next to a game, so it should only ever soak up CPU the game
// isn't using. Chromium's own children (GPU process, capture/encode helpers,
// renderers) spawn on demand — sharing starts a few — so this re-applies on a
// slow timer instead of once. The encode itself is on the GPU; this is about
// the CPU-side capture/convert/RTP work competing with the game's threads.
function lowerPriority() {
  for (const { pid } of app.getAppMetrics()) {
    try {
      os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch { /* process exited between the metrics call and here */ }
  }
}

let mainWindow = null;
let tray = null;
let quitting = false;
let updateReady = false;
let voiceState = { inVoice: false, isMuted: false, isDeafened: false };

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
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    console.log(`renderer console [${level}]:`, message, `(${sourceId}:${lineNumber})`);
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    showTrayHintOnce();
  });
  // Windows won't emit before-quit on shutdown/logoff; without this the
  // close handler above would stall the session end.
  mainWindow.on('session-end', () => { quitting = true; });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
}

// Chrome/Edge show their own "choose what to share" picker for
// getDisplayMedia(); Electron doesn't and resolves the request through this
// handler instead. The renderer runs our themed picker *before* calling
// getDisplayMedia (screen-picker:sources + screen-picker:choose below) and
// stashes the choice here — the handler just applies it. This ordering
// matters: the renderer must only request audio when the user chose it, and
// the handler must grant it — a mismatch aborts the whole capture with
// "Invalid capture constraints".
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

    // 'loopback' captures whatever plays on the default output device
    // (Windows/macOS), for a screen or a window pick alike.
    callback({ video: chosen, audio: pick.withAudio ? 'loopback' : undefined });
  }, { useSystemPicker: false });
}

// Closing the window hides it (Discord-style) so voice and shares keep
// running; only Sair, an update restart or an OS shutdown really quits. Mute
// and deafen state lives in the renderer (voice.js), so the tray menu mirrors
// it through `voice:state` and drives it through `voice:command`.
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showTrayHintOnce() {
  const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
  if (fs.existsSync(flag)) return;
  try { fs.writeFileSync(flag, ''); } catch { /* the hint just shows again next time */ }
  tray?.displayBalloon?.({
    iconType: 'info',
    title: 'Scrima aí',
    content: 'O app continua rodando na bandeja. Clique com o botão direito no ícone para sair.',
  });
}

function sendVoiceCommand(command) {
  mainWindow?.webContents.send('voice:command', command);
}

function buildTrayMenu() {
  const { inVoice, isMuted, isDeafened } = voiceState;
  return Menu.buildFromTemplate([
    { label: isMuted ? 'Desmutar' : 'Mutar', enabled: inVoice, click: () => sendVoiceCommand('toggle-mute') },
    { label: isDeafened ? 'Desativar surdina' : 'Ensurdecer', enabled: inVoice, click: () => sendVoiceCommand('toggle-deafen') },
    ...(updateReady
      ? [{ type: 'separator' }, { label: 'Reiniciar para atualizar', click: () => autoUpdater.quitAndInstall() }]
      : []),
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
}

function refreshTray() {
  tray?.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'public', 'favicon-32.png'));
  tray.setToolTip('Scrima aí');
  tray.on('click', showWindow);
  refreshTray();

  ipcMain.on('voice:state', (_event, next) => {
    voiceState = { inVoice: !!next?.inVoice, isMuted: !!next?.isMuted, isDeafened: !!next?.isDeafened };
    refreshTray();
  });
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
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    refreshTray();
    send('downloaded', { version: info.version });
  });
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

// A second launch (e.g. the shortcut while the app sits in the tray) would
// otherwise start a second copy fighting over the mic; focus the first instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();
  createTray();
  registerScreenPicker();
  initUpdater();
  lowerPriority();
  setInterval(lowerPriority, 5000).unref();
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
