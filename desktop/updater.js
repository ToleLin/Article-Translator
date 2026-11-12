/* PaperLens 桌面版 — 更新
 *
 * 安裝版（PaperLens-Setup）：用 electron-updater 到 GitHub Releases 檢查，有新版就在背景下載，
 *   下載好問一次要不要立刻重新啟動；選「稍後」的話，下次關閉程式時自動安裝。
 * 免安裝版（PaperLens-Portable）沒辦法自己換掉自己，只提醒有新版、附上下載連結。
 * macOS 版沒有 Apple 開發者簽章（自動更新需要），一樣只提醒、附上 .dmg 的下載連結。
 *
 * 啟動 10 秒後檢查一次，之後每 6 小時一次；選單「說明 → 檢查更新…」可以手動檢查。
 */
'use strict';

const { app, dialog, shell, BaseWindow } = require('electron');

const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const MAC = process.platform === 'darwin';
const RENOTIFY = 3 * 24 * 3600 * 1000;      // 免安裝版：同一個新版本 3 天提醒一次

let autoUpdater = null;
let mode = 'notify';
let getStore = () => null;
let saveSoon = () => {};
let manual = false;           // 這次檢查是使用者按的 → 結果都要回報
let queue = Promise.resolve(); // 對話框一個一個跳，不疊在一起
let downloaded = null;        // 已下載、等著安裝的版本
const state = { latest: null, error: null, checkedAt: 0, downloading: false };

const winOf = () => BaseWindow.getFocusedWindow() || BaseWindow.getAllWindows()[0] || undefined;

function friendly(e) {
  const m = String((e && e.message) || e || '');
  if (/\b404\b|Unable to find latest|No published versions|找不到公開/i.test(m)) {
    return '找不到公開的發佈版本（專案可能是私人的，或還沒有發佈過）';
  }
  if (/ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|ENOTFOUND|ETIMEDOUT|ECONN|連不到/i.test(m)) {
    return '連不到 GitHub，請檢查網路';
  }
  if (/\b403\b|\b429\b|rate limit|限制查詢/i.test(m)) return 'GitHub 暫時限制查詢次數，請稍後再試';
  return m.split('\n')[0].slice(0, 200) || '不明的錯誤';
}

function box(opts) {
  const run = queue.then(() => dialog.showMessageBox(winOf(), Object.assign({ title: 'PaperLens 更新', noLink: true }, opts)));
  queue = run.catch(() => {});
  return run.catch(() => ({ response: -1 }));
}

