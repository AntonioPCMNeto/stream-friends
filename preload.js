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
