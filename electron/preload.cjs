// Pilot preload — exposes a minimal, whitelisted API to the shell renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pilot', {
  // window chrome
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-fullscreen'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowState: (cb) => ipcRenderer.on('window-state', (_e, s) => cb(s)),

  // clipboard through main — navigator.clipboard isn't guaranteed on the
  // file:// shell page
  clipboardReadText: () => ipcRenderer.invoke('clipboard-read-text'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  savePdf: (data) => ipcRenderer.invoke('save-pdf', data),
  savePage: (wcId) => ipcRenderer.invoke('save-page', wcId),
  downloadUrl: (url) => ipcRenderer.invoke('download-url', url),
  // guests forward shell shortcuts as 'ms:t'/'m:k'/'k:f11' combos
  onGuestShortcut: (cb) => ipcRenderer.on('guest-shortcut', (_e, combo) => cb(combo)),

  // app metadata
  meta: () => ipcRenderer.invoke('app-meta'),
  setAppTheme: (t) => ipcRenderer.invoke('set-app-theme', t),

  // files / os
  showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),

  // downloads
  listDownloads: () => ipcRenderer.invoke('list-downloads'),
  onDownloadUpdate: (cb) => ipcRenderer.on('download-update', (_e, d) => cb(d)),

  // links that requested a new window are surfaced here -> open as tab
  onOpenUrlInTab: (cb) => ipcRenderer.on('open-url-in-tab', (_e, url) => cb(url)),
});
