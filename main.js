const { app, BrowserWindow, Menu, Tray, session, desktopCapturer, ipcMain, globalShortcut, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
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

// Chromium demotes a hidden or covered renderer to background priority on
// Windows, and the renderer is what packetizes and paces the outgoing RTP — so
// a share started from a window sitting behind a game loses frames to the game's
// threads. Deliberately NOT disabling native window occlusion or timer
// throttling: the viewer auto-pause and the hidden-window skips in the stats
// poll rely on document.hidden turning true when a game covers the window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow = null;
let tray = null;
let quitting = false;
let updateReady = false;
let voiceState = { inVoice: false, isMuted: false, isDeafened: false };

// Started by the OS at login with --hidden (see the "Iniciar minimizado" setting):
// stay in the tray instead of opening a window over whatever the user is doing.
const launchedHidden = process.argv.includes('--hidden');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0b0b10',
    show: !launchedHidden,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // A reload or crash drops the page that was reading the PCM.
  mainWindow.webContents.on('did-start-loading', stopLoopbackHelper);
  mainWindow.webContents.on('render-process-gone', stopLoopbackHelper);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('did-fail-load', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    console.log(`renderer console [${level}]:`, message, `(${sourceId}:${lineNumber})`);
  });

  // The app never opens external links or navigates away from its own
  // index.html (no window.open/target=_blank anywhere in the codebase), so
  // both are just denied outright rather than routed to shell.openExternal —
  // nothing to preserve, and it closes off using either as a way to load
  // arbitrary content into this window.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (!prefs.closeToTray) {
      // "Fechar minimiza para a bandeja" is off: X really closes the app.
      quitting = true;
      return;
    }
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

// Preferences the main process needs before any page has loaded (the close
// behavior and how to start), kept in userData rather than the page's storage.
const PREFS_FILE = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
let prefs = { closeToTray: true, startMinimized: false };

function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'));
    prefs = { closeToTray: raw.closeToTray !== false, startMinimized: raw.startMinimized === true };
  } catch { /* first run, or unreadable: the defaults stand */ }
}

function savePrefs() {
  try { fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs)); } catch { /* the choice just isn't remembered */ }
}

const loginItemArgs = () => (prefs.startMinimized ? ['--hidden'] : []);
// Registering the dev electron.exe as a login item would be wrong, so this is
// only ever touched by the installed app.
const readOpenAtLogin = () => (app.isPackaged ? app.getLoginItemSettings({ args: loginItemArgs() }).openAtLogin : false);

