/* PaperLens 桌面版 — 分頁列的 preload：只開放切換／關閉／新增分頁這幾個動作 */
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('PLTabs', {
  onState: (fn) => ipcRenderer.on('tabs:state', (e, s) => fn(s)),
  ready: () => ipcRenderer.send('tabs:ready'),
  activate: (id) => ipcRenderer.send('tabs:activate', id),
  close: (id) => ipcRenderer.send('tabs:close', id),
  newTab: () => ipcRenderer.send('tabs:new'),
  move: (id, to) => ipcRenderer.send('tabs:move', id, to),
  /** files：拖進分頁列的檔案；不給就跳出「開啟 PDF」視窗 */
  open: (files) => ipcRenderer.send('tabs:open', (files || []).map((f) => {
    try { return webUtils.getPathForFile(f) || ''; } catch (e) { return ''; }
  }).filter(Boolean))
});