/** electron-updater 給的發佈說明是 GitHub 轉好的 HTML，轉回條列文字 */
function htmlToText(h) {
  if (Array.isArray(h)) h = h.map((x) => (x && x.note) || '').join('\n');
  return String(h || '')
    .replace(/<h[1-6][^>]*>/gi, '\n## ').replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function bullets(list) {
  return list && list.length ? '\n\n這一版更新：\n' + list.map((t) => '• ' + t).join('\n') : '';
}

/* ══════════ 安裝版：electron-updater ══════════ */

function setupAuto() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info() {}, warn: console.warn, error: console.warn, debug() {} };

  autoUpdater.on('update-available', (info) => {
    state.latest = info.version;
    state.downloading = true;
    if (manual) {
      manual = false;
      box({ type: 'info', message: '發現新版本 ' + info.version + '，正在背景下載',
        detail: '下載好會再通知你。下載期間可以照常使用。', buttons: ['好'] });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    state.latest = info && info.version;
    if (manual) {
      manual = false;
      box({ type: 'info', message: '已經是最新版（' + app.getVersion() + '）', buttons: ['好'] });
    }
  });

  autoUpdater.on('error', (e) => {
    state.error = friendly(e);
    state.downloading = false;
    if (manual) {
      manual = false;
      box({ type: 'warning', message: '目前無法檢查更新', detail: state.error, buttons: ['好'] });
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    state.downloading = false;
    downloaded = info.version;
    const notes = globalThis.PLUpdate.highlights(htmlToText(info.releaseNotes), 5);
    const r = await box({
      type: 'info',
      message: 'PaperLens ' + info.version + ' 已下載完成',
      detail: '要現在重新啟動並更新嗎？註解、翻譯和設定都會保留。\n'
        + '選「稍後」的話，下次關閉 PaperLens 時會自動安裝。' + bullets(notes),
      buttons: ['立即重新啟動並更新', '稍後'],
      defaultId: 0, cancelId: 1
    });
    if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });
}

/* ══════════ 免安裝版／開發中：只提醒 ══════════ */

async function checkNotify() {
  const PLUpdate = globalThis.PLUpdate;
  let r;
  try {
    r = await PLUpdate.latest();
    state.latest = r.version;
    state.error = null;
  } catch (e) {
    state.error = friendly(e);
    if (manual) box({ type: 'warning', message: '目前無法檢查更新', detail: state.error, buttons: ['好'] });
    return;
  }
  const cur = app.getVersion();
  if (PLUpdate.compare(r.version, cur) <= 0) {
    if (manual) box({ type: 'info', message: '已經是最新版（' + cur + '）', buttons: ['好'] });
    return;
  }
  const store = getStore();
  const seen = store && store.updateNotice;
  if (!manual && seen && seen.version === r.version && Date.now() - seen.at < RENOTIFY) return;
  if (store) { store.updateNotice = { version: r.version, at: Date.now() }; saveSoon(); }

  const dl = (MAC ? r.assets.mac : PORTABLE ? r.assets.portable : r.assets.setup) || r.url;
  const res = await box({
    type: 'info',
    message: '有新版本 ' + r.version + '（目前 ' + cur + '）',
    detail: (MAC
      ? 'macOS 版沒有 Apple 簽章，沒辦法自動更新：下載新的 .dmg，把 PaperLens 拖進「應用程式」取代舊的就好，註解和設定都會保留。'
      : PORTABLE
      ? '免安裝版沒辦法自動更新：下載新的 PaperLens-Portable 換掉舊的就好，註解和設定都會保留。\n'
        + '想要自動更新的話，可以改用安裝版（PaperLens-Setup）。'
      : '下載新版安裝檔，直接執行覆蓋安裝即可，註解和設定都會保留。') + bullets(PLUpdate.highlights(r.notes, 5)),
    buttons: ['下載新版', '看更新內容', '稍後'],
    defaultId: 0, cancelId: 2
  });
  if (res.response === 0) shell.openExternal(dl);
  if (res.response === 1) shell.openExternal(r.url);
}

/* ══════════ 對外 ══════════ */

async function check(isManual) {
  if (downloaded && !isManual) return;      // 已經下載好、等關閉時安裝，不用再查
  manual = !!isManual;
  state.checkedAt = Date.now();
  if (downloaded) {
    manual = false;
    const r = await box({
      type: 'info', message: 'PaperLens ' + downloaded + ' 已經下載好了',
      detail: '重新啟動就會完成更新。', buttons: ['立即重新啟動並更新', '稍後'], defaultId: 0, cancelId: 1
    });
    if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return;
  }
  if (mode === 'auto') {
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { /* 'error' 事件會處理 */ }
  } else {
    await checkNotify();
  }
}

function status() {
  const cur = app.getVersion();
  return {
    current: cur,
    latest: state.latest,
    newer: !!state.latest && globalThis.PLUpdate.compare(state.latest, cur) > 0,
    downloaded,
    downloading: state.downloading,
    error: state.error,
    mode: mode === 'auto' ? 'auto' : PORTABLE ? 'portable' : 'notify',
    url: globalThis.PLUpdate.PAGE
  };
}

function init(opts) {
  getStore = opts.getStore || getStore;
  saveSoon = opts.saveSoon || saveSoon;
  if (app.isPackaged && process.platform === 'win32' && !PORTABLE) {
    try {
      autoUpdater = require('electron-updater').autoUpdater;
      mode = 'auto';
      setupAuto();
    } catch (e) {
      console.warn('[PaperLens] 自動更新元件載入失敗，改成只提醒', e);
    }
  }
  setTimeout(() => check(false), 10 * 1000);
  setInterval(() => check(false), 6 * 3600 * 1000);
}

module.exports = { init, check, status, PORTABLE };
