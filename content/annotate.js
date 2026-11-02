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

  /** 重新把一則註解畫回頁面上；位置對不上時用原文比對救回來 */
  function apply(ann) {
    const block = blockOf(ann.side, ann.block);
    if (!block) { ann.orphan = true; return false; }

    const text = block.textContent;
    let start = ann.start, end = ann.end;

    if (text.slice(start, end) !== ann.exact) {
      let idx = -1;
      if (ann.exact) {
        // 先用前後文定位，避免同一段裡有重複字串時標錯地方
        if (ann.prefix) {
          const p = text.indexOf(ann.prefix + ann.exact);
          if (p >= 0) idx = p + ann.prefix.length;
        }
        if (idx < 0) idx = text.indexOf(ann.exact);
      }
      if (idx < 0) { ann.orphan = true; return false; }
      start = idx; end = idx + ann.exact.length;
    }

    const range = rangeFromOffsets(block, start, end);
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

    return {
      side,
      block: Number(block.getAttribute('data-pl-b')),
      start, end,
      exact: full.slice(start, end),
      prefix: full.slice(Math.max(0, start - 24), start),
      suffix: full.slice(end, end + 24),
      rect: r.getBoundingClientRect(),
      range: r,
      text
    };
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
    persist();
    renderSidebar();
  }
  PL.deleteAnnotation = deleteAnnotation;

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
    if (!items.length) {
      list.appendChild(PL.el('div', {
        class: 'pl-empty',
        text: '還沒有註解。\n在任一欄選取文字，就會跳出螢光筆與心得按鈕。'
      }));
      return;
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
        if (!info) { hideSelBar(); return; }
        pendingRange = info;
        showSelBar(info);
      }, 10);
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (!PL.active) return;
      const t = e.target;
      if (t.closest && t.closest('#pl-sel')) return;
      hideSelBar();
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
