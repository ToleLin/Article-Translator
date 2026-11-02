/* PaperLens — 收集左右對照內容，交給獨立分頁排版成可列印／另存 PDF 的版面 */
(function () {
  'use strict';
  const PL = globalThis.PL;

  /** 把節點深拷貝一份並把相對網址變成絕對網址（匯出頁在別的來源，相對路徑會壞掉） */
  function serialize(el) {
    if (!el) return '';
    const c = el.cloneNode(true);

    // 用「活的」元素取絕對網址，再寫回拷貝
    const liveImgs = el.querySelectorAll('img');
    const copyImgs = c.querySelectorAll('img');
    for (let i = 0; i < copyImgs.length; i++) {
      const live = liveImgs[i];
      if (live && live.currentSrc) copyImgs[i].setAttribute('src', live.currentSrc);
      else if (live && live.src) copyImgs[i].setAttribute('src', live.src);
      copyImgs[i].removeAttribute('srcset');
      copyImgs[i].removeAttribute('sizes');
      copyImgs[i].removeAttribute('loading');
    }
    if (c.tagName === 'IMG') {
      if (el.currentSrc || el.src) c.setAttribute('src', el.currentSrc || el.src);
      c.removeAttribute('srcset');
    }

    const liveA = el.querySelectorAll('a');
    const copyA = c.querySelectorAll('a');
    for (let i = 0; i < copyA.length; i++) {
      if (liveA[i] && liveA[i].href) copyA[i].setAttribute('href', liveA[i].href);
    }

    c.querySelectorAll('script,style,link,noscript,iframe,object,embed,video,audio,button,input,select,textarea')
      .forEach((n) => n.remove());
    c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    c.querySelectorAll('[data-pl-state]').forEach((n) => n.removeAttribute('data-pl-state'));

    // 匯出頁是擴充功能自己的來源，內容全部當成不可信：拔掉事件處理器與 javascript: 連結
    const strip = (n) => {
      for (const a of Array.from(n.attributes || [])) {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
      }
      if (n.tagName === 'A' && /^\s*javascript:/i.test(n.getAttribute('href') || '')) n.removeAttribute('href');
    };
    strip(c);
    c.querySelectorAll('*').forEach(strip);

    const wrap = document.createElement('div');
    wrap.appendChild(c);
    return wrap.innerHTML;
  }

  /** 依文件順序收集匯出單元：對照段落 + 獨立的圖／表／公式 */
  function collectRows() {
    const left = PL.els.left, right = PL.els.right;
    const rows = [];
    if (!left || !right) return rows;

    const allInk = PL.Overlay ? PL.Overlay.items() : [];

    const rightByB = new Map();
    right.querySelectorAll('[data-pl-b]').forEach((el) => rightByB.set(el.getAttribute('data-pl-b'), el));
    const rightByM = new Map();
    right.querySelectorAll('[data-pl-m]').forEach((el) => rightByM.set(el.getAttribute('data-pl-m'), el));

    // querySelectorAll 回傳的就是文件順序；再濾掉「被其他單元包住」的，
    // 例如表格已經整張匯出，裡面的 td 就不要再各自出現一次。
    const all = Array.from(left.querySelectorAll('[data-pl-b],[data-pl-m]'))
      .filter((el) => !el.closest('[data-pl-ui]'));
    const set = new Set(all);
    const units = all.filter((el) => {
      let p = el.parentElement;
      while (p && p !== left) {
        if (set.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });

    for (const el of units) {
      const isBlock = el.hasAttribute('data-pl-b');
      const key = el.getAttribute(isBlock ? 'data-pl-b' : 'data-pl-m');
      const counterpart = isBlock ? rightByB.get(key) : rightByM.get(key);

      const srcHtml = serialize(el);
      const dstHtml = serialize(counterpart);
      if (!srcHtml && !dstHtml) continue;

      const plain = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const media = !isBlock;
      // 導覽列、頁首頁尾、側欄不是論文正文，預設不進 PDF
      const chrome = !!el.closest('nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], '
        + '.nav, .navbar, .menu, .breadcrumb, .footer, .sidebar, .site-header, .site-footer');

      const inkFor = (side) => (allInk || []).filter(
        (k) => k.side === side && k.kind !== 'sticky' && k.anchor === 'b' + key);

      rows.push({
        ink: isBlock ? { src: inkFor('left'), dst: inkFor('right') } : null,
        kind: media ? 'media' : 'pair',
        tag: el.tagName.toLowerCase(),
        block: isBlock ? Number(key) : null,
        src: srcHtml,
        dst: dstHtml || srcHtml,
        heading: /^h[1-6]$/.test(el.tagName.toLowerCase()) ? Number(el.tagName[1]) : 0,
        chrome,
        empty: !plain
      });
    }
    return rows;
  }

  PL.openExport = async function () {
    if (!PL.active) { PL.toast('請先開啟對照閱讀'); return; }

    const pending = PL.blocks.filter((b) => b.state === 'pending' || b.state === 'working').length;
    if (pending) {
      const go = confirm('還有 ' + pending + ' 段沒翻完。\n\n按「確定」先翻完全文再匯出（建議），\n按「取消」直接用目前已翻好的內容匯出。');
      if (go) {
        PL.toast('正在翻譯全文，翻完會自動開啟匯出頁…', 4000);
        PL.translateAll();
        await waitUntilIdle();
      }
    }

    PL.setStatus('整理匯出內容…');
    const rows = collectRows();
    const notes = (PL.getAnnotations ? PL.getAnnotations() : []).slice()
      .sort((a, b) => (a.block - b.block) || (a.start - b.start));

    const stickies = (PL.Overlay ? PL.Overlay.items() : [])
      .filter((i) => i.kind === 'sticky' && i.text)
      .map((i) => ({ page: String(i.anchor).slice(1), side: i.side, text: i.text }));

    const payload = {
      stickies,
      title: PL.pageTitle(),
      url: location.href,
      createdAt: new Date().toISOString(),
      targetLang: PL.settings.targetLang,
      engine: PL.lastEngine || '',
      rows,
      notes
    };

    try {
      await PL.send({ type: 'export.open', payload });
      PL.setStatus('已開啟匯出分頁');
    } catch (e) {
      PL.setStatus('匯出失敗');
      PL.toast('匯出失敗：' + (e.message || e), 5000);
    }
  };

  function waitUntilIdle() {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        const left = PL.blocks.filter((b) => b.state === 'pending' || b.state === 'working').length;
        if (!left) { clearInterval(t); resolve(); }
      }, 600);
      setTimeout(() => { clearInterval(t); resolve(); }, 180000);   // 最多等三分鐘
    });
  }
})();
