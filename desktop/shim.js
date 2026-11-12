/* PaperLens 桌面版 — 頁面端的 chrome.* 模擬
 *
 * 擴充功能的頁面程式（PDF 檢視器、設定頁、匯出頁）完全不用改：
 * 它們呼叫的 chrome.runtime.sendMessage / chrome.storage.local 在這裡轉成 IPC 交給主程序。
 * 這支檔案在 scripts/prepare.js 複製網頁檔案時，自動插到每個 HTML 的 <head> 最前面。
 */
(function () {
  'use strict';
  const B = globalThis.PLDesktopBridge;
  if (!B) return;

  const listeners = [];
  let version = B.appVersion || '0.0.0';
  if (!B.appVersion) B.version().then((v) => { version = v; }).catch(() => {});

  const dispatch = (msg) => {
    for (const fn of listeners.slice()) {
      try { fn(msg, { id: 'desktop' }, () => {}); } catch (e) { console.warn('[PaperLens]', e); }
    }
  };

  const local = {
    get: (keys) => B.storage('get', keys === undefined ? null : keys),
    set: (obj) => B.storage('set', obj),
    remove: (keys) => B.storage('remove', keys),
    getBytesInUse: () => B.storage('bytes')
  };
  // 支援 callback 寫法（舊程式偶爾會用）
  for (const k of Object.keys(local)) {
    const fn = local[k];
    local[k] = function (arg, cb) {
      const p = fn(arg);
      if (typeof cb === 'function') { p.then(cb, () => cb(undefined)); return undefined; }
      return p;
    };
  }

  globalThis.chrome = {
    runtime: {
      id: 'paperlens-desktop',
      lastError: undefined,
      getURL: (p) => location.origin + '/' + String(p).replace(/^\//, ''),
      getManifest: () => ({ version }),
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
      sendMessage(msg, cb) {
        const p = B.send(msg).then(
          (res) => res,
          (e) => ({ ok: false, error: String((e && e.message) || e) })
        );
        if (typeof cb === 'function') { p.then((res) => cb(res)); return undefined; }
        return p;
      },
      openOptionsPage: () => B.send({ type: 'openOptions' })
    },
    storage: {
      local,
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} }
    },
    extension: { isAllowedFileSchemeAccess: (cb) => cb(true) },
    tabs: {
      // 設定頁用它把新設定推給開著的檢視器
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage: (id, msg) => B.broadcast(msg)
    }
  };

  B.onMessage(dispatch);

  globalThis.PLDesktop = {
    isDesktop: true,
    pathForFile: (file) => B.pathForFile(file),
    viewerReady: () => B.viewerReady(),
    docOpened: (title) => B.docOpened(title),
    /** 交給主程序開這個檔案：這個分頁是空的就開在這裡，不然開新分頁 */
    openPath: (filePath) => B.openPath(filePath),
    openDialog: () => B.openDialog(),
    savePdf: (opts) => B.savePdf(opts)
  };

  // 主程序送來的檔案（雙擊 PDF、命令列、選單「開啟」）
  B.onOpenFile((f) => {
    const go = () => {
      if (!globalThis.PL || !PL.openPdfBytes || !PL.settings) { setTimeout(go, 50); return; }
      PL.openPdfBytes(f.bytes, 'file:' + f.path, f.name);
    };
    go();
  });
})();
