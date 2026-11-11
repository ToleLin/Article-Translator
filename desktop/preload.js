/* PaperLens 桌面版 — preload
 * 只開放幾個固定的 IPC 管道給頁面（contextIsolation + sandbox），
 * 頁面端的 chrome.* 模擬在 shim.js。
 */
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('PLDesktopBridge', {
  send: (msg) => ipcRenderer.invoke('pl:send', msg),
  storage: (op, arg) => ipcRenderer.invoke('pl:storage', op, arg),
  broadcast: (msg) => ipcRenderer.invoke('pl:broadcast', msg),
  version: () => ipcRenderer.invoke('pl:version'),
  appVersion: (() => { try { return ipcRenderer.sendSync('pl:version-sync'); } catch (e) { return '0.0.0'; } })(),
  viewerReady: () => ipcRenderer.invoke('pl:viewer-ready'),
  docOpened: (title) => ipcRenderer.send('pl:doc-opened', title),
  openPath: (filePath) => ipcRenderer.invoke('pl:open-path', filePath),
  openDialog: () => ipcRenderer.invoke('pl:open-dialog'),
  savePdf: (opts) => ipcRenderer.invoke('pl:save-pdf', opts),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  },
  onMessage: (fn) => ipcRenderer.on('pl:message', (e, msg) => fn(msg)),
  onOpenFile: (fn) => ipcRenderer.on('pl:open-file', (e, f) => fn(f))
});
