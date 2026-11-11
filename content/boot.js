/* PaperLens — content script 入口：串接各模組、處理來自 background 的訊息 */
(function () {
  'use strict';
  const PL = globalThis.PL;

  let booting = false;

  PL.activate = async function () {
    if (PL.active || booting) return;
    booting = true;
    try {
      PL.settings = await globalThis.PL_loadSettings();

      PL.buildSplit();
      PL.prepareBlocks();
      PL.wireAnnotations();

      await PL.loadAnnotations();
      PL.applyAllAnnotations();
      if (PL.settings.showSidebar) PL.toggleSidebar(true);

      const n = PL.blocks.filter((b) => b.state !== 'skip').length;
      PL.setStatus('找到 ' + n + ' 段可翻譯內容', 0);

      PL.prewarmEngines();

      if (PL.settings.autoTranslate) {
        PL.setupLazy();
        if (!PL.settings.lazyTranslate) PL.translateAll();
      } else {
        PL.setStatus('按「翻譯全文」開始', 0);
      }
    } catch (e) {
      console.error('[PaperLens]', e);
      PL.toast('啟動失敗：' + (e.message || e), 5000);
      try { PL.destroySplit(); } catch (e2) { /* ignore */ }
    } finally {
      booting = false;
    }
  };

  PL.deactivate = function () {
    if (!PL.active) return;
    PL.destroySplit();
  };

  PL.toggle = function () {
    if (PL.active) PL.deactivate();
    else PL.activate();
  };

  /* ══════════ 訊息 ══════════ */

  const MY_MSGS = new Set(['pl.activate', 'pl.toggle', 'pl.state', 'pl.command', 'pl.settings']);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !MY_MSGS.has(msg.type)) return false;   // 不認得的訊息不要搶著回

    (async () => {
      switch (msg.type) {
        case 'pl.activate':
          await PL.activate();
          return { active: PL.active };

        case 'pl.toggle':
          if (PL.active) PL.deactivate(); else await PL.activate();
          return { active: PL.active };

        case 'pl.state':
          return {
            active: PL.active,
            blocks: PL.blocks.length,
            done: PL.blocks.filter((b) => b.state === 'done').length,
            notes: PL.getAnnotations ? PL.getAnnotations().length : 0,
            engine: PL.lastEngine || null
          };

        case 'pl.command':
          if (msg.command === 'highlight-selection') {
            if (!PL.active) await PL.activate();
            PL.highlightSelection(false);
          } else if (msg.command === 'explain-selection') {
            if (!PL.active) await PL.activate();
            PL.highlightSelection(true);
          } else if (msg.command === 'translate-selection') {
            // 沒開對照也可以：直接用小視窗翻譯網頁上選取的文字
            if (!PL.settings) PL.settings = await globalThis.PL_loadSettings();   // 還沒啟用過：先讀設定（語言、引擎、金鑰）
            PL.translateSelection();
          } else if (msg.command === 'export-pdf') {
            await PL.openExport();
          } else if (msg.command === 'translate-all') {
            if (!PL.active) await PL.activate();
            PL.translateAll();
          } else if (msg.command === 'sidebar') {
            if (!PL.active) await PL.activate();
            PL.toggleSidebar(undefined, 'notes');
          } else if (msg.command === 'ask-ai') {
            if (!PL.active) await PL.activate();
            PL.toggleSidebar(undefined, 'ai');
          } else if (msg.command === 'lookup') {
            if (!PL.active) await PL.activate();
            PL.toggleSidebar(undefined, 'tr');
          } else if (msg.command === 'retry') {
            PL.retryFailed();
          }
          return { ok: true };

        case 'pl.settings':
          PL.settings = Object.assign({}, PL.settings, msg.patch || {});
          if (PL.active) {
            PL.applyLook();
            if (msg.retranslate) PL.retranslateAll();
          }
          return { ok: true };

        default:
          return null;
      }
    })().then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: String(err && err.message || err) })
    );
    return true;
  });

  /* 離開頁面前把待寫入的註解刷出去 */
  window.addEventListener('pagehide', () => {
    if (PL.active) { try { PL.destroySplit(); } catch (e) { /* ignore */ } }
  });
})();
