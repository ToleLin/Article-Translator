/* PaperLens — 螢光筆、心得註解、AI 解釋、註解側欄 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  const HL = globalThis.PL_HIGHLIGHTS;

  let store = { title: '', url: '', updatedAt: 0, items: [] };
  let current = null;          // 正在編輯的註解
  let pendingRange = null;     // 還沒存檔的選取範圍

  const storeKey = () => 'ann:' + PL.pageKey();

  /* ══════════ 存取 ══════════ */

  PL.loadAnnotations = async function () {
    try {
      const got = await chrome.storage.local.get(storeKey());
      store = got[storeKey()] || { title: PL.pageTitle(), url: PL.pageKey(), updatedAt: 0, items: [] };
    } catch (e) {
      store = { title: PL.pageTitle(), url: PL.pageKey(), updatedAt: 0, items: [] };
    }
    if (!Array.isArray(store.items)) store.items = [];
    return store;
  };

  const persist = PL.debounce(async () => {
    store.title = PL.pageTitle();
    store.url = PL.pageKey();
    store.updatedAt = Date.now();
    try { await chrome.storage.local.set({ [storeKey()]: store }); }
    catch (e) { PL.toast('註解儲存失敗（儲存空間可能已滿）'); }
  }, 350);

  PL.getAnnotations = () => store.items.slice();

  /* ══════════ 位置換算 ══════════ */

  function charIndex(block, container, offset) {
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(container, offset);
    return r.toString().length;
  }

  function rangeFromOffsets(block, start, end) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    const r = document.createRange();
    let pos = 0, started = false, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (!started && pos + len > start) { r.setStart(n, start - pos); started = true; }
      if (started && pos + len >= end) { r.setEnd(n, end - pos); return r; }
      pos += len;
    }
    return null;
  }

  function textNodesInRange(range) {
    const out = [];
    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentNode;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      const s = (n === range.startContainer) ? range.startOffset : 0;
      const e = (n === range.endContainer) ? range.endOffset : n.nodeValue.length;
      if (e > s && n.nodeValue.slice(s, e).trim()) out.push({ node: n, s, e });
    }
    return out;
  }

  /* ══════════ 上色 / 取消上色 ══════════ */

  function paint(ann, range) {
    const c = HL[ann.color] || HL.yellow;
    const pieces = textNodesInRange(range);
    for (const p of pieces) {
      let n = p.node;
      if (p.e < n.nodeValue.length) n.splitText(p.e);
      if (p.s > 0) n = n.splitText(p.s);
      const mk = document.createElement('mark');
      mk.className = 'pl-hl';
      mk.setAttribute('data-pl-ann', ann.id);
      mk.setAttribute('data-pl-ui-skip', '1');
      mk.style.setProperty('--pl-hl-bg', c.bg);
      mk.style.setProperty('--pl-hl-line', c.line);
      if (ann.note || ann.ai) mk.setAttribute('data-pl-note', '1');
      n.parentNode.insertBefore(mk, n);
      mk.appendChild(n);
    }
    return pieces.length > 0;
  }

  function unpaint(id) {
    document.querySelectorAll('mark.pl-hl[data-pl-ann="' + CSS.escape(id) + '"]').forEach((mk) => {
      const parent = mk.parentNode;
      while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
      parent.removeChild(mk);
      parent.normalize();
    });
  }

  function blockOf(side, index) {
    const b = PL.blocks[index];
    if (!b) return null;
    return side === 'left' ? b.left : b.right;
  }

  /** 在一個段落裡找到這則註解的位置；找不到回傳 null */
  function locate(block, ann) {
    const text = block.textContent;
    if (text.slice(ann.start, ann.end) === ann.exact) return [ann.start, ann.end];
    if (!ann.exact) return null;
    let idx = -1;
    // 先用前後文定位，避免同一段裡有重複字串時標錯地方
    if (ann.prefix) {
      const p = text.indexOf(ann.prefix + ann.exact);
      if (p >= 0) idx = p + ann.prefix.length;
    }
    if (idx < 0) idx = text.indexOf(ann.exact);
    return idx < 0 ? null : [idx, idx + ann.exact.length];
  }

  /** 重新把一則註解畫回頁面上；位置對不上時用原文比對救回來 */
  function apply(ann) {
    let block = blockOf(ann.side, ann.block);
    if (!block) { ann.orphan = true; return false; }

    let pos = locate(block, ann);
    // 標在譯文上、而那一段還沒翻好：等翻好再畫。這時候去別段找會找到別處的同一個詞，
    // 把註解永久掛到錯的段落上
    const own = PL.blocks[ann.block];
    if (!pos && ann.side === 'right' && own && own.state !== 'done' && own.state !== 'same' && own.state !== 'skip') {
      ann.orphan = true;
      return false;
    }
    if (!pos && ann.exact && ann.exact.length >= 4) {
      /* 段落編號變了（例如 PDF 版面分析改版、重新分段）：
         原本那一段已經畫出來、卻找不到這段字，就到其他已經畫出來的段落找，找到就改掛過去 */
      for (const b of PL.blocks) {
        const el = ann.side === 'left' ? b.left : b.right;
        if (!el || el === block) continue;
        const p = locate(el, ann);
        if (p) { block = el; pos = p; ann.block = b.i; persist(); break; }
      }
    }
    if (!pos) { ann.orphan = true; return false; }

    const range = rangeFromOffsets(block, pos[0], pos[1]);
    if (!range) { ann.orphan = true; return false; }
    ann.orphan = !paint(ann, range);
    return !ann.orphan;
  }

  PL.applyAllAnnotations = function () {
    for (const ann of store.items) {
      unpaint(ann.id);
      apply(ann);
    }
    renderSidebar();
  };

  PL.reapplyAnnotations = function (blockIndex) {
    for (const ann of store.items) {
      if (ann.block !== blockIndex) continue;
      unpaint(ann.id);
      apply(ann);
    }
  };

  /* ══════════ 建立註解 ══════════ */

  function describeSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 1) return null;

    const anchorEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (!anchorEl || anchorEl.closest('[data-pl-ui]')) return null;

    const block = anchorEl.closest('[data-pl-b]');
    if (!block) return null;

    const pane = anchorEl.closest('#pl-left, #pl-right');
    const side = pane && pane.id === 'pl-right' ? 'right' : 'left';

    // 選取跨越多個區塊時只取起始區塊內的部分，避免錨點無法還原
    let r = range;
    if (!block.contains(range.endContainer)) {
      r = range.cloneRange();
      r.setEnd(block, block.childNodes.length);
    }

    const start = charIndex(block, r.startContainer, r.startOffset);
    const end = charIndex(block, r.endContainer, r.endOffset);
    const full = block.textContent;

    // 選取範圍跨過的所有段落（「翻譯」要用整段選取，不只起始那一段）
    const blocks = [];
    if (pane) {
      pane.querySelectorAll('[data-pl-b]').forEach((el) => {
        if (range.intersectsNode(el)) blocks.push(Number(el.getAttribute('data-pl-b')));
      });
    }

    return {
      side,
      block: Number(block.getAttribute('data-pl-b')),
      start, end,
      exact: full.slice(start, end),
      prefix: full.slice(Math.max(0, start - 24), start),
      suffix: full.slice(end, end + 24),
      rect: range.getBoundingClientRect(),
      range: r,
      full: range,
      fullText: selectionText(range),
      blocks,
      text
    };
  }

  /**
   * 選取範圍的文字。PDF 的文字層是一個個絕對定位的小片段，直接 toString() 會把
   * 行尾和下一行開頭黏成一個字（diffractivewaveguide）；這裡依片段位置補空白、接回斷字。
   */
  function selectionText(range) {
    if (!PL.isPdf) return range.toString().replace(/\s+/g, ' ').trim();
    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const L = globalThis.PLLayout;
    const vocab = PL.pdf && PL.pdf.doc && PL.pdf.doc.layout ? PL.pdf.doc.layout.vocab : null;
    let out = '', prev = null, n;
    while ((n = walker.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      const host = n.parentElement && n.parentElement.closest('span');
      if (!host || host.closest('[data-pl-ui]')) continue;
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : n.nodeValue.length;
      const t = n.nodeValue.slice(s, e);
      if (!t.trim()) continue;
      const r = host.getBoundingClientRect();
      if (!out) out = t;
      else if (prev && Math.abs(r.top - prev.top) > Math.max(3, prev.height * 0.5)) {
        out = L ? L.joinPieces(out.replace(/\s+$/, ''), t.replace(/^\s+/, ''), vocab) : out + ' ' + t;   // 換行
      } else if (prev && host !== prev.host && r.left - prev.right > 1.5 && !/\s$/.test(out) && !/^\s/.test(t)) {
        out += ' ' + t;
      } else out += t;
      prev = { top: r.top, height: r.height, right: r.right, host };
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function createAnnotation(info, color) {
    const ann = {
      id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      side: info.side,
      block: info.block,
      start: info.start,
      end: info.end,
      exact: info.exact,
      prefix: info.prefix,
      suffix: info.suffix,
      color: color || PL.settings.defaultHighlight || 'yellow',
      note: '',
      ai: '',
      createdAt: Date.now()
    };
    store.items.push(ann);
    paint(ann, info.range);
    persist();
    renderSidebar();
    return ann;
  }

  function updateAnnotation(ann, patch) {
    Object.assign(ann, patch);
    unpaint(ann.id);
    apply(ann);
    persist();
    renderSidebar();
  }

  function deleteAnnotation(ann) {
    unpaint(ann.id);
    store.items = store.items.filter((a) => a.id !== ann.id);
    if (current && current.id === ann.id) closePopup();
    persist();
    renderSidebar();
  }
  PL.deleteAnnotation = deleteAnnotation;

  /** 復原用：把刪掉的註解放回去（橡皮擦擦掉螢光筆之後按 Ctrl+Z） */
  PL.restoreAnnotation = function (ann) {
    if (!ann || store.items.some((a) => a.id === ann.id)) return;
    const copy = Object.assign({}, ann);
    store.items.push(copy);
    apply(copy);
    persist();
    renderSidebar();
  };

  /* ══════════ 選字小工具列 ══════════ */

  function selBar() {
    if (PL.els.sel) return PL.els.sel;
    const bar = PL.el('div', { id: 'pl-sel', 'data-pl-ui': '1' });

    Object.keys(HL).forEach((key) => {
      const b = PL.el('button', {
        class: 'pl-swatch', title: HL[key].label + '色螢光筆',
        style: { background: HL[key].line }
      });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (!pendingRange) return;
        const ann = createAnnotation(pendingRange, key);
        hideSelBar();
        document.getSelection().removeAllRanges();
        PL.settings.defaultHighlight = key;
        globalThis.PL_saveSettings({ defaultHighlight: key });
        void ann;
      });
      bar.appendChild(b);
    });

    bar.appendChild(PL.el('span', { class: 'pl-div' }));

    // 翻譯選取的文字：小視窗顯示譯文，同時把這幾段在右欄就地翻好
    const bTr = PL.el('button', { class: 'pl-sel-tr', text: '🌐 翻譯', title: '翻譯選取的文字（右欄的這幾段也會一起翻好）' });
    bTr.addEventListener('mousedown', (e) => e.preventDefault());
    bTr.addEventListener('click', () => {
      if (!pendingRange) return;
      const info = pendingRange;
      hideSelBar();
      quickTranslate(info);
    });
    bar.appendChild(bTr);

    // 選的是譯文：看對應的原文
    const bSrc = PL.el('button', { class: 'pl-sel-src', text: '📄 原文', title: '顯示這段譯文對應的原文' });
    bSrc.addEventListener('mousedown', (e) => e.preventDefault());
    bSrc.addEventListener('click', () => {
      if (!pendingRange) return;
      const info = pendingRange;
      hideSelBar();
      showOriginal(info);
    });
    bar.appendChild(bSrc);

    const bNote = PL.el('button', { text: '✎ 心得' });
    bNote.addEventListener('mousedown', (e) => e.preventDefault());
    bNote.addEventListener('click', () => {
      if (!pendingRange) return;
      const ann = createAnnotation(pendingRange, PL.settings.defaultHighlight);
      hideSelBar();
      document.getSelection().removeAllRanges();
      openPopup(ann, true);
    });
    bar.appendChild(bNote);

    const bAI = PL.el('button', { text: '✨ AI 解釋' });
    bAI.addEventListener('mousedown', (e) => e.preventDefault());
    bAI.addEventListener('click', () => {
      if (!pendingRange) return;
      const ann = createAnnotation(pendingRange, PL.settings.defaultHighlight);
      hideSelBar();
      document.getSelection().removeAllRanges();
      openPopup(ann);
      runExplain(ann);
    });
    bar.appendChild(bAI);

    // 針對這段向 AI 提問（側欄，可以連續追問）
    const bAsk = PL.el('button', { class: 'pl-sel-ask', text: '💬 問 AI', title: '針對選取的文字向 AI（Gemini）提問' });
    bAsk.addEventListener('mousedown', (e) => e.preventDefault());
    bAsk.addEventListener('click', () => {
      if (!pendingRange) return;
      const info = pendingRange;
      hideSelBar();
      PL.askAI(info);
    });
    bar.appendChild(bAsk);

    const bCopy = PL.el('button', { text: '⧉' , title: '複製選取文字'});
    bCopy.addEventListener('mousedown', (e) => e.preventDefault());
    bCopy.addEventListener('click', async () => {
      if (!pendingRange) return;
      try { await navigator.clipboard.writeText(pendingRange.text); PL.toast('已複製'); }
      catch (e) { PL.toast('複製失敗'); }
      hideSelBar();
    });
    bar.appendChild(bCopy);

    document.documentElement.appendChild(bar);
    PL.els.sel = bar;
    return bar;
  }

  function showSelBar(info) {
    const bar = selBar();
    // 選的是右欄（已經是譯文）就不用再翻
    const tr = bar.querySelector('.pl-sel-tr');
    if (tr) tr.style.display = info.side === 'right' ? 'none' : '';
    const sb = bar.querySelector('.pl-sel-src');
    if (sb) sb.style.display = info.side === 'right' && info.block != null ? '' : 'none';
    bar.classList.add('pl-show');
    const r = info.rect;
    const w = bar.offsetWidth || 260;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    let y = r.top - bar.offsetHeight - 10;
    if (y < 50) y = r.bottom + 10;
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  }

  function hideSelBar() {
    if (PL.els.sel) PL.els.sel.classList.remove('pl-show');
    pendingRange = null;
  }

  /* ══════════ 註解泡泡 ══════════ */

  function popup() {
    if (PL.els.pop) return PL.els.pop;
    const p = PL.el('div', { id: 'pl-pop', 'data-pl-ui': '1' });

    const quote = PL.el('div', { class: 'pl-quote' });
    const colors = PL.el('div', { class: 'pl-row' });
    const ta = PL.el('textarea', { placeholder: '寫下你讀到這裡的心得…（會自動存在本機）' });
    const ai = PL.el('div', { class: 'pl-ai' });
    ai.style.display = 'none';

    const row = PL.el('div', { class: 'pl-row' });
    const bAI = PL.el('button', { text: '✨ AI 解釋這段' });
    const bDel = PL.el('button', { class: 'pl-danger', text: '刪除' });
    const spacer = PL.el('span', { class: 'pl-spacer', style: { flex: '1' } });
    const bClose = PL.el('button', { class: 'pl-primary', text: '完成' });
    row.append(bAI, bDel, spacer, bClose);

    p.append(quote, colors, ta, ai, row);
    document.documentElement.appendChild(p);

    Object.keys(HL).forEach((key) => {
      const b = PL.el('button', { class: 'pl-swatch', 'data-color': key, title: HL[key].label, style: { background: HL[key].line } });
      b.addEventListener('click', () => {
        if (!current) return;
        updateAnnotation(current, { color: key });
        refreshColors();
      });
      colors.appendChild(b);
    });

    ta.addEventListener('input', () => {
      if (!current) return;
      current.note = ta.value;
      persist();
      document.querySelectorAll('mark.pl-hl[data-pl-ann="' + CSS.escape(current.id) + '"]')
        .forEach((m) => m.setAttribute('data-pl-note', (current.note || current.ai) ? '1' : '0'));
      renderSidebarSoon();
    });

    bAI.addEventListener('click', () => current && runExplain(current));
    bDel.addEventListener('click', () => { if (current) { deleteAnnotation(current); closePopup(); } });
    bClose.addEventListener('click', closePopup);

    PL.els.pop = p;
    p._parts = { quote, colors, ta, ai, bAI };
    return p;

    function refreshColors() {
      colors.querySelectorAll('.pl-swatch').forEach((b) => {
        b.classList.toggle('pl-cur', current && b.getAttribute('data-color') === current.color);
      });
    }
  }

  function openPopup(ann, focusNote) {
    current = ann;
    const p = popup();
    const { quote, colors, ta, ai } = p._parts;

    quote.textContent = ann.exact;
    ta.value = ann.note || '';
    ai.textContent = ann.ai || '';
    ai.style.display = ann.ai ? 'block' : 'none';
    colors.querySelectorAll('.pl-swatch').forEach((b) => {
      b.classList.toggle('pl-cur', b.getAttribute('data-color') === ann.color);
    });

    p.classList.add('pl-show');
    position(p, ann);
    if (focusNote) setTimeout(() => ta.focus(), 30);
  }

  function position(p, ann) {
    const mk = document.querySelector('mark.pl-hl[data-pl-ann="' + CSS.escape(ann.id) + '"]');
    const r = mk ? mk.getBoundingClientRect() : { left: window.innerWidth / 2 - 170, bottom: 120, top: 120, width: 0 };
    const w = p.offsetWidth || 340;
    const h = p.offsetHeight || 260;
    let x = Math.min(window.innerWidth - w - 10, Math.max(10, r.left));
    let y = r.bottom + 10;
    if (y + h > window.innerHeight - 10) y = Math.max(50, r.top - h - 10);
    p.style.left = x + 'px';
    p.style.top = y + 'px';
  }

  function closePopup() {
    if (PL.els.pop) PL.els.pop.classList.remove('pl-show');
    current = null;
  }
  PL.closeAnnotationUI = function () { hideSelBar(); closePopup(); };

  /* ══════════ AI 解釋 ══════════ */

  async function runExplain(ann) {
    const p = popup();
    const { ai } = p._parts;
    ai.style.display = 'block';
    ai.textContent = '思考中…（第一次使用內建模型可能要先下載，請稍候）';

    const block = blockOf(ann.side, ann.block);
    const around = block ? block.textContent.slice(0, 1500) : '';

    try {
      const res = await PL.send({
        type: 'ai.explain',
        text: ann.exact,
        context: { title: PL.pageTitle(), around }
      });
      ann.ai = res.text;
      ai.textContent = res.text;
      persist();
      document.querySelectorAll('mark.pl-hl[data-pl-ann="' + CSS.escape(ann.id) + '"]')
        .forEach((m) => m.setAttribute('data-pl-note', '1'));
      renderSidebar();
    } catch (e) {
      ai.textContent = '⚠ ' + (e.message || e);
    }
  }
  PL.runExplain = runExplain;

  /* ══════════ 選取時，另一邊對應的地方一起標出來 ══════════
     用 CSS Custom Highlight（不改動任何 DOM）。
     1) 先找對應的句子：兩邊切句，句數一樣就一句對一句；對不上就按位置比例。
     2) 只選了幾個字（單字、數字、術語、片語）→ 再到那一句裡找「真正對應的那幾個字」：
        數字、縮寫、英文術語這種兩邊原樣出現的直接找；其餘把選的字翻成另一邊的語言，
        再在句子裡找最像的一段（中文以字為單位比對、再對齊到詞的邊界；英文以單字比對）。
     對到字：那幾個字用黃色標，所在的句子用很淡的黃色當背景；對不到就整句標黃。 */

  const CAN_SYNC = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh-Hant', { granularity: 'word' }) : null;

  const nonWsLen = (str) => str.replace(/\s+/g, '').length;

  /**
   * PDF 文字層的字串（a）跟整理過的原文（b）逐字對齊：空白兩邊各自跳過；
   * a 行尾的連字號在 b 已經被接回去（diffrac-/tive → diffractive），那個「-」不佔 b 的位置。
   * 光算「第幾個非空白字」的話，每遇到一個接回去的連字號就會差一個字。
   */
  function alignMap(a, b) {
    const a2b = new Int32Array(a.length + 1), b2a = new Int32Array(b.length + 1);
    const ws = (c) => /\s/.test(c);
    const hy = (c) => c === '-' || c === '\u2010' || c === '\u2011' || c === '\u00ad';
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && ws(a[i])) { a2b[i] = j; i++; continue; }
      if (j < b.length && ws(b[j])) { b2a[j] = i; j++; continue; }
      if (i >= a.length) { b2a[j] = i; j++; continue; }
      if (j >= b.length) { a2b[i] = j; i++; continue; }
      if (a[i] !== b[j] && hy(a[i])) {
        let k = i + 1;
        while (k < a.length && ws(a[k])) k++;
        if (k < a.length && a[k] === b[j]) { a2b[i] = j; i++; continue; }
      }
      a2b[i] = j; b2a[j] = i; i++; j++;
    }
    a2b[a.length] = b.length;
    b2a[b.length] = a.length;
    return { a2b, b2a };
  }

  const EN_ABBR = /(?:\b(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Ref|Refs|Sec|Tab|No|Vol|approx|ca|resp|Dr|Prof|Suppl)|\b[A-Z])\.$/;

  function sentenceSpans(text, cjk) {
    const spans = [];
    const re = cjk ? /[。！？；!?]+[」』”’）)\]]*/g : /[.!?;]+["”’)\]]*(?=\s)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      if (!cjk && EN_ABBR.test(text.slice(Math.max(0, m.index - 12), m.index + 1))
        // 「etc. Due to …」：etc. 後面接大寫開頭的字，是句子結束
        && !(/\betc\.$/.test(text.slice(Math.max(0, m.index - 4), m.index + 1)) && /^\s+\p{Lu}/u.test(text.slice(end, end + 4)))) continue;
      if (text.slice(last, end).trim()) spans.push([last, end]);
      last = end;
    }
    if (text.slice(last).trim()) spans.push([last, text.length]);
    return spans.length ? spans : [[0, text.length]];
  }

  function spanIdx(spans, s, e) {
    let i0 = -1, i1 = -1;
    spans.forEach(([a, b], k) => {
      if (b > s && a < Math.max(e, s + 1)) { if (i0 < 0) i0 = k; i1 = k; }
    });
    if (i0 < 0) i0 = i1 = spans.length - 1;
    return [i0, i1];
  }

  const trimWs = (str, r) => {
    let [a, z] = r;
    while (a < z && /\s/.test(str[a])) a++;
    while (z > a && /\s/.test(str[z - 1])) z--;
    return [a, z];
  };

  /* ---- 句子對齊 ----
     兩邊的句數常常不一樣（一句英文翻成兩句中文、或兩句併成一句），不能只照第幾句或位置比例去對。
     這裡用動態規劃把兩邊的句子配對：長度比例要接近；兩邊都出現的數字、英文縮寫（QDs、IR、45°）
     是很強的線索。允許 1 對 1、1 對 2、2 對 1、2 對 2，或某一句在另一邊沒有對應。 */

  const ANCHOR_RE = /\d+(?:\.\d+)?|[A-Za-z][A-Za-z0-9-]+/g;
  const anchorsOf = (t) => (t.match(ANCHOR_RE) || []).map((x) => x.toLowerCase());

  function alignSentences(src, A, tgt, B) {
    const n = A.length, m = B.length;
    const la = A.map(([a, z]) => nonWsLen(src.slice(a, z)));
    const lb = B.map(([a, z]) => nonWsLen(tgt.slice(a, z)));
    const ratio = la.reduce((x, y) => x + y, 0) / Math.max(1, lb.reduce((x, y) => x + y, 0));
    const inSrc = new Set(anchorsOf(src)), inTgt = new Set(anchorsOf(tgt));
    const SA = A.map(([a, z]) => new Set(anchorsOf(src.slice(a, z)).filter((x) => inTgt.has(x))));
    const SB = B.map(([a, z]) => new Set(anchorsOf(tgt.slice(a, z)).filter((x) => inSrc.has(x))));

    const cost = (i0, i1, j0, j1) => {
      let x = 0, y = 0;
      const sa = new Set(), sb = new Set();
      for (let i = i0; i < i1; i++) { x += la[i]; SA[i].forEach((v) => sa.add(v)); }
      for (let k = j0; k < j1; k++) { y += lb[k] * ratio; SB[k].forEach((v) => sb.add(v)); }
      let shared = 0;
      sa.forEach((v) => { if (sb.has(v)) shared++; });
      const only = sa.size + sb.size - 2 * shared;
      return 0.3 * Math.abs(x - y) / Math.sqrt(x + y + 1) + 0.45 * only - 0.9 * shared;
    };
    const MOVES = [[1, 1, 0], [1, 2, 0.7], [2, 1, 0.7], [2, 2, 1.3], [1, 3, 1.5], [3, 1, 1.5], [1, 0, 2.6], [0, 1, 2.6]];
    const f = [], back = [];
    for (let i = 0; i <= n; i++) { f.push(new Array(m + 1).fill(Infinity)); back.push(new Array(m + 1).fill(null)); }
    f[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let k = 0; k <= m; k++) {
        if (f[i][k] === Infinity) continue;
        for (const [di, dk, pen] of MOVES) {
          if (i + di > n || k + dk > m) continue;
          const c = f[i][k] + pen + cost(i, i + di, k, k + dk);
          if (c < f[i + di][k + dk]) { f[i + di][k + dk] = c; back[i + di][k + dk] = [di, dk]; }
        }
      }
    }
    // 每一句對到另一邊的哪幾句（[第一句, 最後一句]）
    const a2b = new Array(n).fill(null), b2a = new Array(m).fill(null);
    let i = n, k = m;
    while (i > 0 || k > 0) {
      const mv = back[i][k];
      if (!mv) break;
      const [di, dk] = mv;
      const i0 = i - di, k0 = k - dk;
      for (let x = i0; x < i; x++) a2b[x] = dk ? [k0, k - 1] : null;
      for (let y = k0; y < k; y++) b2a[y] = di ? [i0, i - 1] : null;
      i = i0; k = k0;
    }
    // 沒有對應的句子：借用前一句（或後一句）的對應
    const fill = (arr, max) => {
      for (let x = 0; x < arr.length; x++) {
        if (arr[x]) continue;
        let y = x - 1;
        while (y >= 0 && !arr[y]) y--;
        if (y >= 0) { arr[x] = [arr[y][1], arr[y][1]]; continue; }
        y = x + 1;
        while (y < arr.length && !arr[y]) y++;
        arr[x] = y < arr.length ? [arr[y][0], arr[y][0]] : [Math.max(0, max - 1), Math.max(0, max - 1)];
      }
    };
    fill(a2b, m);
    fill(b2a, n);
    return { a2b, b2a };
  }

  /* ---- 翻譯單位 ----
     跨欄、跨頁串起來的同一段話是「一起翻、再切回各個方塊」的，中文切開的位置跟英文不會剛好一樣：
     左邊第一塊最後一句的中文，可能排在右邊第二塊的開頭。所以對應要以整個單位來算，
     算出來的位置再換回是哪一塊的哪幾個字（可能落在另一欄、另一頁）。 */

  const CJK_CH = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  const mostlyCjk = (t) => ((t.match(CJK_CH) || []).length > nonWsLen(t) * 0.3);

  /** PDF：文字層的字串 ↔ 整理過的原文 的逐字對照（沒畫出來的頁面是 null） */
  function leftMap(x) {
    if (!PL.isPdf || !x.left) return null;
    const leftTxt = x.left.textContent, src = x.srcText || '';
    if (!x._amap || x._amap.l !== leftTxt.length || x._amap.s !== src.length) {
      x._amap = { l: leftTxt.length, s: src.length, m: alignMap(leftTxt, src) };
    }
    return x._amap.m;
  }
  const endOf = (tbl, str, p) => {
    let k = Math.min(p, str.length) - 1;
    while (k >= 0 && /\s/.test(str[k])) k--;
    return k < 0 ? 0 : tbl[k] + 1;
  };

  function unitOfBlock(b) {
    let chain = [b];
    if (PL.isPdf && b.head != null && (b.prevI >= 0 || b.nextI >= 0)) {
      const list = [];
      for (let x = PL.blocks[b.head]; x && list.length < 12; x = x.nextI >= 0 ? PL.blocks[x.nextI] : null) list.push(x);
      if (list.includes(b) && list.every((x) => x.state === 'done')) chain = list;
    }
    const texts = chain.map((x) => ({
      src: PL.isPdf ? (x.srcText || '') : (x.left ? x.left.textContent : ''),
      tgt: x.right ? x.right.textContent : (PL.isPdf ? (x.translated || '') : '')
    }));
    const key = chain.map((x, k) => x.i + ':' + texts[k].src.length + ':' + texts[k].tgt.length).join('|');
    const head = chain[0];
    if (head._unit && head._unit.key === key) return head._unit;
    const U = { key, segs: [], src: '', tgt: '' };
    chain.forEach((x, k) => {
      if (U.src) U.src += ' ';
      const seg = { b: x, s0: U.src.length, t0: U.tgt.length, srcText: texts[k].src };
      U.src += texts[k].src;
      U.tgt += texts[k].tgt;
      seg.s1 = U.src.length;
      seg.t1 = U.tgt.length;
      U.segs.push(seg);
    });
    U.srcCjk = mostlyCjk(U.src);
    U.tgtCjk = mostlyCjk(U.tgt);
    U.A = sentenceSpans(U.src, U.srcCjk);
    U.B = sentenceSpans(U.tgt, U.tgtCjk);
    U.link = alignSentences(U.src, U.A, U.tgt, U.B);
    head._unit = U;
    return U;
  }

  /** 單位裡某一邊的 [a, z) → 頁面上的 Range（跨到另一塊就會有好幾個；沒畫出來的頁面略過） */
  function unitRanges(U, side, a, z) {
    const out = [];
    for (const seg of U.segs) {
      const g0 = side === 'left' ? seg.s0 : seg.t0, g1 = side === 'left' ? seg.s1 : seg.t1;
      const lo = Math.max(a, g0), hi = Math.min(z, g1);
      if (hi <= lo) continue;
      const el = side === 'left' ? seg.b.left : seg.b.right;
      if (!el) continue;
      let A = lo - g0, Z = hi - g0;
      if (side === 'left') {
        const m = leftMap(seg.b);
        if (m) { A = m.b2a[Math.min(A, seg.srcText.length)]; Z = endOf(m.b2a, seg.srcText, Z); }
      }
      Z = Math.min(Z, el.textContent.length);
      const r = Z > A ? rangeFromOffsets(el, A, Z) : null;
      if (r) out.push(r);
    }
    return out;
  }

  /* ---- 找「原樣出現」的字：數字、縮寫、英文術語、單位 ---- */

  const TOKEN_RE = /[A-Za-z0-9](?:[A-Za-z0-9.+\-−–°%/]*[A-Za-z0-9%°])?/g;
  const isAsciiWord = (c) => !!c && /[A-Za-z0-9]/.test(c);

  /** exp：預期出現的位置。同一句裡出現好幾次（QDs … QDs）時，挑離預期位置最近的那一個 */
  function findWord(text, w, from, to, exp) {
    const low = text.toLowerCase(), q = w.toLowerCase();
    let i = low.indexOf(q, from), best = null, bd = Infinity;
    while (i >= 0 && i + q.length <= to) {
      // 英數字要整個字對上（找 18 不能對到 1968 裡面）
      const ok = !/^[A-Za-z0-9]/.test(q) || (!isAsciiWord(text[i - 1]) && !isAsciiWord(text[i + q.length]));
      if (ok) {
        if (exp == null) return [i, i + q.length];
        const d = Math.abs(i + q.length / 2 - exp);
        if (d < bd) { bd = d; best = [i, i + q.length]; }
      }
      i = low.indexOf(q, i + 1);
    }
    return best;
  }

  /** 選的字整段原樣出現在另一邊（例如選了「1968」「AR」「HoloLens」） */
  function findLiteral(phrase, text, from, to, exp) {
    const p = phrase.replace(/\s+/g, ' ').replace(/^[\s,.;:()\[\]"'“”‘’，。；：、（）]+|[\s,.;:()\[\]"'“”‘’，。；：、（）]+$/g, '');
    if (!p) return null;
    const whole = findWord(text, p, from, to, exp) || (/[A-Za-z]{2}s$/.test(p) ? findWord(text, p.slice(0, -1), from, to, exp) : null);
    if (whole) return whole;
    // 選到數字後面黏著的引用上標（1968¹、網頁上的 19681）：去掉上標再找
    const core = p.replace(/[⁰-⁹¹²³⁺⁻,–\-]+$/u, '');
    if (core && core !== p) {
      const r = findWord(text, core, from, to, exp);
      if (r) return r;
    }
    const all = p.match(TOKEN_RE) || [];
    const rest = p.replace(TOKEN_RE, '').replace(/[\s\p{P}\p{S}⁰-⁹¹²³]/gu, '');
    if (!all.length || rest) return null;             // 還有別的字 → 交給翻譯比對
    // 「focus on」不能只因為找到 on 就算對到：虛詞不算
    const tokens = all.length > 1 ? all.filter((t) => !STOP.has(t.toLowerCase())) : all;
    if (!tokens.length) return null;
    const hits = [];
    for (const t of tokens) {
      let r = findWord(text, t, from, to, exp);
      if (!r && /^\d{5,}$/.test(t)) {                 // 19681 → 1968
        for (let k = 1; k <= 3 && !r; k++) r = findWord(text, t.slice(0, -k), from, to, exp);
      }
      if (!r && /[A-Za-z]{2}s$/.test(t)) r = findWord(text, t.slice(0, -1), from, to, exp);   // q-BICs → q-BIC
      if (r) hits.push(r);
    }
    if (!hits.length || hits.length < tokens.length / 2) return null;
    const a = Math.min(...hits.map((h) => h[0])), z = Math.max(...hits.map((h) => h[1]));
    return z - a <= p.length * 3 + 12 ? [a, z] : hits[0];
  }

  /* ---- 翻譯後比對：中文以字為單位 ---- */

  const CJK_UNIT = /[A-Za-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  function units(str) {
    const out = [];
    let m;
    CJK_UNIT.lastIndex = 0;
    while ((m = CJK_UNIT.exec(str))) out.push({ t: m[0].toLowerCase(), i: m.index, j: m.index + m[0].length });
    return out;
  }

  /** 位置的加減分：分數一樣高的候選，挑離預期位置近的 */
  const nearBonus = (mid, exp, from, to) => (exp == null ? 0 : -0.06 * Math.min(1, Math.abs(mid - exp) / Math.max(20, to - from)));

  function matchCjk(q, text, from, to, exp) {
    const Q = units(q), T = units(text).filter((u) => u.i >= from && u.j <= to);
    if (!Q.length || !T.length) return null;
    const m = Q.length;
    const need = new Map();
    Q.forEach((u) => need.set(u.t, (need.get(u.t) || 0) + 1));
    const bi = new Map();
    for (let k = 0; k + 1 < m; k++) { const g = Q[k].t + '|' + Q[k + 1].t; bi.set(g, (bi.get(g) || 0) + 1); }
    let best = null;
    for (let i = 0; i < T.length; i++) {
      if (!need.has(T[i].t)) continue;
      const cnt = new Map(), bcnt = new Map();
      let common = 0, bcommon = 0;
      for (let j = i; j < T.length && j - i < m * 2 + 2; j++) {
        const t = T[j].t;
        const c = (cnt.get(t) || 0) + 1;
        cnt.set(t, c);
        if (c <= (need.get(t) || 0)) common++;
        if (j > i) {
          const g = T[j - 1].t + '|' + t;
          const bc = (bcnt.get(g) || 0) + 1;
          bcnt.set(g, bc);
          if (bc <= (bi.get(g) || 0)) bcommon++;
        }
        if (!need.has(t)) continue;                   // 頭尾都要是對得上的字
        const len = j - i + 1;
        const score = 0.8 * fScore(common, m, len) + 0.2 * (m > 1 && len > 1 ? fScore(bcommon, m - 1, len - 1) : fScore(common, m, len));
        // 至少要對到六成的字：兩個字的詞只對到一個字（方案 ↔ 圖案）是碰巧，不算
        if (common < Math.ceil(m * 0.6)) continue;
        const adj = score + nearBonus((T[i].i + T[j].j) / 2, exp, from, to);
        if (!best || adj > best.adj + 1e-9 ||
            (Math.abs(adj - best.adj) < 1e-9 && Math.abs(len - m) < Math.abs(best.len - m))) {
          best = { score, adj, i, j, len };
        }
      }
    }
    if (!best || best.score < 0.5) return null;
    // 只對到一部分（「元表面」對到「表面」）：照沒對到的字數往前後補（→「超表面」）
    const [qi0, qi1] = matchedSpan(Q, T.slice(best.i, best.j + 1));
    let i = best.i, j = best.j;
    // 補的必須是緊鄰的中文字（中間沒有空白或標點）
    const glued = (x, y) => x >= 0 && y < T.length && /\p{Script=Han}/u.test(T[x < i || x > j ? x : y].t)
      && /^[^\s\p{P}]*$/u.test(text.slice(T[x].j, T[y].i));
    // 最多補到跟選的字一樣長（補過頭會把旁邊不相干的字也標進去）
    for (let n = 0; n < qi0 && glued(i - 1, i) && j - i + 1 < m; n++) i--;
    for (let n = 0; n < m - 1 - qi1 && glued(j, j + 1) && j - i + 1 < m; n++) j++;
    return { r: snapWords(text, [T[i].i, T[j].j]), score: best.score };
  }

  /** 視窗裡對到的字，對應到查詢字串的第幾個字到第幾個字 */
  function matchedSpan(Q, W, same) {
    const eq = same || ((x, y) => x === y);
    const used = new Array(Q.length).fill(false);
    let lo = Infinity, hi = -1;
    for (const w of W) {
      const k = Q.findIndex((q, x) => !used[x] && eq(q.t, w.t));
      if (k >= 0) { used[k] = true; lo = Math.min(lo, k); hi = Math.max(hi, k); }
    }
    return hi < 0 ? [0, Q.length - 1] : [lo, hi];
  }

  /** 對到多少（召回）比多標幾個字（精確）重要：F-score，β = 1.5 */
  function fScore(common, want, got) {
    if (!common) return 0;
    const P = common / got, R = common / want, b2 = 2.25;
    return (1 + b2) * P * R / (b2 * P + R);
  }

  /** 對齊到詞的邊界：「射光波導」→「繞射光波導」（只補短詞，不會一路擴到整句） */
  function snapWords(text, r) {
    if (!SEG) return r;
    let [a, z] = r;
    const lo = Math.max(0, a - 6), hi = Math.min(text.length, z + 6);
    for (const sg of SEG.segment(text.slice(lo, hi))) {
      const s0 = lo + sg.index, s1 = s0 + sg.segment.length;
      if (!sg.isWordLike || sg.segment.length > 4) continue;
      if (s0 < a && s1 > a) a = s0;
      if (s0 < z && s1 > z) z = s1;
    }
    return [a, z];
  }

  /* ---- 翻譯後比對：英文以單字為單位 ---- */

  const STOP = new Set(('a an the of to in on for and or with by as at from is are was were be been being this that these ' +
    'those its it their our we which into via than such can may also has have had not but so if then there here when where while ' +
    'do does did will would could should about over under between through during within without due order because since ' +
    'both each any all no up out off very some own same just still even').split(' '));
  const stem = (w) => w.toLowerCase().replace(/(ies|es|s|ed|ing|ly)$/, '').replace(/(e)$/, '');
  function sameWord(x, y) {
    if (x === y) return true;
    const a = stem(x), b = stem(y);
    if (a === b) return true;
    const n = Math.min(a.length, b.length);
    if (n < 4) return false;
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    if (k >= 5 && k >= n * 0.7) return true;          // diffraction ↔ diffractive
    return n >= 5 && (a.includes(b) || b.includes(a)); // wavelength ↔ subwavelength
  }

  function matchEn(q, text, from, to, exp) {
    const qw = (q.match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g) || []).map((w) => w.toLowerCase());
    const need = qw.filter((w) => !STOP.has(w));
    // 只有 in、on、for 這類虛詞：到處都是，對到哪一個都不可靠 → 不對字，交給整句標示
    if (!need.length) return null;
    const re = /[A-Za-z0-9][A-Za-z0-9'\-]*/g;
    const T = [];
    let m;
    while ((m = re.exec(text))) {
      if (m.index >= from && m.index + m[0].length <= to) T.push({ t: m[0].toLowerCase(), i: m.index, j: m.index + m[0].length });
    }
    const hit = (t) => need.some((w) => sameWord(w, t));
    let best = null;
    for (let i = 0; i < T.length; i++) {
      if (!hit(T[i].t)) continue;
      for (let j = i; j < T.length && j - i < need.length * 2 + 3; j++) {
        if (!hit(T[j].t)) continue;
        const used = new Array(need.length).fill(false);
        let common = 0, content = 0;
        for (let k = i; k <= j; k++) {
          // 虛詞不能拿來對字，但夾在中間會讓標出來的範圍變長：算半個
          if (STOP.has(T[k].t)) { content += 0.5; continue; }
          content++;
          const u = need.findIndex((w, x) => !used[x] && sameWord(w, T[k].t));
          if (u >= 0) { used[u] = true; common++; }
        }
        const score = fScore(common, need.length, Math.max(1, content));
        const adj = score + nearBonus((T[i].i + T[j].j) / 2, exp, from, to);
        if (!best || adj > best.adj + 1e-9) best = { score, adj, i, j };
      }
    }
    if (!best || best.score < 0.5) return null;
    // 只對到一部分（thinnest geometry → geometry）：照沒對到的字數往前後補（→ slimmest geometry）
    const Qc = need.map((t) => ({ t }));
    const [qi0, qi1] = matchedSpan(Qc, T.slice(best.i, best.j + 1).filter((w) => !STOP.has(w.t)), sameWord);
    let i = best.i, j = best.j;
    const joined = (x, y) => /^[\s\-]*$/.test(text.slice(T[x].j, T[y].i));     // 中間沒有標點才補
    for (let n = 0; n < qi0 && i > 0 && T[i - 1].i >= from && !STOP.has(T[i - 1].t) && joined(i - 1, i); n++) i--;
    for (let n = 0; n < need.length - 1 - qi1 && j + 1 < T.length && !STOP.has(T[j + 1].t) && joined(j, j + 1); n++) j++;
    return { r: [T[i].i, T[j].j], score: best.score };
  }

  /* ---- 把選的字翻成另一邊的語言（結果記在記憶體） ----
     先用翻這一段的同一個引擎（用詞才會跟譯文一致），不行再換 Google／微軟。 */

  const phraseCache = new Map();
  function phraseTranslate(text, from, to, prefer) {
    const key = from + '>' + to + ':' + text;
    if (phraseCache.has(key)) return phraseCache.get(key);
    const forward = !/^(zh|ja|ko)/i.test(from);
    const order = [];
    [prefer, 'google', 'edge'].forEach((e) => { if (e && !order.includes(e)) order.push(e); });
    const p = (async () => {
      for (const engine of order) {
        try {
          let t;
          if (engine === 'chrome') {
            // Chrome 內建翻譯只裝了「原文 → 譯文」這個方向
            if (!forward || !globalThis.PLTranslate) continue;
            t = (await PLTranslate.translateWith('chrome', [text]))[0];
          } else {
            if (engine === 'gemini' && !(PL.settings && PL.settings.geminiApiKey)) continue;
            const res = await PL.send({ type: 'translate.remote', engine, texts: [text], sourceLang: from, targetLang: to });
            t = res && res.result && res.result[0];
          }
          if (t && String(t).trim()) return String(t).trim();
        } catch (e) { /* 換下一個引擎 */ }
      }
      return null;
    })();
    phraseCache.set(key, p);
    p.then((v) => { if (v == null) phraseCache.delete(key); });
    if (phraseCache.size > 300) phraseCache.delete(phraseCache.keys().next().value);
    return p;
  }

  /** 整句一起翻、選的字用【】框起來，看框起來的地方翻成什麼（連前後文一起翻，用詞最接近譯文） */
  const MARK_RE = /【\s*([^【】]+?)\s*】/;
  const MARK_ALT = /[\[「〔『]\s*([^\[\]「」〔〕『』]+?)\s*[\]」〕』]/g;
  /** 記號被翻譯引擎換成別種括號時：排除引用編號 [12]，剩下剛好一個才算數 */
  function markedPart(out) {
    const m = out.match(MARK_RE);
    if (m) return m[1].trim();
    const alt = [];
    let x;
    MARK_ALT.lastIndex = 0;
    while ((x = MARK_ALT.exec(out))) if (!/^[\d\s,，–-]+$/.test(x[1])) alt.push(x[1].trim());
    return alt.length === 1 ? alt[0] : null;
  }
  async function markedTranslate(c) {
    let sen = c.selSentence, a = c.rel[0], z = c.rel[1];
    if (!sen || z <= a) return null;
    // 句子很長：只取選取處前後的幾個子句（前後文夠用就好，太長反而容易翻走樣）
    // （中文一個字的資訊量大約是英文的三倍，門檻也跟著不同）
    const [trig, near, far] = c.selCjk ? [100, 22, 70] : [320, 60, 180];
    if (sen.length > trig) {
      const CL = /[，、；：,;:]/;
      let lo = a, hi = z;
      while (lo > 0 && (a - lo < near || !CL.test(sen[lo - 1])) && a - lo < far) lo--;
      while (hi < sen.length && (hi - z < near || !CL.test(sen[hi])) && hi - z < far) hi++;
      sen = sen.slice(lo, hi);
      a -= lo; z -= lo;
    }
    const marked = sen.slice(0, a) + '【' + sen.slice(a, z).trim() + '】' + sen.slice(z);
    const out = await phraseTranslate(marked, c.from, c.to, c.engine);
    return out ? markedPart(out) : null;
  }

  /** 一個段落裡選了 [s, e)（selected 那一邊的文字位置）→ 另一邊對應的句子，以及找字需要的資料 */
  function counterpart(b, side, s, e) {
    if (!b || b.state !== 'done') return null;
    const selEl = side === 'left' ? b.left : b.right;
    if (!selEl) return null;
    const U = unitOfBlock(b);
    if (!U.src.trim() || !U.tgt.trim()) return null;
    const seg = U.segs.find((x) => x.b === b);

    // 選取的位置 → 單位裡的位置
    let us, ue;
    if (side === 'left') {
      const m = leftMap(b);
      const leftTxt = selEl.textContent;
      // 起點對到「第一個被選到的字」，終點對到「最後一個被選到的字的後面」（不然會多亮下一句）
      const ss = m ? m.a2b[Math.min(s, leftTxt.length)] : s;
      const se = Math.max(ss + 1, m ? endOf(m.a2b, leftTxt, e) : e);
      us = seg.s0 + ss; ue = seg.s0 + se;
    } else {
      us = seg.t0 + s; ue = seg.t0 + e;
    }
    const left = side === 'left';
    const selText = left ? U.src : U.tgt, othText = left ? U.tgt : U.src;
    const X = left ? U.A : U.B, Y = left ? U.B : U.A, link = left ? U.link.a2b : U.link.b2a;
    const [i0, i1] = spanIdx(X, us, ue);
    const j0 = Math.min(link[i0][0], link[i1][0]), j1 = Math.max(link[i0][1], link[i1][1]);
    const sent = trimWs(othText, [Y[j0][0], Y[j1][1]]);
    const selSent = trimWs(selText, [X[i0][0], X[i1][1]]);
    const rel = ((us + ue) / 2 - selSent[0]) / Math.max(1, selSent[1] - selSent[0]);

    const tgtLang = (PL.settings && PL.settings.targetLang) || 'zh-Hant';
    const srcLang = (globalThis.PLTranslate && PLTranslate.sourceLang && PLTranslate.sourceLang !== 'auto')
      ? PLTranslate.sourceLang : 'en';
    return {
      U, side, other: left ? 'right' : 'left',
      text: othText, sent, sentIdx: [j0, j1], spans: Y, cjk: left ? U.tgtCjk : U.srcCjk,
      exp: sent[0] + Math.max(0, Math.min(1, rel)) * (sent[1] - sent[0]),      // 預期出現在句子的哪裡
      selSent, selCjk: left ? U.srcCjk : U.tgtCjk,
      phrase: selText.slice(us, ue),
      ratio: nonWsLen(selText.slice(us, ue)) / Math.max(1, nonWsLen(selText.slice(selSent[0], selSent[1]))),
      selSentence: selText.slice(selSent[0], selSent[1]), rel: [us - selSent[0], ue - selSent[0]],
      single: i0 === i1, from: left ? srcLang : tgtLang, to: left ? tgtLang : srcLang, engine: b.engine
    };
  }

  /** c.text 上的 [a, z) → 頁面上的 Range（跨到另一塊時會有好幾個） */
  const elRanges = (c, a, z) => unitRanges(c.U, c.other, a, z);
  const elRange = (c, a, z) => elRanges(c, a, z)[0] || null;
  const selSentRanges = (c) => unitRanges(c.U, c.side, c.selSent[0], c.selSent[1]);

  /**
   * 在對應的句子裡找字。找不到時只再看前後各一句（句子配對偶爾會差一句），而且要很像才算。
   * 不到更遠的地方找：同一個詞在整段常常出現好幾次，找到別句去就是「對應跑掉」。
   */
  function locateIn(c, finder) {
    let f = finder(c.sent[0], c.sent[1], c.exp);
    let sent = c.sent;
    if (!f) {
      for (const k of [c.sentIdx[0] - 1, c.sentIdx[1] + 1]) {
        if (k < 0 || k >= c.spans.length) continue;
        const sp = trimWs(c.text, c.spans[k]);
        const g = finder(sp[0], sp[1], null);
        if (g && g.score >= 0.85 && (!f || g.score > f.score)) { f = g; sent = sp; }
      }
    }
    return f ? { r: f.r, score: f.score, sent } : null;
  }

  const literalHit = (phrase, text, a, z, exp) => {
    const r = findLiteral(phrase, text, a, z, exp);
    return r ? { r, score: 1 } : null;
  };

  let syncTok = 0;

  function clearSync() {
    syncTok++;
    if (!CAN_SYNC) return;
    CSS.highlights.delete('pl-sync');
    CSS.highlights.delete('pl-sync-ctx');
  }

  function paintSync(strong, ctx) {
    strong = [].concat(...strong).filter(Boolean);
    ctx = [].concat(...ctx).filter(Boolean);
    if (strong.length) CSS.highlights.set('pl-sync', new Highlight(...strong)); else CSS.highlights.delete('pl-sync');
    if (ctx.length) CSS.highlights.set('pl-sync-ctx', new Highlight(...ctx)); else CSS.highlights.delete('pl-sync-ctx');
  }

  function scrollToRange(info, range) {
    // 對應的地方不在畫面上（例如關掉了同步捲動）：把另一欄捲過去
    const pane = info.side === 'left' ? PL.els.right : PL.els.left;
    const rr = range && range.getBoundingClientRect();
    if (!pane || !rr || !rr.height) return;
    const pr = pane.getBoundingClientRect();
    if (rr.bottom < pr.top + 10 || rr.top > pr.bottom - 10) {
      pane.scrollBy({ top: rr.top - pr.top - pane.clientHeight / 3, behavior: 'smooth' });
    }
  }

  function collectHits(info) {
    const range = info.full;
    const hits = [];
    if (!range) return hits;
    for (const i of (info.blocks && info.blocks.length ? info.blocks : [info.block])) {
      const b = PL.blocks[i];
      const el = b && (info.side === 'left' ? b.left : b.right);
      if (!el) continue;
      const s = el.contains(range.startContainer) ? charIndex(el, range.startContainer, range.startOffset) : 0;
      const e = el.contains(range.endContainer) ? charIndex(el, range.endContainer, range.endOffset) : el.textContent.length;
      if (e <= s) continue;
      const c = counterpart(b, info.side, s, e);
      if (c) hits.push(c);
    }
    return hits;
  }

  const isWordMode = (hits) => {
    const c = hits[0];
    return hits.length === 1 && c.single && c.ratio < 0.75 && nonWsLen(c.phrase) <= 80 && /[\p{L}\p{N}]/u.test(c.phrase);
  };

  function syncSelection(info) {
    if (!CAN_SYNC || !info || !info.full) return;
    const tok = ++syncTok;
    const hits = collectHits(info);
    if (!hits.length) { clearSync(); return; }

    const sentRanges = (c, sent) => elRanges(c, sent[0], sent[1]);

    const c = hits[0];
    if (!isWordMode(hits)) {
      const strong = hits.map((h) => sentRanges(h, h.sent));
      paintSync(strong, []);
      scrollToRange(info, [].concat(...strong)[0]);
      return;
    }

    // 1) 原樣出現的字（數字、縮寫、術語）→ 馬上標
    const lit = locateIn(c, (a, z, exp) => literalHit(c.phrase, c.text, a, z, exp));
    if (lit) {
      const r = elRanges(c, lit.r[0], lit.r[1]);
      paintSync([r], [sentRanges(c, lit.sent), selSentRanges(c)]);
      scrollToRange(info, r[0]);
      return;
    }

    // 2) 先淡淡標出整句，等選的字翻好再找出對應的那幾個字
    const sr = sentRanges(c, c.sent);
    paintSync([], [sr, selSentRanges(c)]);
    scrollToRange(info, sr[0]);
    alignPhrase(c).then((found) => {
      if (tok !== syncTok) return;                    // 選取已經換了
      if (found) {
        const r = elRanges(c, found.r[0], found.r[1]);
        paintSync([r], [sentRanges(c, found.sent), selSentRanges(c)]);
        if (found.sent !== c.sent) scrollToRange(info, r[0]);
      } else {
        paintSync([sr], [selSentRanges(c)]);              // 找不到對應的字：整句標黃
      }
    }, () => { if (tok === syncTok) paintSync([sr], [selSentRanges(c)]); });
  }

  /* ---- 逐字對照（最後一招）----
     選的字直接翻過去對不到（同義詞：譯文寫「實現」，單獨翻 achieved 卻是「達成」）：
     反過來，把對應句子裡的每個詞各自翻成選取那邊的語言，看哪一個詞的意思跟選的字最像。
     一句話只問一次，結果記在記憶體。 */

  const glossCache = new Map();
  async function glossWords(words, from, to, prefer) {
    const key = (w) => from + '>' + to + ':' + w;
    const missing = words.filter((w) => !glossCache.has(key(w)));
    if (missing.length) {
      const order = [];
      [prefer, 'google', 'edge'].forEach((e) => { if (e && e !== 'chrome' && !order.includes(e)) order.push(e); });
      for (const engine of order) {
        if (engine === 'gemini' && !(PL.settings && PL.settings.geminiApiKey)) continue;
        try {
          const res = await PL.send({ type: 'translate.remote', engine, texts: missing, sourceLang: from, targetLang: to });
          if (!res || !res.result) continue;
          missing.forEach((w, k) => glossCache.set(key(w), String(res.result[k] || '')));
          break;
        } catch (e) { /* 換下一個引擎 */ }
      }
      if (glossCache.size > 3000) glossCache.clear();
    }
    return words.map((w) => glossCache.get(key(w)) || '');
  }

  async function glossMatch(c, phrase) {
    const [a, z] = c.sent;
    const cands = [];
    if (c.cjk) {
      if (!SEG) return null;
      for (const sg of SEG.segment(c.text.slice(a, z))) {
        if (sg.isWordLike && /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(sg.segment)) {
          cands.push({ t: sg.segment, i: a + sg.index, j: a + sg.index + sg.segment.length });
        }
      }
    } else {
      const re = /[A-Za-z][A-Za-z'\-]{2,}/g;
      let m;
      const part = c.text.slice(a, z);
      while ((m = re.exec(part))) if (!STOP.has(m[0].toLowerCase())) cands.push({ t: m[0], i: a + m.index, j: a + m.index + m[0].length });
    }
    if (!cands.length) return null;
    // 句子很長：只看預期位置附近的詞
    if (cands.length > 45) {
      const near = cands.slice().sort((x, y) => Math.abs((x.i + x.j) / 2 - c.exp) - Math.abs((y.i + y.j) / 2 - c.exp)).slice(0, 45);
      const keep = new Set(near);
      for (let k = cands.length - 1; k >= 0; k--) if (!keep.has(cands[k])) cands.splice(k, 1);
    }
    const uniq = [...new Set(cands.map((x) => x.t.toLowerCase()))];
    const gl = await glossWords(uniq, c.to, c.from, c.engine);
    const glossOf = new Map(uniq.map((w, k) => [w, gl[k]]));

    let scoreOf;
    if (c.selCjk) {
      const P = units(phrase).map((u) => u.t);
      if (!P.length) return null;
      scoreOf = (g) => {
        const G = units(g).map((u) => u.t);
        if (!G.length) return 0;
        const left = P.slice();
        let common = 0;
        for (const t of G) { const k = left.indexOf(t); if (k >= 0) { left.splice(k, 1); common++; } }
        return fScore(common, P.length, G.length);
      };
    } else {
      const P = (phrase.match(/[A-Za-z][A-Za-z'\-]*/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w));
      if (!P.length) return null;
      scoreOf = (g) => {
        const G = (g.match(/[A-Za-z][A-Za-z'\-]*/g) || []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w));
        if (!G.length) return 0;
        const common = P.filter((w) => G.some((x) => sameWord(w, x))).length;
        return fScore(common, P.length, G.length);
      };
    }
    let best = null;
    cands.forEach((x, k) => {
      x.score = scoreOf(glossOf.get(x.t.toLowerCase()) || '');
      const adj = x.score + nearBonus((x.i + x.j) / 2, c.exp, a, z);
      if (x.score >= 0.6 && (!best || adj > best.adj)) best = { adj, k };
    });
    if (!best) return null;
    // 旁邊緊鄰的詞也對得上就一起標（「光束 轉向」）
    let i = best.k, j = best.k;
    const tight = (x, y) => /^[\s\-]*$/.test(c.text.slice(cands[x].j, cands[y].i));
    while (i > 0 && cands[i - 1].score >= 0.6 && tight(i - 1, i)) i--;
    while (j + 1 < cands.length && cands[j + 1].score >= 0.6 && tight(j, j + 1)) j++;
    return { r: [cands[i].i, cands[j].j], score: 0.9 * cands[best.k].score, sent: c.sent };
  }

  /** 選的字 → 另一邊句子裡對應的位置。短的字先單獨翻；長一點的片語連整句一起翻比較準 */
  async function alignPhrase(c) {
    const phrase = c.phrase.replace(/\s+/g, ' ').trim();
    // 選的只有 the、of、in 這類虛詞：沒有可靠的對應，整句標示就好
    if (!c.selCjk) {
      const w = (phrase.match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g) || []).map((x) => x.toLowerCase());
      if (w.length && w.every((x) => STOP.has(x))) return null;
    }
    const onlyStop = (q) => { const w = (q.match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g) || []); return w.length > 0 && w.every((x) => STOP.has(x.toLowerCase())); };
    const find = (q) => q && !(!c.cjk && onlyStop(q)) && locateIn(c, (a, z, exp) => literalHit(q, c.text, a, z, exp)
      || (c.cjk ? matchCjk(q, c.text, a, z, exp) : matchEn(q, c.text, a, z, exp)));
    const short = c.cjk ? phrase.split(' ').length <= 2 : nonWsLen(phrase) <= 6;
    const tries = short
      ? [() => phraseTranslate(phrase, c.from, c.to, c.engine), () => markedTranslate(c)]
      : [() => markedTranslate(c), () => phraseTranslate(phrase, c.from, c.to, c.engine)];
    // 第一個結果夠像就用；不夠像再試另一種翻法，取比較像的那個
    let best = null;
    for (const t of tries) {
      let q = null;
      try { q = await t(); } catch (e) { /* ignore */ }
      const f = find(q);
      if (f && (!best || f.score > best.score)) best = f;
      if (best && best.score >= 0.85) break;
    }
    if ((!best || best.score < 0.7) && nonWsLen(phrase) <= 40) {
      let g = null;
      try { g = await glossMatch(c, phrase); } catch (e) { /* ignore */ }
      if (g && (!best || g.score > best.score)) best = g;
    }
    return best;
  }

  // 測試用
  PL._sync = { findLiteral, matchCjk, matchEn, snapWords, sentenceSpans, alignMap, markedPart, counterpart, elRange, alignSentences, phraseTranslate, markedTranslate, alignPhrase, glossMatch };

  /* ══════════ 翻譯選取的文字 ══════════ */

  let qt = null, qtState = null;

  function engineLabel(k) {
    if (k === 'cache') return '快取';
    if (k === 'same') return '不需翻譯';
    return ((globalThis.PL_ENGINE_LABEL && globalThis.PL_ENGINE_LABEL[k]) || k || '').split('（')[0];
  }

  function qtPopup() {
    if (qt) return qt;
    qt = PL.el('div', { id: 'pl-qt', 'data-pl-ui': '1' });
    qt.innerHTML = ''
      + '<header><b class="pl-qt-title">🌐 翻譯選取的文字</b><span class="pl-spacer"></span>'
      + '<button class="pl-x" data-act="close" title="關閉（Esc）">✕</button></header>'
      + '<div class="pl-qt-src"></div>'
      + '<div class="pl-qt-out"></div>'
      + '<div class="pl-qt-meta"></div>'
      + '<div class="pl-row">'
      + '<button data-act="copy">⧉ 複製譯文</button>'
      + '<button data-act="note">✎ 存成心得</button>'
      + '<select class="pl-qt-eng" title="換一個引擎再翻一次"></select>'
      + '</div>';
    document.documentElement.appendChild(qt);

    qt.addEventListener('mousedown', (e) => e.stopPropagation());
    qt.addEventListener('click', async (e) => {
      const a = e.target.closest && e.target.closest('[data-act]');
      if (!a || !qtState) return;
      const act = a.getAttribute('data-act');
      if (act === 'close') closeQt();
      else if (act === 'copy') {
        const orig = qtState.kind === 'orig';
        try { await navigator.clipboard.writeText(qtState.out || ''); PL.toast(orig ? '已複製原文' : '已複製譯文'); }
        catch (err) { PL.toast('複製失敗'); }
      } else if (act === 'note') {
        if (!qtState.out) return;
        try {
          const ann = createAnnotation(qtState.info, PL.settings.defaultHighlight);
          const orig = qtState.kind === 'orig';
          updateAnnotation(ann, { note: (orig ? '【原文】' : '【譯文】') + qtState.out });
          PL.toast(orig ? '已標記並把原文存成心得' : '已標記並把譯文存成心得');
          closeQt();
        } catch (err) {
          PL.toast('這段選取已經變動，請重新選取後再存');
        }
      }
    });
    qt.querySelector('.pl-qt-eng').addEventListener('change', (e) => {
      const eng = e.target.value;
      e.target.value = '';
      if (eng && qtState) runQt(eng);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQt(); }, true);
    document.addEventListener('mousedown', (e) => {
      if (qt.classList.contains('pl-show') && !qt.contains(e.target)) closeQt();
    }, true);
    return qt;
  }

  function closeQt() { if (qt) qt.classList.remove('pl-show'); qtState = null; }

  async function runQt(engine) {
    const st = qtState;
    const out = qt.querySelector('.pl-qt-out'), meta = qt.querySelector('.pl-qt-meta');
    out.textContent = '翻譯中…';
    out.classList.add('pl-wait');
    meta.textContent = '';
    st.out = '';
    const T = globalThis.PLTranslate;
    const t0 = performance.now();
    try {
      await T.ensureSourceLang(st.src);
      let t, eng;
      if (engine) {
        t = (await T.translateWith(engine, [st.src]))[0];
        eng = engine;
      } else {
        const r = await T.translateCached([st.src]);
        t = r[0];
        eng = r.engines ? r.engines[0] : T.lastEngine;
      }
      if (qtState !== st) return;           // 已經關掉或換了別段
      if (t == null || !String(t).trim()) throw new Error('翻譯引擎沒有回傳結果，可以從下面換一個引擎再試');
      st.out = String(t);
      out.textContent = st.out;
      meta.textContent = engineLabel(eng) + ' · ' + Math.round(performance.now() - t0) + ' ms';
    } catch (e) {
      if (qtState !== st) return;
      out.textContent = '⚠ ' + (e.message || e);
    }
    out.classList.remove('pl-wait');
  }

  /* ══════════ 顯示原文（選了譯文 → 對應的原文句子，對得到字的話把那幾個字標出來） ══════════ */

  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  async function showOriginal(info) {
    const hits = collectHits(Object.assign({}, info, { side: 'right' }));
    let text = '';
    if (hits.length) {
      text = hits.map((h) => clean(h.text.slice(h.sent[0], h.sent[1]))).join(' ');
    } else {
      // 段落還沒翻完之類：退回整段原文
      const b = PL.blocks[info.block];
      text = clean(b && (b.srcText || (b.left && b.left.textContent)));
    }
    if (!text) { PL.toast('找不到這段的原文'); return; }

    const p = qtPopup();
    qtState = { info, src: clean(info.fullText || info.text), out: text, kind: 'orig' };
    const st = qtState;
    setQtMode('orig');
    p.querySelector('.pl-qt-src').textContent = st.src.length > 300 ? st.src.slice(0, 300) + '…' : st.src;
    const out = p.querySelector('.pl-qt-out'), meta = p.querySelector('.pl-qt-meta');
    out.textContent = text;
    meta.textContent = hits.length ? '對應的原文句子' : '這一段的原文';
    placeQt(p, info);

    if (!hits.length || !isWordMode(hits)) return;
    const c = hits[0];
    let found = locateIn(c, (a, z, exp) => literalHit(c.phrase, c.text, a, z, exp));
    if (!found) {
      meta.textContent = '對應的原文句子 · 正在找對應的字…';
      try { found = await alignPhrase(c); } catch (e) { found = null; }
    }
    if (qtState !== st) return;
    if (!found) { meta.textContent = '對應的原文句子'; return; }
    // 把那一句重寫成「前面 + <mark>對應的字</mark> + 後面」
    const sen = c.text.slice(found.sent[0], found.sent[1]);
    const a = found.r[0] - found.sent[0], z = found.r[1] - found.sent[0];
    out.textContent = '';
    out.append(clean(sen.slice(0, a)) + (a > 0 && /\s/.test(sen[a - 1]) ? ' ' : ''),
      PL.el('mark', { text: clean(sen.slice(a, z)) }),
      (/\s/.test(sen[z] || '') ? ' ' : '') + clean(sen.slice(z)));
    st.out = clean(sen);
    st.word = clean(sen.slice(a, z));
    meta.textContent = '「' + clean(st.src).slice(0, 40) + '」對應的原文：' + st.word;
  }
  PL.showOriginal = showOriginal;

  function setQtMode(kind) {
    const p = qtPopup();
    const orig = kind === 'orig';
    p.querySelector('.pl-qt-title').textContent = orig ? '📄 對應的原文' : '🌐 翻譯選取的文字';
    p.querySelector('[data-act="copy"]').textContent = orig ? '⧉ 複製原文' : '⧉ 複製譯文';
    p.querySelector('.pl-qt-eng').style.display = orig ? 'none' : '';
    p.classList.toggle('pl-qt-orig', orig);
  }

  function placeQt(p, info) {
    p.classList.add('pl-show');
    const r = info.rect || { left: window.innerWidth / 2 - 200, bottom: 120, top: 120 };
    const w = Math.min(460, window.innerWidth - 20);
    p.style.width = w + 'px';
    p.style.left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left)) + 'px';
    const h = p.offsetHeight || 220;
    let y = r.bottom + 10;
    if (y + h > window.innerHeight - 10) y = Math.max(50, r.top - h - 10);
    p.style.top = y + 'px';
  }

  /** info 來自 describeSelection()；沒有段落的一般網頁選取也可以（只有 text） */
  function quickTranslate(info) {
    const src = (info.fullText || info.text || '').trim();
    if (!src) { PL.toast('請先選取要翻譯的文字'); return; }
    // 只選了一個字或短詞：在側邊查字典就好，不用連整段一起翻
    if (PL.active && PL.Lookup && PL.Lookup.isShort(src) && PL.lookupInSide(src)) return;
    const p = qtPopup();
    qtState = { info, src, out: '' };
    setQtMode('tr');
    p.querySelector('.pl-qt-src').textContent = src.length > 600 ? src.slice(0, 600) + '…' : src;
    p.querySelector('[data-act="note"]').style.display = info.range ? '' : 'none';

    const sel = p.querySelector('.pl-qt-eng');
    sel.textContent = '';
    sel.appendChild(PL.el('option', { value: '', text: '換引擎再翻…' }));
    const engines = globalThis.PLDesktop ? ['google', 'edge', 'gemini'] : ['chrome', 'edge', 'google', 'gemini'];
    engines.filter((e) => e !== 'gemini' || (PL.settings && PL.settings.geminiApiKey))
      .forEach((e) => sel.appendChild(PL.el('option', { value: e, text: engineLabel(e) })));

    placeQt(p, info);

    runQt(null);
    // 選到的這幾段在右欄也一起翻好（例如關掉了「自動翻譯」、只想翻自己選的段落時）
    if (info.blocks && info.blocks.length && PL.translateBlocks) PL.translateBlocks(info.blocks);
  }

  /** 快捷鍵／右鍵選單用：翻譯目前選取的文字 */
  PL.translateSelection = function () {
    const info = describeSelection();
    if (info) { hideSelBar(); quickTranslate(info); return; }
    const sel = document.getSelection();
    const text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (!text) { PL.toast('請先選取要翻譯的文字'); return; }
    const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    quickTranslate({ text, rect });
  };

  /* ══════════ 側欄 ══════════ */

  function sidebar() {
    if (PL.els.side) return PL.els.side;
    const el = PL.el('div', { id: 'pl-side', 'data-pl-ui': '1' });

    // 兩個分頁：側邊翻譯（查字）／我的註解
    const head = PL.el('header');
    const tabs = PL.el('div', { class: 'pl-tabs' });
    const tTr = PL.el('button', { class: 'pl-tab', 'data-tab': 'tr', text: '🔤 查字', title: '查字・翻譯：查單字、翻一句話，不會動到文章' });
    const tAi = PL.el('button', { class: 'pl-tab', 'data-tab': 'ai', text: '💬 問 AI', title: '針對選取的段落向 AI（Gemini）提問' });
    const tNotes = PL.el('button', { class: 'pl-tab', 'data-tab': 'notes', text: '📝 註解', title: '我的註解' });
    tabs.append(tTr, tAi, tNotes);
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-tab]');
      if (b) setSideTab(b.getAttribute('data-tab'));
    });
    head.appendChild(tabs);
    head.appendChild(PL.el('span', { class: 'pl-spacer' }));

    const bExport = PL.el('button', { class: 'pl-side-export', text: '匯出', title: '把本頁註解存成 JSON' });
    bExport.addEventListener('click', exportJson);
    head.appendChild(bExport);

    const bClose = PL.el('button', { text: '✕', title: '關閉側欄' });
    bClose.addEventListener('click', () => PL.toggleSidebar(false));
    head.appendChild(bClose);

    const list = PL.el('div', { class: 'pl-list' });
    const trPane = PL.el('div', { class: 'pl-trpane' });
    const aiPane = PL.el('div', { class: 'pl-aipane' });

    // 左緣的寬度把手
    const grip = PL.el('div', { id: 'pl-side-grip', title: '拖曳調整註解欄寬度' });
    let dragging = false;
    grip.addEventListener('mousedown', (e) => {
      dragging = true;
      grip.classList.add('pl-dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(220, Math.min(680, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--pl-side-w', w + 'px');
    }, true);
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove('pl-dragging');
      document.body.style.userSelect = '';
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--pl-side-w'), 10);
      if (w) globalThis.PL_saveSettings({ sidebarWidth: w });
      if (PL.Sync) PL.Sync.markDirty();
      if (PL.Overlay) PL.Overlay.reproject();
    }, true);

    el.append(grip, head, list, trPane, aiPane);
    document.documentElement.appendChild(el);
    if (PL.settings && PL.settings.sidebarWidth) {
      document.documentElement.style.setProperty('--pl-side-w', PL.settings.sidebarWidth + 'px');
    }
    PL.els.side = el;
    PL.els.sideList = list;
    PL.els.sideTr = trPane;
    if (PL.Lookup) PL.Lookup.mount(trPane);
    if (PL.AskAI) PL.AskAI.mount(aiPane);
    setSideTab((PL.settings && PL.settings.sideTab) || 'notes');
    return el;
  }

  let sideTab = 'notes';
  PL.sideTab = () => (document.documentElement.classList.contains('pl-side-open') ? sideTab : null);

  function setSideTab(tab) {
    if ((tab === 'tr' && !PL.Lookup) || (tab === 'ai' && !PL.AskAI) || !/^(tr|ai|notes)$/.test(tab)) tab = 'notes';
    sideTab = tab;
    const el = PL.els.side;
    if (!el) return;
    el.setAttribute('data-tab', tab);
    el.querySelectorAll('.pl-tab').forEach((b) => b.classList.toggle('pl-cur', b.getAttribute('data-tab') === tab));
    if (tab === 'notes') renderSidebar();
    paintSideButtons();
    if (PL.settings && PL.settings.sideTab !== tab) {
      PL.settings.sideTab = tab;
      globalThis.PL_saveSettings({ sideTab: tab });
    }
  }

  function paintSideButtons() {
    const open = document.documentElement.classList.contains('pl-side-open');
    if (PL.els.sideBtn) PL.els.sideBtn.classList.toggle('pl-on', open && sideTab === 'notes');
    if (PL.els.lookupBtn) PL.els.lookupBtn.classList.toggle('pl-on', open && sideTab === 'tr');
    if (PL.els.askBtn) PL.els.askBtn.classList.toggle('pl-on', open && sideTab === 'ai');
  }

  const renderSidebarSoon = PL.debounce(() => renderSidebar(), 400);

  function renderSidebar() {
    if (!PL.els.sideList) return;
    const list = PL.els.sideList;
    list.textContent = '';

    const items = store.items.slice().sort((a, b) => (a.block - b.block) || (a.start - b.start));
    const notes = (PL.Overlay && PL.Overlay.notes) ? PL.Overlay.notes().filter((n) => (n.text || '').trim() || n.kind === 'sticky') : [];
    if (!items.length && !notes.length) {
      list.appendChild(PL.el('div', {
        class: 'pl-empty',
        text: '還沒有註解。\n在任一欄選取文字，就會跳出螢光筆與心得按鈕；\n或打開「標註」工具列，用「便利貼」在任何地方貼一張。'
      }));
      return;
    }

    // 便利貼、文字方塊也列在這裡，點一下就捲過去
    if (notes.length) {
      list.appendChild(PL.el('div', { class: 'pl-sec', text: '便利貼與文字（' + notes.length + '）' }));
      for (const n of notes) {
        const item = PL.el('div', { class: 'pl-item pl-note-item' });
        item.style.borderLeftColor = n.kind === 'sticky' ? '#d4a017' : (n.color || '#888');
        item.appendChild(PL.el('div', { class: 'pl-ex', text: (n.kind === 'sticky' ? '🗒 ' : '✎ ') + ((n.text || '').trim().slice(0, 160) || '（空白便利貼）') }));
        const where = /^p\d+$/.test(String(n.anchor)) ? '第 ' + String(n.anchor).slice(1) + ' 頁' : '第 ' + (Number(String(n.anchor).slice(1)) + 1) + ' 段';
        item.appendChild(PL.el('div', { class: 'pl-meta', text: (n.side === 'right' ? '譯文' : '原文') + ' · ' + where }));
        item.addEventListener('click', () => PL.Overlay.focus(n.id));
        list.appendChild(item);
      }
      if (items.length) list.appendChild(PL.el('div', { class: 'pl-sec', text: '螢光筆與心得（' + items.length + '）' }));
    }

    for (const ann of items) {
      const c = HL[ann.color] || HL.yellow;
      const item = PL.el('div', { class: 'pl-item', style: { '--pl-hl-line': c.line } });
      item.style.borderLeftColor = c.line;

      item.appendChild(PL.el('div', { class: 'pl-ex', text: ann.exact.slice(0, 160) }));
      if (ann.note) item.appendChild(PL.el('div', { class: 'pl-nt', text: '✎ ' + ann.note }));
      if (ann.ai) item.appendChild(PL.el('div', { class: 'pl-nt', text: '✨ ' + ann.ai.slice(0, 180) }));

      const meta = (ann.side === 'right' ? '譯文' : '原文') + ' · 第 ' + (ann.block + 1) + ' 段'
        + (ann.orphan ? ' · ⚠ 位置已變動' : '');
      item.appendChild(PL.el('div', { class: 'pl-meta', text: meta }));

      item.addEventListener('click', () => {
        PL.scrollToBlock(ann.block, ann.side);
        setTimeout(() => {
          const mk = document.querySelector('mark.pl-hl[data-pl-ann="' + CSS.escape(ann.id) + '"]');
          if (mk) {
            mk.classList.add('pl-hl-focus');
            setTimeout(() => mk.classList.remove('pl-hl-focus'), 1600);
          }
          openPopup(ann);
        }, 420);
      });

      list.appendChild(item);
    }
  }
  PL.renderSidebar = renderSidebar;

  /**
   * force：true 打開、false 關掉、不給就切換。
   * tab：'notes'（註解）或 'tr'（查字・翻譯）。側欄已經開著、但是另一個分頁 → 只換分頁，不會關掉
   */
  PL.toggleSidebar = function (force, tab) {
    sidebar();
    const root = document.documentElement;
    const open = root.classList.contains('pl-side-open');
    let next;
    if (force !== undefined) next = !!force;
    else if (tab && open && tab !== sideTab) next = true;
    else next = !open;
    if (tab) setSideTab(tab);
    root.classList.toggle('pl-side-open', next);
    paintSideButtons();
    if (next && sideTab === 'notes') renderSidebar();
    if (next && sideTab === 'tr' && PL.Lookup) PL.Lookup.focus();
    if (next && sideTab === 'ai' && PL.AskAI) PL.AskAI.focus();
    if (PL.Sync) PL.Sync.markDirty();
    if (PL.Overlay) PL.Overlay.reproject();
    if (open !== next) globalThis.PL_saveSettings({ showSidebar: next });
  };

  /** 問 AI：打開側欄的「問 AI」分頁，把選取的文字設成要問的段落 */
  PL.askAI = function (info) {
    if (!PL.AskAI) return false;
    PL.toggleSidebar(true, 'ai');
    if (info) PL.AskAI.setContext(info);
    return true;
  };

  /** 把選取的文字標起來，並把 text 存成它的心得（問 AI 的「存成心得」用） */
  PL.noteFromSelection = function (info, text) {
    try {
      const ann = createAnnotation(info, PL.settings.defaultHighlight);
      updateAnnotation(ann, { note: text });
      PL.toast('已標記並存成心得');
      return true;
    } catch (e) {
      PL.toast('這段選取已經變動，請重新選取後再存');
      return false;
    }
  };

  /** 側邊翻譯：打開「查字・翻譯」分頁並查這段文字 */
  PL.lookupInSide = function (text) {
    if (!PL.Lookup) return false;
    PL.toggleSidebar(true, 'tr');
    PL.Lookup.lookup(text);
    return true;
  };

  function exportJson() {
    const data = JSON.stringify({
      title: PL.pageTitle(), url: location.href, exportedAt: new Date().toISOString(), items: store.items
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = PL.el('a', { href: URL.createObjectURL(blob), download: 'paperlens-notes.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ══════════ 事件 ══════════ */

  PL.wireAnnotations = function () {
    document.addEventListener('mouseup', (e) => {
      if (!PL.active) return;
      if (e.target.closest && e.target.closest('[data-pl-ui]')) return;
      setTimeout(() => {
        const info = describeSelection();
        if (!info) { hideSelBar(); clearSync(); return; }
        pendingRange = info;
        showSelBar(info);
        syncSelection(info);
        // 側邊「查字・翻譯」開著：選了就在側欄查
        if (PL.Lookup && PL.Lookup.wantsSelection()) PL.Lookup.fromSelection(info.fullText || info.text);
        // 「問 AI」開著：改成問這一段
        if (PL.AskAI && PL.sideTab() === 'ai') PL.AskAI.fromSelection(info);
      }, 10);
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (!PL.active) return;
      const t = e.target;
      if (t.closest && t.closest('#pl-sel')) return;
      hideSelBar();
      if (!(t.closest && t.closest('[data-pl-ui]'))) clearSync();
      if (t.closest && (t.closest('#pl-pop') || t.closest('#pl-side'))) return;

      const mk = t.closest && t.closest('mark.pl-hl');
      if (mk) {
        const ann = store.items.find((a) => a.id === mk.getAttribute('data-pl-ann'));
        if (ann) { e.preventDefault(); openPopup(ann); return; }
      }
      closePopup();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!PL.active) return;
      if (e.key === 'Escape') { hideSelBar(); closePopup(); }
    }, true);
  };

  /** 快捷鍵／右鍵選單用：直接把目前選取螢光標記起來 */
  PL.highlightSelection = function (alsoExplain) {
    const info = describeSelection();
    if (!info) { PL.toast('請先選取要標記的文字'); return; }
    const ann = createAnnotation(info, PL.settings.defaultHighlight);
    document.getSelection().removeAllRanges();
    hideSelBar();
    if (alsoExplain) { openPopup(ann); runExplain(ann); }
    else PL.toast('已標記');
  };
})();
