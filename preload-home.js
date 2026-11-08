// Bridge for the in-game Home menu overlay (renderer/home.html): it only receives what to show and reports the choice.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('home', {
  onOpen: fn => ipcRenderer.on('home:open', (e, d) => fn(d)),
  onButton: fn => ipcRenderer.on('home:button', (e, d) => fn(d)),
  onToast: fn => ipcRenderer.on('home:toast', (e, t) => fn(t)),
  onPaused: fn => ipcRenderer.on('home:paused', (e, p) => fn(p)),
  act: action => ipcRenderer.send('home:act', String(action))
});
