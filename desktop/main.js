/* PaperLens 桌面版 — Electron 主程序
 *
 * 跟 Chrome 擴充功能用的是「同一套」PDF 檢視器（pdf/pdfview.html 與其餘網頁程式），差別只在：
 *  - chrome.* API 由 shim.js 模擬：資料存在使用者資料夾的一個 JSON 檔，翻譯請求交給這個主程序
 *  - 翻譯服務用 Chromium 的網路堆疊（net.fetch）呼叫：沿用系統 proxy 設定、沒有跨網域限制
 *  - 引擎實作直接 require 共用的 shared/remote-engines.js，跟擴充功能的 background 同一份程式碼
 *
 * 桌面版沒有 Chrome 內建 AI（那是 Chrome 瀏覽器才有的功能），翻譯走 Google／微軟，
 * 有 Gemini 金鑰就多一個選擇。
 *
 * 視窗像瀏覽器一樣有分頁：一個視窗（BaseWindow）最上面是分頁列（一個小網頁），
 * 下面每個分頁各是一個獨立的檢視器（WebContentsView）。切換分頁只是換哪一個顯示出來，
 * 所以每篇文章的翻譯進度、捲動位置、標註都各自留著。
 */
'use strict';

const { app, BrowserWindow, BaseWindow, WebContentsView, webContents, ipcMain, dialog, Menu, protocol, net, shell } = require('electron');
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
require(path.join(APP_DIR, 'shared', 'update.js'));
const PLRemote = globalThis.PLRemote;
const updater = require('./updater');

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
  'ai.ask': (msg) => PLRemote.ask(msg, settings()),
  'dict.lookup': (msg) => {
    const map = globalThis.PL_mapLang;
    const src = msg.sourceLang && msg.sourceLang !== 'auto' ? map('google', msg.sourceLang) : 'auto';
    return PLRemote.lookup(msg.text, src, map('google', msg.targetLang || settings().targetLang));
  },
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
  'update.check': async (msg) => {
    if (msg && msg.force) await updater.check(true);
    return updater.status();
  },
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

// 設定頁改了設定 → 轉給其他頁面（相當於擴充功能的 chrome.tabs.sendMessage）
ipcMain.handle('pl:broadcast', (e, msg) => {
  for (const wc of webContents.getAllWebContents()) {
    if (wc !== e.sender && !wc.isDestroyed() && wc.getURL().startsWith(ORIGIN)) wc.send('pl:message', msg);
  }
  return true;
});

ipcMain.handle('pl:version', () => app.getVersion());
ipcMain.on('pl:version-sync', (e) => { e.returnValue = app.getVersion(); });

ipcMain.handle('pl:viewer-ready', (e) => {
  const at = locate(e.sender);
  if (!at || !at.tab) return true;
  const tab = at.tab;
  tab.ready = true;
  // 重新載入（Ctrl+R）之後：把原本那份文件再開回來
  if (!tab.pending && tab.path) tab.pending = tab.path;
  at.frame.deliver(tab);
  return true;
});

ipcMain.handle('pl:open-dialog', (e) => {
  const at = locate(e.sender);
  return openDialog(at ? at.frame : null);
});

// 檢視器裡拖進來／選了一個檔案：這個分頁是空的就開在這裡，已經有文件就開新分頁
ipcMain.handle('pl:open-path', (e, filePath) => {
  if (!isPdf(filePath)) return false;
  const at = locate(e.sender);
  (at ? at.frame : mainFrame()).openFile(filePath, at && at.tab);
  return true;
});

