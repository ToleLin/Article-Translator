/* PaperLens — 手寫標註圖層與便利貼
 *
 * 網頁對照與 PDF 檢視器共用同一套。每一筆標註都「掛」在一個錨點元素上
 * （網頁是段落，PDF 是頁面），座標存成相對於錨點方框的比例，
 * 所以放大縮小、換引擎重翻、視窗改大小之後，標註都還在原本指的那個地方。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;

  const NS = 'http://www.w3.org/2000/svg';
  const TOOLS = ['pen', 'marker', 'ellipse', 'rect', 'arrow', 'sticky', 'eraser'];

  const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#111827'];

  const state = {
    tool: null,
    color: '#ef4444',
    width: 3,
    items: [],          // { id, side, anchor, kind, color, width, pts[] }  或便利貼
    sides: {},          // side -> { pane, layer, svg, anchorAt, anchorEl }
    drawing: null,
    loaded: false
  };

  const storeKey = () => 'ovl:' + PL.pageKey();

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
  }

  /* ══════════ 座標換算 ══════════ */

  /** 滑鼠座標 → 該欄「內容座標」（已含捲動量） */
  function toContent(side, clientX, clientY) {
    const s = state.sides[side];
    const r = s.pane.getBoundingClientRect();
    return {
      x: clientX - r.left + s.pane.scrollLeft,
      y: clientY - r.top + s.pane.scrollTop
    };
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

  function norm(box, pt) {
    return [(pt.x - box.x) / box.w, (pt.y - box.y) / box.h];
  }

  function denorm(box, n) {
    return { x: box.x + n[0] * box.w, y: box.y + n[1] * box.h };
  }

  /* ══════════ 圖層 ══════════ */

  PL.Overlay = {
    register(side, cfg) {
      const layer = PL.el('div', { class: 'pl-ovl', 'data-pl-ui': '1' });
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'pl-ovl-svg');
      layer.appendChild(svg);
      cfg.pane.appendChild(layer);

      state.sides[side] = {
        pane: cfg.pane, layer, svg,
        anchorAt: cfg.anchorAt,     // (clientX, clientY) -> 錨點元素
        anchorEl: cfg.anchorEl,     // key -> 錨點元素
        keyOf: cfg.keyOf,           // 錨點元素 -> key
        notes: PL.el('div', { class: 'pl-ovl-notes' })
      };
      layer.appendChild(state.sides[side].notes);

      wirePane(side);
      if (!state.loaded) load();
      return layer;
    },

    setTool(tool) {
      state.tool = (state.tool === tool) ? null : tool;
      document.documentElement.classList.toggle('pl-drawing', !!state.tool);
      for (const k in state.sides) {
        state.sides[k].layer.classList.toggle('pl-active-layer', !!state.tool && state.tool !== 'sticky');
      }
      renderPalette();
      return state.tool;
    },

    get tool() { return state.tool; },
    setColor(c) { state.color = c; renderPalette(); },
    setWidth(w) { state.width = w; renderPalette(); },

    reproject,
    clearSide(side) {
      state.items = state.items.filter((it) => it.side !== side);
      persist();
      reproject();
    },
    clearAll() {
      state.items = [];
      persist();
      reproject();
    },
    count: () => state.items.length,
    items: () => state.items.slice(),
    load
  };

  /* ══════════ 繪製 ══════════ */

  function wirePane(side) {
    const s = state.sides[side];

    s.layer.addEventListener('pointerdown', (e) => {
      if (!state.tool || state.tool === 'sticky') return;
      if (e.button !== 0) return;
      e.preventDefault();
      try { s.layer.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件沒有真的指標 */ }

      const pt = toContent(side, e.clientX, e.clientY);

      if (state.tool === 'eraser') { state.erasing = side; eraseAt(side, pt); return; }

      const anchorEl = anchorUnder(side, e.clientX, e.clientY);
      if (!anchorEl) return;
      const box = anchorBox(side, anchorEl);
      if (box.w < 4 || box.h < 2) return;      // 版面還沒量好，先不要記

      state.drawing = {
        id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        side,
        anchor: s.keyOf(anchorEl),
        anchorEl,
        kind: state.tool,
        color: state.color,
        width: state.tool === 'marker' ? 14 : state.width,
        pts: [norm(box, pt)],
        box
      };
      drawLive();
    });

    s.layer.addEventListener('pointermove', (e) => {
      if (state.erasing === side) {
        eraseAt(side, toContent(side, e.clientX, e.clientY));
        return;
      }
      const d = state.drawing;
      if (!d || d.side !== side) return;
      const pt = toContent(side, e.clientX, e.clientY);
      const n = norm(d.box, pt);
      if (d.kind === 'pen' || d.kind === 'marker') {
        const last = d.pts[d.pts.length - 1];
        const dx = (n[0] - last[0]) * d.box.w, dy = (n[1] - last[1]) * d.box.h;
        if (dx * dx + dy * dy < 4) return;        // 太密的點不收，檔案才不會爆
        d.pts.push(n);
      } else {
        d.pts[1] = n;
      }
      drawLive();
    });

    const finish = () => {
      state.erasing = null;
      const d = state.drawing;
      if (!d) return;
      state.drawing = null;
      if (d.pts.length < 2) { reproject(); return; }
      state.items.push({
        id: d.id, side: d.side, anchor: d.anchor, kind: d.kind,
        color: d.color, width: d.width, pts: d.pts
      });
      persist();
      reproject();
    };
    s.layer.addEventListener('pointerup', finish);
    s.layer.addEventListener('pointercancel', finish);

    // 便利貼：用貼紙工具在任意位置點一下
    s.layer.addEventListener('click', (e) => {
      if (state.tool !== 'sticky') return;
      const anchorEl = anchorUnder(side, e.clientX, e.clientY);
      if (!anchorEl) return;
      const box = anchorBox(side, anchorEl);
      if (box.w < 4 || box.h < 2) return;
      const pt = toContent(side, e.clientX, e.clientY);
      state.items.push({
        id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        side,
        anchor: s.keyOf(anchorEl),
        kind: 'sticky',
        color: state.color,
        pos: norm(box, pt),
        size: [200, 130],
        text: ''
      });
      persist();
      reproject();
      PL.Overlay.setTool(null);
    });
  }

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

  function drawLive() {
    const d = state.drawing;
    if (!d) return;
    const s = state.sides[d.side];
    let live = s.svg.querySelector('#pl-live');
    if (live) live.remove();
    live = buildShape(d, d.box);
    if (live) { live.setAttribute('id', 'pl-live'); s.svg.appendChild(live); }
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
        el.setAttribute('stroke-opacity', '0.35');
        el.setAttribute('stroke-linecap', 'butt');
      }
      el.setAttribute('data-pl-ink', item.id);
      return el;
    };

    if (item.kind === 'pen' || item.kind === 'marker') {
      const p = document.createElementNS(NS, 'polyline');
      p.setAttribute('points', pts.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '));
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
        distToSeg(pt, { x: x0, y: y0 }, { x: x1, y: y0 }),
        distToSeg(pt, { x: x1, y: y0 }, { x: x1, y: y1 }),
        distToSeg(pt, { x: x1, y: y1 }, { x: x0, y: y1 }),
        distToSeg(pt, { x: x0, y: y1 }, { x: x0, y: y0 })
      );
    }

    if (item.kind === 'ellipse') {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const rx = Math.max(1, Math.abs(b.x - a.x) / 2), ry = Math.max(1, Math.abs(b.y - a.y) / 2);
      const r = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry);
      return Math.abs(r - 1) * Math.min(rx, ry);
    }
    return Infinity;
  }

  function eraseAt(side, pt) {
    const s = state.sides[side];
    let hitId = null, bestD = Infinity;

    for (const item of state.items) {
      if (item.side !== side || item.kind === 'sticky') continue;
      const el = s.anchorEl(item.anchor);
      if (!el || !el.isConnected) continue;
      const box = anchorBox(side, el);
      const d = distToShape(item, box, pt);
      const tol = Math.max(12, (item.width || 3) * 1.6);
      if (d <= tol && d < bestD) { bestD = d; hitId = item.id; }
    }

    if (hitId) {
      state.items = state.items.filter((i) => i.id !== hitId);
      persist();
      reproject();
      return true;
    }
    return false;
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
    for (const side in state.sides) {
      const s = state.sides[side];
      const h = Math.max(s.pane.scrollHeight, s.pane.clientHeight);
      s.layer.style.height = h + 'px';
      s.svg.textContent = '';
      s.notes.textContent = '';
    }

    for (const item of state.items) {
      const s = state.sides[item.side];
      if (!s) continue;
      const el = s.anchorEl(item.anchor);
      if (!el || !el.isConnected) continue;
      const box = anchorBox(item.side, el);

      if (item.kind === 'sticky') {
        s.notes.appendChild(buildSticky(item, box));
      } else {
        const shape = buildShape(item, box);
        if (shape) s.svg.appendChild(shape);
      }
    }
  }

  /* ══════════ 便利貼 ══════════ */

  function buildSticky(item, box) {
    const p = denorm(box, item.pos);
    const el = PL.el('div', { class: 'pl-sticky', 'data-pl-ui': '1' });
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.width = item.size[0] + 'px';
    el.style.height = item.size[1] + 'px';
    el.style.setProperty('--pl-sticky', item.color);

    const bar = PL.el('div', { class: 'pl-sticky-bar' });
    const grip = PL.el('span', { class: 'pl-sticky-grip', text: '⠿', title: '拖曳移動' });
    const spacer = PL.el('span', { style: { flex: '1' } });

    const colorBtn = PL.el('button', { title: '換顏色', text: '●' });
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = COLORS.indexOf(item.color);
      item.color = COLORS[(i + 1) % COLORS.length];
      persist(); reproject();
    });

    const del = PL.el('button', { title: '刪除', text: '✕' });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.items = state.items.filter((x) => x.id !== item.id);
      persist(); reproject();
    });

    bar.append(grip, spacer, colorBtn, del);

    const ta = PL.el('textarea', { placeholder: '寫點什麼…' });
    ta.value = item.text || '';
    ta.addEventListener('input', () => { item.text = ta.value; persist(); });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());

    el.append(bar, ta);

    // 拖曳移動
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { x: e.clientX, y: e.clientY, left: p.x, top: p.y };
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const nx = drag.left + (e.clientX - drag.x);
      const ny = drag.top + (e.clientY - drag.y);
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
    });
    bar.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      item.pos = norm(box, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
      persist();
    });

    // 使用者用 CSS resize 改大小後記起來
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(PL.debounce(() => {
        const w = el.offsetWidth, h = el.offsetHeight;
        if (w && h && (w !== item.size[0] || h !== item.size[1])) {
          item.size = [w, h];
          persist();
        }
      }, 300));
      ro.observe(el);
    }

    return el;
  }

  /* ══════════ 工具面板 ══════════ */

  const TOOL_LABEL = {
    pen: ['✏', '畫筆'],
    marker: ['🖍', '螢光筆（自由塗）'],
    ellipse: ['◯', '圈選'],
    rect: ['▭', '方框'],
    arrow: ['↗', '箭頭'],
    sticky: ['🗒', '便利貼'],
    eraser: ['⌫', '橡皮擦']
  };

  let palette = null;

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
  }

  PL.Overlay.togglePalette = function (force) {
    if (!palette) {
      palette = PL.el('div', { id: 'pl-palette', 'data-pl-ui': '1' });

      TOOLS.forEach((t) => {
        const [icon, label] = TOOL_LABEL[t];
        const b = PL.el('button', { 'data-tool': t, title: label, text: icon });
        b.addEventListener('click', () => PL.Overlay.setTool(t));
        palette.appendChild(b);
      });

      palette.appendChild(PL.el('div', { class: 'pl-pal-div' }));

      COLORS.forEach((c) => {
        const b = PL.el('button', { class: 'pl-pal-color', 'data-color': c, style: { background: c }, title: c });
        b.addEventListener('click', () => PL.Overlay.setColor(c));
        palette.appendChild(b);
      });

      palette.appendChild(PL.el('div', { class: 'pl-pal-div' }));

      [2, 4, 7].forEach((w) => {
        const b = PL.el('button', { 'data-width': String(w), title: '粗細 ' + w, text: '•'.repeat(Math.ceil(w / 2)) });
        b.addEventListener('click', () => PL.Overlay.setWidth(w));
        palette.appendChild(b);
      });

      palette.appendChild(PL.el('div', { class: 'pl-pal-div' }));

      const clr = PL.el('button', { class: 'pl-pal-danger', text: '🗑', title: '清除這份文獻的所有手寫標註與便利貼' });
      clr.addEventListener('click', () => {
        if (confirm('要清掉這份文獻上所有手寫標註與便利貼嗎？（螢光筆選字註解不受影響）')) PL.Overlay.clearAll();
      });
      palette.appendChild(clr);

      document.documentElement.appendChild(palette);
    }

    const show = (force === undefined) ? !palette.classList.contains('pl-show') : !!force;
    palette.classList.toggle('pl-show', show);
    if (!show) PL.Overlay.setTool(null);
    renderPalette();
    return show;
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.tool) PL.Overlay.setTool(null);
  }, true);
})();
