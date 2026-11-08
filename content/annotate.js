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

  function nonWsBefore(str, pos) {
    let k = 0;
    for (let i = 0; i < pos && i < str.length; i++) if (!/\s/.test(str[i])) k++;
    return k;
  }
  function posOfNonWs(str, k) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      if (/\s/.test(str[i])) continue;
      if (n === k) return i;
      n++;
    }
    return str.length;
  }
  const nonWsLen = (str) => str.replace(/\s+/g, '').length;

  const EN_ABBR = /(?:\b(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Ref|Refs|Sec|Tab|No|Vol|approx|ca|resp|Dr|Prof|Suppl)|\b[A-Z])\.$/;

  function sentenceSpans(text, cjk) {
    const spans = [];
    const re = cjk ? /[。！？；!?]+[」』”’）)\]]*/g : /[.!?;]+["”’)\]]*(?=\s)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      if (!cjk && EN_ABBR.test(text.slice(Math.max(0, m.index - 12), m.index + 1))) continue;
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

  /** 選取那一邊的 [s, e) → { tgt: 另一邊對應的句子, src: 選取那一邊所在的句子, single: 只在一句之內 } */
  function mapRange(src, s, e, srcCjk, tgt, tgtCjk) {
    const A = sentenceSpans(src, srcCjk), B = sentenceSpans(tgt, tgtCjk);
    const [i0, i1] = spanIdx(A, s, e);
    let r;
    if (A.length === B.length) r = [B[i0][0], B[i1][1]];
    else {
      const L1 = src.length || 1;
      const [j0, j1] = spanIdx(B, Math.floor(s / L1 * tgt.length), Math.ceil(e / L1 * tgt.length));
      r = [B[j0][0], B[j1][1]];
    }
    return { tgt: trimWs(tgt, r), src: trimWs(src, [A[i0][0], A[i1][1]]), single: i0 === i1, B };
  }

  /* ---- 找「原樣出現」的字：數字、縮寫、英文術語、單位 ---- */

  const TOKEN_RE = /[A-Za-z0-9](?:[A-Za-z0-9.+\-−–°%/]*[A-Za-z0-9%°])?/g;
  const isAsciiWord = (c) => !!c && /[A-Za-z0-9]/.test(c);

  function findWord(text, w, from, to) {
    const low = text.toLowerCase(), q = w.toLowerCase();
    let i = low.indexOf(q, from);
    while (i >= 0 && i + q.length <= to) {
      // 英數字要整個字對上（找 18 不能對到 1968 裡面）
      const ok = !/^[A-Za-z0-9]/.test(q) || (!isAsciiWord(text[i - 1]) && !isAsciiWord(text[i + q.length]));
      if (ok) return [i, i + q.length];
      i = low.indexOf(q, i + 1);
    }
    return null;
  }

  /** 選的字整段原樣出現在另一邊（例如選了「1968」「AR」「HoloLens」） */
  function findLiteral(phrase, text, from, to) {
    const p = phrase.replace(/\s+/g, ' ').replace(/^[\s,.;:()\[\]"'“”‘’，。；：、（）]+|[\s,.;:()\[\]"'“”‘’，。；：、（）]+$/g, '');
    if (!p) return null;
    const whole = findWord(text, p, from, to) || (/[A-Za-z]{2}s$/.test(p) ? findWord(text, p.slice(0, -1), from, to) : null);
    if (whole) return whole;
    // 選到數字後面黏著的引用上標（1968¹、網頁上的 19681）：去掉上標再找
    const core = p.replace(/[⁰-⁹¹²³⁺⁻,–\-]+$/u, '');
    if (core && core !== p) {
      const r = findWord(text, core, from, to);
      if (r) return r;
    }
    const tokens = p.match(TOKEN_RE) || [];
    const rest = p.replace(TOKEN_RE, '').replace(/[\s\p{P}\p{S}⁰-⁹¹²³]/gu, '');
    if (!tokens.length || rest) return null;          // 還有別的字 → 交給翻譯比對
    const hits = [];
    for (const t of tokens) {
      let r = findWord(text, t, from, to);
      if (!r && /^\d{5,}$/.test(t)) {                 // 19681 → 1968
        for (let k = 1; k <= 3 && !r; k++) r = findWord(text, t.slice(0, -k), from, to);
      }
      if (!r && /[A-Za-z]{2}s$/.test(t)) r = findWord(text, t.slice(0, -1), from, to);   // q-BICs → q-BIC
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

  function matchCjk(q, text, from, to) {
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
        if (!best || score > best.score + 1e-9 ||
            (Math.abs(score - best.score) < 1e-9 && Math.abs(len - m) < Math.abs(best.len - m))) {
          best = { score, i, j, len };
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
    for (let n = 0; n < qi0 && glued(i - 1, i) && j - i + 1 < m + 2; n++) i--;
    for (let n = 0; n < m - 1 - qi1 && glued(j, j + 1) && j - i + 1 < m + 2; n++) j++;
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
    'those its it their our we which into via than such can may also has have had not but').split(' '));
  const stem = (w) => w.toLowerCase().replace(/(ies|es|s|ed|ing|ly)$/, '').replace(/(e)$/, '');
  function sameWord(x, y) {
    if (x === y) return true;
    const a = stem(x), b = stem(y);
    if (a === b) return true;
    const n = Math.min(a.length, b.length);
    if (n < 4) return false;
    let k = 0;
    while (k < n && a[k] === b[k]) k++;
    return k >= 5 && k >= n * 0.7;                    // diffraction ↔ diffractive
  }

  function matchEn(q, text, from, to) {
    const qw = (q.match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g) || []).map((w) => w.toLowerCase());
    let need = qw.filter((w) => !STOP.has(w));
    if (!need.length) need = qw;
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
          if (STOP.has(T[k].t) && need.length !== qw.length) continue;
          content++;
          const u = need.findIndex((w, x) => !used[x] && sameWord(w, T[k].t));
          if (u >= 0) { used[u] = true; common++; }
        }
        const score = fScore(common, need.length, Math.max(1, content));
        if (!best || score > best.score + 1e-9) best = { score, i, j };
      }
    }
    if (!best || best.score < 0.5) return null;
    // 只對到一部分（thinnest geometry → geometry）：照沒對到的字數往前後補（→ slimmest geometry）
    const Qc = need.map((t) => ({ t }));
    const [qi0, qi1] = matchedSpan(Qc, T.slice(best.i, best.j + 1).filter((w) => !STOP.has(w.t) || need.length === qw.length), sameWord);
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
  const MARK_RE = /[【\[「〔]+\s*([^【】\[\]「」〔〕]+?)\s*[】\]」〕]+/;
  async function markedTranslate(c) {
    const sen = c.selSentence, a = c.rel[0], z = c.rel[1];
    if (!sen || z <= a || sen.length > 900) return null;
    const marked = sen.slice(0, a) + '【' + sen.slice(a, z).trim() + '】' + sen.slice(z);
    const out = await phraseTranslate(marked, c.from, c.to, c.engine);
    const m = out && out.match(MARK_RE);
    return m ? m[1].trim() : null;
  }

  /** 一個段落裡選了 [s, e)（selected 那一邊的文字位置）→ 另一邊對應的句子，以及找字需要的資料 */
  function counterpart(b, side, s, e) {
    if (!b || !b.left || !b.right || b.state !== 'done') return null;
    const tgtLang = (PL.settings && PL.settings.targetLang) || 'zh-Hant';
    const tgtCjk = /^(zh|ja|ko)/i.test(tgtLang);
    const leftTxt = b.left.textContent, rightTxt = b.right.textContent;
    if (!leftTxt.trim() || !rightTxt.trim()) return null;
    // PDF 左欄文字層的字串沒有行與行之間的空白：句子要在整理過的原文（srcText）上切，再按「非空白字元」對回去
    const src = PL.isPdf ? b.srcText : leftTxt;
    // 起點對到「第一個被選到的字」，終點對到「最後一個被選到的字的後面」（不然會多亮下一句）
    const toSrc = (p) => (PL.isPdf ? posOfNonWs(src, nonWsBefore(leftTxt, p)) : p);
    const toSrcEnd = (p) => (PL.isPdf ? posOfNonWs(src, Math.max(0, nonWsBefore(leftTxt, p) - 1)) + 1 : p);
    const toLeft = (p) => (PL.isPdf ? posOfNonWs(leftTxt, nonWsBefore(src, p)) : p);
    const toLeftEnd = (p) => (PL.isPdf ? posOfNonWs(leftTxt, Math.max(0, nonWsBefore(src, p) - 1)) + 1 : p);
    const srcLang = (globalThis.PLTranslate && PLTranslate.sourceLang && PLTranslate.sourceLang !== 'auto')
      ? PLTranslate.sourceLang : 'en';

    if (side === 'left') {
      const ss = toSrc(s), se = Math.max(ss + 1, toSrcEnd(e));
      const m = mapRange(src, ss, se, false, rightTxt, tgtCjk);
      return {
        el: b.right, text: rightTxt, sent: m.tgt, spans: m.B, toEl: (p) => p, toElEnd: (p) => p, cjk: tgtCjk,
        selEl: b.left, selSent: [toLeft(m.src[0]), toLeftEnd(m.src[1])],
        phrase: src.slice(ss, se), ratio: nonWsLen(src.slice(ss, se)) / Math.max(1, nonWsLen(src.slice(m.src[0], m.src[1]))),
        selSentence: src.slice(m.src[0], m.src[1]), rel: [ss - m.src[0], se - m.src[0]],
        single: m.single, from: srcLang, to: tgtLang, engine: b.engine
      };
    }
    const m = mapRange(rightTxt, s, e, tgtCjk, src, false);
    return {
      el: b.left, text: src, sent: m.tgt, spans: m.B, toEl: toLeft, toElEnd: toLeftEnd, cjk: false,
      selEl: b.right, selSent: m.src,
      phrase: rightTxt.slice(s, e), ratio: nonWsLen(rightTxt.slice(s, e)) / Math.max(1, nonWsLen(rightTxt.slice(m.src[0], m.src[1]))),
      selSentence: rightTxt.slice(m.src[0], m.src[1]), rel: [s - m.src[0], e - m.src[0]],
      single: m.single, from: tgtLang, to: srcLang, engine: b.engine
    };
  }

  /** c.text 上的 [a, z) → c.el 裡的 Range */
  function elRange(c, a, z) {
    const A = c.toEl(a), Z = Math.min(c.toElEnd(z), c.el.textContent.length);
    return Z > A ? rangeFromOffsets(c.el, A, Z) : null;
  }

  /** 在對應的句子裡找字；句子對錯了（兩邊句數不同）就整段找（要更像才算） */
  function locateIn(c, finder) {
    let f = finder(c.sent[0], c.sent[1]);
    let sent = c.sent;
    if (!f) {
      f = finder(0, c.text.length);
      if (f && f.score < 0.7) f = null;
      if (f) {
        const k = c.spans.findIndex(([a, z]) => z > f.r[0] && a < f.r[1]);
        if (k >= 0) sent = trimWs(c.text, c.spans[k]);
      }
    }
    return f ? { r: f.r, score: f.score, sent } : null;
  }

  const literalHit = (phrase, text, a, z) => {
    const r = findLiteral(phrase, text, a, z);
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
    strong = strong.filter(Boolean);
    ctx = ctx.filter(Boolean);
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

    const sentRange = (c, sent) => elRange(c, sent[0], sent[1]);
    const selSentRange = (c) => (c.selSent[1] > c.selSent[0] ? rangeFromOffsets(c.selEl, c.selSent[0], Math.min(c.selSent[1], c.selEl.textContent.length)) : null);

    const c = hits[0];
    if (!isWordMode(hits)) {
      const strong = hits.map((h) => sentRange(h, h.sent));
      paintSync(strong, []);
      scrollToRange(info, strong[0]);
      return;
    }

    // 1) 原樣出現的字（數字、縮寫、術語）→ 馬上標
    const lit = locateIn(c, (a, z) => literalHit(c.phrase, c.text, a, z));
    if (lit) {
      const r = elRange(c, lit.r[0], lit.r[1]);
      paintSync([r], [sentRange(c, lit.sent), selSentRange(c)]);
      scrollToRange(info, r);
      return;
    }

    // 2) 先淡淡標出整句，等選的字翻好再找出對應的那幾個字
    const sr = sentRange(c, c.sent);
    paintSync([], [sr, selSentRange(c)]);
    scrollToRange(info, sr);
    alignPhrase(c).then((found) => {
      if (tok !== syncTok) return;                    // 選取已經換了
      if (found) {
        const r = elRange(c, found.r[0], found.r[1]);
        paintSync([r], [sentRange(c, found.sent), selSentRange(c)]);
        if (found.sent !== c.sent) scrollToRange(info, r);
      } else {
        paintSync([sr], [selSentRange(c)]);               // 找不到對應的字：整句標黃
      }
    }, () => { if (tok === syncTok) paintSync([sr], [selSentRange(c)]); });
  }

  /** 選的字 → 另一邊句子裡對應的位置。短的字先單獨翻；長一點的片語連整句一起翻比較準 */
  async function alignPhrase(c) {
    const phrase = c.phrase.replace(/\s+/g, ' ').trim();
    const find = (q) => q && locateIn(c, (a, z) => literalHit(q, c.text, a, z)
      || (c.cjk ? matchCjk(q, c.text, a, z) : matchEn(q, c.text, a, z)));
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
    return best;
  }

  // 測試用
  PL._sync = { findLiteral, matchCjk, matchEn, snapWords, sentenceSpans };

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
    let found = locateIn(c, (a, z) => literalHit(c.phrase, c.text, a, z));
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
    const tTr = PL.el('button', { class: 'pl-tab', 'data-tab': 'tr', text: '🔤 查字・翻譯', title: '側邊翻譯：查單字、翻一句話，不會動到文章' });
    const tNotes = PL.el('button', { class: 'pl-tab', 'data-tab': 'notes', text: '📝 我的註解' });
    tabs.append(tTr, tNotes);
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

    el.append(grip, head, list, trPane);
    document.documentElement.appendChild(el);
    if (PL.settings && PL.settings.sidebarWidth) {
      document.documentElement.style.setProperty('--pl-side-w', PL.settings.sidebarWidth + 'px');
    }
    PL.els.side = el;
    PL.els.sideList = list;
    PL.els.sideTr = trPane;
    if (PL.Lookup) PL.Lookup.mount(trPane);
    setSideTab(PL.settings && PL.settings.sideTab === 'tr' && PL.Lookup ? 'tr' : 'notes');
    return el;
  }

  let sideTab = 'notes';
  PL.sideTab = () => (document.documentElement.classList.contains('pl-side-open') ? sideTab : null);

  function setSideTab(tab) {
    if (tab === 'tr' && !PL.Lookup) tab = 'notes';
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
    if (PL.Sync) PL.Sync.markDirty();
    if (PL.Overlay) PL.Overlay.reproject();
    if (open !== next) globalThis.PL_saveSettings({ showSidebar: next });
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
