/* PaperLens — 手寫標註、文字方塊與便利貼（網頁對照與 PDF 檢視器共用）
 *
 * 每一筆標註都「掛」在一個錨點元素上（網頁是段落，PDF 是頁面），座標存成相對於錨點方框的比例，
 * 所以放大縮小、換引擎重翻、視窗改大小之後，標註都還在原本指的那個地方。
 *
 * 這一版重新設計過：
 *  - 工具列改成橫向、每個工具都有文字標籤，不會再像舊版那樣擋在譯文上面
 *  - 復原／重做（Ctrl+Z / Ctrl+Shift+Z）；擦掉、清除也都能復原
 *  - 橡皮擦可以擦線條、圖形、文字方塊、便利貼，連「選字螢光筆」也擦得掉
 *  - 便利貼：點一下就貼（舊版這個工具其實點了沒反應），可拖曳、縮放、換色、收合成小圖示
 *  - 新增「文字」工具：直接在頁面上打字，跟著頁面一起縮放
 *  - 筆跡平滑；螢光筆用「色彩增值」疊上去，底下的字不會被蓋淡
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  const NS = 'http://www.w3.org/2000/svg';

  const TOOLS = ['pen', 'marker', 'arrow', 'rect', 'ellipse', 'text', 'sticky', 'eraser'];
  const INK_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#111827'];
  const NOTE_COLORS = ['#fde68a', '#fbcfe8', '#bbf7d0', '#bfdbfe', '#ddd6fe', '#fed7aa'];
  // 舊版便利貼是「飽和色＋白字」，很難讀；換成對應的淡色紙張＋深色字
  const OLD_NOTE = {
    '#ef4444': '#fbcfe8', '#f59e0b': '#fde68a', '#10b981': '#bbf7d0',
    '#3b82f6': '#bfdbfe', '#8b5cf6': '#ddd6fe', '#111827': '#fed7aa'
  };
  const WIDTHS = [2, 4, 7];
  const TEXT_PX = { 2: 14, 4: 18, 7: 24 };

  const state = {
    tool: null,
    color: '#ef4444',
    width: 4,
    items: [],          // 筆跡 { id, side, anchor, kind, color, width, pts[] }
                        // 便利貼 { id, side, anchor, kind:'sticky', color, pos, size, text, collapsed }
                        // 文字 { id, side, anchor, kind:'text', color, pos, fs, text }
    sides: {},          // side -> { pane, layer, svg, notes, nodes, anchorAt, anchorEl, keyOf }
    drawing: null,
    erasing: null,
    hidden: false,
    loaded: false,
    undo: [],
    redo: []
  };

  const storeKey = () => 'ovl:' + PL.pageKey();
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const find = (id) => state.items.find((i) => i.id === id);
  const isNote = (it) => it.kind === 'sticky' || it.kind === 'text';

  /* ══════════ 儲存 ══════════ */

  const persist = PL.debounce(async () => {
    try {
      await chrome.storage.local.set({
        [storeKey()]: { url: PL.pageKey(), title: PL.pageTitle(), updatedAt: Date.now(), items: state.items }
      });
    } catch (e) {
      PL.toast('標註儲存失敗（儲存空間可能已滿）');
    }
  }, 400);

  async function load() {
    try {
      const got = await chrome.storage.local.get(storeKey());
      const rec = got[storeKey()];
      state.items = (rec && Array.isArray(rec.items)) ? rec.items : [];
    } catch (e) {
      state.items = [];
    }
    state.loaded = true;
    reproject();
    sidebarSoon();
  }

  /* ══════════ 復原／重做 ══════════ */

  function commit(op) {
    state.undo.push(op);
    if (state.undo.length > 300) state.undo.shift();
    state.redo = [];
    renderPalette();
  }

  function clone(it) { return JSON.parse(JSON.stringify(it)); }

  function applyOp(op, back) {
    const add = (list) => list.forEach((it) => { if (!find(it.id)) state.items.push(clone(it)); });
    const del = (list) => {
      const ids = new Set(list.map((i) => i.id));
      state.items = state.items.filter((i) => !ids.has(i.id));
    };
    if (op.type === 'add') (back ? del : add)(op.items);
    else if (op.type === 'remove') (back ? add : del)(op.items);
    else if (op.type === 'change') {
      for (const c of op.changes) {
        const it = find(c.id);
        if (it) Object.assign(it, clone(back ? c.before : c.after));
      }
    }
    if (op.hl && op.hl.length) {
      for (const a of op.hl) {
        if (back) { if (PL.restoreAnnotation) PL.restoreAnnotation(a); }
        else if (PL.deleteAnnotation) PL.deleteAnnotation(a);
      }
    }
    persist();
    reproject();
    sidebarSoon();
  }

  function undo() {
    const op = state.undo.pop();
    if (!op) { PL.toast('沒有可以復原的動作'); return; }
    applyOp(op, true);
    state.redo.push(op);
    renderPalette();
  }

  function redo() {
    const op = state.redo.pop();
    if (!op) return;
    applyOp(op, false);
    state.undo.push(op);
    renderPalette();
  }

  /* ══════════ 座標換算 ══════════ */

  /** 滑鼠座標 → 該欄「內容座標」（已含捲動量） */
  function toContent(side, clientX, clientY) {
    const s = state.sides[side];
    const r = s.pane.getBoundingClientRect();
    return { x: clientX - r.left + s.pane.scrollLeft, y: clientY - r.top + s.pane.scrollTop };
  }

  /** 錨點元素在該欄內容座標裡的方框 */
  function anchorBox(side, el) {
    const s = state.sides[side];
    const pr = s.pane.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return {
      x: er.left - pr.left + s.pane.scrollLeft,
      y: er.top - pr.top + s.pane.scrollTop,
      w: Math.max(1, er.width),
      h: Math.max(1, er.height)
    };
  }

  const norm = (box, pt) => [(pt.x - box.x) / box.w, (pt.y - box.y) / box.h];
  const denorm = (box, n) => ({ x: box.x + n[0] * box.w, y: box.y + n[1] * box.h });

  /** 圖層蓋在內容上面，要先讓它不擋滑鼠才能問出底下的錨點元素 */
  function anchorUnder(side, clientX, clientY) {
    const s = state.sides[side];
    const prev = s.layer.style.pointerEvents;
    s.layer.style.pointerEvents = 'none';
    let el = null;
    try { el = s.anchorAt(clientX, clientY); } catch (e) { el = null; }
    s.layer.style.pointerEvents = prev;
    return el;
  }

  /* ══════════ 圖層 ══════════ */

  PL.Overlay = {
    register(side, cfg) {
      const layer = PL.el('div', { class: 'pl-ovl', 'data-pl-ui': '1' });
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'pl-ovl-svg');
      const notes = PL.el('div', { class: 'pl-ovl-notes' });
      layer.append(svg, notes);
      cfg.pane.appendChild(layer);

      state.sides[side] = {
        pane: cfg.pane, layer, svg, notes, nodes: new Map(),
        anchorAt: cfg.anchorAt, anchorEl: cfg.anchorEl, keyOf: cfg.keyOf,
        label: cfg.label || null
      };
      wirePane(side);
      applyToolClass();
      if (!state.loaded) load(); else reproject();
      return layer;
    },

    setTool(tool) {
      state.tool = (state.tool === tool) ? null : (tool || null);
      applyToolClass();
      renderPalette();
      return state.tool;
    },

    get tool() { return state.tool; },
    setColor(c) { state.color = c; renderPalette(); },
    setWidth(w) { state.width = w; renderPalette(); },

    reproject,
    undo, redo,
    clearSide(side) { clearWhere((it) => it.side === side); },
    clearAll() { clearWhere(() => true); },
    clearVisible,
    setHidden(h) {
      state.hidden = !!h;
      for (const k in state.sides) state.sides[k].layer.classList.toggle('pl-hidden', state.hidden);
      renderPalette();
    },
    count: () => state.items.length,
    items: () => state.items.slice(),
    notes: () => state.items.filter((i) => i.kind === 'sticky' || i.kind === 'text'),
    focus: focusNote,
    load
  };

  function applyToolClass() {
    const t = state.tool;
    document.documentElement.classList.toggle('pl-drawing', !!t);
    for (const k in state.sides) {
      const L = state.sides[k].layer;
      L.classList.toggle('pl-active-layer', !!t);
      TOOLS.forEach((x) => L.classList.toggle('pl-tool-' + x, t === x));
    }
  }

  function clearWhere(pred) {
    const gone = state.items.filter(pred);
    if (!gone.length) { PL.toast('沒有可以清除的標註'); return; }
    state.items = state.items.filter((i) => !pred(i));
    commit({ type: 'remove', items: gone.map(clone) });
    persist();
    reproject();
    sidebarSoon();
    PL.toast('已清除 ' + gone.length + ' 筆標註（按 Ctrl+Z 可以復原）', 3200);
  }

  /** 清掉「目前畫面上看得到」的標註（左右兩欄都算） */
  function clearVisible() {
    const visible = new Set();
    for (const side in state.sides) {
      const s = state.sides[side];
      const pr = s.pane.getBoundingClientRect();
      for (const it of state.items) {
        if (it.side !== side) continue;
        const el = s.anchorEl(it.anchor);
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom > pr.top && r.top < pr.bottom) visible.add(it.id);
      }
    }
    clearWhere((it) => visible.has(it.id));
  }

  /* ══════════ 繪製 ══════════ */

  function wirePane(side) {
    const s = state.sides[side];

    s.layer.addEventListener('pointerdown', (e) => {
      if (!state.tool || e.button !== 0) return;
      if (e.target.closest && e.target.closest('.pl-sticky, .pl-inktext') && state.tool !== 'eraser') return;
      e.preventDefault();

      if (state.tool === 'eraser') {
        state.erasing = { side, items: [], hl: [] };
        try { s.layer.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件沒有真的指標 */ }
        eraseAt(side, e.clientX, e.clientY);
        return;
      }
      if (state.tool === 'sticky' || state.tool === 'text') {
        place(side, e);
        return;
      }

      const anchorEl = anchorUnder(side, e.clientX, e.clientY);
      if (!anchorEl) return;
      const box = anchorBox(side, anchorEl);
      if (box.w < 4 || box.h < 2) return;      // 版面還沒量好，先不要記
      try { s.layer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      const pt = toContent(side, e.clientX, e.clientY);
      state.drawing = {
        id: uid('k'), side, anchor: s.keyOf(anchorEl), anchorEl,
        kind: state.tool, color: state.color,
        width: state.tool === 'marker' ? state.width * 3.5 : state.width,
        pts: [norm(box, pt)], box
      };
      drawLive();
    });

    s.layer.addEventListener('pointermove', (e) => {
      if (state.erasing && state.erasing.side === side) {
        eraseAt(side, e.clientX, e.clientY);
        return;
      }
      const d = state.drawing;
      if (!d || d.side !== side) return;
      const pt = toContent(side, e.clientX, e.clientY);
      let n = norm(d.box, pt);
      if (d.kind === 'pen' || d.kind === 'marker') {
        const last = d.pts[d.pts.length - 1];
        const dx = (n[0] - last[0]) * d.box.w, dy = (n[1] - last[1]) * d.box.h;
        if (dx * dx + dy * dy < 4) return;        // 太密的點不收，檔案才不會爆
        d.pts.push(n);
      } else {
        if (e.shiftKey) n = constrain(d, n);
        d.pts[1] = n;
      }
      drawLive();
    });

    const finish = () => {
      if (state.erasing && state.erasing.side === side) {
        const er = state.erasing;
        state.erasing = null;
        if (er.items.length || er.hl.length) commit({ type: 'remove', items: er.items, hl: er.hl });
        return;
      }
      const d = state.drawing;
      if (!d || d.side !== side) return;
      state.drawing = null;
      if (d.pts.length < 2) { reproject(); return; }
      const item = { id: d.id, side: d.side, anchor: d.anchor, kind: d.kind, color: d.color, width: d.width, pts: d.pts };
      state.items.push(item);
      commit({ type: 'add', items: [clone(item)] });
      persist();
      reproject();
    };
    s.layer.addEventListener('pointerup', finish);
    s.layer.addEventListener('pointercancel', finish);
  }

  /** 按住 Shift：方框變正方形、圈選變正圓、箭頭鎖 45° */
  function constrain(d, n) {
    const a = d.pts[0];
    let dx = (n[0] - a[0]) * d.box.w, dy = (n[1] - a[1]) * d.box.h;
    if (d.kind === 'rect' || d.kind === 'ellipse') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m;
    } else if (d.kind === 'arrow') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(ang) * len; dy = Math.sin(ang) * len;
    }
    return [a[0] + dx / d.box.w, a[1] + dy / d.box.h];
  }

  /** 便利貼、文字方塊：點一下就放在那裡，馬上可以打字 */
  function place(side, e) {
    const s = state.sides[side];
    const anchorEl = anchorUnder(side, e.clientX, e.clientY);
    if (!anchorEl) return;
    const box = anchorBox(side, anchorEl);
    if (box.w < 4 || box.h < 2) return;
    let pt = toContent(side, e.clientX, e.clientY);
    let item;
    if (state.tool === 'sticky') {
      // 不要跟既有的便利貼疊在同一個位置
      for (let k = 0; k < 8; k++) {
        const hit = state.items.some((it) => it.kind === 'sticky' && it.side === side && it.anchor === s.keyOf(anchorEl)
          && Math.abs(denorm(box, it.pos).x - pt.x) < 24 && Math.abs(denorm(box, it.pos).y - pt.y) < 24);
        if (!hit) break;
        pt = { x: pt.x + 22, y: pt.y + 22 };
      }
      const ci = INK_COLORS.indexOf(state.color);
      item = {
        id: uid('n'), side, anchor: s.keyOf(anchorEl), kind: 'sticky',
        color: NOTE_COLORS[ci >= 0 ? ci : 0], pos: norm(box, pt), size: [220, 140], text: '', collapsed: false
      };
    } else {
      item = {
        id: uid('t'), side, anchor: s.keyOf(anchorEl), kind: 'text',
        color: state.color, pos: norm(box, { x: pt.x, y: pt.y - 10 }), fs: (TEXT_PX[state.width] || 18) / box.w, text: ''
      };
    }
    state.items.push(item);
    commit({ type: 'add', items: [clone(item)] });
    persist();
    PL.Overlay.setTool(null);
    doReproject();
    focusNote(item.id, true);
    sidebarSoon();
  }

  function drawLive() {
    const d = state.drawing;
    if (!d) return;
    const s = state.sides[d.side];
    let live = s.svg.querySelector('#pl-live');
    if (live) live.remove();
    live = buildShape(d, d.box);
    if (live) { live.setAttribute('id', 'pl-live'); s.svg.appendChild(live); }
  }

  /** 平滑的筆跡：每兩點之間用二次曲線接起來 */
  function smoothPath(pts) {
    if (pts.length < 3) return 'M' + pts.map((q) => q.x.toFixed(1) + ' ' + q.y.toFixed(1)).join(' L');
    let d = 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ' Q' + pts[i].x.toFixed(1) + ' ' + pts[i].y.toFixed(1) + ' ' + mx.toFixed(1) + ' ' + my.toFixed(1);
    }
    const l = pts[pts.length - 1];
    return d + ' L' + l.x.toFixed(1) + ' ' + l.y.toFixed(1);
  }

  function buildShape(item, box) {
    const pts = item.pts.map((n) => denorm(box, n));
    if (pts.length < 2) return null;

    const common = (el) => {
      el.setAttribute('stroke', item.color);
      el.setAttribute('stroke-width', String(item.width));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      if (item.kind === 'marker') {
        el.setAttribute('stroke-opacity', '0.38');
        el.setAttribute('stroke-linecap', 'butt');
        el.setAttribute('class', 'pl-ink-marker');
      }
      el.setAttribute('data-pl-ink', item.id);
      return el;
    };

    if (item.kind === 'pen' || item.kind === 'marker') {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', smoothPath(pts));
      return common(p);
    }

    const a = pts[0], b = pts[pts.length - 1];

    if (item.kind === 'ellipse') {
      const el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', ((a.x + b.x) / 2).toFixed(1));
      el.setAttribute('cy', ((a.y + b.y) / 2).toFixed(1));
      el.setAttribute('rx', (Math.abs(b.x - a.x) / 2).toFixed(1));
      el.setAttribute('ry', (Math.abs(b.y - a.y) / 2).toFixed(1));
      return common(el);
    }

    if (item.kind === 'rect') {
      const el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', Math.min(a.x, b.x).toFixed(1));
      el.setAttribute('y', Math.min(a.y, b.y).toFixed(1));
      el.setAttribute('width', Math.abs(b.x - a.x).toFixed(1));
      el.setAttribute('height', Math.abs(b.y - a.y).toFixed(1));
      el.setAttribute('rx', '4');
      return common(el);
    }

    if (item.kind === 'arrow') {
      const g = document.createElementNS(NS, 'g');
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', a.x.toFixed(1)); line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1)); line.setAttribute('y2', b.y.toFixed(1));
      g.appendChild(common(line));
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.max(10, item.width * 4);
      const head = document.createElementNS(NS, 'polyline');
      const p1 = { x: b.x - len * Math.cos(ang - 0.4), y: b.y - len * Math.sin(ang - 0.4) };
      const p2 = { x: b.x - len * Math.cos(ang + 0.4), y: b.y - len * Math.sin(ang + 0.4) };
      head.setAttribute('points', [p1, b, p2].map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '));
      g.appendChild(common(head));
      g.setAttribute('data-pl-ink', item.id);
      return g;
    }
    return null;
  }

  /* ══════════ 橡皮擦 ══════════ */

  function distToSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }

  /**
   * 點到圖形「邊線」的距離。
   * 方框、橢圓、箭頭只存兩個端點，只比對端點的話點在邊上根本擦不到。
   */
  function distToShape(item, box, pt) {
    const P = item.pts.map((n) => denorm(box, n));
    if (!P.length) return Infinity;
    if (item.kind === 'pen' || item.kind === 'marker') {
      if (P.length === 1) return Math.hypot(pt.x - P[0].x, pt.y - P[0].y);
      let m = Infinity;
      for (let i = 1; i < P.length; i++) m = Math.min(m, distToSeg(pt, P[i - 1], P[i]));
      return m;
    }
    const a = P[0], b = P[P.length - 1];
    if (item.kind === 'arrow') return distToSeg(pt, a, b);
    if (item.kind === 'rect') {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      return Math.min(
        distToSeg(pt, { x: x0, y: y0 }, { x: x1, y: y0 }), distToSeg(pt, { x: x1, y: y0 }, { x: x1, y: y1 }),
        distToSeg(pt, { x: x1, y: y1 }, { x: x0, y: y1 }), distToSeg(pt, { x: x0, y: y1 }, { x: x0, y: y0 }));
    }
    if (item.kind === 'ellipse') {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const rx = Math.max(1, Math.abs(b.x - a.x) / 2), ry = Math.max(1, Math.abs(b.y - a.y) / 2);
      const r = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry);
      return Math.abs(r - 1) * Math.min(rx, ry);
    }
    return Infinity;
  }

  function eraseAt(side, clientX, clientY) {
    const s = state.sides[side];
    const er = state.erasing;
    const pt = toContent(side, clientX, clientY);
    const kill = [];

    for (const item of state.items) {
      if (item.side !== side) continue;
      if (isNote(item)) {
        const node = s.nodes.get(item.id);
        if (!node) continue;
        const r = node.getBoundingClientRect();
        if (clientX >= r.left - 4 && clientX <= r.right + 4 && clientY >= r.top - 4 && clientY <= r.bottom + 4) kill.push(item);
        continue;
      }
      const el = s.anchorEl(item.anchor);
      if (!el || !el.isConnected) continue;
      const d = distToShape(item, anchorBox(side, el), pt);
      if (d <= Math.max(12, (item.width || 3) * 1.2)) kill.push(item);
    }
    if (kill.length) {
      const ids = new Set(kill.map((k) => k.id));
      state.items = state.items.filter((i) => !ids.has(i.id));
      if (er) er.items.push.apply(er.items, kill.map(clone));
      persist();
      reproject();
      sidebarSoon();
    }

    // 選字螢光筆也擦得掉
    if (PL.getAnnotations && PL.deleteAnnotation) {
      const prev = s.layer.style.pointerEvents;
      s.layer.style.pointerEvents = 'none';
      let els = [];
      try { els = document.elementsFromPoint(clientX, clientY); } catch (e) { els = []; }
      s.layer.style.pointerEvents = prev;
      const mk = els.find((x) => x.matches && x.matches('mark.pl-hl'));
      if (mk) {
        const ann = PL.getAnnotations().find((a) => a.id === mk.getAttribute('data-pl-ann'));
        if (ann) {
          if (er) er.hl.push(clone(ann));
          PL.deleteAnnotation(ann);
        }
      }
    }
  }

  /* ══════════ 重新投影（版面一變就要重畫） ══════════ */

  let reprojectPending = false;
  function reproject() {
    if (reprojectPending) return;
    reprojectPending = true;
    requestAnimationFrame(() => {
      reprojectPending = false;
      doReproject();
    });
  }

  function doReproject() {
    const alive = new Map();
    for (const side in state.sides) {
      const s = state.sides[side];
      const h = Math.max(s.pane.scrollHeight, s.pane.clientHeight);
      s.layer.style.height = h + 'px';
      s.svg.textContent = '';
      alive.set(side, new Set());
    }

    for (const item of state.items) {
      const s = state.sides[item.side];
      if (!s) continue;
      const el = s.anchorEl(item.anchor);
      if (!el || !el.isConnected) continue;
      const box = anchorBox(item.side, el);

      if (isNote(item)) {
        alive.get(item.side).add(item.id);
        let node = s.nodes.get(item.id);
        if (!node || !node.isConnected) {
          node = item.kind === 'sticky' ? buildSticky(item) : buildText(item);
          s.nodes.set(item.id, node);
          s.notes.appendChild(node);
        }
        placeNode(node, item, box);
      } else {
        const shape = buildShape(item, box);
        if (shape) s.svg.appendChild(shape);
      }
    }

    // 已經刪掉、或錨點暫時不在畫面上（PDF 頁面釋放了）的便利貼節點拿掉；
    // 正在打字的那一個不要動，免得游標跳掉
    for (const side in state.sides) {
      const s = state.sides[side];
      const keep = alive.get(side);
      for (const [id, node] of s.nodes) {
        if (keep.has(id)) continue;
        if (node.contains(document.activeElement) && find(id)) continue;
        node.remove();
        s.nodes.delete(id);
      }
    }
  }

  function placeNode(node, item, box) {
    const p = denorm(box, item.pos);
    node._box = box;
    node.style.left = p.x + 'px';
    node.style.top = p.y + 'px';
    if (item.kind === 'sticky') {
      const c = OLD_NOTE[item.color] || item.color;
      node.style.setProperty('--pl-note', c);
      node.classList.toggle('pl-collapsed', !!item.collapsed);
      if (!item.collapsed) {
        node.style.width = item.size[0] + 'px';
        node.style.height = item.size[1] + 'px';
      } else {
        node.style.width = node.style.height = '';
      }
      node.title = item.collapsed ? (item.text || '（空白便利貼）') + '\n點一下展開' : '';
    } else {
      node.style.color = item.color;
      node.style.fontSize = Math.max(8, item.fs * box.w) + 'px';
    }
  }

  /** 拖曳移動（便利貼的標題列、文字方塊的把手） */
  function makeDraggable(handle, node, item) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
      if (state.tool === 'eraser') return;
      drag = { x: e.clientX, y: e.clientY, left: parseFloat(node.style.left), top: parseFloat(node.style.top), before: clone(item), moved: false };
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      node.style.left = (drag.left + dx) + 'px';
      node.style.top = (drag.top + dy) + 'px';
    });
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved || !node._box) return;
      item.pos = norm(node._box, { x: parseFloat(node.style.left), y: parseFloat(node.style.top) });
      commit({ type: 'change', changes: [{ id: item.id, before: { pos: d.before.pos }, after: { pos: item.pos.slice() } }] });
      persist();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /* ══════════ 便利貼 ══════════ */

  function buildSticky(item) {
    const el = PL.el('div', { class: 'pl-sticky', 'data-pl-ui': '1', 'data-pl-note-id': item.id });

    const bar = PL.el('div', { class: 'pl-sticky-bar' });
    const grip = PL.el('span', { class: 'pl-sticky-grip', text: '便利貼', title: '拖曳移動' });
    const spacer = PL.el('span', { class: 'pl-spacer' });
    const bColor = PL.el('button', { title: '換顏色', text: '●' });
    const bMin = PL.el('button', { title: '收合成小圖示（不擋住文字）', text: '–' });
    const bDel = PL.el('button', { title: '刪除（可用 Ctrl+Z 復原）', text: '✕' });
    bar.append(grip, spacer, bColor, bMin, bDel);

    const ta = PL.el('textarea', { placeholder: '寫點什麼…（自動儲存）' });
    ta.value = item.text || '';
    const icon = PL.el('button', { class: 'pl-sticky-icon', title: '展開便利貼', text: '🗒' });
    el.append(bar, ta, icon);

    ta.addEventListener('input', () => { item.text = ta.value; persist(); sidebarSoon(); });
    ta.addEventListener('pointerdown', (e) => {
      if (state.tool === 'eraser') return;
      e.stopPropagation();
    });

    bColor.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = OLD_NOTE[item.color] || item.color;
      const next = NOTE_COLORS[(NOTE_COLORS.indexOf(cur) + 1) % NOTE_COLORS.length];
      commit({ type: 'change', changes: [{ id: item.id, before: { color: item.color }, after: { color: next } }] });
      item.color = next;
      persist(); reproject();
    });
    const setCollapsed = (v) => {
      commit({ type: 'change', changes: [{ id: item.id, before: { collapsed: !!item.collapsed }, after: { collapsed: v } }] });
      item.collapsed = v;
      persist(); reproject();
      if (!v) setTimeout(() => ta.focus(), 30);
    };
    bMin.addEventListener('click', (e) => { e.stopPropagation(); setCollapsed(true); });
    icon.addEventListener('click', (e) => {
      if (state.tool === 'eraser') return;
      e.stopPropagation();
      setCollapsed(false);
    });
    bDel.addEventListener('click', (e) => {
      e.stopPropagation();
      removeItems([item]);
    });

    makeDraggable(bar, el, item);
    makeDraggable(icon, el, item);

    // 使用者用右下角拉大小之後記起來
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(PL.debounce(() => {
        if (item.collapsed || !el.isConnected) return;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (w && h && (Math.abs(w - item.size[0]) > 1 || Math.abs(h - item.size[1]) > 1)) {
          item.size = [w, h];
          persist();
        }
      }, 300));
      ro.observe(el);
    }
    return el;
  }

  /* ══════════ 文字方塊 ══════════ */

  function buildText(item) {
    const el = PL.el('div', { class: 'pl-inktext', 'data-pl-ui': '1', 'data-pl-note-id': item.id });
    const grip = PL.el('span', { class: 'pl-inktext-grip', text: '⠿', title: '拖曳移動' });
    const body = PL.el('div', { class: 'pl-inktext-body', contenteditable: 'true', spellcheck: 'false' });
    body.textContent = item.text || '';
    el.append(grip, body);

    body.addEventListener('input', () => { item.text = body.innerText.replace(/\n$/, ''); persist(); });
    body.addEventListener('pointerdown', (e) => {
      if (state.tool === 'eraser') return;
      e.stopPropagation();
    });
    body.addEventListener('blur', () => {
      if (!(item.text || '').trim() && find(item.id)) {
        // 什麼都沒打就離開：當作沒放過（不進復原紀錄）
        state.items = state.items.filter((i) => i.id !== item.id);
        state.undo = state.undo.filter((op) => !(op.type === 'add' && op.items.length === 1 && op.items[0].id === item.id));
        persist(); reproject(); renderPalette();
      }
    });
    body.addEventListener('keydown', (e) => { if (e.key === 'Escape') body.blur(); });
    makeDraggable(grip, el, item);
    return el;
  }

  function removeItems(list) {
    const ids = new Set(list.map((i) => i.id));
    state.items = state.items.filter((i) => !ids.has(i.id));
    commit({ type: 'remove', items: list.map(clone) });
    persist();
    reproject();
    sidebarSoon();
  }

  /** 側欄點便利貼 → 捲過去並展開 */
  function focusNote(id, edit) {
    const item = find(id);
    if (!item) return;
    const s = state.sides[item.side];
    if (!s) return;
    if (item.kind === 'sticky' && item.collapsed) { item.collapsed = false; persist(); doReproject(); }
    let node = s.nodes.get(id);
    if (!node) {
      // PDF 頁面可能還沒渲染：先捲到錨點，等它畫出來
      const el = s.anchorEl(item.anchor);
      if (el) s.pane.scrollTo({ top: Math.max(0, anchorBox(item.side, el).y - 120), behavior: 'smooth' });
      setTimeout(() => focusNote(id, edit), 500);
      return;
    }
    if (!edit) {
      const top = parseFloat(node.style.top) - 120;
      s.pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      node.classList.add('pl-flash');
      setTimeout(() => node.classList.remove('pl-flash'), 1400);
    }
    const input = node.querySelector('textarea, [contenteditable]');
    if (input) setTimeout(() => input.focus(), edit ? 20 : 450);
  }

  const sidebarSoon = PL.debounce(() => { if (PL.renderSidebar) PL.renderSidebar(); }, 300);

  /* ══════════ 工具列 ══════════ */

  const ICON = {
    pen: '<path d="M4 20l1.2-4.2L15.5 5.5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8.2 18.8z"/><path d="M13.5 7.5l3 3"/>',
    marker: '<path d="M7 15l6.5-9.5a2 2 0 0 1 2.8-.5l1.7 1.2a2 2 0 0 1 .5 2.8L12 18.5z"/><path d="M7 15l-2 4h5l2-1.5"/>',
    arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
    text: '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
    sticky: '<path d="M5 4h14v10l-6 6H5z"/><path d="M13 20v-6h6"/>',
    eraser: '<path d="M7 20h12"/><path d="M5.6 14.6l8.5-8.5a2 2 0 0 1 2.8 0l2 2a2 2 0 0 1 0 2.8L12 18H8.9z"/><path d="M9.5 10.7l4.8 4.8"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>',
    eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 3.9M6.1 7.4A16 16 0 0 0 2 12s3.6 6.5 10 6.5a9.5 9.5 0 0 0 4-.9"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  const svgIcon = (k) => '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>';

  const TOOL_LABEL = {
    pen: ['畫筆', '自由手寫（P）'],
    marker: ['螢光筆', '半透明的粗筆，直接在版面上塗（H）'],
    arrow: ['箭頭', '拉一條箭頭；按住 Shift 鎖定 45°（A）'],
    rect: ['方框', '框住一塊區域；按住 Shift 畫正方形（R）'],
    ellipse: ['圈選', '圈起重點；按住 Shift 畫正圓（O）'],
    text: ['文字', '在頁面上點一下，直接打字（T）'],
    sticky: ['便利貼', '點一下貼一張便利貼，可拖曳、縮放、收合（N）'],
    eraser: ['橡皮擦', '點或拖過去就擦掉：線條、圖形、文字、便利貼、選字螢光筆都可以（E）']
  };
  const HOTKEY = { p: 'pen', h: 'marker', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', n: 'sticky', e: 'eraser' };

  let palette = null, clearMenu = null;

  function renderPalette() {
    if (!palette) return;
    palette.querySelectorAll('[data-tool]').forEach((b) => {
      b.classList.toggle('pl-on', b.getAttribute('data-tool') === state.tool);
    });
    palette.querySelectorAll('[data-color]').forEach((b) => {
      b.classList.toggle('pl-cur', b.getAttribute('data-color') === state.color);
    });
    palette.querySelectorAll('[data-width]').forEach((b) => {
      b.classList.toggle('pl-on', Number(b.getAttribute('data-width')) === state.width);
    });
    const u = palette.querySelector('[data-act="undo"]'), r = palette.querySelector('[data-act="redo"]');
    if (u) u.disabled = !state.undo.length;
    if (r) r.disabled = !state.redo.length;
    const eye = palette.querySelector('[data-act="eye"]');
    if (eye) {
      eye.innerHTML = svgIcon(state.hidden ? 'eyeOff' : 'eye');
      eye.title = state.hidden ? '顯示標註' : '暫時隱藏所有標註';
      eye.classList.toggle('pl-on', state.hidden);
    }
  }

  function buildPalette() {
    palette = PL.el('div', { id: 'pl-palette', 'data-pl-ui': '1', role: 'toolbar', 'aria-label': '標註工具' });

    const grip = PL.el('span', { class: 'pl-pal-grip', title: '拖曳移動工具列', text: '⠿' });
    palette.appendChild(grip);

    const tools = PL.el('div', { class: 'pl-pal-group' });
    TOOLS.forEach((t) => {
      const [label, tip] = TOOL_LABEL[t];
      const b = PL.el('button', { class: 'pl-pal-tool', 'data-tool': t, title: tip });
      b.innerHTML = svgIcon(t) + '<span>' + label + '</span>';
      b.addEventListener('click', () => PL.Overlay.setTool(t));
      tools.appendChild(b);
    });
    palette.appendChild(tools);

    const colors = PL.el('div', { class: 'pl-pal-group' });
    INK_COLORS.forEach((c) => {
      const b = PL.el('button', { class: 'pl-pal-color', 'data-color': c, title: '顏色', style: { background: c } });
      b.addEventListener('click', () => PL.Overlay.setColor(c));
      colors.appendChild(b);
    });
    palette.appendChild(colors);

    const widths = PL.el('div', { class: 'pl-pal-group' });
    WIDTHS.forEach((w) => {
      const b = PL.el('button', { class: 'pl-pal-width', 'data-width': String(w), title: ['細', '中', '粗'][WIDTHS.indexOf(w)] });
      b.appendChild(PL.el('i', { style: { width: (w * 2 + 2) + 'px', height: (w * 2 + 2) + 'px' } }));
      b.addEventListener('click', () => PL.Overlay.setWidth(w));
      widths.appendChild(b);
    });
    palette.appendChild(widths);

    const acts = PL.el('div', { class: 'pl-pal-group' });
    const act = (k, icon, tip, fn) => {
      const b = PL.el('button', { class: 'pl-pal-act', 'data-act': k, title: tip });
      b.innerHTML = svgIcon(icon);
      b.addEventListener('click', fn);
      acts.appendChild(b);
      return b;
    };
    act('undo', 'undo', '復原（Ctrl+Z）', undo);
    act('redo', 'redo', '重做（Ctrl+Shift+Z）', redo);
    act('eye', 'eye', '暫時隱藏所有標註', () => PL.Overlay.setHidden(!state.hidden));
    const bClear = act('clear', 'trash', '清除…', (e) => { e.stopPropagation(); toggleClearMenu(bClear); });
    act('close', 'close', '關閉工具列（Esc 只會放下目前的工具）', () => {
      PL.Overlay.togglePalette(false);
      const btn = document.getElementById('pl-inkbtn');
      if (btn) btn.classList.remove('pl-on');
    });
    palette.appendChild(acts);

    // 工具列可以拖到不礙事的地方
    let drag = null;
    grip.addEventListener('pointerdown', (e) => {
      const r = palette.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      palette.style.left = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
      palette.style.top = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + 'px';
      palette.style.transform = 'none';
    });
    grip.addEventListener('pointerup', () => { drag = null; });

    document.documentElement.appendChild(palette);
  }

  function toggleClearMenu(anchor) {
    if (!clearMenu) {
      clearMenu = PL.el('div', { id: 'pl-clearmenu', 'data-pl-ui': '1' });
      const item = (text, fn) => {
        const b = PL.el('button', { text });
        b.addEventListener('click', () => { clearMenu.classList.remove('pl-show'); fn(); });
        clearMenu.appendChild(b);
      };
      item('清除目前畫面上的標註', clearVisible);
      item('清除這份文獻的全部手寫標註與便利貼', () => {
        if (confirm('要清掉這份文獻上所有手寫標註、文字方塊與便利貼嗎？\n（選字螢光筆不受影響；清掉之後按 Ctrl+Z 可以復原）')) PL.Overlay.clearAll();
      });
      document.documentElement.appendChild(clearMenu);
      document.addEventListener('pointerdown', (e) => {
        if (clearMenu.classList.contains('pl-show') && !clearMenu.contains(e.target) && !anchor.contains(e.target)) {
          clearMenu.classList.remove('pl-show');
        }
      }, true);
    }
    const r = anchor.getBoundingClientRect();
    clearMenu.style.left = Math.max(8, Math.min(window.innerWidth - 280, r.right - 260)) + 'px';
    clearMenu.style.top = (r.bottom + 6) + 'px';
    clearMenu.classList.toggle('pl-show');
  }

  PL.Overlay.togglePalette = function (force) {
    if (!palette) buildPalette();
    const show = (force === undefined) ? !palette.classList.contains('pl-show') : !!force;
    palette.classList.toggle('pl-show', show);
    if (!show) {
      PL.Overlay.setTool(null);
      if (clearMenu) clearMenu.classList.remove('pl-show');
    } else if (state.hidden) {
      PL.Overlay.setHidden(false);
    }
    renderPalette();
    return show;
  };

  /* ══════════ 鍵盤 ══════════ */

  const typing = (t) => t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);

  document.addEventListener('keydown', (e) => {
    if (!PL.active) return;
    if (e.key === 'Escape' && state.tool) { PL.Overlay.setTool(null); return; }
    if (typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      if (e.shiftKey) { if (state.redo.length) { e.preventDefault(); redo(); } }
      else if (state.undo.length) { e.preventDefault(); undo(); }
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y') && state.redo.length) { e.preventDefault(); redo(); return; }
    // 工具列開著的時候，單鍵切換工具
    if (!mod && !e.altKey && palette && palette.classList.contains('pl-show')) {
      const t = HOTKEY[e.key.toLowerCase()];
      if (t) { e.preventDefault(); PL.Overlay.setTool(t); }
    }
  }, true);
})();
