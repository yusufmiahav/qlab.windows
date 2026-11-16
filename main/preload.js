const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cs', {
  cmd: (name, args) => ipcRenderer.invoke('cmd', name, args),
  on: (channel, fn) => ipcRenderer.on(channel, (e, payload) => fn(payload)),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
