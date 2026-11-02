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
  viewerReady: () => ipcRenderer.invoke('pl:viewer-ready'),
  docOpened: () => ipcRenderer.send('pl:doc-opened'),
  openDialog: () => ipcRenderer.invoke('pl:open-dialog'),
  savePdf: (opts) => ipcRenderer.invoke('pl:save-pdf', opts),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  },
  onMessage: (fn) => ipcRenderer.on('pl:message', (e, msg) => fn(msg)),
  onOpenFile: (fn) => ipcRenderer.on('pl:open-file', (e, f) => fn(f))
});