ipcMain.handle('pl:save-pdf', async (e, opts) => {
  const win = BrowserWindow.fromWebContents(e.sender) || undefined;
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

/* ══════════ 視窗與分頁 ══════════ */

const ICON = path.join(__dirname, 'app', 'icons', 'icon512.png');
const STRIP_H = 40;                 // 分頁列的高度
const NEW_TAB = '新分頁';

const isPdf = (f) => typeof f === 'string' && /\.pdf$/i.test(f) && fs.existsSync(f);
const baseName = (f) => path.basename(f).replace(/\.pdf$/i, '');

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
function hookLinks(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (ev, url) => {
    if (!url.startsWith(ORIGIN)) { ev.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
}

const frames = new Set();
let lastFrame = null;
let tabSeq = 0;

/** 這個頁面是哪個視窗的哪個分頁（分頁列本身的話 tab 是 null） */
function locate(wc) {
  for (const frame of frames) {
    if (frame.strip.webContents === wc) return { frame, tab: null };
    const tab = frame.tabs.find((t) => t.view.webContents === wc);
    if (tab) return { frame, tab };
  }
  return null;
}
const frameOfWindow = (w) => { for (const f of frames) if (f.win === w) return f; return null; };
const mainFrame = () => (lastFrame && frames.has(lastFrame) ? lastFrame : frames.values().next().value) || new TabFrame();

class TabFrame {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.closing = false;
    this.win = new BaseWindow({
      width: 1440, height: 920, minWidth: 900, minHeight: 560,
      title: 'PaperLens', icon: fs.existsSync(ICON) ? ICON : undefined,
      backgroundColor: '#f7f8fb'
    });
    this.strip = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'tabs-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    this.win.contentView.addChildView(this.strip);
    this.strip.webContents.loadURL(ORIGIN + '/desktop/tabs.html');
    this.strip.webContents.on('did-finish-load', () => this.push());
    this.hookKeys(this.strip.webContents);

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => { lastFrame = this; });
    this.win.on('close', () => { this.closing = true; });
    this.win.on('closed', () => {
      frames.delete(this);
      if (lastFrame === this) lastFrame = null;
      // 視窗不會自動收掉裡面的頁面，要自己關
      for (const t of this.tabs) { try { t.view.webContents.close(); } catch (e) { /* ignore */ } }
      try { this.strip.webContents.close(); } catch (e) { /* ignore */ }
      this.tabs = [];
    });
    frames.add(this);
    lastFrame = this;
    this.layout();
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    this.strip.setBounds({ x: 0, y: 0, width: w, height: STRIP_H });
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: STRIP_H, width: w, height: Math.max(0, h - STRIP_H) });
  }

  /** Ctrl+1～8 切到第幾個分頁、Ctrl+9 最後一個（選單放不下這麼多項，直接攔按鍵） */
  hookKeys(wc) {
    wc.on('before-input-event', (ev, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt || input.shift) return;
      if (!/^[1-9]$/.test(input.key)) return;
      const n = Number(input.key);
      const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (tab) { ev.preventDefault(); this.activate(tab); }
    });
  }

  /**
   * filePath：要開的 PDF（沒有就是空白分頁）。
   * opts.lazy：先掛個分頁標籤、等使用者點到才真的載入（還原上次的分頁時用，免得一次全部開始翻譯）
   */
  addTab(filePath, opts) {
    opts = opts || {};
    const view = new WebContentsView({ webPreferences: webPrefs() });
    view.setBackgroundColor('#f7f8fb');
    const tab = {
      id: ++tabSeq, view, loaded: false, ready: false,
      pending: filePath || null, path: filePath || null,
      title: filePath ? baseName(filePath) : NEW_TAB, hasDocument: false
    };
    hookLinks(view.webContents);
    this.hookKeys(view.webContents);
    view.webContents.on('page-title-updated', (ev) => ev.preventDefault());
    view.setVisible(false);
    this.win.contentView.addChildView(view);
    this.tabs.push(tab);
    this.layout();
    if (opts.lazy) this.push();
    else this.activate(tab);
    return tab;
  }

  load(tab) {
    if (tab.loaded) return;
    tab.loaded = true;
    tab.view.webContents.loadURL(ORIGIN + '/pdf/pdfview.html');
  }

  activate(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    this.active = tab;
    this.load(tab);
    for (const t of this.tabs) t.view.setVisible(t === tab);
    this.layout();
    if (!this.win.isDestroyed() && this.win.isFocused()) tab.view.webContents.focus();
    this.deliver(tab);
    this.push();
  }

  /** 檢視器準備好了、而且有等著開的檔案：把內容送過去 */
  deliver(tab) {
    if (!tab.ready || !tab.pending) return;
    const f = tab.pending;
    tab.pending = null;
    try {
      const bytes = fs.readFileSync(f);
      tab.path = f;
      tab.title = baseName(f);
      tab.view.webContents.send('pl:open-file', { path: f, name: path.basename(f), bytes: new Uint8Array(bytes) });
      app.addRecentDocument(f);
    } catch (e) {
      tab.path = null;
      tab.title = NEW_TAB;
      dialog.showErrorBox('PaperLens', '無法開啟檔案：\n' + f + '\n\n' + e.message);
    }
    this.push();
  }

  /** 開一個檔案：已經開著就切過去；指定的分頁（或目前的分頁）是空的就用它，不然開新分頁 */
  openFile(filePath, preferTab) {
    const same = this.tabs.find((t) => t.path && path.resolve(t.path) === path.resolve(filePath));
    if (same) { this.activate(same); this.focus(); return same; }
    const empty = (t) => t && !t.hasDocument && !t.pending && !t.path;
    const target = empty(preferTab) ? preferTab : empty(this.active) ? this.active : null;
    if (!target) { const t = this.addTab(filePath); this.focus(); return t; }
    target.pending = filePath;
    target.path = filePath;
    target.title = baseName(filePath);
    this.activate(target);
    this.focus();
    return target;
  }

  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    // 最後一個分頁：有文件就換成空白分頁（不小心按到不會整個程式關掉）；已經是空白的才關視窗
    if (this.tabs.length === 1) {
      if (!tab.hasDocument && !tab.path) { this.win.close(); return; }
      this.addTab(null);
    }
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    try { this.win.contentView.removeChildView(tab.view); } catch (e) { /* ignore */ }
    try { tab.view.webContents.close(); } catch (e) { /* ignore */ }
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.push();
  }

  step(d) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + d + this.tabs.length) % this.tabs.length]);
  }

  move(id, to) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0) return;
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, to)), 0, t);
    this.push();
  }

  focus() {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
    if (this.active) this.active.view.webContents.focus();
  }

  activeWC() { return this.active ? this.active.view.webContents : null; }

  /** 分頁有變動：更新分頁列、視窗標題，並記下「這次開了哪些檔案」供下次啟動還原 */
  push() {
    if (this.closing || this.win.isDestroyed()) return;
    const t = this.active;
    this.win.setTitle(t && t.title !== NEW_TAB ? t.title + ' — PaperLens' : 'PaperLens');
    if (!this.strip.webContents.isDestroyed()) {
      this.strip.webContents.send('tabs:state', {
        active: t ? t.id : null,
        tabs: this.tabs.map((x) => ({ id: x.id, title: x.title, path: x.path || '', empty: !x.path }))
      });
    }
    if (lastFrame === this || frames.size === 1) {
      const files = this.tabs.filter((x) => x.path).map((x) => x.path);
      store.session = { files, active: t && t.path ? files.indexOf(t.path) : -1 };
      saveStoreSoon();
    }
  }
}

