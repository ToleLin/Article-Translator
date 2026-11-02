/* PaperLens — PDF 對照檢視器（原版面覆蓋式翻譯）
 *
 * 設計重點：右欄「不重排」。左右兩欄畫的是同一張頁面，
 * 右欄只是把原本的文字區塊用不透明底色蓋掉、在同一個位置放上譯文。
 *
 * 這樣圖、照片、公式、雙欄排版根本不需要重建，天生就是 1:1；
 * 連圖裡面的標籤（Laser projector、Retina…）也會就地變成中文。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  const T = globalThis.PLTranslate;
  const pdfjsLib = globalThis.pdfjsLib;

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');

  const $ = (id) => document.getElementById(id);
  const MAX_DPR = 1.5;          // 左右各一張畫布，解析度別開太高
  const KEEP_PAGES = 4;         // 離視窗太遠的頁面把畫布釋放掉

  const doc = {
    pdf: null, url: '', title: '',
    pages: [], zoom: 1, fitL: 1, fitR: 1,
    raw: null, columnMode: 'auto'
  };

  /* ══════════ PL 相容層（讓 annotate.js / overlay.js 直接沿用） ══════════ */

  PL.active = true;
  PL.mode = 'both';
  PL.isPdf = true;

  PL.setStatus = function (text, ratio) {
    const s = document.querySelector('#pl-bar .pl-status');
    const p = document.querySelector('#pl-bar .pl-prog > i');
    if (s && text != null) s.textContent = text;
    if (p && typeof ratio === 'number') p.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  };

  PL.pageKey = () => 'pdf:' + (doc.url || 'unknown');
  PL.pageTitle = () => doc.title || 'PDF';

  PL.scrollToBlock = function (index, side) {
    const b = PL.blocks[index];
    if (!b) return;
    const pane = side === 'left' ? $('pl-left') : $('pl-right');
    const el = side === 'left' ? b.left : b.right;
    if (!pane || !el) return;
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 100;
    pane.scrollTo({ top, behavior: 'smooth' });
    [b.left, b.right].forEach((x) => {
      if (!x) return;
      x.classList.add('pl-para-hit');
      setTimeout(() => x.classList.remove('pl-para-hit'), 1600);
    });
  };

  /* ══════════ 讀取 PDF ══════════ */

  function fileParam() {
    const m = /[?&]file=([^&]+)/.exec(location.search) || /[#&]file=([^&]+)/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function loadBytes(url) {
    if (/^file:/i.test(url)) {
      const allowed = await new Promise((res) => {
        try {
          if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
            chrome.extension.isAllowedFileSchemeAccess((x) => res(x !== false));
          } else res(true);
        } catch (e) { res(true); }
      });
      if (!allowed) {
        const err = new Error('沒有本機檔案的讀取權限');
        err.needFileAccess = true;
        throw err;
      }
      return new Promise((res, rej) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          if (xhr.response && xhr.response.byteLength) res(new Uint8Array(xhr.response));
          else rej(new Error('檔案是空的或讀取失敗'));
        };
        xhr.onerror = () => {
          const e = new Error('無法讀取本機檔案');
          e.needFileAccess = true;
          rej(e);
        };
        xhr.send();
      });
    }
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error('下載 PDF 失敗（HTTP ' + r.status + '）');
    return new Uint8Array(await r.arrayBuffer());
  }

  async function openPdf(bytes, url, name) {
    doc.url = url || name || 'local';
    PL.setStatus('解析 PDF…');

    doc.pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;

    let title = '';
    try {
      const meta = await doc.pdf.getMetadata();
      title = (meta && meta.info && meta.info.Title) || '';
    } catch (e) { /* 沒有中繼資料就用檔名 */ }
    doc.title = (title || name || decodeURIComponent((url || '').split('/').pop()) || 'PDF')
      .replace(/\.pdf$/i, '').replace(/\s+/g, ' ').slice(0, 200);
    document.title = 'PaperLens — ' + doc.title;

    $('pl-page-total').textContent = String(doc.pdf.numPages);
    $('pl-drop').classList.add('pl-hide');

    await extractAll();
    layoutPages();

    await PL.loadAnnotations();
    PL.applyAllAnnotations();
    if (PL.settings.showSidebar) PL.toggleSidebar(true);

    const n = PL.blocks.filter((b) => b.state !== 'skip').length;
    PL.setStatus('共 ' + doc.pdf.numPages + ' 頁 · ' + n + ' 段可翻譯', 0);

    T.prewarm();
    updateViewport();
    if (PL.settings.autoTranslate && !PL.settings.lazyTranslate) translateAll();
  }

  /* ══════════ 文字抽取 → 行 → 欄 → 段落 ══════════ */

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  }

  function toItems(textContent, viewport) {
    const items = [];
    for (const it of textContent.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]);
      if (!h || h > 200) continue;
      items.push({
        str: it.str, x: tx[4], y: tx[5] - h, h,
        w: Math.abs(it.width) * viewport.scale,
        fontName: it.fontName,
        rawTransform: it.transform,
        wRaw: Math.abs(it.width)
      });
    }
    return items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  /** 先分欄再分行：雙欄論文左右基線對齊，先分行會把兩欄併成一行 */
  function toLines(items) {
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(it.y - last.y) <= Math.max(2, last.h * 0.55)) {
        last.items.push(it);
        last.x = Math.min(last.x, it.x);
        last.right = Math.max(last.right, it.x + it.w);
        last.h = Math.max(last.h, it.h);
      } else {
        lines.push({ y: it.y, x: it.x, right: it.x + it.w, h: it.h, items: [it] });
      }
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.text = joinItems(l.items);
    }
    return lines.filter((l) => l.text.trim());
  }

  function joinItems(items) {
    let s = '', prev = null;
    for (const it of items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        if (gap > prev.h * 0.22 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
      }
      s += it.str;
      prev = it;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * 找出雙欄版面中間的溝槽。
   *
   * 不要求溝槽「完全沒有文字」—— 真實論文裡總會有幾行（作者列、通訊地址、
   * 跨欄公式）伸進中間。改成找「平滑後的覆蓋量明顯低於兩側」的山谷，
   * 再用「真正橫跨分割線的元素不能太多」來驗證。
   */
  function detectSplit(items, width, force) {
    const narrow = items.filter((it) => it.w > 0 && it.w < width * 0.55);
    if (narrow.length < 16) return force ? width / 2 : null;

    const BINS = 240, step = width / BINS;
    const cover = new Array(BINS).fill(0);
    for (const it of narrow) {
      const a = Math.max(0, Math.floor(it.x / step));
      const b = Math.min(BINS, Math.ceil((it.x + it.w) / step));
      for (let i = a; i < b; i++) cover[i]++;
    }

    const sm = cover.map((_, i) => {
      let sum = 0, n = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < BINS) { sum += cover[j]; n++; }
      }
      return sum / n;
    });

    const lo = Math.floor(BINS * 0.34), hi = Math.ceil(BINS * 0.66);
    let minI = -1, minV = Infinity;
    for (let i = lo; i < hi; i++) if (sm[i] < minV) { minV = sm[i]; minI = i; }
    if (minI < 0) return force ? width / 2 : null;

    const sides = [];
    for (let i = 0; i < BINS; i++) if (cover[i] > 0 && (i < lo || i >= hi)) sides.push(cover[i]);
    const split = (minI + 0.5) * step;
    if (force) return split;          // 使用者手動指定雙欄，就照山谷切下去

    if (sides.length < 10) return null;
    const typical = median(sides);
    if (typical < 3) return null;
    if (minV > typical * 0.35) return null;          // 中間沒有明顯的谷 → 當成單欄

    const straddle = narrow.filter((it) => it.x < split - step && it.x + it.w > split + step).length;
    if (straddle > narrow.length * 0.12) return null;

    const left = narrow.filter((it) => it.x + it.w / 2 < split).length;
    if (left < narrow.length * 0.2 || (narrow.length - left) < narrow.length * 0.2) return null;

    return split;
  }

  /**
   * 這一行屬於哪一組？
   *   0 = 跨欄（整行連續橫跨中央，例如標題、圖說）
   *   1 = 左欄　2 = 右欄
   *  -1 = 其實是「左右兩欄各自的一行剛好在同一條基線上」，要拆開
   */
  function rowGroup(row, split, width) {
    const left = row.items.filter((it) => it.x + it.w / 2 < split);
    const right = row.items.filter((it) => it.x + it.w / 2 >= split);
    if (!left.length) return 2;
    if (!right.length) return 1;

    // 有片段真的壓在分割線上 → 一定是連續的一行
    if (row.items.some((it) => it.x < split - 2 && it.x + it.w > split + 2)) return 0;

    // 否則看中間的空隙：字距那麼小代表是同一行，欄距那麼大代表是兩欄
    const leftEnd = Math.max.apply(null, left.map((it) => it.x + it.w));
    const rightStart = Math.min.apply(null, right.map((it) => it.x));
    return (rightStart - leftEnd) < width * 0.03 ? 0 : -1;
  }

  /** 頁碼、跨頁重複的頁首頁尾不必翻（原文會照常顯示，反正是 1:1 版面） */
  function markRunningHeads(pages) {
    const seen = new Map();
    const norm = (t) => t.replace(/\d+/g, '#').trim();
    const inBand = (row, p) => (row.y < p.h * 0.06) || (row.y + row.h > p.h * 0.94);

    for (const p of pages) {
      for (const row of p.rows) {
        if (!inBand(row, p)) continue;
        const key = norm(row.text);
        if (key) seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    for (const p of pages) {
      const drop = new Set();
      for (const row of p.rows) {
        if (!inBand(row, p)) continue;
        const t = row.text.trim();
        const kill = /^[ivxlcdm]+$/i.test(t) || /^[\d\s|/–—-]+$/.test(t)
          || /^(https?:\/\/|www\.)/i.test(t) || /doi\.org|arxiv:/i.test(t)
          || (pages.length > 1 && (seen.get(norm(t)) || 0) >= 2 && t.length < 160);
        if (kill) row.items.forEach((it) => drop.add(it));
      }
      if (drop.size) p.items = p.items.filter((it) => !drop.has(it));
    }
  }

  function buildParas(lines, bodySize, colWidth) {
    if (!lines.length) return [];
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i].y - lines[i - 1].y;
      if (g > 0) gaps.push(g);
    }
    const medGap = median(gaps) || bodySize * 1.25;

    const bodyRights = lines.filter((l) => l.h <= bodySize * 1.15).map((l) => l.right);
    const rightEdge = bodyRights.length ? median(bodyRights)
      : Math.max.apply(null, lines.map((l) => l.right));
    const shortBy = Math.max(bodySize * 3.2, (colWidth || 240) * 0.1);

    const out = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], prev = lines[i - 1];
      let brk = !cur;
      if (prev) {
        const gap = l.y - prev.y;
        if (gap > Math.max(medGap * 1.45, Math.max(l.h, prev.h) * 1.8)) brk = true;
        if (prev.right < rightEdge - shortBy) brk = true;
        if (Math.abs(l.h - prev.h) / Math.max(l.h, prev.h) > 0.08) brk = true;
        if (l.x > prev.x + bodySize * 0.9) brk = true;
      }
      if (brk) { cur = { lines: [] }; out.push(cur); }
      cur.lines.push(l);
    }

    return out.map((p) => ({
      text: joinLines(p.lines),
      lines: p.lines,
      top: Math.min.apply(null, p.lines.map((l) => l.y)),
      bottom: Math.max.apply(null, p.lines.map((l) => l.y + l.h)),
      left: Math.min.apply(null, p.lines.map((l) => l.x)),
      right: Math.max.apply(null, p.lines.map((l) => l.right)),
      size: median(p.lines.map((l) => l.h))
    })).filter((p) => p.text.trim());
  }

  function joinLines(lines) {
    let s = '';
    for (const l of lines) {
      if (!s) { s = l.text; continue; }
      if (/[‐-―-]$/.test(s) && /^[a-z]/.test(l.text)) {
        s = s.replace(/[‐-―-]$/, '') + l.text;
      } else s += ' ' + l.text;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  async function extractAll() {
    const total = doc.pdf.numPages;
    const raw = [];

    for (let n = 1; n <= total; n++) {
      PL.setStatus('讀取文字 ' + n + '/' + total + '…', n / total * 0.4);
      const page = await doc.pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = toItems(tc, vp);
      raw.push({ num: n, w: vp.width, h: vp.height, page, items, rows: toLines(items) });
    }

    markRunningHeads(raw);
    doc.raw = raw;          // 換欄數設定時不必重讀
    buildPages();
  }

  /** 依目前的欄數設定，把原始文字片段組成段落與區塊 */
  function buildPages() {
    const raw = doc.raw || [];
    const heights = [];
    raw.forEach((p) => p.items.forEach((it) => heights.push(it.h)));
    const bodySize = median(heights) || 10;

    doc.pages = [];
    PL.blocks = [];

    for (const p of raw) {
      const split = doc.columnMode === '1' ? null
        : detectSplit(p.items, p.w, doc.columnMode === '2');
      /* 欄位歸屬要以「整行」為單位判斷，不能逐個文字片段判斷。
         圖說是跨欄的一整行，但它由許多很窄的單字組成，
         逐字按中心點分的話會被硬生生切成左右兩個半句，
         各自翻譯、各自覆蓋，畫面就變成兩段殘句疊在一起。 */
      let bands, groups;
      if (split) {
        bands = [[0, p.w], [0, split], [split, p.w]];   // 第 0 組 = 跨欄
        groups = [[], [], []];
        for (const row of toLines(p.items)) {
          const g = rowGroup(row, split, p.w);
          if (g >= 0) {
            groups[g].push.apply(groups[g], row.items);
          } else {
            for (const it of row.items) {
              groups[(it.x + it.w / 2) < split ? 1 : 2].push(it);
            }
          }
        }
      } else {
        bands = [[0, p.w]];
        groups = [p.items.slice()];
      }

      const paras = [];
      groups.forEach((gItems, gi) => {
        paras.push.apply(paras, buildParas(toLines(gItems), bodySize, bands[gi][1] - bands[gi][0]));
      });

      const pg = {
        num: p.num, w: p.w, h: p.h, page: p.page, split, bodySize, paras,
        elL: null, elR: null, canvasL: null, canvasR: null,
        textlayer: null, trlayer: null, rendered: false, rendering: false
      };
      doc.pages.push(pg);

      paras.forEach((para) => {
        const i = PL.blocks.length;
        const skip = !/\p{L}{2,}/u.test(para.text)
          || (PL.settings.skipChinese && PL.cjkRatio(para.text) > 0.5);
        PL.blocks.push({
          i, page: pg, para, left: null, right: null,
          srcText: para.text, translated: null,
          state: skip ? 'skip' : 'pending'
        });
      });
    }
  }

  /* ══════════ 版面：左右兩欄各放同一份頁面 ══════════ */

  function layoutPages() {
    const hostL = $('pl-pages'), hostR = $('pl-out');
    hostL.textContent = '';
    hostR.textContent = '';

    const wL = Math.max(240, ($('pl-left').clientWidth || 620) - 30);
    const wR = Math.max(240, ($('pl-right').clientWidth || 620) - 30);
    const base = doc.pages[0] ? doc.pages[0].w : 600;
    doc.fitL = wL / base;
    doc.fitR = wR / base;

    for (const p of doc.pages) {
      p.elL = makePageShell(p, doc.fitL * doc.zoom, 'left');
      p.elR = makePageShell(p, doc.fitR * doc.zoom, 'right');
      hostL.appendChild(p.elL);
      hostR.appendChild(p.elR);
      releasePage(p);
    }

    PL.blocks.forEach((b) => { b.left = null; b.right = null; });
    if (PL.Overlay) PL.Overlay.reproject();
  }

  function makePageShell(p, scale, side) {
    const el = PL.el('div', { class: 'pdf-page', 'data-page': String(p.num), 'data-side': side });
    el.style.width = Math.round(p.w * scale) + 'px';
    el.style.height = Math.round(p.h * scale) + 'px';
    el.appendChild(PL.el('div', { class: 'pdf-wait', text: '第 ' + p.num + ' 頁' }));
    el.appendChild(PL.el('div', { class: 'pdf-pagelabel', text: String(p.num) }));
    return el;
  }

  function releasePage(p) {
    p.rendered = false;
    [p.canvasL, p.canvasR].forEach((c) => { if (c) { c.width = 0; c.height = 0; } });
    p.canvasL = p.canvasR = null;
    p.textlayer = p.trlayer = null;
    PL.blocks.forEach((b) => { if (b.page === p) { b.left = null; b.right = null; } });
  }

  async function renderPage(p) {
    if (p.rendered || p.rendering) return;
    p.rendering = true;
    try {
      const scaleL = doc.fitL * doc.zoom;
      const scaleR = doc.fitR * doc.zoom;
      const dpr = Math.min(MAX_DPR, globalThis.devicePixelRatio || 1);

      const vp = p.page.getViewport({ scale: scaleL * dpr });
      const canvasL = document.createElement('canvas');
      canvasL.width = Math.round(vp.width);
      canvasL.height = Math.round(vp.height);
      const ctx = canvasL.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvasL.width, canvasL.height);
      await p.page.render({ canvasContext: ctx, viewport: vp }).promise;

      // 右欄畫同一張圖，不用再跑一次渲染
      const canvasR = document.createElement('canvas');
      canvasR.width = Math.round(p.w * scaleR * dpr);
      canvasR.height = Math.round(p.h * scaleR * dpr);
      canvasR.getContext('2d', { alpha: false }).drawImage(canvasL, 0, 0, canvasR.width, canvasR.height);

      mountCanvas(p.elL, canvasL);
      mountCanvas(p.elR, canvasR);
      p.canvasL = canvasL;
      p.canvasR = canvasR;

      buildTextLayer(p, p.page.getViewport({ scale: scaleL }));
      buildTransLayer(p, scaleR);

      p.rendered = true;
      PL.applyAllAnnotations();
      Sync.markDirty();
      if (PL.Overlay) PL.Overlay.reproject();
      updateViewportSoon();
    } catch (e) {
      console.warn('[PaperLens] 第 ' + p.num + ' 頁渲染失敗', e);
      const w = p.elL && p.elL.querySelector('.pdf-wait');
      if (w) w.textContent = '第 ' + p.num + ' 頁渲染失敗';
    } finally {
      p.rendering = false;
    }
  }

  function mountCanvas(shell, canvas) {
    const wait = shell.querySelector('.pdf-wait');
    if (wait) wait.remove();
    const old = shell.querySelector('canvas');
    if (old) old.remove();
    shell.insertBefore(canvas, shell.firstChild);
  }

  /** 左欄：透明文字層，讓使用者可以選字、上螢光筆 */
  function buildTextLayer(p, cssVp) {
    const layer = PL.el('div', { class: 'pdf-textlayer' });
    const pending = [];

    for (const b of PL.blocks) {
      if (b.page !== p) continue;
      const wrap = PL.el('div', { class: 'pl-para', 'data-pl-b': String(b.i) });
      for (const line of b.para.lines) {
        for (const it of line.items) {
          const tx = pdfjsLib.Util.transform(cssVp.transform, it.rawTransform);
          const h = Math.hypot(tx[2], tx[3]);
          const span = document.createElement('span');
          span.textContent = it.str;
          span.style.left = tx[4] + 'px';
          span.style.top = (tx[5] - h) + 'px';
          span.style.fontSize = h + 'px';
          span.style.fontFamily = /serif|times|roman|georgia/i.test(it.fontName || '') ? 'serif' : 'sans-serif';
          wrap.appendChild(span);
          pending.push({ span, want: it.wRaw * cssVp.scale });
        }
      }
      layer.appendChild(wrap);
      b.left = wrap;
    }

    p.elL.appendChild(layer);
    p.textlayer = layer;

    const widths = pending.map((x) => x.span.offsetWidth);
    pending.forEach((x, k) => {
      if (widths[k] > 0 && x.want > 0) x.span.style.transform = 'scaleX(' + (x.want / widths[k]) + ')';
    });
  }

  /** 右欄：在原文字的位置蓋上不透明方塊，裡面放譯文 */
  function buildTransLayer(p, scale) {
    const layer = PL.el('div', { class: 'pdf-trlayer' });

    for (const b of PL.blocks) {
      if (b.page !== p) continue;
      if (b.state === 'skip') { b.right = null; continue; }

      const box = {
        x: b.para.left * scale,
        y: b.para.top * scale,
        w: Math.max(8, (b.para.right - b.para.left) * scale),
        h: Math.max(8, (b.para.bottom - b.para.top) * scale)
      };

      const pad = Math.max(1.5, b.para.size * scale * 0.28);
      const el = PL.el('div', {
        class: 'pl-tr', 'data-pl-b': String(b.i),
        'data-pl-state': b.state === 'done' ? null : b.state
      });
      el.style.left = (box.x - pad) + 'px';
      el.style.top = (box.y - pad) + 'px';
      el.style.width = (box.w + pad * 2) + 'px';
      el.style.minHeight = (box.h + pad * 2) + 'px';

      const bg = sampleBg(p.canvasR, box, p, scale);
      el.style.background = bg.css;
      el.style.color = bg.dark ? '#f4f6fb' : '#12141a';
      el.dataset.size = String(b.para.size * scale);

      layer.appendChild(el);
      b.right = el;
      if (b.translated) fillTranslation(b);
    }

    p.elR.appendChild(layer);
    p.trlayer = layer;
  }

  /** 取文字方塊周圍的底色，圖片上的標籤才不會被白底蓋掉一塊 */
  function sampleBg(canvas, box, p, scale) {
    const fallback = { css: '#ffffff', dark: false };
    if (!canvas || !canvas.width) return fallback;
    try {
      const k = canvas.width / (p.w * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const pts = [
        [box.x - 3, box.y + box.h / 2], [box.x + box.w + 3, box.y + box.h / 2],
        [box.x + box.w / 2, box.y - 3], [box.x + box.w / 2, box.y + box.h + 3]
      ];
      const rs = [], gs = [], bs = [];
      for (const [px, py] of pts) {
        const X = Math.round(px * k), Y = Math.round(py * k);
        if (X < 0 || Y < 0 || X >= canvas.width || Y >= canvas.height) continue;
        const d = ctx.getImageData(X, Y, 1, 1).data;
        rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
      }
      if (!rs.length) return fallback;
      const r = median(rs), g = median(gs), b = median(bs);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return { css: 'rgb(' + r + ',' + g + ',' + b + ')', dark: lum < 0.5 };
    } catch (e) {
      return fallback;
    }
  }

  /**
   * 把譯文塞進方塊。先在原字級附近二分搜尋，塞不下就收緊行距再試一次；
   * 真的還是放不下才讓方塊長出去（並標記起來），絕不把字切掉。
   */
  function fillTranslation(b) {
    const el = b.right;
    if (!el) return;

    el.textContent = b.translated;
    el.removeAttribute('data-pl-state');
    el.setAttribute('data-pl-done', '1');
    el.classList.remove('pl-overflow');
    el.style.height = '';

    const base = Number(el.dataset.size) || 12;
    const maxH = parseFloat(el.style.minHeight) || 40;
    const floor = Math.max(6, base * 0.55);      // 再小就看不清楚了，不如讓它長出去

    const fits = (size, lh) => {
      el.style.fontSize = size + 'px';
      el.style.lineHeight = String(lh);
      return el.scrollHeight <= maxH + 1;
    };

    for (const lh of [1.28, 1.12]) {
      let lo = floor, hi = base * 1.05, best = null;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid, lh)) { best = mid; lo = mid; } else hi = mid;
      }
      if (best) { fits(best, lh); return; }
    }

    fits(floor, 1.12);
    el.style.height = 'auto';
    el.classList.add('pl-overflow');
  }

  /* ══════════ 視窗範圍：渲染與翻譯 ══════════ */

  let queue = [], queued = new Set(), running = false, failures = 0;

  function updateViewport() {
    if (!doc.pdf) return;
    const L = $('pl-left'), R = $('pl-right');
    const lr = L.getBoundingClientRect(), rr = R.getBoundingClientRect();
    const M = 700;
    const near = new Set();

    for (const p of doc.pages) {
      if (!p.elL) continue;
      const a = p.elL.getBoundingClientRect();
      const b = p.elR.getBoundingClientRect();
      const nearL = a.bottom > lr.top - M && a.top < lr.bottom + M;
      const nearR = b.bottom > rr.top - M && b.top < rr.bottom + M;
      if (nearL || nearR) { near.add(p); renderPage(p); }
    }

    // 離太遠的頁面釋放畫布，長論文才不會吃光記憶體
    let far = 0;
    for (const p of doc.pages) {
      if (near.has(p) || !p.rendered) continue;
      far++;
      if (far > KEEP_PAGES) { releasePage(p); rebuildShell(p); }
    }

    if (!PL.settings.lazyTranslate) return;
    const hit = [];
    for (const b of PL.blocks) if (b.state === 'pending' && near.has(b.page)) hit.push(b.i);
    if (hit.length) enqueue(hit);
  }

  function rebuildShell(p) {
    [p.elL, p.elR].forEach((el) => {
      if (!el) return;
      el.textContent = '';
      el.appendChild(PL.el('div', { class: 'pdf-wait', text: '第 ' + p.num + ' 頁' }));
      el.appendChild(PL.el('div', { class: 'pdf-pagelabel', text: String(p.num) }));
    });
  }

  const updateViewportSoon = PL.throttleRaf(updateViewport);

  /* ══════════ 翻譯 ══════════ */

  function enqueue(list) {
    let added = 0;
    for (const i of list) {
      const b = PL.blocks[i];
      if (!b || b.state === 'done' || b.state === 'skip' || queued.has(i)) continue;
      queued.add(i); queue.push(i); added++;
    }
    if (added) pump();
  }

  function translateAll() {
    failures = 0;
    T.prewarm();
    enqueue(PL.blocks.map((b) => b.i));
  }
  PL.translateAll = translateAll;

  function sortByViewport() {
    if (queue.length < 3) return;
    const top = $('pl-right').getBoundingClientRect().top;
    queue.sort((a, b) => dist(a) - dist(b));
    function dist(i) {
      const b = PL.blocks[i];
      const el = b && (b.right || b.page.elR);
      if (!el) return 1e9;
      const rel = el.getBoundingClientRect().top - top;
      return rel >= 0 ? rel : -rel * 3;
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      await T.ensureSourceLang(PL.blocks.slice(0, 30).map((b) => b.srcText).join(' '));

      while (queue.length) {
        sortByViewport();

        const batch = [];
        let chars = 0;
        while (queue.length && batch.length < 24) {
          const i = queue[0];
          const b = PL.blocks[i];
          if (!b || b.state === 'done' || b.state === 'skip') { queue.shift(); queued.delete(i); continue; }
          if (batch.length && chars + b.srcText.length > 6000) break;
          queue.shift(); batch.push(b); chars += b.srcText.length;
        }
        if (!batch.length) continue;

        batch.forEach((b) => {
          b.state = 'working';
          if (b.right) b.right.setAttribute('data-pl-state', 'working');
        });

        try {
          const out = await T.translateCached(batch.map((b) => b.srcText));
          PL.lastEngine = T.lastEngine;
          batch.forEach((b, k) => {
            if (out[k] == null) {
              b.state = 'error';
              if (b.right) b.right.setAttribute('data-pl-state', 'error');
            } else {
              b.translated = out[k];
              b.state = 'done';
              if (b.right) { fillTranslation(b); PL.reapplyAnnotations(b.i); }
            }
          });
          failures = 0;
        } catch (e) {
          failures++;
          batch.forEach((b) => { if (b.state === 'working') b.state = 'pending'; });
          PL.setStatus('翻譯失敗（第 ' + failures + ' 次）：' + (e.message || e));
          if (failures >= 5) {
            PL.toast('翻譯連續失敗，先暫停。\n' + (e.message || e)
              + '\n\n到設定頁按「測試引擎可用性」看是哪個引擎有問題；'
              + '或在上方引擎選單直接指定 Edge。', 9000);
            queue.forEach((i) => queued.delete(i));
            queue = [];
            batch.forEach((b) => queued.delete(b.i));
            break;
          }
          await PL.sleep(1500 * failures);        // 被限流時退避久一點
          batch.forEach((b) => { queued.delete(b.i); });
          enqueue(batch.map((b) => b.i));
          continue;
        }
        batch.forEach((b) => queued.delete(b.i));
        report();
      }
      report(true);
    } finally {
      running = false;
      if (queue.length) setTimeout(pump, 500);
    }
  }

  function report(final) {
    const total = PL.blocks.filter((b) => b.state !== 'skip').length || 1;
    const done = PL.blocks.filter((b) => b.state === 'done').length;
    const err = PL.blocks.filter((b) => b.state === 'error').length;
    const eng = PL.lastEngine ? (globalThis.PL_ENGINE_LABEL[PL.lastEngine] || PL.lastEngine).split('（')[0] : '';
    let msg = done + '/' + total + (eng ? ' · ' + eng : '') + (err ? ' · ' + err + ' 段失敗' : '');
    if (final && !queue.length) {
      if (done >= total) msg = '完成 ' + msg;
      else if (PL.settings.lazyTranslate) msg = '已翻 ' + msg + '（捲到哪翻到哪）';
    }
    PL.setStatus(msg, done / total);
  }

  PL.retryFailed = function () {
    const bad = PL.blocks.filter((b) => b.state === 'error').map((b) => b.i);
    if (!bad.length) { PL.toast('沒有失敗的段落'); return; }
    failures = 0;
    bad.forEach((i) => { PL.blocks[i].state = 'pending'; });
    enqueue(bad);
  };

  /* ══════════ 捲動同步（兩欄頁序一致，用頁面位置對位） ══════════ */

  const Sync = PL.Sync = {
    dirty: true, lt: [], rt: [],
    markDirty() { this.dirty = true; scheduleOverlay(); },
    build() {
      const L = $('pl-left'), R = $('pl-right');
      const lo = L.getBoundingClientRect().top - L.scrollTop;
      const ro = R.getBoundingClientRect().top - R.scrollTop;
      this.lt = []; this.rt = [];
      for (const p of doc.pages) {
        if (!p.elL || !p.elR) continue;
        this.lt.push(p.elL.getBoundingClientRect().top - lo);
        this.rt.push(p.elR.getBoundingClientRect().top - ro);
      }
      this.dirty = false;
    },
    ensure() { if (this.dirty) this.build(); },
    idx(tops, v) {
      let lo = 0, hi = tops.length - 1, ans = 0;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (tops[m] <= v + 40) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return ans;
    }
  };

  const scheduleOverlay = PL.debounce(() => { if (PL.Overlay) PL.Overlay.reproject(); }, 180);

  let lock = 0;
  function syncFrom(side) {
    if (!PL.settings.syncScroll || PL.mode !== 'both') return;
    if (Date.now() < lock) return;
    Sync.ensure();
    if (Sync.lt.length < 1) return;

    const L = $('pl-left'), R = $('pl-right');
    const from = side === 'left' ? L : R;
    const to = side === 'left' ? R : L;
    const ft = side === 'left' ? Sync.lt : Sync.rt;
    const tt = side === 'left' ? Sync.rt : Sync.lt;

    const i = Sync.idx(ft, from.scrollTop);
    const pageH = (ft[i + 1] !== undefined ? ft[i + 1] - ft[i] : 1);
    const toH = (tt[i + 1] !== undefined ? tt[i + 1] - tt[i] : 1);
    const frac = pageH > 0 ? (from.scrollTop - ft[i]) / pageH : 0;
    const target = Math.max(0, tt[i] + frac * toH);

    if (Math.abs(to.scrollTop - target) < 2) return;
    lock = Date.now() + 80;
    to.scrollTop = target;
  }

  function currentPage() {
    const L = $('pl-left');
    const top = L.getBoundingClientRect().top;
    let cur = 1;
    for (const p of doc.pages) {
      if (p.elL && p.elL.getBoundingClientRect().top - top <= 80) cur = p.num;
    }
    return cur;
  }

  /* ══════════ 工具列與互動 ══════════ */

  function wireBar() {
    const engine = $('pl-engine');
    engine.appendChild(PL.el('option', { value: 'auto', text: '自動（依序備援）' }));
    ['chrome', 'edge', 'google', 'gemini'].forEach((k) => {
      engine.appendChild(PL.el('option', { value: k, text: globalThis.PL_ENGINE_LABEL[k] }));
    });
    engine.value = PL.settings.forceEngine || 'auto';
    engine.addEventListener('change', () => {
      PL.settings.forceEngine = engine.value === 'auto' ? null : engine.value;
      failures = 0;
      PL.toast('引擎切換為：' + (engine.value === 'auto' ? '自動' : globalThis.PL_ENGINE_LABEL[engine.value]));
    });

    $('pl-translate-all').addEventListener('click', translateAll);

    document.querySelectorAll('#pl-bar .pl-modes button').forEach((b) => {
      b.addEventListener('click', () => setMode(b.getAttribute('data-mode')));
    });
    setMode('both');

    const cols = $('pl-cols');
    if (cols) {
      cols.value = doc.columnMode;
      cols.addEventListener('change', () => {
        doc.columnMode = cols.value;
        if (!doc.pdf) return;
        PL.setStatus('重新分析版面…');
        buildPages();
        layoutPages();
        PL.applyAllAnnotations();
        updateViewport();
        const n = PL.blocks.filter((b) => b.state !== 'skip').length;
        PL.setStatus('共 ' + doc.pdf.numPages + ' 頁 · ' + n + ' 段可翻譯', 0);
      });
    }

    $('pl-zoom-in').addEventListener('click', () => setZoom(doc.zoom * 1.2));
    $('pl-zoom-out').addEventListener('click', () => setZoom(doc.zoom / 1.2));

    const sync = $('pl-sync');
    sync.classList.toggle('pl-on', !!PL.settings.syncScroll);
    sync.addEventListener('click', () => {
      PL.settings.syncScroll = !PL.settings.syncScroll;
      sync.classList.toggle('pl-on', PL.settings.syncScroll);
      globalThis.PL_saveSettings({ syncScroll: PL.settings.syncScroll });
    });

    const inkBtn = $('pl-inkbtn');
    if (inkBtn) inkBtn.addEventListener('click', () => {
      inkBtn.classList.toggle('pl-on', PL.Overlay.togglePalette());
    });

    PL.els.sideBtn = $('pl-sidebtn');
    $('pl-sidebtn').addEventListener('click', () => PL.toggleSidebar());
    $('pl-export').addEventListener('click', doExport);
    $('pl-options').addEventListener('click', () => PL.send({ type: 'openOptions' }).catch(() => {}));
  }

  function setMode(mode) {
    PL.mode = mode;
    const root = document.documentElement;
    root.classList.toggle('pl-only-dst', mode === 'dst');
    root.classList.toggle('pl-only-src', mode === 'src');
    document.querySelectorAll('#pl-bar .pl-modes button').forEach((b) => {
      b.classList.toggle('pl-on', b.getAttribute('data-mode') === mode);
    });
    relayout();
  }

  const relayout = PL.debounce(() => {
    if (!doc.pdf) return;
    const L = $('pl-left');
    const frac = L.scrollHeight ? L.scrollTop / L.scrollHeight : 0;
    layoutPages();
    requestAnimationFrame(() => {
      L.scrollTop = frac * L.scrollHeight;
      updateViewport();
    });
  }, 220);

  function setZoom(z) {
    doc.zoom = Math.max(0.4, Math.min(3, z));
    $('pl-zoom-label').textContent = Math.round(doc.zoom * 100) + '%';
    relayout();
  }

  function wirePanes() {
    const L = $('pl-left'), R = $('pl-right');
    PL.els.left = L;
    PL.els.right = R;

    L.addEventListener('scroll', PL.throttleRaf(() => {
      syncFrom('left');
      $('pl-page-cur').textContent = String(currentPage());
      updateViewportSoon();
    }), { passive: true });
    R.addEventListener('scroll', PL.throttleRaf(() => {
      syncFrom('right');
      updateViewportSoon();
    }), { passive: true });

    const g = $('pl-gutter');
    let dragging = false;
    g.addEventListener('mousedown', (e) => { dragging = true; g.classList.add('pl-dragging'); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const r = Math.max(0.2, Math.min(0.8, e.clientX / window.innerWidth));
      document.documentElement.style.setProperty('--pl-left-w', (r * 100) + '%');
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      g.classList.remove('pl-dragging');
      globalThis.PL_saveSettings({ splitRatio: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pl-left-w')) / 100 });
      relayout();
    });
    g.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--pl-left-w', '50%');
      relayout();
    });

    window.addEventListener('resize', relayout);

    /* 分頁在背景時 viewport 是 0，什麼都不會被判定為「在附近」。
       等它真的有尺寸了要自己補一次，否則會永遠停在等待畫面。 */
    if (typeof ResizeObserver !== 'undefined') {
      let lastW = 0;
      const ro = new ResizeObserver(() => {
        const w = L.clientWidth;
        if (!w) return;
        if (!lastW) { lastW = w; layoutPages(); updateViewport(); return; }
        lastW = w;
        Sync.markDirty();
        updateViewportSoon();
      });
      ro.observe(L);
      ro.observe(R);
    }

    if (PL.Overlay) {
      const mk = (pane, side) => ({
        pane,
        anchorAt(cx, cy) {
          const el = document.elementFromPoint(cx, cy);
          const pg = el && el.closest ? el.closest('.pdf-page') : null;
          if (pg && pane.contains(pg)) return pg;
          return nearestPageEl(pane, cy);
        },
        anchorEl(key) { return pane.querySelector('.pdf-page[data-page="' + String(key).slice(1) + '"]'); },
        keyOf(el) { return 'p' + el.getAttribute('data-page'); }
      });
      PL.Overlay.register('left', mk(L, 'left'));
      PL.Overlay.register('right', mk(R, 'right'));
    }
  }

  function nearestPageEl(pane, clientY) {
    let best = null, bd = Infinity;
    pane.querySelectorAll('.pdf-page').forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = clientY < r.top ? r.top - clientY : (clientY > r.bottom ? clientY - r.bottom : 0);
      if (d < bd) { bd = d; best = el; }
    });
    return best;
  }

  /* ══════════ 匯出：把兩欄都畫成圖片，手寫標註一起燒進去 ══════════ */

  async function doExport() {
    const pending = PL.blocks.filter((b) => b.state === 'pending' || b.state === 'working').length;
    if (pending && confirm('還有 ' + pending + ' 段沒翻完。\n\n按「確定」先翻完全文再匯出（建議），\n按「取消」直接用目前已翻好的內容匯出。')) {
      translateAll();
      await new Promise((res) => {
        const t = setInterval(() => {
          if (!PL.blocks.some((b) => b.state === 'pending' || b.state === 'working')) { clearInterval(t); res(); }
        }, 600);
        setTimeout(() => { clearInterval(t); res(); }, 240000);
      });
    }

    const rows = [];
    const ink = PL.Overlay ? PL.Overlay.items() : [];

    for (const p of doc.pages) {
      PL.setStatus('產生第 ' + p.num + ' 頁的匯出影像…');
      const pair = await renderPagePair(p, ink);
      rows.push({
        // 用 pair 而不是 media：頁面影像要左右並排，不能被當成「跨欄圖表」只印一張
        kind: 'pair', tag: 'figure', block: null, heading: 0, chrome: false, empty: false,
        src: '<img src="' + pair.src + '" alt="page ' + p.num + '">',
        dst: '<img src="' + pair.dst + '" alt="第 ' + p.num + ' 頁">'
      });
    }

    const payload = {
      title: doc.title, url: doc.url,
      createdAt: new Date().toISOString(),
      targetLang: PL.settings.targetLang,
      engine: PL.lastEngine || '',
      rows,
      notes: PL.getAnnotations().slice().sort((a, b) => (a.block - b.block) || (a.start - b.start)),
      stickies: ink.filter((i) => i.kind === 'sticky' && i.text)
        .map((i) => ({ page: String(i.anchor).slice(1), side: i.side, text: i.text }))
    };

    try {
      await PL.send({ type: 'export.open', payload });
      PL.setStatus('已開啟匯出分頁');
    } catch (e) {
      PL.toast('匯出失敗：' + (e.message || e), 5000);
    }
  }

  /** 把一頁畫成「原文」與「譯文」兩張 PNG，含手寫標註 */
  async function renderPagePair(p, ink) {
    const EXPORT_SCALE = 1.6;
    const vp = p.page.getViewport({ scale: EXPORT_SCALE });

    const src = document.createElement('canvas');
    src.width = Math.round(vp.width);
    src.height = Math.round(vp.height);
    const sctx = src.getContext('2d', { alpha: false });
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, src.width, src.height);
    await p.page.render({ canvasContext: sctx, viewport: vp }).promise;

    const dst = document.createElement('canvas');
    dst.width = src.width;
    dst.height = src.height;
    const dctx = dst.getContext('2d', { alpha: false });
    dctx.drawImage(src, 0, 0);

    // 譯文就地覆蓋
    for (const b of PL.blocks) {
      if (b.page !== p || !b.translated) continue;
      drawTranslatedBox(dctx, b, EXPORT_SCALE, src);
    }

    // 手寫標註燒進去（左右兩欄各自的筆跡都畫上，因為錨點都是「這一頁」）
    drawInk(sctx, ink.filter((i) => i.side === 'left' && i.anchor === 'p' + p.num), p, EXPORT_SCALE);
    drawInk(dctx, ink.filter((i) => i.side === 'right' && i.anchor === 'p' + p.num), p, EXPORT_SCALE);

    return { src: src.toDataURL('image/jpeg', 0.88), dst: dst.toDataURL('image/jpeg', 0.88) };
  }

  function drawTranslatedBox(ctx, b, scale, srcCanvas) {
    const pad = Math.max(1.5, b.para.size * scale * 0.28);
    const x = b.para.left * scale - pad;
    const y = b.para.top * scale - pad;
    const w = (b.para.right - b.para.left) * scale + pad * 2;
    const h = (b.para.bottom - b.para.top) * scale + pad * 2;

    const bg = sampleBgCanvas(srcCanvas, x, y, w, h);
    ctx.save();
    ctx.fillStyle = bg.css;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = bg.dark ? '#f4f6fb' : '#12141a';

    const font = '"Noto Serif TC","PingFang TC","Microsoft JhengHei",serif';
    let size = b.para.size * scale;
    let lines = null;
    for (let i = 0; i < 9 && size > 4; i++) {
      ctx.font = size + 'px ' + font;
      lines = wrapCanvasText(ctx, b.translated, w - 2);
      if (lines.length * size * 1.28 <= h) break;
      size *= 0.92;
    }
    ctx.font = size + 'px ' + font;
    ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, x + 1, y + 1 + i * size * 1.28));
    ctx.restore();
  }

  function wrapCanvasText(ctx, text, maxW) {
    const out = [];
    let cur = '';
    for (const ch of text) {
      const cand = cur + ch;
      if (ctx.measureText(cand).width > maxW && cur) { out.push(cur); cur = ch; }
      else cur = cand;
    }
    if (cur) out.push(cur);
    return out;
  }

  function sampleBgCanvas(canvas, x, y, w, h) {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const pts = [[x - 3, y + h / 2], [x + w + 3, y + h / 2], [x + w / 2, y - 3], [x + w / 2, y + h + 3]];
      const rs = [], gs = [], bs = [];
      for (const [px, py] of pts) {
        const X = Math.round(px), Y = Math.round(py);
        if (X < 0 || Y < 0 || X >= canvas.width || Y >= canvas.height) continue;
        const d = ctx.getImageData(X, Y, 1, 1).data;
        rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
      }
      if (!rs.length) return { css: '#ffffff', dark: false };
      const r = median(rs), g = median(gs), b = median(bs);
      return {
        css: 'rgb(' + r + ',' + g + ',' + b + ')',
        dark: (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
      };
    } catch (e) {
      return { css: '#ffffff', dark: false };
    }
  }

  function drawInk(ctx, items, p, scale) {
    for (const it of items) {
      if (it.kind === 'sticky') continue;
      const pts = it.pts.map((n) => ({ x: n[0] * p.w * scale, y: n[1] * p.h * scale }));
      ctx.save();
      ctx.strokeStyle = it.color;
      ctx.lineWidth = it.width * scale * 0.7;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (it.kind === 'marker') ctx.globalAlpha = 0.35;

      if (it.kind === 'pen' || it.kind === 'marker') {
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
      } else {
        const a = pts[0], b = pts[pts.length - 1];
        if (it.kind === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (it.kind === 'rect') {
          ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        } else if (it.kind === 'arrow') {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          const len = Math.max(10, it.width * scale * 3);
          ctx.beginPath();
          ctx.moveTo(b.x - len * Math.cos(ang - 0.4), b.y - len * Math.sin(ang - 0.4));
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(b.x - len * Math.cos(ang + 0.4), b.y - len * Math.sin(ang + 0.4));
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  /* 除錯用 */
  PL.pdf = { doc, detectSplit, buildParas, toLines, renderPage, updateViewport };

  /* ══════════ 來自 background 的指令 ══════════ */

  const MY_MSGS = new Set(['pl.state', 'pl.command', 'pl.settings']);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    /* 只回應自己認得的訊息。對不認得的也回覆的話，
       設定頁送給背景服務的請求會被這裡搶先回一個 null，整個翻譯就斷了。 */
    if (!msg || !MY_MSGS.has(msg.type)) return false;

    (async () => {
      switch (msg.type) {
        case 'pl.state':
          return {
            active: true, pdf: true,
            blocks: PL.blocks.length,
            done: PL.blocks.filter((b) => b.state === 'done').length,
            notes: PL.getAnnotations().length,
            engine: PL.lastEngine || null
          };
        case 'pl.command':
          if (msg.command === 'highlight-selection') PL.highlightSelection(false);
          else if (msg.command === 'explain-selection') PL.highlightSelection(true);
          else if (msg.command === 'translate-all') translateAll();
          else if (msg.command === 'sidebar') PL.toggleSidebar();
          else if (msg.command === 'retry') PL.retryFailed();
          else if (msg.command === 'export-pdf') doExport();
          return { ok: true };
        case 'pl.settings':
          PL.settings = Object.assign({}, PL.settings, msg.patch || {});
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

  /* ══════════ 開檔畫面 ══════════ */

  function showDrop(msg, hint) {
    const d = $('pl-drop');
    d.classList.remove('pl-hide');
    if (msg) $('pl-drop-msg').textContent = msg;
    $('pl-drop-hint').innerHTML = hint || '';
  }

  function wireDrop() {
    const d = $('pl-drop');
    $('pl-pick').addEventListener('click', () => $('pl-file').click());
    $('pl-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) openFile(f);
      e.target.value = '';
    });
    ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => {
      e.preventDefault(); d.classList.add('pl-over');
    }));
    ['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => {
      e.preventDefault();
      if (t === 'dragleave' && e.relatedTarget) return;
      d.classList.remove('pl-over');
    }));
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) openFile(f);
    });
  }

  async function openFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      PL.toast('這不是 PDF 檔');
      return;
    }
    const buf = await file.arrayBuffer();
    await openPdf(new Uint8Array(buf), 'file:' + file.name, file.name);
  }

  /* ══════════ 啟動 ══════════ */

  (async function main() {
    PL.settings = await globalThis.PL_loadSettings();
    T.init({
      getSettings: () => PL.settings,
      onStatus: (t) => PL.setStatus(t),
      onNotice: (t, ms) => PL.toast(t, ms)
    });

    document.documentElement.classList.add('pl-active');
    document.documentElement.style.setProperty('--pl-trans-font', PL.settings.transFont);
    document.documentElement.style.setProperty('--pl-left-w', (PL.settings.splitRatio * 100) + '%');

    wireBar();
    wirePanes();
    wireDrop();
    PL.wireAnnotations();

    const url = fileParam();
    if (!url) {
      showDrop('把 PDF 檔拖進來，或按下面的按鈕選擇。');
      PL.setStatus('等待檔案');
      return;
    }

    PL.setStatus('下載 PDF…');
    try {
      const bytes = await loadBytes(url);
      await openPdf(bytes, url, decodeURIComponent(url.split('/').pop() || ''));
    } catch (e) {
      PL.setStatus('開啟失敗');
      if (e && e.needFileAccess) {
        showDrop('沒有本機檔案的讀取權限，所以無法自動開啟這個 PDF。',
          '要讓 PaperLens 自動開啟本機 PDF，請到 <code>chrome://extensions</code> → 找到 PaperLens → 「詳細資料」→ 打開<b>「允許存取檔案網址」</b>，然後重新整理這一頁。\n\n'
          + '不想開權限的話，直接把 PDF 拖進這個視窗也可以。');
      } else {
        showDrop('開啟失敗：' + (e.message || e), '可以改用拖曳或「選擇 PDF 檔案」的方式開啟。');
      }
    }
  })();
})();
