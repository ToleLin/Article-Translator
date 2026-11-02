/* PaperLens — 分欄檢視：建立／還原、工具列、捲動同步、拖曳分隔線 */
(function () {
  'use strict';
  const PL = globalThis.PL;

  const saved = {
    bodyStyle: null,
    htmlStyle: null,
    scrollY: 0,
    children: null
  };

  /* ══════════ 建立分欄 ══════════ */

  PL.buildSplit = function () {
    if (PL.active) return;
    const body = document.body;
    if (!body) throw new Error('頁面還沒準備好');

    saved.scrollY = window.scrollY;
    saved.bodyStyle = body.getAttribute('style');
    saved.htmlStyle = document.documentElement.getAttribute('style');

    // 兩欄的底色必須沿用原頁面的底色（在搬動 DOM 之前先量好）
    document.documentElement.style.setProperty('--pl-page-bg', detectPageBackground());

    /* 1. 原頁面內容整批搬進左欄 —— 不是複製，所以 CSS、圖片、公式 100% 原樣 */
    const left = PL.el('div', { id: 'pl-left', class: 'pl-pane' });
    const kids = Array.from(body.childNodes);
    saved.children = kids;
    for (const n of kids) left.appendChild(n);
    body.appendChild(left);

    /* 2. 標記翻譯單位（左右共用同一組編號，捲動同步與註解都靠它對位） */
    const leftBlocks = PL.collectBlocks(left);
    leftBlocks.forEach((el, i) => el.setAttribute('data-pl-b', String(i)));
    PL.tagMedia(left);        // 圖／表／公式也編號，匯出 PDF 時才不會漏掉

    /* 3. 右欄 = 左欄的深拷貝 */
    const right = left.cloneNode(true);
    right.id = 'pl-right';
    sanitizeClone(left, right);

    const gutter = PL.el('div', { id: 'pl-gutter', 'data-pl-ui': '1', title: '拖曳調整左右寬度，雙擊回到 50%' });
    body.appendChild(gutter);
    body.appendChild(right);

    PL.els.left = left;
    PL.els.right = right;
    PL.els.gutter = gutter;

    /* 4. 配對區塊 */
    const rightBlocks = Array.from(right.querySelectorAll('[data-pl-b]'));
    const rightMap = new Map(rightBlocks.map((el) => [el.getAttribute('data-pl-b'), el]));
    PL.blocks = leftBlocks.map((el, i) => {
      const r = rightMap.get(String(i));
      return {
        i,
        left: el,
        right: r || null,
        srcText: '',
        atoms: null,
        state: 'pending'
      };
    }).filter((b) => b.right);

    PL.blocks.forEach((b) => {
      b.right.setAttribute('data-pl-state', 'pending');
      b.origHTML = b.right.innerHTML;
    });

    fixLazyImages(left);
    fixLazyImages(right);

    /* 5. UI */
    buildBar();
    applyLook();
    document.documentElement.classList.add('pl-active');
    setRatio(PL.settings.splitRatio);

    /* 6. 行為 */
    wireScrollSync();
    wireGutter();
    registerOverlays();

    PL.active = true;

    // 捲回原本閱讀的位置
    requestAnimationFrame(() => { left.scrollTop = saved.scrollY; Sync.markDirty(); });
  };

  /** 手寫標註／便利貼圖層：網頁版用「段落」當錨點 */
  function registerOverlays() {
    if (!PL.Overlay) return;

    const mk = (pane) => ({
      pane,
      anchorAt(cx, cy) {
        const el = document.elementFromPoint(cx, cy);
        const b = el && el.closest ? el.closest('[data-pl-b]') : null;
        if (b && pane.contains(b)) return b;
        return nearestBlock(pane, cy);
      },
      anchorEl(key) {
        return pane.querySelector('[data-pl-b="' + CSS.escape(String(key).slice(1)) + '"]');
      },
      keyOf(el) { return 'b' + el.getAttribute('data-pl-b'); }
    });

    PL.Overlay.register('left', mk(PL.els.left));
    PL.Overlay.register('right', mk(PL.els.right));
  }

  /** 點在段落之間的空白時，掛到最近的段落上 */
  function nearestBlock(pane, clientY) {
    let best = null, bd = Infinity;
    pane.querySelectorAll('[data-pl-b]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.height) return;
      const d = clientY < r.top ? r.top - clientY : (clientY > r.bottom ? clientY - r.bottom : 0);
      if (d < bd) { bd = d; best = el; }
    });
    return best;
  }

  /* ══════════ 還原 ══════════ */

  PL.destroySplit = function () {
    if (!PL.active) return;
    const body = document.body;
    const left = PL.els.left;
    const y = left ? left.scrollTop : 0;

    unwireScrollSync();
    if (PL.closeAnnotationUI) PL.closeAnnotationUI();

    document.documentElement.classList.remove('pl-active', 'pl-dim', 'pl-only-dst', 'pl-only-src', 'pl-side-open');

    document.querySelectorAll('.pl-ovl').forEach((n) => n.remove());
    const pal = document.getElementById('pl-palette');
    if (pal) pal.remove();
    document.documentElement.classList.remove('pl-drawing');

    ['bar', 'right', 'gutter', 'side', 'sel', 'pop'].forEach((k) => {
      if (PL.els[k] && PL.els[k].parentNode) PL.els[k].parentNode.removeChild(PL.els[k]);
      PL.els[k] = null;
    });

    if (left) {
      while (left.firstChild) body.appendChild(left.firstChild);
      if (left.parentNode) left.parentNode.removeChild(left);
    }
    PL.els.left = null;

    // 清掉我們加在原始 DOM 上的標記（螢光筆標記保留在儲存空間裡，下次開啟會重畫）
    document.querySelectorAll('[data-pl-b],[data-pl-m]').forEach((el) => {
      el.removeAttribute('data-pl-b');
      el.removeAttribute('data-pl-m');
      el.removeAttribute('data-pl-state');
      el.removeAttribute('data-pl-done');
    });
    document.querySelectorAll('mark.pl-hl').forEach((mk) => {
      const parent = mk.parentNode;
      if (!parent) return;
      while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
      parent.removeChild(mk);
      parent.normalize();
    });

    document.documentElement.style.removeProperty('--pl-page-bg');
    if (saved.bodyStyle == null) body.removeAttribute('style'); else body.setAttribute('style', saved.bodyStyle);
    if (saved.htmlStyle == null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', saved.htmlStyle);

    PL.blocks = [];
    PL.active = false;
    window.scrollTo(0, y);
  };

  /**
   * 量出這個網站「實際看起來」的底色。
   * 不能直接用我們的深淺色主題：淺色網站配上系統深色模式時，
   * 我們若把底畫成深色，網站原本的深色文字就會糊進背景消失。
   */
  function detectPageBackground() {
    const opaque = (c) => {
      if (!c || c === 'transparent') return false;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return true;
      const parts = m[1].split(',').map((x) => parseFloat(x));
      return !(parts.length > 3 && parts[3] < 0.05);
    };

    const bodyBg = getComputedStyle(document.body).backgroundColor;
    if (opaque(bodyBg)) return bodyBg;

    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    if (opaque(htmlBg)) return htmlBg;

    // html 與 body 都透明時，底色是瀏覽器自己畫的，看 color-scheme 決定
    const scheme = (getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
    if (scheme.includes('dark') && !scheme.includes('light')) return '#131417';
    return '#ffffff';
  }

  /* ══════════ 右欄清理 ══════════ */

  function sanitizeClone(left, right) {
    // 腳本不需要（clone 本來也不會執行），移掉省記憶體
    right.querySelectorAll('script,noscript,template').forEach((n) => n.remove());

    // 我們自己的 UI 不該被複製
    right.querySelectorAll('[data-pl-ui]').forEach((n) => n.remove());

    // 嵌入式內容在右欄重複載入只會浪費頻寬（廣告、播放器），換成佔位
    right.querySelectorAll('iframe,object,embed,video,audio').forEach((n) => {
      const ph = PL.el('div', { class: 'pl-placeholder', text: '（嵌入內容：請看左欄原文）' });
      if (n.parentNode) n.parentNode.replaceChild(ph, n);
    });

    // canvas 在 clone 裡是空白的 —— 盡量把左欄畫好的內容拍成圖片搬過去
    const lc = left.querySelectorAll('canvas');
    const rc = right.querySelectorAll('canvas');
    for (let i = 0; i < rc.length; i++) {
      let replacement = null;
      try {
        const url = lc[i] && lc[i].toDataURL('image/png');
        if (url && url.length > 64) {
          replacement = PL.el('img', { src: url, style: { maxWidth: '100%' }, alt: 'canvas' });
        }
      } catch (e) { /* 跨網域污染的 canvas 無法匯出 */ }
      if (!replacement) replacement = PL.el('div', { class: 'pl-placeholder', text: '（動態圖表：請看左欄原文）' });
      if (rc[i].parentNode) rc[i].parentNode.replaceChild(replacement, rc[i]);
    }
  }

  /** 很多站用 data-src 延遲載圖；分欄後 window 不再捲動，它們的 loader 不會觸發 */
  function fixLazyImages(root) {
    root.querySelectorAll('img').forEach((img) => {
      const cand = img.getAttribute('data-src') || img.getAttribute('data-original')
        || img.getAttribute('data-lazy-src') || img.getAttribute('data-echo')
        || img.getAttribute('data-hi-res-src');
      const cur = img.getAttribute('src') || '';
      const looksPlaceholder = !cur || cur.startsWith('data:image/gif') || /placeholder|blank|spacer|loading/i.test(cur);
      if (cand && looksPlaceholder) img.setAttribute('src', cand);

      const srcset = img.getAttribute('data-srcset');
      if (srcset && !img.getAttribute('srcset')) img.setAttribute('srcset', srcset);

      if (img.getAttribute('loading') === 'lazy') img.setAttribute('loading', 'eager');
    });
  }

  /* ══════════ 工具列 ══════════ */

  function buildBar() {
    const bar = PL.el('div', { id: 'pl-bar', 'data-pl-ui': '1' });

    bar.appendChild(PL.el('span', { class: 'pl-brand', text: 'PaperLens' }));

    const engine = PL.el('select', { id: 'pl-engine', title: '翻譯引擎' });
    engine.appendChild(PL.el('option', { value: 'auto', text: '自動（依序備援）' }));
    ['chrome', 'edge', 'google', 'gemini'].forEach((k) => {
      engine.appendChild(PL.el('option', { value: k, text: globalThis.PL_ENGINE_LABEL[k] }));
    });
    engine.value = PL.settings.forceEngine || 'auto';
    engine.addEventListener('change', () => {
      if (engine.value === 'gemini' && !PL.settings.geminiApiKey && PL.openGeminiDialog) {
        // 還沒有金鑰就選 Gemini：直接打開金鑰視窗
        engine.value = PL.settings.forceEngine || 'auto';
        PL.openGeminiDialog();
        return;
      }
      PL.settings.forceEngine = engine.value === 'auto' ? null : engine.value;
      if (PL.refreshGeminiButton) PL.refreshGeminiButton();
      PL.toast('引擎切換為：' + (engine.value === 'auto' ? '自動' : globalThis.PL_ENGINE_LABEL[engine.value]));
    });
    bar.appendChild(engine);

    // 獨立的 Gemini 入口：貼上金鑰就能改用 Gemini 翻譯
    if (PL.makeGeminiButton) bar.appendChild(PL.makeGeminiButton());

    const btnAll = PL.el('button', { id: 'pl-translate-all', text: '翻譯全文' });
    btnAll.addEventListener('click', () => PL.translateAll());
    bar.appendChild(btnAll);

    const prog = PL.el('div', { class: 'pl-prog' }, [PL.el('i')]);
    bar.appendChild(prog);
    PL.els.prog = prog.firstChild;

    const status = PL.el('span', { class: 'pl-status', text: '待命' });
    bar.appendChild(status);
    PL.els.status = status;

    bar.appendChild(PL.el('span', { class: 'pl-spacer' }));

    const modeWrap = PL.el('span', { class: 'pl-modes' });
    [['both', '對照'], ['dst', '僅譯文'], ['src', '僅原文']].forEach(([v, label]) => {
      const b = PL.el('button', { text: label, 'data-mode': v });
      b.addEventListener('click', () => setMode(v));
      modeWrap.appendChild(b);
    });
    bar.appendChild(modeWrap);
    PL.els.modeWrap = modeWrap;

    const btnSync = PL.el('button', { id: 'pl-sync', text: '同步捲動', title: '讓兩欄跟著同一段落' });
    btnSync.classList.toggle('pl-on', !!PL.settings.syncScroll);
    btnSync.addEventListener('click', () => {
      PL.settings.syncScroll = !PL.settings.syncScroll;
      btnSync.classList.toggle('pl-on', PL.settings.syncScroll);
      globalThis.PL_saveSettings({ syncScroll: PL.settings.syncScroll });
    });
    bar.appendChild(btnSync);

    const btnInk = PL.el('button', { id: 'pl-inkbtn', text: '標註', title: '畫筆、圈選、箭頭、便利貼' });
    btnInk.addEventListener('click', () => {
      btnInk.classList.toggle('pl-on', PL.Overlay.togglePalette());
    });
    bar.appendChild(btnInk);

    const btnSide = PL.el('button', { id: 'pl-sidebtn', text: '註解' });
    btnSide.addEventListener('click', () => PL.toggleSidebar());
    bar.appendChild(btnSide);
    PL.els.sideBtn = btnSide;

    const btnPdf = PL.el('button', { text: '匯出 PDF' });
    btnPdf.addEventListener('click', () => PL.openExport());
    bar.appendChild(btnPdf);

    const btnOpt = PL.el('button', { text: '⚙', title: '設定' });
    btnOpt.addEventListener('click', () => PL.send({ type: 'openOptions' }).catch(() => {}));
    bar.appendChild(btnOpt);

    const btnClose = PL.el('button', { text: '✕', title: '關閉對照閱讀 (Alt+Shift+T)' });
    btnClose.addEventListener('click', () => PL.deactivate());
    bar.appendChild(btnClose);

    bar.style.flexWrap = 'nowrap';
    bar.style.overflowX = 'auto';
    document.documentElement.appendChild(bar);
    PL.els.bar = bar;
    setMode('both');
  }

  function setMode(mode) {
    const root = document.documentElement;
    root.classList.toggle('pl-only-dst', mode === 'dst');
    root.classList.toggle('pl-only-src', mode === 'src');
    if (PL.els.modeWrap) {
      PL.els.modeWrap.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('pl-on', b.getAttribute('data-mode') === mode);
      });
    }
    PL.mode = mode;
    Sync.markDirty();
  }
  PL.setMode = setMode;

  PL.setStatus = function (text, ratio) {
    if (PL.els.status) PL.els.status.textContent = text;
    if (PL.els.prog && typeof ratio === 'number') {
      PL.els.prog.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
    }
  };

  function applyLook() {
    const s = PL.settings;
    const root = document.documentElement;
    root.style.setProperty('--pl-trans-font', s.transFont);
    root.style.setProperty('--pl-trans-lh', String(s.transLineHeight));
    root.classList.toggle('pl-dim', !!s.dimOriginal);
    if (PL.els.right) PL.els.right.style.fontSize = (s.transFontScale || 1) === 1 ? '' : (s.transFontScale * 100) + '%';
  }
  PL.applyLook = applyLook;

  function setRatio(r) {
    r = Math.max(0.2, Math.min(0.8, r || 0.5));
    document.documentElement.style.setProperty('--pl-left-w', (r * 100) + '%');
    PL.settings.splitRatio = r;
  }

  /* ══════════ 拖曳分隔線 ══════════ */

  function wireGutter() {
    const g = PL.els.gutter;
    let dragging = false;

    g.addEventListener('mousedown', (e) => {
      dragging = true;
      g.classList.add('pl-dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    const onMove = (e) => {
      if (!dragging) return;
      setRatio(e.clientX / window.innerWidth);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      g.classList.remove('pl-dragging');
      document.body.style.userSelect = '';
      globalThis.PL_saveSettings({ splitRatio: PL.settings.splitRatio });
      Sync.markDirty();
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    g.addEventListener('dblclick', () => { setRatio(0.5); Sync.markDirty(); });

    PL._gutterCleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
  }

  /* ══════════ 捲動同步 ══════════ */

  const Sync = PL.Sync = {
    dirty: true,
    leftTops: [], rightTops: [], pairs: [],

    markDirty() { this.dirty = true; scheduleOverlay(); },

    build() {
      const L = PL.els.left, R = PL.els.right;
      if (!L || !R) return;
      const lr = L.getBoundingClientRect().top - L.scrollTop;
      const rr = R.getBoundingClientRect().top - R.scrollTop;
      const lt = [], rt = [], pairs = [];
      for (const b of PL.blocks) {
        if (!b.left.isConnected || !b.right.isConnected) continue;
        const a = b.left.getBoundingClientRect();
        const c = b.right.getBoundingClientRect();
        if (!a.height && !c.height) continue;          // 隱藏元素跳過
        lt.push(a.top - lr);
        rt.push(c.top - rr);
        pairs.push(b);
      }
      this.leftTops = lt; this.rightTops = rt; this.pairs = pairs;
      this.dirty = false;
    },

    ensure() { if (this.dirty) this.build(); },

    /** 找到第一個底邊還在視窗內的區塊 */
    indexFor(tops, scrollTop) {
      let lo = 0, hi = tops.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tops[mid] <= scrollTop + 40) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return ans;
    }
  };

  const scheduleOverlay = PL.debounce(() => {
    if (PL.Overlay) PL.Overlay.reproject();
  }, 180);

  let lock = 0;

  function syncFrom(side) {
    if (!PL.settings.syncScroll || PL.mode !== 'both') return;
    if (Date.now() < lock) return;
    const L = PL.els.left, R = PL.els.right;
    if (!L || !R) return;

    Sync.ensure();
    if (!Sync.pairs.length) return;

    const from = side === 'left' ? L : R;
    const to = side === 'left' ? R : L;
    const fromTops = side === 'left' ? Sync.leftTops : Sync.rightTops;
    const toTops = side === 'left' ? Sync.rightTops : Sync.leftTops;

    const i = Sync.indexFor(fromTops, from.scrollTop);
    const delta = from.scrollTop - fromTops[i];
    const target = Math.max(0, toTops[i] + delta);

    if (Math.abs(to.scrollTop - target) < 2) return;
    lock = Date.now() + 80;
    to.scrollTop = target;
  }

  const onLeft = PL.throttleRaf(() => {
    syncFrom('left');
    relayScroll();
    if (PL.onViewportChange) PL.onViewportChange();
  });
  const onRight = PL.throttleRaf(() => {
    syncFrom('right');
    if (PL.onViewportChange) PL.onViewportChange();
  });

  /** 原站的 lazy-load / 吸頂邏輯監聽的是 window 捲動，分欄後不會再觸發，這裡補一個 */
  let relayAt = 0;
  function relayScroll() {
    const now = Date.now();
    if (now - relayAt < 250) return;
    relayAt = now;
    try {
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    } catch (e) { /* ignore */ }
  }

  let ro = null;
  function wireScrollSync() {
    PL.els.left.addEventListener('scroll', onLeft, { passive: true });
    PL.els.right.addEventListener('scroll', onRight, { passive: true });

    const remark = PL.debounce(() => Sync.markDirty(), 200);
    window.addEventListener('resize', remark);
    PL._resizeCleanup = () => window.removeEventListener('resize', remark);

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(remark);
      ro.observe(PL.els.left);
      ro.observe(PL.els.right);
    }
  }

  function unwireScrollSync() {
    if (PL.els.left) PL.els.left.removeEventListener('scroll', onLeft);
    if (PL.els.right) PL.els.right.removeEventListener('scroll', onRight);
    if (PL._resizeCleanup) PL._resizeCleanup();
    if (PL._gutterCleanup) PL._gutterCleanup();
    if (ro) { ro.disconnect(); ro = null; }
  }

  /** 捲到某個區塊（兩欄一起） */
  PL.scrollToBlock = function (index, side) {
    const b = PL.blocks[index];
    if (!b) return;
    const pane = side === 'right' ? PL.els.right : PL.els.left;
    const el = side === 'right' ? b.right : b.left;
    if (!pane || !el) return;
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 80;
    pane.scrollTo({ top, behavior: 'smooth' });
    setTimeout(() => syncFrom(side === 'right' ? 'right' : 'left'), 380);
  };
})();
