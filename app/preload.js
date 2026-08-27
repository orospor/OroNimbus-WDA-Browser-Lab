const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oroNimbus', {
  getState: () => ipcRenderer.invoke('lab:get-state'),
  inspect: () => ipcRenderer.invoke('lab:inspect'),
  navigate: (value) => ipcRenderer.invoke('browser:navigate', value),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  openExternal: (url) => ipcRenderer.invoke('browser:external', url),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  exit: () => ipcRenderer.invoke('window:exit'),
  onState: (callback) => ipcRenderer.on('lab:state', (_event, state) => callback(state)),
  onLocation: (callback) => ipcRenderer.on('browser:location', (_event, url) => callback(url)),
  onLoading: (callback) => ipcRenderer.on('browser:loading', (_event, loading) => callback(loading)),
  onFullscreen: (callback) => ipcRenderer.on('window:fullscreen', (_event, fullscreen) => callback(fullscreen)),
});
