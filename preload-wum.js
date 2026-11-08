// Bridge for the hidden Wii U manual renderer window (renderer/wiiu-manual.html)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wum', {
  onModel: cb => ipcRenderer.on('wum:model', (e, m) => cb(m)), // every job sent: the background helper windows are reused
  done: (err, pages) => ipcRenderer.send('wum:done', err, pages)
});
