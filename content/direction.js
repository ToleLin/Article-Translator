/* PaperLens — 對調：左右位置、翻譯方向
 *
 *  ⇄ 左右對調：原文跟譯文換邊（譯文在左、原文在右）。只是換位置，內容不變。
 *  英→中／中→英：切換翻譯方向。讀中文文獻時切成「中→英」，中文段落就會翻成英文。
 *
 * 網頁對照與 PDF 檢視器共用；真正重新翻譯的部分由各自的 PL.applyTargetLang() 處理。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  if (!PL || PL.Direction) return;

  const isCjk = (l) => /^(zh|ja|ko)/i.test(l || '');
  const target = () => (PL.settings && PL.settings.targetLang) || 'zh-Hant';
  PL.isCjkLang = isCjk;

  /** 使用者自己看的語言（介面、AI 回答用）：翻成英文的時候，回答還是用原本的中文 */
  PL.readerLang = () => (isCjk(target()) ? target() : ((PL.settings && PL.settings.lastCjkTarget) || 'zh-Hant'));

  /** 整份文件主要是什麼語言（由各自的檢視器在分段之前設定 PL.docLang） */
  PL.setDocLang = function (sample) {
    const T = globalThis.PLTranslate;
    PL.docLang = (T && T.guessLang && T.guessLang(String(sample || '').slice(0, 6000))) || null;
    return PL.docLang;
  };

  /** 這段文字已經是目標語言了（不用翻） */
  PL.alreadyTarget = function (text) {
    const tgt = target();
    if (/^zh/i.test(tgt)) return PL.cjkRatio(text) > 0.5;
    if (/^ja/i.test(tgt)) return /[぀-ヿ]/.test(text);
    if (/^ko/i.test(tgt)) return /[가-힯]/.test(text);
    // 翻成英文：這段本來就是英文（中文文獻裡夾的英文摘要）才跳過；德文、法文還是要翻
    if (/^en/i.test(tgt)) {
      if (PL.cjkRatio(text) > 0.1) return false;
      const T = globalThis.PLTranslate;
      if (T && T.guessLang && T.guessLang(text) === 'en') return true;
      // 短的標題、標籤（Abstract、Open Access）看不出語言：整份文件是英文的話，它們也是英文
      return PL.docLang === 'en' && !/[^\x00-\x7f\u2010-\u2027\u00a0-\u00bf]/.test(text.replace(/\s+/g, ''));
    }
    return false;
  };

  const SHORT = { 'zh-Hant': '中', 'zh-Hans': '中', en: '英', ja: '日', ko: '韓' };
  function dirLabel() {
    const t = target();
    return isCjk(t) ? '英→' + (SHORT[t] || '中') : '中→' + (SHORT[t] || '英');
  }

  function refresh() {
    const swapped = !!(PL.settings && PL.settings.swapPanes);
    document.documentElement.classList.toggle('pl-swap', swapped);
    document.querySelectorAll('[data-pl-dir]').forEach((b) => {
      b.textContent = '翻譯 ' + dirLabel();
      b.title = '翻譯方向：目前是「' + dirLabel() + '」（翻成' + ((globalThis.PL_LANG_LABEL || {})[target()] || target())
        + '）。按一下對調，整份會重新翻譯';
    });
    document.querySelectorAll('[data-pl-swap]').forEach((b) => {
      b.textContent = '⇄ 左右對調';
      b.classList.toggle('pl-on', swapped);
      b.title = swapped ? '左右對調中：譯文在左、原文在右。按一下換回來' : '左右對調：把譯文換到左邊、原文換到右邊';
    });
  }

  function toggleSwap() {
    const next = !PL.settings.swapPanes;
    PL.settings.swapPanes = next;
    globalThis.PL_saveSettings({ swapPanes: next });
    refresh();
    if (PL.Sync && PL.Sync.markDirty) PL.Sync.markDirty();
    if (PL.Overlay && PL.Overlay.reproject) PL.Overlay.reproject();
    PL.toast(next ? '已對調：譯文在左、原文在右' : '已換回：原文在左、譯文在右');
  }

  const translatable = () => (PL.blocks || []).filter((b) => b.state !== 'skip').length;

  function toggleDirection(opts) {
    const cur = target();
    const before = translatable();
    const patch = {};
    if (isCjk(cur)) { patch.lastCjkTarget = cur; patch.targetLang = 'en'; }
    else patch.targetLang = PL.settings.lastCjkTarget || 'zh-Hant';
    // 原文語言如果被固定成跟新的目標一樣（例如固定「英文」又要翻成英文），改回自動偵測
    const src = PL.settings.sourceLang;
    if (src && src !== 'auto' && (src === patch.targetLang || (/^zh/i.test(src) && /^zh/i.test(patch.targetLang)))) patch.sourceLang = 'auto';
    Object.assign(PL.settings, patch);
    globalThis.PL_saveSettings(patch);
    refresh();
    if (PL.applyTargetLang) PL.applyTargetLang();
    // 換了方向之後幾乎沒有東西可以翻：這份文件本來就是新的譯文語言（例如英文論文切成「中→英」）。
    // 留在這個狀態畫面上會一片空白、看起來像壞掉，所以自動換回來並說明
    const after = translatable();
    if (!(opts && opts.noGuard) && before >= 4 && after < before * 0.15) {
      const tried = dirLabel();
      toggleDirection({ noGuard: true });
      PL.toast('這份文件沒有可以用「' + tried + '」翻的內容，已換回「' + dirLabel() + '」。\n'
        + '（「翻譯 ' + tried + '」是改變翻譯的語言；想把譯文換到左邊，請按「⇄ 左右對調」）', 9000);
      return;
    }
    if (!(opts && opts.noGuard)) PL.toast('翻譯方向：' + dirLabel() + '，重新翻譯中…');
  }

  function wire(root) {
    (root || document).querySelectorAll('[data-pl-dir]').forEach((b) => {
      if (b._plWired) return;
      b._plWired = true;
      b.addEventListener('click', () => toggleDirection());
    });
    (root || document).querySelectorAll('[data-pl-swap]').forEach((b) => {
      if (b._plWired) return;
      b._plWired = true;
      b.addEventListener('click', toggleSwap);
    });
    refresh();
  }

  PL.Direction = {
    refresh, wire, toggleSwap, toggleDirection, label: dirLabel,
    makeDirButton: () => PL.el('button', { 'data-pl-dir': '1', class: 'pl-dir-btn', text: '翻譯 ' + dirLabel() }),
    makeSwapButton: () => PL.el('button', { 'data-pl-swap': '1', class: 'pl-swap-btn', text: '⇄ 左右對調' })
  };
})();