ipcMain.on('tabs:activate', (e, id) => { const at = locate(e.sender); if (at) at.frame.activate(at.frame.tabs.find((t) => t.id === id)); });
ipcMain.on('tabs:close', (e, id) => { const at = locate(e.sender); if (at) at.frame.closeTab(at.frame.tabs.find((t) => t.id === id)); });
ipcMain.on('tabs:new', (e) => { const at = locate(e.sender); if (at) at.frame.addTab(null); });
ipcMain.on('tabs:move', (e, id, to) => { const at = locate(e.sender); if (at) at.frame.move(id, Number(to) || 0); });
ipcMain.on('tabs:open', (e, files) => {
  const at = locate(e.sender);
  if (!at) return;
  const list = [].concat(files || []).filter(isPdf);
  if (list.length) list.forEach((f) => at.frame.openFile(f));
  else openDialog(at.frame);
});
ipcMain.on('tabs:ready', (e) => { const at = locate(e.sender); if (at) at.frame.push(); });

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
  hookLinks(w.webContents);
  w.loadURL(ORIGIN + '/' + page);
  aux[key] = w;
  return w;
}

/** 開一個 PDF（雙擊檔案、命令列、最近開啟）：開在最近用的那個視窗的分頁裡 */
function openPath(filePath) {
  if (!isPdf(filePath)) return;
  mainFrame().openFile(filePath);
}

