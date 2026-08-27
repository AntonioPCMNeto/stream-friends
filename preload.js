const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenPicker', {
  // Called by main.js's setDisplayMediaRequestHandler with the available
  // screen/window sources whenever getDisplayMedia() is invoked.
  onShow: (callback) => {
    ipcRenderer.on('screen-picker:show', (_event, sources) => callback(sources));
  },
  // Sends the user's choice back to main.js, which is waiting on it to
  // resolve the pending getDisplayMedia() request. Pass null to cancel.
  select: (result) => {
    ipcRenderer.send('screen-picker:selection', result);
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
