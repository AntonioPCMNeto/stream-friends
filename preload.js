const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('screenPicker', {
  // Available screen/window sources, fetched on demand by share.js before it
  // shows the themed picker.
  listSources: () => ipcRenderer.invoke('screen-picker:sources'),
  // Stashes the user's choice in main.js so the display-media handler can
  // apply it. Awaited before getDisplayMedia() so it's in place in time.
  // Pass null to clear a stale pick (e.g. on cancel).
  choose: (pick) => ipcRenderer.invoke('screen-picker:choose', pick),
});

// System-tray bridge — see createTray() in main.js. Absent on the web build,
// so voice.js only talks to it when it exists.
contextBridge.exposeInMainWorld('tray', {
  reportVoiceState: (voiceState) => ipcRenderer.send('voice:state', voiceState),
  onVoiceCommand: (callback) => {
    ipcRenderer.on('voice:command', (_event, command) => callback(command));
  },
});

// Global mute/deafen shortcuts — see registerDesktopIpc() in main.js. Absent on
// the web build, where hotkeys.js falls back to in-page key listeners.
contextBridge.exposeInMainWorld('hotkeys', {
  // { mute, deafen } accelerators (or null); resolves to { mute, deafen } booleans
  // saying which ones the OS actually granted.
  set: (bindings) => ipcRenderer.invoke('hotkeys:set', bindings),
  onTrigger: (callback) => {
    ipcRenderer.on('hotkeys:trigger', (_event, action) => callback(action));
  },
});

// Desktop-only preferences and window helpers for the settings page.
contextBridge.exposeInMainWorld('desktop', {
  showWindow: () => ipcRenderer.invoke('desktop:show-window'),
  // Unread count for the taskbar overlay/flash and tray tooltip; the icon is a
  // small PNG data URL drawn by the page. 0 clears it.
  setUnread: (count, iconDataUrl) => ipcRenderer.invoke('desktop:set-unread', count, iconDataUrl),
  getPrefs: () => ipcRenderer.invoke('desktop:get-prefs'),
  setPrefs: (patch) => ipcRenderer.invoke('desktop:set-prefs', patch),
  setZoom: (percent) => {
    if (Number.isFinite(percent)) webFrame.setZoomFactor(Math.min(2, Math.max(0.5, percent / 100)));
  },
});

// electron-updater bridge — see initUpdater() in main.js. Absent on the web
// build, which is how public/js/updater.js knows to stay hidden there.
contextBridge.exposeInMainWorld('updater', {
  check: () => ipcRenderer.invoke('updater:check'),
  install: () => ipcRenderer.invoke('updater:install'),
  version: () => ipcRenderer.invoke('updater:version'),
  onStatus: (callback) => {
    ipcRenderer.on('updater:status', (_event, payload) => callback(payload));
  },
});

// scrima://invite/<id> links — see handleInviteLink() in main.js. `take`
// returns the id of a link that launched the app (once), `onInvite` fires for
// links opened while it's already running.
contextBridge.exposeInMainWorld('deepLinks', {
  take: () => ipcRenderer.invoke('deeplink:take'),
  onInvite: (callback) => {
    ipcRenderer.on('deeplink:invite', (_event, serverId) => callback(serverId));
  },
});
