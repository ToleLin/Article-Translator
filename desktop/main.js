/* PaperLens 桌面版 — Electron 主程序
 *
 * 跟 Chrome 擴充功能用的是「同一套」PDF 檢視器（pdf/pdfview.html 與其餘網頁程式），差別只在：
 *  - chrome.* API 由 shim.js 模擬：資料存在使用者資料夾的一個 JSON 檔，翻譯請求交給這個主程序
 *  - 翻譯服務用 Chromium 的網路堆疊（net.fetch）呼叫：沿用系統 proxy 設定、沒有跨網域限制
 *  - 引擎實作直接 require 共用的 shared/remote-engines.js，跟擴充功能的 background 同一份程式碼
 *
 * 桌面版沒有 Chrome 內建 AI（那是 Chrome 瀏覽器才有的功能），翻譯走 Google／微軟，
 * 有 Gemini 金鑰就多一個選擇。
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP_DIR = path.join(__dirname, 'app');
const SCHEME = 'paperlens';
const ORIGIN = SCHEME + '://app';
const REPO = 'https://github.com/ToleLin/Article-Translator';

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

/* ══════════ 共用程式（掛在 globalThis 的傳統腳本，跟擴充功能同一份） ══════════ */

require(path.join(APP_DIR, 'shared', 'defaults.js'));
require(path.join(APP_DIR, 'shared', 'remote-engines.js'));
const PLRemote = globalThis.PLRemote;

/* ══════════ 儲存：一個 JSON 檔（翻譯快取、註解、標註、設定） ══════════ */

let store = {};
let storeFile = null;
let saveTimer = null;

function loadStore() {
  storeFile = path.join(app.getPath('userData'), 'paperlens-data.json');
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) || {}; }
  catch (e) { store = {}; }
}

function saveStoreNow() {
  if (!storeFile) return;
  const tmp = storeFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, storeFile);
}

function saveStoreSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { saveStoreNow(); } catch (e) { console.warn('[PaperLens] 儲存失敗', e); }
  }, 800);
}

function storageOp(op, arg) {
  switch (op) {
    case 'get': {
      if (arg == null) return Object.assign({}, store);
      const keys = typeof arg === 'string' ? [arg] : Array.isArray(arg) ? arg : Object.keys(arg);
      const out = {};
      for (const k of keys) {
        if (store[k] !== undefined) out[k] = store[k];
        else if (arg && typeof arg === 'object' && !Array.isArray(arg)) out[k] = arg[k];
      }
      return out;
    }
    case 'set':
      Object.assign(store, arg || {});
      saveStoreSoon();
      return true;
    case 'remove':
      [].concat(arg || []).forEach((k) => { delete store[k]; });
      saveStoreSoon();
      return true;
    case 'bytes':
      return Buffer.byteLength(JSON.stringify(store));
    default:
      throw new Error('未知的儲存操作：' + op);
  }
}

const RETIRED_GEMINI = /^gemini-(1\.0|1\.5|2\.0)(-|$)|^gemini-pro$/;
function settings() {
  const s = Object.assign({}, globalThis.PL_DEFAULTS, store.settings || {});
  if (!s.geminiModel || RETIRED_GEMINI.test(s.geminiModel)) s.geminiModel = globalThis.PL_DEFAULTS.geminiModel;
  return s;
}

/* ══════════ 訊息處理（對應擴充功能 background.js 的 handlers） ══════════ */

let exportPayload = null;
const NO_AI = '桌面版沒有 Chrome 內建 AI（那是 Chrome 瀏覽器才有的功能），請改用 Google／微軟或 Gemini。';

const handlers = {
  'translate.remote': (msg) => PLRemote.translate(msg, settings()),
  'gemini.test': (msg) => {
    if (!msg.key) throw new Error('請先貼上金鑰');
    return PLRemote.geminiTest(msg.key, msg.model, globalThis.PL_mapLang('gemini', msg.targetLang || settings().targetLang));
  },
  'ai.detect': () => ({ lang: null }),
  'ai.probe': () => ({ where: 'desktop', translator: 'unsupported', languageModel: 'unsupported', tried: [] }),
  'ai.warm': () => { throw new Error(NO_AI); },
  'ai.translate': () => { throw new Error(NO_AI); },
  'ai.explain': async (msg) => ({ text: await PLRemote.explain(msg.text, msg.context, settings()), via: 'gemini' }),
  'settings.get': () => settings(),
  'settings.set': (msg) => {
    store.settings = Object.assign({}, store.settings || {}, msg.patch || {});
    saveStoreSoon();
    return settings();
  },
  'export.open': (msg) => {
    exportPayload = msg.payload;
    openAux('export/export.html', { width: 1280, height: 900 });
    return { tabId: -1 };
  },
  'export.take': () => exportPayload,
  'openOptions': () => { openAux('options/options.html', { width: 900, height: 900 }); return true; },
  'image.inline': async (msg) => {
    const out = {};
    for (const u of (msg.urls || []).slice(0, 200)) {
      try {
        const r = await net.fetch(u);
        const buf = Buffer.from(await r.arrayBuffer());
        out[u] = 'data:' + (r.headers.get('content-type') || 'image/png') + ';base64,' + buf.toString('base64');
      } catch (e) { out[u] = null; }
    }
    return out;
  }
};