async function openDialog(frame) {
  frame = frame && frames.has(frame) ? frame : mainFrame();
  const r = await dialog.showOpenDialog(frame.win, {
    title: '開啟 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled) return false;
  r.filePaths.forEach((p) => frame.openFile(p));
  return true;
}

ipcMain.on('pl:doc-opened', (e, title) => {
  const at = locate(e.sender);
  if (!at || !at.tab) return;
  at.tab.hasDocument = true;
  // 有檔名就用檔名當分頁名稱（比 PDF 內嵌的標題好認）；拖進來拿不到路徑的才用文件標題
  if (!at.tab.path && title) at.tab.title = String(title).slice(0, 80);
  at.frame.push();
});

/* ══════════ 選單 ══════════ */

function buildMenu() {
  const frameFor = (w) => frameOfWindow(w) || (lastFrame && frames.has(lastFrame) ? lastFrame : null);
  const send = (w, msg) => { const f = frameFor(w); const wc = f && f.activeWC(); if (wc) wc.send('pl:message', msg); };
  const cmd = (command) => (m, w) => send(w, { type: 'pl.command', command });
  // 目前游標所在的頁面（檢視器、設定頁、匯出頁都算）
  const focused = (w) => webContents.getFocusedWebContents() || (frameFor(w) && frameFor(w).activeWC());
  const onFocused = (fn) => (m, w) => { const wc = focused(w); if (wc && !wc.isDestroyed()) fn(wc); };
  const zoomBy = (d) => onFocused((wc) => wc.setZoomLevel(d === 0 ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + d))));
  const template = [
    {
      label: '檔案',
      submenu: [
        { label: '開啟 PDF…', accelerator: 'CmdOrCtrl+O', click: (m, w) => openDialog(frameFor(w)) },
        { label: '新分頁', accelerator: 'CmdOrCtrl+N', click: (m, w) => (frameFor(w) || mainFrame()).addTab(null) },
        { label: '關閉分頁', accelerator: 'CmdOrCtrl+W', click: (m, w) => { const f = frameOfWindow(w); if (f) f.closeTab(f.active); else if (w) w.close(); } },
        { label: '新視窗', accelerator: 'CmdOrCtrl+Shift+N', click: () => new TabFrame().addTab(null) },
        { role: 'recentDocuments', label: '最近開啟' },
        { type: 'separator' },
        { label: '翻譯全文', accelerator: 'CmdOrCtrl+T', click: cmd('translate-all') },
        { label: '使用 Gemini 翻譯（輸入金鑰）…', accelerator: 'CmdOrCtrl+G', click: cmd('gemini-key') },
        { label: '匯出左右對照 PDF…', accelerator: 'CmdOrCtrl+E', click: cmd('export-pdf') },
        { type: 'separator' },
        { label: '設定…', accelerator: 'CmdOrCtrl+,', click: () => openAux('options/options.html', { width: 900, height: 900 }) },
        { type: 'separator' },
        { role: 'quit', label: '結束' }
      ]
    },
    {
      label: '編輯',
      submenu: [
        { label: '剪下', accelerator: 'CmdOrCtrl+X', click: onFocused((wc) => wc.cut()) },
        { label: '複製', accelerator: 'CmdOrCtrl+C', click: onFocused((wc) => wc.copy()) },
        { label: '貼上', accelerator: 'CmdOrCtrl+V', click: onFocused((wc) => wc.paste()) },
        { label: '全選', accelerator: 'CmdOrCtrl+A', click: onFocused((wc) => wc.selectAll()) }
      ]
    },
    {
      label: '檢視',
      submenu: [
        { label: '下一個分頁', accelerator: 'Ctrl+Tab', click: (m, w) => { const f = frameFor(w); if (f) f.step(1); } },
        { label: '上一個分頁', accelerator: 'Ctrl+Shift+Tab', click: (m, w) => { const f = frameFor(w); if (f) f.step(-1); } },
        { type: 'separator' },
        { label: '註解側欄', accelerator: 'CmdOrCtrl+B', click: cmd('sidebar') },
        { label: '問 AI（側欄）', accelerator: 'CmdOrCtrl+I', click: cmd('ask-ai') },
        { label: '查字・翻譯（側欄）', accelerator: 'CmdOrCtrl+L', click: cmd('lookup') },
        { type: 'separator' },
        // Ctrl+= / Ctrl+- / Ctrl+0 放大縮小的是「PDF 頁面」（Ctrl+滾輪也可以）；介面字太小再用下面那三個
        { label: '放大頁面', accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
        { label: '縮小頁面', accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
        { label: '頁面貼齊欄寬', accelerator: 'CmdOrCtrl+0', click: cmd('zoom-reset') },
        { type: 'separator' },
        { label: '放大介面文字', accelerator: 'CmdOrCtrl+Shift+=', click: zoomBy(0.5) },
        { label: '縮小介面文字', accelerator: 'CmdOrCtrl+Shift+-', click: zoomBy(-0.5) },
        { label: '介面文字實際大小', accelerator: 'CmdOrCtrl+Shift+0', click: zoomBy(0) },
        { label: '全螢幕', accelerator: 'F11', click: (m, w) => { if (w) w.setFullScreen(!w.isFullScreen()); } },
        { type: 'separator' },
        { label: '重新載入', accelerator: 'CmdOrCtrl+R', click: onFocused((wc) => wc.reload()) },
        { label: '開發人員工具', accelerator: 'CmdOrCtrl+Shift+I', click: onFocused((wc) => wc.toggleDevTools()) }
      ]
    },
    {
      label: '說明',
      submenu: [
        { label: '使用說明書', click: () => shell.openExternal(REPO + '/blob/main/%E4%BD%BF%E7%94%A8%E8%AA%AA%E6%98%8E%E6%9B%B8.md') },
        { label: '專案網頁', click: () => shell.openExternal(REPO) },
        { type: 'separator' },
        { label: '檢查更新…', click: () => updater.check(true) },
        { label: '所有版本與更新內容', click: () => shell.openExternal(REPO + '/releases') },
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

/** 第一個視窗：有指定檔案就開它；不然把上次關閉時開著的文件開回來（最多 12 個，點到才載入） */
function firstWindow(file) {
  const frame = new TabFrame();
  const last = (store.session && Array.isArray(store.session.files) ? store.session.files : []).filter(isPdf).slice(0, 12);
  if (file || !last.length) { frame.addTab(file || null); return frame; }
  const want = store.session.active;
  const tabs = last.map((f) => frame.addTab(f, { lazy: true }));
  frame.activate(tabs[want >= 0 && want < tabs.length ? want : tabs.length - 1]);
  return frame;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 已經開著的時候再雙擊一個 PDF：在現有視窗開一個新分頁
  app.on('second-instance', (e, argv) => {
    const f = pdfFromArgv(argv);
    if (f) openPath(f);
    else mainFrame().focus();
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
    firstWindow(pdfFromArgv(process.argv));
    updater.init({ getStore: () => store, saveSoon: saveStoreSoon });

    app.on('activate', () => { if (!frames.size) firstWindow(null); });
  });

  app.on('before-quit', () => {
    for (const f of frames) f.closing = true;       // 關閉過程中分頁一個個收掉，不要把「上次開的檔案」清空
    clearTimeout(saveTimer);
    try { saveStoreNow(); } catch (e) { /* ignore */ }
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
