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

  /* ══════════ 選取時，另一邊對應的句子一起標出來 ══════════
     用 CSS Custom Highlight（不改動任何 DOM），選了英文就亮出對應的中文句子，反過來也一樣。
     對應方式：先切句，兩邊句數一樣就一句對一句；對不上就按位置比例，再擴到整句。 */

  const CAN_SYNC = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

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
    while (r[0] < r[1] && /\s/.test(tgt[r[0]])) r[0]++;
    return r;
  }

  /** 一個段落裡選了 [s, e)（selected 那一邊的文字位置）→ 另一邊對應的 Range */
  function counterpart(b, side, s, e) {
    if (!b || !b.left || !b.right || b.state !== 'done') return null;
    const tgtCjk = /^(zh|ja|ko)/i.test((PL.settings && PL.settings.targetLang) || 'zh');
    const leftTxt = b.left.textContent, rightTxt = b.right.textContent;
    if (!leftTxt.trim() || !rightTxt.trim()) return null;
    // PDF 左欄文字層的字串沒有行與行之間的空白：句子要在整理過的原文（srcText）上切，再按「非空白字元」對回去
    const src = PL.isPdf ? b.srcText : leftTxt;
    // 起點對到「第一個被選到的字」，終點對到「最後一個被選到的字的後面」（不然會多亮下一句）
    const toSrc = (p) => (PL.isPdf ? posOfNonWs(src, nonWsBefore(leftTxt, p)) : p);
    const toSrcEnd = (p) => (PL.isPdf ? posOfNonWs(src, Math.max(0, nonWsBefore(leftTxt, p) - 1)) + 1 : p);
    const toLeft = (p) => (PL.isPdf ? posOfNonWs(leftTxt, nonWsBefore(src, p)) : p);
    const toLeftEnd = (p) => (PL.isPdf ? posOfNonWs(leftTxt, Math.max(0, nonWsBefore(src, p) - 1)) + 1 : p);
    let a, z, el;
    if (side === 'left') {
      const ss = toSrc(s);
      [a, z] = mapRange(src, ss, Math.max(ss + 1, toSrcEnd(e)), false, rightTxt, tgtCjk);
      el = b.right;
    } else {
      const [ss, se] = mapRange(rightTxt, s, e, tgtCjk, src, false);
      a = toLeft(ss); z = Math.max(a + 1, toLeftEnd(se));
      el = b.left;
    }
    return z > a ? rangeFromOffsets(el, a, Math.min(z, el.textContent.length)) : null;
  }

  function clearSync() {
    if (CAN_SYNC) CSS.highlights.delete('pl-sync');
  }

  function syncSelection(info) {
    if (!CAN_SYNC || !info || !info.full) return;
    const range = info.full;
    const ranges = [];
    for (const i of (info.blocks && info.blocks.length ? info.blocks : [info.block])) {
      const b = PL.blocks[i];
      const el = b && (info.side === 'left' ? b.left : b.right);
      if (!el) continue;
      const s = el.contains(range.startContainer) ? charIndex(el, range.startContainer, range.startOffset) : 0;
      const e = el.contains(range.endContainer) ? charIndex(el, range.endContainer, range.endOffset) : el.textContent.length;
      if (e <= s) continue;
      const r = counterpart(b, info.side, s, e);
      if (r) ranges.push(r);
    }
    if (!ranges.length) { clearSync(); return; }
    CSS.highlights.set('pl-sync', new Highlight(...ranges));

    // 對應的句子不在畫面上（例如關掉了同步捲動）：把另一欄捲過去
    const pane = info.side === 'left' ? PL.els.right : PL.els.left;
    const rr = ranges[0].getBoundingClientRect();
    if (pane && rr.height) {
      const pr = pane.getBoundingClientRect();
      if (rr.bottom < pr.top + 10 || rr.top > pr.bottom - 10) {
        pane.scrollBy({ top: rr.top - pr.top - pane.clientHeight / 3, behavior: 'smooth' });
      }
    }
  }

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
      + '<header><b>🌐 翻譯選取的文字</b><span class="pl-spacer"></span>'
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
        try { await navigator.clipboard.writeText(qtState.out || ''); PL.toast('已複製譯文'); }
        catch (err) { PL.toast('複製失敗'); }
      } else if (act === 'note') {
        if (!qtState.out) return;
        try {
          const ann = createAnnotation(qtState.info, PL.settings.defaultHighlight);
          updateAnnotation(ann, { note: '【譯文】' + qtState.out });
          PL.toast('已標記並把譯文存成心得');
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

  /** info 來自 describeSelection()；沒有段落的一般網頁選取也可以（只有 text） */
  function quickTranslate(info) {
    const src = (info.fullText || info.text || '').trim();
    if (!src) { PL.toast('請先選取要翻譯的文字'); return; }
    const p = qtPopup();
    qtState = { info, src, out: '' };
    p.querySelector('.pl-qt-src').textContent = src.length > 600 ? src.slice(0, 600) + '…' : src;
    p.querySelector('[data-act="note"]').style.display = info.range ? '' : 'none';

    const sel = p.querySelector('.pl-qt-eng');
    sel.textContent = '';
    sel.appendChild(PL.el('option', { value: '', text: '換引擎再翻…' }));
    const engines = globalThis.PLDesktop ? ['google', 'edge', 'gemini'] : ['chrome', 'edge', 'google', 'gemini'];
    engines.filter((e) => e !== 'gemini' || (PL.settings && PL.settings.geminiApiKey))
      .forEach((e) => sel.appendChild(PL.el('option', { value: e, text: engineLabel(e) })));

    p.classList.add('pl-show');
    const r = info.rect || { left: window.innerWidth / 2 - 200, bottom: 120, top: 120 };
    const w = Math.min(460, window.innerWidth - 20);
    p.style.width = w + 'px';
    p.style.left = Math.max(10, Math.min(window.innerWidth - w - 10, r.left)) + 'px';
    const h = p.offsetHeight || 220;
    let y = r.bottom + 10;
    if (y + h > window.innerHeight - 10) y = Math.max(50, r.top - h - 10);
    p.style.top = y + 'px';

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

    const head = PL.el('header');
    head.appendChild(PL.el('span', { text: '我的註解' }));
    head.appendChild(PL.el('span', { class: 'pl-spacer' }));

    const bExport = PL.el('button', { text: '匯出', title: '把本頁註解存成 JSON' });
    bExport.addEventListener('click', exportJson);
    head.appendChild(bExport);

    const bClose = PL.el('button', { text: '✕' });
    bClose.addEventListener('click', () => PL.toggleSidebar(false));
    head.appendChild(bClose);

    const list = PL.el('div', { class: 'pl-list' });

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

    el.append(grip, head, list);
    document.documentElement.appendChild(el);
    if (PL.settings && PL.settings.sidebarWidth) {
      document.documentElement.style.setProperty('--pl-side-w', PL.settings.sidebarWidth + 'px');
    }
    PL.els.side = el;
    PL.els.sideList = list;
    return el;
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

  PL.toggleSidebar = function (force) {
    sidebar();
    const root = document.documentElement;
    const next = (force === undefined) ? !root.classList.contains('pl-side-open') : !!force;
    root.classList.toggle('pl-side-open', next);
    if (PL.els.sideBtn) PL.els.sideBtn.classList.toggle('pl-on', next);
    if (next) renderSidebar();
    PL.Sync.markDirty();
    globalThis.PL_saveSettings({ showSidebar: next });
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