ipcMain.handle('pl:storage', (e, op, arg) => storageOp(op, arg));

ipcMain.handle('pl:send', async (e, msg) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return { ok: true, data: null };
  try { return { ok: true, data: await fn(msg, e.sender) }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// 設定頁改了設定 → 轉給其他視窗（相當於擴充功能的 chrome.tabs.sendMessage）
ipcMain.handle('pl:broadcast', (e, msg) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents !== e.sender) w.webContents.send('pl:message', msg);
  }
  return true;
});

ipcMain.handle('pl:version', () => app.getVersion());

ipcMain.handle('pl:viewer-ready', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w.pendingFile) {
    const f = w.pendingFile;
    w.pendingFile = null;
    sendFile(w, f);
  }
  return true;
});

ipcMain.handle('pl:open-dialog', (e) => openDialog(BrowserWindow.fromWebContents(e.sender)));

ipcMain.handle('pl:save-pdf', async (e, opts) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const safe = String((opts && opts.title) || 'PaperLens').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120).trim() || 'PaperLens';
  const r = await dialog.showSaveDialog(win, {
    title: '存成 PDF',
    defaultPath: path.join(app.getPath('documents'), safe + '（對照）.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  const data = await e.sender.printToPDF({ printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(r.filePath, data);
  shell.showItemInFolder(r.filePath);
  return { filePath: r.filePath };
});

/* ══════════ 視窗 ══════════ */

const ICON = path.join(__dirname, 'app', 'icons', 'icon512.png');

function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false
  };
}

/** 頁面裡的外部連結（例如設定頁的 AI Studio 申請連結）用系統瀏覽器開 */
function hookLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(ORIGIN)) { ev.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
}

function createViewer(filePath) {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 560,
    title: 'PaperLens', icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#f7f8fb', show: false,
    webPreferences: webPrefs()
  });
  win.pendingFile = filePath || null;
  win.once('ready-to-show', () => win.show());
  hookLinks(win);
  win.loadURL(ORIGIN + '/pdf/pdfview.html');
  return win;
}

const aux = {};
function openAux(page, size) {
  const key = page;
  if (aux[key] && !aux[key].isDestroyed()) {
    if (page.startsWith('export/')) aux[key].reload();
    aux[key].focus();
    return aux[key];
  }
  const w = new BrowserWindow({
    width: (size && size.width) || 1100, height: (size && size.height) || 860,
    title: 'PaperLens', icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#ffffff', webPreferences: webPrefs()
  });
  hookLinks(w);
  w.loadURL(ORIGIN + '/' + page);
  aux[key] = w;
  return w;
}

function sendFile(win, filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    win.webContents.send('pl:open-file', {
      path: filePath, name: path.basename(filePath), bytes: new Uint8Array(bytes)
    });
    app.addRecentDocument(filePath);
  } catch (e) {
    dialog.showErrorBox('PaperLens', '無法開啟檔案：\n' + filePath + '\n\n' + e.message);
  }
}

/** 已經有文件的視窗另開新視窗；空白的視窗直接拿來用 */
function openPath(filePath, preferWin) {
  const win = preferWin && !preferWin.isDestroyed() ? preferWin : null;
  if (win && !win.hasDocument) { sendFile(win, filePath); win.focus(); return; }
  createViewer(filePath);
}

async function openDialog(win) {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '開啟 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled) return false;
  r.filePaths.forEach((p, k) => {
    if (k === 0 && win) { sendFile(win, p); win.focus(); }
    else createViewer(p);
  });
  return true;
}

ipcMain.on('pl:doc-opened', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.hasDocument = true;
});

/* ══════════ 選單 ══════════ */

