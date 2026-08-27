const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenPicker', {
  // Available screen/window sources, fetched on demand by share.js before it
  // shows the themed picker.
  listSources: () => ipcRenderer.invoke('screen-picker:sources'),
  // Stashes the user's choice in main.js so the display-media handler can
  // apply it. Awaited before getDisplayMedia() so it's in place in time.
  // Pass null to clear a stale pick (e.g. on cancel).
  choose: (pick) => ipcRenderer.invoke('screen-picker:choose', pick),
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