// Global mute/deafen. The renderer asks for accelerators; nothing that could
// swallow ordinary typing system-wide is accepted (needs Ctrl/Alt/Super or an
// F-key), even from a compromised page.
const HOTKEY_KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Tab|Enter|Backspace|[`\-=\[\]\\;',./])$/;
const HOTKEY_MODIFIERS = ['Control', 'Alt', 'Shift', 'Super'];
let registeredHotkeys = [];

function isSafeHotkey(accel) {
  if (typeof accel !== 'string' || accel.length > 40) return false;
  const parts = accel.split('+');
  const key = parts.pop();
  if (!HOTKEY_KEY.test(key)) return false;
  if (new Set(parts).size !== parts.length || !parts.every((m) => HOTKEY_MODIFIERS.includes(m))) return false;
  return parts.some((m) => m === 'Control' || m === 'Alt' || m === 'Super') || /^F\d/.test(key);
}

// ---- Stream audio without Discord ----
// Chromium's loopback capture takes everything the default output plays, Discord's
// voice chat included. When Discord is running, the stream's audio instead comes
// from a helper that captures "everything except Discord's processes" through the
// Windows process-loopback API (win-process-loopback.ps1) and hands back raw PCM,
// which the page turns into the audio track (public/js/appAudio.js). Anything that
// goes wrong here (old Windows, Discord not running, PowerShell blocked) reports
// { ok:false } and the page keeps the regular system audio.
const AUDIO_EXCLUDE_NAMES = process.env.SCRIMA_AUDIO_EXCLUDE || 'Discord,DiscordPTB,DiscordCanary';
const LOOPBACK_START_TIMEOUT_MS = 15000; // the first run compiles the helper
const PCM_FRAME_BYTES = 4; // 16-bit stereo
let loopbackHelper = null;

function stopLoopbackHelper() {
  const child = loopbackHelper;
  loopbackHelper = null;
  if (child) { try { child.kill(); } catch { /* already gone */ } }
}

// Process loopback exists from Windows 10 2004 (build 19041).
const supportsProcessLoopback = () => process.platform === 'win32' && Number(os.release().split('.')[2]) >= 19041;

function startLoopbackHelper(sourceId) {
  stopLoopbackHelper();
  if (!supportsProcessLoopback()) return Promise.resolve({ ok: false, reason: 'unsupported' });

  // PowerShell can't read from inside the asar, so the script is copied out; the
  // compiled helper is cached next to it, both keyed by the script's content.
  const source = fs.readFileSync(path.join(__dirname, 'win-process-loopback.ps1'), 'utf8');
  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 8);
  const dir = app.getPath('userData');
  const script = path.join(dir, `win-process-loopback-${hash}.ps1`);
  if (!fs.existsSync(script)) fs.writeFileSync(script, source, 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // A window share captures only that program's audio (so Discord, mic monitoring
  // and every other app are left out whatever device they play on); a screen share
  // has no single program, so it is "everything except Discord".
  const windowHandle = /^window:(\d+):/.exec(String(sourceId || ''));
  const target = windowHandle ? ['-Mode', 'include', '-Hwnd', windowHandle[1]] : ['-Mode', 'exclude'];

  return new Promise((resolve) => {
    // -MTA: the audio client lives in the MTA and has no proxy for a PowerShell STA thread.
    const child = spawn(powershell, [
      '-MTA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      ...target, '-Name', AUDIO_EXCLUDE_NAMES, '-DllPath', path.join(dir, `scrima-loopback-${hash}.dll`),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    loopbackHelper = child;

    let settled = false;
    let stderr = '';
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok && loopbackHelper === child) stopLoopbackHelper();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), LOOPBACK_START_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('READY')) return settle({ ok: true, mode: /MODE:(\w+)/.exec(stderr)?.[1] || target[1] });
      const failure = /ERR:(\S+)/.exec(stderr);
      if (failure) settle({ ok: false, reason: failure[1] });
    });
    // Chunks arrive at arbitrary sizes; the page needs whole stereo frames.
    let pending = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      if (loopbackHelper !== child) return;
      pending = Buffer.concat([pending, chunk]);
      const usable = pending.length - (pending.length % PCM_FRAME_BYTES);
      if (!usable) return;
      mainWindow?.webContents.send('app-audio:pcm', new Uint8Array(pending.subarray(0, usable)));
      pending = pending.subarray(usable);
    });
    child.stdout.on('error', () => {});
    child.on('error', () => settle({ ok: false, reason: 'spawn-failed' }));
    child.on('exit', (code) => {
      settle({ ok: false, reason: `exit-${code}` });
      if (loopbackHelper === child) loopbackHelper = null;
    });
  });
}

function registerDesktopIpc() {
  ipcMain.handle('app-audio:start', (_event, sourceId) => startLoopbackHelper(sourceId));
  ipcMain.handle('app-audio:stop', () => stopLoopbackHelper());

  ipcMain.handle('hotkeys:set', (_event, bindings) => {
    registeredHotkeys.forEach((accel) => globalShortcut.unregister(accel));
    registeredHotkeys = [];
    const result = { mute: false, deafen: false };
    ['mute', 'deafen'].forEach((action) => {
      const accel = bindings?.[action];
      if (!isSafeHotkey(accel) || registeredHotkeys.includes(accel)) return;
      let granted = false;
      try {
        granted = globalShortcut.register(accel, () => mainWindow?.webContents.send('hotkeys:trigger', action));
      } catch { /* an accelerator Electron can't parse counts as refused */ }
      if (granted) {
        registeredHotkeys.push(accel);
        result[action] = true;
      }
    });
    return result;
  });

  ipcMain.handle('desktop:show-window', () => showWindow());
  ipcMain.handle('desktop:set-unread', (_event, count, iconDataUrl) => applyUnread(count, iconDataUrl));
  ipcMain.handle('deeplink:take', () => {
    inviteListenerReady = true;
    const id = pendingInvite;
    pendingInvite = null;
    return id;
  });

  ipcMain.handle('desktop:get-prefs', () => ({
    closeToTray: prefs.closeToTray,
    startMinimized: prefs.startMinimized,
    openAtLogin: readOpenAtLogin(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('desktop:set-prefs', (_event, patch) => {
    const wasOpenAtLogin = readOpenAtLogin(); // read with the old args, before they change
    if (typeof patch?.closeToTray === 'boolean') prefs.closeToTray = patch.closeToTray;
    if (typeof patch?.startMinimized === 'boolean') prefs.startMinimized = patch.startMinimized;
    savePrefs();
    if (app.isPackaged && (typeof patch?.openAtLogin === 'boolean' || typeof patch?.startMinimized === 'boolean')) {
      app.setLoginItemSettings({
        openAtLogin: typeof patch.openAtLogin === 'boolean' ? patch.openAtLogin : wasOpenAtLogin,
        args: loginItemArgs(),
      });
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopLoopbackHelper();
  });
}

// scrima://invite/<serverId> — opens the app and accepts the server invite.
// Windows hands the URL to a cold start in argv and to a running instance via
// `second-instance`; either way the renderer gets only the validated id. A
// cold start's link waits in `pendingInvite` until the page asks for it.
const DEEP_LINK = /^scrima:\/\/invite\/([A-Za-z0-9_-]{1,100})\/?$/i;
let pendingInvite = null;
let inviteListenerReady = false;

function inviteFromArgv(argv) {
  for (const arg of argv) {
    const match = DEEP_LINK.exec(arg);
    if (match) return match[1];
  }
  return null;
}

function handleInviteLink(serverId) {
  if (!serverId) return;
  if (inviteListenerReady) mainWindow?.webContents.send('deeplink:invite', serverId);
  else pendingInvite = serverId;
  showWindow();
}

// Messages that arrived while the window wasn't being looked at. The renderer
// owns the count (it resets on focus) and draws the overlay icon on a canvas;
// this only applies it to the taskbar button and the tray tooltip.
const TRAY_TOOLTIP = 'Scrima aí';
function applyUnread(count, iconDataUrl) {
  const n = Number.isInteger(count) && count > 0 ? Math.min(count, 999) : 0;
  const valid = typeof iconDataUrl === 'string' && iconDataUrl.length < 20000 && iconDataUrl.startsWith('data:image/png;base64,');
  mainWindow?.setOverlayIcon(n && valid ? nativeImage.createFromDataURL(iconDataUrl) : null, n ? `${n} não lidas` : '');
  if (n && !mainWindow?.isFocused()) mainWindow?.flashFrame(true);
  else mainWindow?.flashFrame(false);
  tray?.setToolTip(n ? `${TRAY_TOOLTIP} — ${n} ${n === 1 ? 'mensagem não lida' : 'mensagens não lidas'}` : TRAY_TOOLTIP);
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
app.on('second-instance', (_event, argv) => {
  const serverId = inviteFromArgv(argv);
  if (serverId) handleInviteLink(serverId);
  else showWindow();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  loadPrefs();
  // The dev electron.exe must not become the system handler for scrima://.
  if (app.isPackaged) app.setAsDefaultProtocolClient('scrima');
  pendingInvite = inviteFromArgv(process.argv);
  registerDesktopIpc();
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