function buildMenu() {
  const send = (w, msg) => { if (w) w.webContents.send('pl:message', msg); };
  const template = [
    {
      label: '檔案',
      submenu: [
        { label: '開啟 PDF…', accelerator: 'CmdOrCtrl+O', click: (m, w) => openDialog(w) },
        { label: '在新視窗開啟 PDF…', accelerator: 'CmdOrCtrl+Shift+O', click: () => openDialog(null) },
        { role: 'recentDocuments', label: '最近開啟' },
        { type: 'separator' },
        { label: '翻譯全文', accelerator: 'CmdOrCtrl+T', click: (m, w) => send(w, { type: 'pl.command', command: 'translate-all' }) },
        { label: '使用 Gemini 翻譯（輸入金鑰）…', accelerator: 'CmdOrCtrl+G', click: (m, w) => send(w, { type: 'pl.command', command: 'gemini-key' }) },
        { label: '匯出左右對照 PDF…', accelerator: 'CmdOrCtrl+E', click: (m, w) => send(w, { type: 'pl.command', command: 'export-pdf' }) },
        { type: 'separator' },
        { label: '設定…', accelerator: 'CmdOrCtrl+,', click: () => openAux('options/options.html', { width: 900, height: 900 }) },
        { type: 'separator' },
        { role: 'quit', label: '結束' }
      ]
    },
    {
      label: '編輯',
      submenu: [
        { role: 'cut', label: '剪下' },
        { role: 'copy', label: '複製' },
        { role: 'paste', label: '貼上' },
        { role: 'selectAll', label: '全選' }
      ]
    },
    {
      label: '檢視',
      submenu: [
        { label: '註解側欄', accelerator: 'CmdOrCtrl+B', click: (m, w) => send(w, { type: 'pl.command', command: 'sidebar' }) },
        { type: 'separator' },
        // Ctrl+= / Ctrl+- / Ctrl+0 放大縮小的是「PDF 頁面」（Ctrl+滾輪也可以）；介面字太小再用下面那三個
        { label: '放大頁面', accelerator: 'CmdOrCtrl+=', click: (m, w) => send(w, { type: 'pl.command', command: 'zoom-in' }) },
        { label: '縮小頁面', accelerator: 'CmdOrCtrl+-', click: (m, w) => send(w, { type: 'pl.command', command: 'zoom-out' }) },
        { label: '頁面貼齊欄寬', accelerator: 'CmdOrCtrl+0', click: (m, w) => send(w, { type: 'pl.command', command: 'zoom-reset' }) },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大介面文字', accelerator: 'CmdOrCtrl+Shift+=' },
        { role: 'zoomOut', label: '縮小介面文字', accelerator: 'CmdOrCtrl+Shift+-' },
        { role: 'resetZoom', label: '介面文字實際大小', accelerator: 'CmdOrCtrl+Shift+0' },
        { role: 'togglefullscreen', label: '全螢幕' },
        { type: 'separator' },
        { role: 'reload', label: '重新載入' },
        { role: 'toggleDevTools', label: '開發人員工具' }
      ]
    },
    {
      label: '說明',
      submenu: [
        { label: '使用說明書', click: () => shell.openExternal(REPO + '/blob/main/%E4%BD%BF%E7%94%A8%E8%AA%AA%E6%98%8E%E6%9B%B8.md') },
        { label: '專案網頁', click: () => shell.openExternal(REPO) },
        { type: 'separator' },
        {
          label: '關於 PaperLens',
          click: (m, w) => dialog.showMessageBox(w || undefined, {
            type: 'info', title: '關於 PaperLens',
            message: 'PaperLens 文獻對照閱讀器 ' + app.getVersion(),
            detail: '左原文、右繁中，PDF 版面原樣保留；螢光筆、手寫標註、便利貼、雙欄 PDF 匯出。\n\n'
              + '資料（註解、翻譯快取、設定）存在：\n' + (storeFile || app.getPath('userData'))
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ══════════ 啟動 ══════════ */

const pdfFromArgv = (argv) => argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 已經開著的時候再雙擊一個 PDF：交給現有的程式開
  app.on('second-instance', (e, argv) => {
    const f = pdfFromArgv(argv);
    const wins = BrowserWindow.getAllWindows().filter((w) => !Object.values(aux).includes(w));
    if (f) openPath(f, wins.find((w) => !w.hasDocument));
    else if (wins[0]) { if (wins[0].isMinimized()) wins[0].restore(); wins[0].focus(); }
  });

  app.on('open-file', (e, f) => {          // macOS
    e.preventDefault();
    if (app.isReady()) openPath(f); else app.once('ready', () => openPath(f));
  });

  app.whenReady().then(() => {
    loadStore();
    // 翻譯服務走 Chromium 的網路堆疊：系統 proxy、憑證都跟一般瀏覽器一樣
    globalThis.fetch = (input, init) => net.fetch(input, init);

    protocol.handle(SCHEME, (req) => {
      const u = new URL(req.url);
      const p = path.normalize(path.join(APP_DIR, decodeURIComponent(u.pathname)));
      if (!p.startsWith(APP_DIR)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(p).toString());
    });

    buildMenu();
    createViewer(pdfFromArgv(process.argv));

    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createViewer(); });
  });

  app.on('before-quit', () => {
    clearTimeout(saveTimer);
    try { saveStoreNow(); } catch (e) { /* ignore */ }
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
