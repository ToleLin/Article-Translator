/* PaperLens — PDF 對照檢視器（原版面覆蓋式翻譯）
 *
 * 設計重點：右欄「不重排」。左右兩欄畫的是同一張頁面，
 * 右欄只是把原本每一行字用同色的小方塊蓋掉、在同一個位置放上譯文。
 *
 * 這樣圖、照片、公式、雙欄排版根本不需要重建，天生就是 1:1；
 * 連圖裡面的標籤（Laser projector、Retina…）也會就地變成中文。
 *
 * 版面分析（哪些字是同一段、雙欄怎麼切、跨欄接續）在 pdf/layout.js。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  const T = globalThis.PLTranslate;
  const LAY = globalThis.PLLayout;
  const pdfjsLib = globalThis.pdfjsLib;

  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');

  const $ = (id) => document.getElementById(id);
  const MAX_DPR = 1.5;          // 左右各一張畫布，解析度別開太高
  const KEEP_PAGES = 4;         // 離視窗太遠的頁面把畫布釋放掉
  const CJK_SCALE = 0.88;       // 同字級的中文看起來比英文大一圈，縮一點才會跟原文一樣「重」
  const MIN_PX = 5.5;           // 再小就看不清楚了，寧可讓方塊長出去
  const JOBS = 3;               // 同時送出的翻譯請求數

  const doc = {
    pdf: null, url: '', title: '',
    raw: null, layout: null,
    pages: [], zoom: 1, fitL: 1, fitR: 1,
    columnMode: 'auto'
  };

  /* ══════════ PL 相容層（讓 annotate.js / overlay.js 直接沿用） ══════════ */

  PL.active = true;
  PL.mode = 'both';
  PL.isPdf = true;

  PL.setStatus = function (text, ratio) {
    const s = document.querySelector('#pl-bar .pl-status');
    const p = document.querySelector('#pl-bar .pl-prog > i');
    if (s && text != null) { s.textContent = text; s.title = text; }
    if (p && typeof ratio === 'number') p.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  };

  PL.pageKey = () => 'pdf:' + (doc.url || 'unknown');
  PL.pageTitle = () => doc.title || 'PDF';

  PL.scrollToBlock = function (index, side) {
    const b = PL.blocks[index];
    if (!b) return;
    const pane = side === 'left' ? $('pl-left') : $('pl-right');
    const el = (side === 'left' ? b.left : b.right) || (side === 'left' ? b.page.elL : b.page.elR);
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
    resetQueue();
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
    if (globalThis.PLDesktop && PLDesktop.docOpened) PLDesktop.docOpened();

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

  /* ══════════ 文字抽取 → 版面分析 ══════════ */

  async function extractAll() {
    const total = doc.pdf.numPages;
    const raw = new Array(total);
    let next = 1, done = 0;
    const worker = async () => {
      while (next <= total) {
        const n = next++;
        const page = await doc.pdf.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        raw[n - 1] = { num: n, w: vp.width, h: vp.height, vt: vp.transform, styles: tc.styles, items: tc.items, page };
        done++;
        PL.setStatus('讀取文字 ' + done + '/' + total + '…', done / total * 0.4);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    doc.raw = raw;          // 換欄數設定時不必重讀
    buildPages();
  }

  /** 依目前的欄數設定，把原始文字片段組成段落與區塊 */
  function buildPages() {
    const res = LAY.analyze(doc.raw, { columns: doc.columnMode });
    doc.layout = res;
    doc.pages = [];
    PL.blocks = [];

    res.pages.forEach((lp, k) => {
      const pg = {
        num: lp.num, w: lp.w, h: lp.h, page: doc.raw[k].page, lp,
        elL: null, elR: null, canvasL: null, canvasR: null,
        textlayer: null, trlayer: null, rendered: false, rendering: false, colored: false
      };
      doc.pages.push(pg);
      for (const blk of lp.blocks) {
        let state = blk.skip ? 'skip' : 'pending';
        if (state === 'pending' && PL.settings.skipChinese && PL.cjkRatio(blk.text) > 0.5) state = 'skip';
        // 參考文獻預設保留原文（設定頁可以改成要翻）
        if (state === 'pending' && blk.ref && !PL.settings.translateRefs) state = 'skip';
        blk.idx = PL.blocks.length;
        PL.blocks.push({
          i: blk.idx, page: pg, para: blk, left: null, right: null, rightText: null,
          srcText: blk.text, translated: null, engine: null, state
        });
      }
    });

    // 翻譯單位：被串起來的區塊（跨欄、跨頁的同一段話）一起送翻
    for (const b of PL.blocks) {
      b.prevI = b.para.prev && b.para.prev.idx != null ? b.para.prev.idx : -1;
      b.nextI = b.para.next && b.para.next.idx != null ? b.para.next.idx : -1;
    }
    for (const b of PL.blocks) {
      if (b.state !== 'skip') continue;
      if (b.prevI >= 0) PL.blocks[b.prevI].nextI = -1;
      if (b.nextI >= 0) PL.blocks[b.nextI].prevI = -1;
      b.prevI = b.nextI = -1;
    }
    for (const b of PL.blocks) {
      let h = b;
      while (h.prevI >= 0) h = PL.blocks[h.prevI];
      b.head = h.i;
    }
  }

  function chainOf(head) {
    const out = [];
    for (let b = PL.blocks[head]; b; b = b.nextI >= 0 ? PL.blocks[b.nextI] : null) out.push(b);
    return out;
  }

  function unitOf(head) {
    const blocks = chainOf(head);
    let text = '';
    for (const b of blocks) text = LAY.joinPieces(text, b.srcText, doc.layout && doc.layout.vocab);
    return { head, blocks, text };
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

    PL.blocks.forEach((b) => { b.left = null; b.right = null; b.rightText = null; });
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
    PL.blocks.forEach((b) => { if (b.page === p) { b.left = null; b.right = null; b.rightText = null; } });
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

      if (!p.colored) colorize(p, canvasL, scaleL * dpr);

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

  /* ══════════ 取色：每一行原文的底色與字色 ══════════
     一次把整頁像素讀出來（一次讀回，比每塊各讀一次快很多），
     在每一行字的方框裡找出現最多的顏色當底色、跟底色差最多的那一群當字色。
     白底黑字、藍底白字的橫幅、圖片上的標籤都能蓋得天衣無縫。 */

  function lum(r, g, b) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

  function sampleRect(data, W, H, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return null;
    const step = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) / 10));
    const bins = new Map();
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const o = (y * W + x) * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let e = bins.get(key);
        if (!e) bins.set(key, (e = [0, 0, 0, 0]));
        e[0]++; e[1] += r; e[2] += g; e[3] += b;
      }
    }
    let best = null;
    for (const e of bins.values()) if (!best || e[0] > best[0]) best = e;
    if (!best) return null;
    const bg = [best[1] / best[0], best[2] / best[0], best[3] / best[0]].map(Math.round);
    const bl = lum(bg[0], bg[1], bg[2]);
    /* 字色：小字的反鋸齒邊緣（灰色）往往比筆畫中心（黑色）還多，直接取「最多的」會變成灰字。
       改成：跟底色差夠多的那些顏色裡，由對比最強的開始累加，累積到兩成像素的那一個 */
    const cand = [];
    let total = 0;
    for (const e of bins.values()) {
      if (e === best) continue;
      const c = [e[1] / e[0], e[2] / e[0], e[3] / e[0]];
      const l = lum(c[0], c[1], c[2]);
      if (Math.abs(l - bl) < 0.3) continue;
      cand.push({ c, l, n: e[0], d: Math.abs(l - bl) });
      total += e[0];
    }
    let fg = null, fl = 0;
    if (total >= 3) {
      cand.sort((a, b) => b.d - a.d);
      let acc = 0;
      for (const x of cand) {
        acc += x.n;
        if (acc >= total * 0.2) { fg = x.c.map(Math.round); fl = x.l; break; }
      }
    }
    return {
      bg: 'rgb(' + bg.join(',') + ')', bgLum: bl,
      fg: fg ? 'rgb(' + fg.join(',') + ')' : null, fgLum: fl
    };
  }

  function colorize(p, canvas, k) {
    let data;
    try {
      data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (e) { return; }
    for (const blk of p.lp.blocks) {
      if (blk.skip) continue;
      for (const l of blk.lines) {
        const c = sampleRect(data, canvas.width, canvas.height,
          (l.x0 - 0.1 * l.h) * k, l.top * k, (l.x1 + 0.1 * l.h) * k, l.bottom * k);
        if (c) Object.assign(l, c);
      }
    }
    p.colored = true;
  }

  function blockColors(blk) {
    if (blk.colors) return blk.colors;
    const l0 = blk.lines.find((x) => x.bg) || {};
    const bg = l0.bg || 'rgb(255,255,255)';
    const bl = l0.bgLum != null ? l0.bgLum : 1;
    // 原文字色（藍色標題、白字橫幅）只要跟底色夠對比就沿用。
    // 用整段「多數決」：第一行剛好有一段藍色連結時，不能害整段都變藍
    const votes = new Map();
    for (const l of blk.lines) {
      if (!l.fg || Math.abs(l.fgLum - bl) < 0.35) continue;
      const key = l.fg.replace(/\d+/g, (v) => String(Math.round(v / 24)));
      const e = votes.get(key) || { w: 0, c: l.fg };
      e.w += Math.max(1, l.x1 - l.x0);
      votes.set(key, e);
    }
    let fg = null, best = 0;
    for (const e of votes.values()) if (e.w > best) { best = e.w; fg = e.c; }
    const res = { bg, fg: fg || (bl < 0.5 ? '#f4f6fb' : '#15171c'), light: bl >= 0.5 };
    if (l0.bg) blk.colors = res;
    return res;
  }

  /* ══════════ 左欄：透明文字層，讓使用者可以選字、上螢光筆 ══════════ */

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
          span.style.fontFamily = it.family || 'sans-serif';
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

  /* ══════════ 右欄：每一行原文蓋一塊同色的小方塊，譯文放在整段的範圍裡 ══════════
     只蓋「字本身」的範圍（不是整段的外框再加大），
     所以摘要外框的線、圖片、表格線都不會被白色方塊吃掉。 */

  function boxOf(blk, scale) {
    const padX = 0.12 * blk.h, padY = 0.04 * blk.h;
    return {
      x: (blk.x0 - padX) * scale,
      y: (blk.top - padY) * scale,
      w: (blk.x1 - blk.x0 + 2 * padX) * scale,
      h: (blk.bottom - blk.top + 2 * padY) * scale,
      padX, padY
    };
  }

  function maskRects(blk, scale, box) {
    return blk.lines.map((l) => ({
      x: (l.x0 - 0.15 * l.h) * scale - (box ? box.x : 0),
      y: (l.top - 0.05 * l.h) * scale - (box ? box.y : 0),
      w: (l.x1 - l.x0 + 0.3 * l.h) * scale,
      h: (l.bottom - l.top + 0.1 * l.h) * scale,
      bg: l.bg || 'rgb(255,255,255)'
    }));
  }

  function buildTransLayer(p, scale) {
    const layer = PL.el('div', { class: 'pdf-trlayer' });
    const lang = PL.settings.targetLang || 'zh-Hant';
    const ready = [];

    for (const b of PL.blocks) {
      if (b.page !== p) continue;
      if (b.state === 'skip') { b.right = null; b.rightText = null; continue; }
      const blk = b.para;
      const box = boxOf(blk, scale);
      const el = PL.el('div', {
        class: 'pl-tr', 'data-pl-b': String(b.i), lang,
        'data-pl-state': b.state === 'done' ? null : b.state
      });
      el.style.left = box.x + 'px';
      el.style.top = box.y + 'px';
      el.style.width = box.w + 'px';
      el.style.height = box.h + 'px';

      const bgs = PL.el('div', { class: 'pl-trbg' });
      for (const m of maskRects(blk, scale, box)) {
        const i = document.createElement('i');
        i.style.left = m.x + 'px';
        i.style.top = m.y + 'px';
        i.style.width = m.w + 'px';
        i.style.height = m.h + 'px';
        i.style.background = m.bg;
        bgs.appendChild(i);
      }
      const tx = PL.el('div', { class: 'pl-trtx' });
      if (blk.centered) tx.style.textAlign = 'center';
      const c = blockColors(blk);
      el.style.color = c.fg;
      el.dataset.bg = c.bg;
      // 淺色底的段落才套用使用者選的字色（藍底白字的橫幅維持白字）
      if (c.light) el.classList.add('pl-light');
      el.append(bgs, tx);

      layer.appendChild(el);
      b.right = el;
      b.rightText = tx;
      if (b.translated != null) ready.push(b);
    }

    p.elR.appendChild(layer);
    p.trlayer = layer;
    // 先放進頁面再填譯文：還沒放進去之前量不到高度（全部量成 0），
    // 字級跟行距會算錯 —— 背景翻好的頁面、縮放過的頁面捲過去時字會疊在一起
    for (const b of ready) fillTranslation(b);
  }

  /** 同一種原文字級 → 同一個譯文字級，整頁看起來才整齊；只有真的塞不下的段落才縮 */
  function targetPx(blk, scale) {
    return blk.h * CJK_SCALE * (PL.settings.transFontScale || 1) * scale;
  }

  function fillTranslation(b) {
    const el = b.right, tx = b.rightText;
    if (!el || !tx) return;
    tx.textContent = b.translated;
    el.removeAttribute('data-pl-state');
    el.setAttribute('data-pl-done', '1');
    fitText(b);
  }

  /**
   * 先用目標字級、緊湊行距量看看幾行；放不下才縮字（二分搜尋）。
   * 決定行數之後再把行距撐開到剛好填滿原文那一塊 —— 段落的頭尾會跟左邊原文對齊，
   * 而不是擠在上半部、下面留一大片空白。
   */
  function fitText(b) {
    const el = b.right, tx = b.rightText;
    if (!el || !tx) return;
    if (!el.isConnected) { b.needFit = true; return; }     // 等放進頁面再量
    b.needFit = false;
    const blk = b.para;
    const scale = doc.fitR * doc.zoom;
    const box = boxOf(blk, scale);
    el.classList.remove('pl-overflow');
    el.style.height = box.h + 'px';
    el.style.background = '';

    const H = (fs, lh) => {
      tx.style.fontSize = fs + 'px';
      tx.style.lineHeight = lh + 'px';
      return tx.offsetHeight;
    };
    const K = 1.22;
    const tfs = Math.max(MIN_PX, targetPx(blk, scale));
    let fs = tfs;
    let h = H(fs, K * fs);
    if (h > box.h + 0.5) {
      let lo = Math.max(MIN_PX, tfs * 0.5), hi = tfs;
      if (H(lo, K * lo) > box.h + 0.5) {
        // 縮到一半還塞不下（譯文比原文長很多）：先把行距收緊、再容許小一點的字，
        // 還是不行才讓方塊往下長 —— 長出去的部分會蓋到下一段，能不長就不長
        const K2 = 1.06;
        let lo2 = Math.max(MIN_PX * 0.8, tfs * 0.38), hi2 = lo;
        if (H(lo2, K2 * lo2) <= box.h + 0.5) {
          for (let k = 0; k < 8; k++) {
            const mid = (lo2 + hi2) / 2;
            if (H(mid, K2 * mid) <= box.h + 0.5) lo2 = mid; else hi2 = mid;
          }
          H(lo2, K2 * lo2);
          return;
        }
        fs = lo2;
        h = H(fs, K2 * fs);
        el.classList.add('pl-overflow');
        el.style.height = h + 'px';
        el.style.background = el.dataset.bg || '#fff';
        return;
      }
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2;
        if (H(mid, K * mid) <= box.h + 0.5) lo = mid; else hi = mid;
      }
      fs = lo;
      h = H(fs, K * fs);
    }
    const n = Math.max(1, Math.round(h / (K * fs)));
    const lh = Math.min(1.85 * fs, Math.max(K * fs, box.h / n));
    H(fs, lh);
  }

  /** 字型、字級改了，或網頁字型晚一點才載入（字寬會變）：已經顯示的譯文重新量一次 */
  function refitAll() {
    for (const b of PL.blocks) {
      if (b.right && b.rightText && b.translated != null && b.right.isConnected) fitText(b);
    }
  }
  PL.refitTranslations = refitAll;
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', PL.debounce(refitAll, 150));
  }

  /* ══════════ 視窗範圍：渲染與翻譯 ══════════ */

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

    if (!PL.settings.autoTranslate && !Q.started) return;
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

  /* ══════════ 翻譯 ══════════
     - 以「翻譯單位」（跨欄、跨頁串起來的同一段話）為單位排隊
     - 同時最多 3 個請求在跑，第一批刻意小一點，畫面最快出現譯文
     - 每一段一翻好就畫上去，不用等整批
     - 看得到的頁面先翻；翻完了就在背景把整篇翻完（可在設定頁關掉） */

  const Q = {
    queue: [], queued: new Set(), inflight: 0, failures: 0, paused: false, started: false, firstDone: false,
    gen: 0,            // 每次重置就加一：還在路上的舊請求回來時直接丟掉，不會蓋掉新的譯文
    noCache: false     // 「用 Gemini 重新翻譯整份」時不讀快取
  };

  function resetQueue() {
    Q.queue = []; Q.queued = new Set(); Q.failures = 0; Q.paused = false; Q.started = false; Q.firstDone = false;
    Q.gen++; Q.noCache = false;
  }

  /** 全部重翻（換了引擎之後用）；opts.noCache：不要拿快取裡舊引擎的譯文 */
  PL.retranslateAll = function (opts) {
    resetQueue();
    Q.noCache = !!(opts && opts.noCache);
    for (const b of PL.blocks) {
      if (b.state === 'skip') continue;
      b.translated = null;
      b.engine = null;
      setState(b, 'pending');
      if (b.right) {
        b.right.removeAttribute('data-pl-done');
        b.right.classList.remove('pl-overflow');
        b.right.style.background = '';
        if (b.rightText) b.rightText.textContent = '';
      }
    }
    report();
    translateAll();
  };

  function setState(b, s) {
    b.state = s;
    if (b.right) {
      if (s === 'done') b.right.removeAttribute('data-pl-state');
      else b.right.setAttribute('data-pl-state', s);
    }
  }

  /** manual：使用者自己選的段落 —— 只翻這幾段，不會因此開始自動翻整份 */
  function enqueue(list, manual) {
    let added = 0;
    for (const i of list) {
      const b = PL.blocks[i];
      if (!b) continue;
      const h = PL.blocks[b.head];
      if (h.state !== 'pending' && h.state !== 'error') continue;
      if (Q.queued.has(h.i)) continue;
      Q.queued.add(h.i); Q.queue.push(h.i); added++;
    }
    if (added) { if (!manual) Q.started = true; pump(); }
  }

  /** 翻譯指定的段落（選取文字按「翻譯」時用） */
  PL.translateBlocks = function (list) {
    const want = (list || []).filter((i) => PL.blocks[i] && (PL.blocks[i].state === 'pending' || PL.blocks[i].state === 'error'));
    if (!want.length) return 0;
    Q.paused = false; Q.failures = 0;
    want.forEach((i) => { if (PL.blocks[i].state === 'error') setState(PL.blocks[i], 'pending'); });
    enqueue(want, true);
    return want.length;
  };

  function translateAll() {
    Q.failures = 0; Q.paused = false; Q.started = true;
    T.prewarm();
    PL.blocks.forEach((b) => { if (b.state === 'error') b.state = 'pending'; });
    enqueue(PL.blocks.map((b) => b.i));
  }
  PL.translateAll = translateAll;

  function distOf(head) {
    const b = PL.blocks[head];
    const el = b && (b.right || (b.page && b.page.elR));
    if (!el) return 1e9;
    const top = $('pl-right').getBoundingClientRect().top;
    const rel = el.getBoundingClientRect().top - top;
    return rel >= 0 ? rel : -rel * 3;           // 已經捲過去的往後排
  }

  function takeJob() {
    if (Q.queue.length > 2) {
      const d = new Map(Q.queue.map((h) => [h, distOf(h)]));
      Q.queue.sort((a, b) => d.get(a) - d.get(b));
    }
    const small = !Q.firstDone;
    const maxItems = small ? 3 : 10, maxChars = small ? 900 : 3600;
    const job = [];
    let chars = 0;
    while (Q.queue.length && job.length < maxItems) {
      const h = Q.queue[0];
      const hb = PL.blocks[h];
      if (!hb || (hb.state !== 'pending' && hb.state !== 'error')) { Q.queue.shift(); Q.queued.delete(h); continue; }
      const u = unitOf(h);
      if (job.length && chars + u.text.length > maxChars) break;
      Q.queue.shift();
      job.push(u);
      chars += u.text.length;
    }
    return job;
  }

  function pump() {
    if (Q.paused) return;
    while (Q.inflight < JOBS && Q.queue.length) {
      const job = takeJob();
      if (!job.length) break;
      Q.inflight++;
      runJob(job).finally(() => {
        Q.inflight--;
        reportSoon();
        if (Q.queue.length) pump();
        else if (!Q.inflight) setTimeout(continueInBackground, 300);
      });
    }
  }

  let langReady = null;
  function ensureLang() {
    if (!langReady) {
      const sample = PL.blocks.filter((b) => b.state !== 'skip').slice(0, 30).map((b) => b.srcText).join(' ');
      langReady = T.ensureSourceLang(sample).catch(() => 'en');
    }
    return langReady;
  }

  function deliver(u, text, engine, force) {
    if (u.delivered && !force) return;
    u.delivered = true;
    // 引擎認為不用翻（人名、期刊名、參考文獻）：保留原文，不要蓋上一模一樣的英文
    if (engine === 'same' || String(text).replace(/\s+/g, ' ').trim() === u.text.replace(/\s+/g, ' ').trim()) {
      u.blocks.forEach((b) => { b.translated = null; b.engine = 'same'; setState(b, 'same'); });
      reportSoon();
      return;
    }
    const parts = LAY.splitTranslation(String(text), u.blocks.map((b) => Math.max(1, b.srcText.length)));
    u.blocks.forEach((b, k) => {
      b.translated = parts[k] || '';
      b.engine = engine || T.lastEngine;
      setState(b, 'done');
      if (b.right) { fillTranslation(b); PL.reapplyAnnotations(b.i); }
    });
    Q.firstDone = true;
    reportSoon();
  }

  async function runJob(units) {
    const gen = Q.gen;
    await ensureLang();
    if (gen !== Q.gen) return;
    units.forEach((u) => u.blocks.forEach((b) => setState(b, 'working')));
    try {
      const out = await T.translateCached(units.map((u) => u.text), {
        noCache: Q.noCache,
        onItem: (k, t, eng) => { if (gen === Q.gen) deliver(units[k], t, eng); }
      });
      if (gen !== Q.gen) return;          // 期間按了重翻、換了欄數：這批結果作廢
      PL.lastEngine = T.lastEngine;
      units.forEach((u, k) => {
        if (u.delivered) return;
        if (out[k] != null) deliver(u, out[k], out.engines && out.engines[k]);
        else u.blocks.forEach((b) => setState(b, 'error'));
      });
      Q.failures = 0;
      units.forEach((u) => Q.queued.delete(u.head));
    } catch (e) {
      if (gen !== Q.gen) return;
      Q.failures++;
      const left = units.filter((u) => !u.delivered);
      left.forEach((u) => u.blocks.forEach((b) => setState(b, 'pending')));
      units.filter((u) => u.delivered).forEach((u) => Q.queued.delete(u.head));
      const heads = left.map((u) => u.head);
      PL.setStatus('翻譯失敗（第 ' + Q.failures + ' 次）：' + (e.message || e));
      if (Q.failures >= 5) {
        Q.paused = true;
        heads.forEach((h) => Q.queued.delete(h));
        Q.queue.forEach((h) => Q.queued.delete(h));
        Q.queue = [];
        PL.toast('翻譯連續失敗，先暫停。\n' + (e.message || e)
          + '\n\n到設定頁按「測試引擎可用性」看是哪個引擎有問題；'
          + '或在上方引擎選單直接指定別的引擎，再按「翻譯全文」。', 9000);
      } else {
        setTimeout(() => {
          heads.forEach((h) => Q.queued.delete(h));
          enqueue(heads);
        }, 1500 * Q.failures);        // 被限流時退避久一點
      }
    }
  }

  /** 看得到的都翻完了：一頁一頁往後（再繞回前面）把整篇補完 */
  function continueInBackground() {
    if (Q.paused || Q.inflight || Q.queue.length || !Q.started) return;
    if (!PL.settings.lazyTranslate || PL.settings.bgTranslate === false) return;
    const cur = currentPage();
    const order = doc.pages.slice(cur - 1).concat(doc.pages.slice(0, cur - 1));
    for (const p of order) {
      const list = PL.blocks.filter((b) => b.page === p && b.state === 'pending').map((b) => b.i);
      if (list.length) { enqueue(list); return; }
    }
    Q.noCache = false;           // 整份都重翻完了，之後恢復用快取
  }

  function report(final) {
    const total = PL.blocks.filter((b) => b.state !== 'skip').length || 1;
    const done = PL.blocks.filter((b) => b.state === 'done' || b.state === 'same').length;
    const err = PL.blocks.filter((b) => b.state === 'error').length;
    const busy = Q.inflight > 0 || Q.queue.length > 0;
    const eng = PL.lastEngine ? (globalThis.PL_ENGINE_LABEL[PL.lastEngine] || PL.lastEngine).split('（')[0] : '';
    let msg = done + '/' + total + (eng ? ' · ' + eng : '') + (err ? ' · ' + err + ' 段失敗（可重試）' : '');
    if (!busy) {
      if (done >= total) msg = '完成 ' + msg;
      else if (Q.paused) msg = '暫停 ' + msg;
      else if (PL.settings.lazyTranslate) msg = '已翻 ' + msg + '（捲到哪翻到哪）';
    } else if (final !== true) {
      msg = '翻譯中 ' + msg;
    }
    PL.setStatus(msg, done / total);
  }
  // 節流而不是防抖：一段一段持續進來的時候，狀態列也要跟著動
  let reportTimer = null;
  function reportSoon() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => { reportTimer = null; report(); }, 150);
  }

  PL.retryFailed = function () {
    const bad = PL.blocks.filter((b) => b.state === 'error').map((b) => b.i);
    if (!bad.length) { PL.toast('沒有失敗的段落'); return; }
    Q.failures = 0; Q.paused = false;
    bad.forEach((i) => setState(PL.blocks[i], 'pending'));
    enqueue(bad);
  };

  /* ══════════ 段落工具：看原文、重翻、比較各引擎 ══════════
     游標停在譯文上會出現一顆小按鈕；點開可以把同一段丟給每一個引擎，
     並排比較哪一個翻得對，選中的那一份會直接套用並記進快取。 */

  let hoverBtn = null, hoverB = null, hoverTimer = null, panel = null;

  function showHoverBtn(b) {
    if (!hoverBtn) {
      hoverBtn = PL.el('button', { id: 'pl-blockbtn', 'data-pl-ui': '1', title: '這段的譯文工具：看原文、重翻、比較各引擎', text: '⋯' });
      hoverBtn.addEventListener('mousedown', (e) => e.preventDefault());
      hoverBtn.addEventListener('click', () => { if (hoverB) openPanel(hoverB); });
      hoverBtn.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
      hoverBtn.addEventListener('mouseleave', hideHoverBtnSoon);
      document.documentElement.appendChild(hoverBtn);
    }
    clearTimeout(hoverTimer);
    hoverB = b;
    const r = b.right.getBoundingClientRect();
    hoverBtn.style.left = Math.min(window.innerWidth - 30, r.right - 4) + 'px';
    hoverBtn.style.top = Math.max(48, r.top - 10) + 'px';
    hoverBtn.classList.add('pl-show');
  }

  function hideHoverBtnSoon() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (hoverBtn) hoverBtn.classList.remove('pl-show'); }, 450);
  }

  function engineName(k) {
    if (k === 'cache') return '快取';
    return ((globalThis.PL_ENGINE_LABEL[k] || k || '').split('（')[0]) || '未知';
  }

  function openPanel(b) {
    const u = unitOf(b.head);
    if (!panel) {
      panel = PL.el('div', { id: 'pl-cmp', 'data-pl-ui': '1' });
      document.documentElement.appendChild(panel);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.classList.remove('pl-show'); }, true);
    }
    panel.textContent = '';
    const close = PL.el('button', { class: 'pl-x', text: '✕', title: '關閉 (Esc)' });
    close.addEventListener('click', () => panel.classList.remove('pl-show'));
    const head = PL.el('header', {}, [
      PL.el('b', { text: '第 ' + b.page.num + ' 頁 · 這段的譯文' }),
      PL.el('span', { class: 'pl-spacer' }), close
    ]);
    const cur = u.blocks.map((x) => x.translated || '').join('');
    const src = PL.el('div', { class: 'pl-src', text: u.text });
    const now = PL.el('div', { class: 'pl-now' }, [
      PL.el('div', { class: 'pl-tag', text: '目前譯文 · ' + engineName(u.blocks[0].engine) }),
      PL.el('div', { class: 'pl-txt', text: cur || '（還沒翻譯）' })
    ]);
    const list = PL.el('div', { class: 'pl-list' });
    const bRe = PL.el('button', { text: '↻ 重新翻譯' });
    const bCmp = PL.el('button', { class: 'pl-primary', text: '⚖ 比較各引擎' });
    const bCopy = PL.el('button', { text: '⧉ 複製譯文' });
    const row = PL.el('div', { class: 'pl-row' }, [bCmp, bRe, bCopy]);
    panel.append(head, PL.el('div', { class: 'pl-tag', text: '原文' }), src, now, row, list);
    panel.classList.add('pl-show');

    const apply = (text, eng) => {
      T.cachePut(u.text, PL.settings.targetLang, text);
      deliver(u, text, eng, true);
      now.querySelector('.pl-txt').textContent = text;
      now.querySelector('.pl-tag').textContent = '目前譯文 · ' + engineName(eng);
    };

    bCopy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(u.blocks.map((x) => x.translated || '').join('')); PL.toast('已複製'); }
      catch (e) { PL.toast('複製失敗'); }
    });

    bRe.addEventListener('click', async () => {
      bRe.disabled = true;
      bRe.textContent = '翻譯中…';
      try {
        await ensureLang();
        const r = await T.translate([u.text], { exclude: [] });
        if (r.result[0]) apply(r.result[0], r.engine);
      } catch (e) {
        PL.toast('重新翻譯失敗：' + (e.message || e), 5000);
      }
      bRe.disabled = false;
      bRe.textContent = '↻ 重新翻譯';
    });

    bCmp.addEventListener('click', async () => {
      bCmp.disabled = true;
      list.textContent = '';
      const engines = engineList().filter((e) => e !== 'gemini' || PL.settings.geminiApiKey);
      await ensureLang();
      await Promise.all(engines.map(async (eng) => {
        const txt = PL.el('div', { class: 'pl-txt', text: '翻譯中…' });
        const use = PL.el('button', { text: '採用這個', disabled: 'disabled' });
        const item = PL.el('div', { class: 'pl-item' }, [
          PL.el('div', { class: 'pl-tag', text: engineName(eng) }), txt, use
        ]);
        list.appendChild(item);
        const t0 = performance.now();
        try {
          const r = await T.translateWith(eng, [u.text]);
          const t = r && r[0];
          if (!t) throw new Error('沒有回傳結果');
          txt.textContent = t;
          item.querySelector('.pl-tag').textContent = engineName(eng) + ' · ' + Math.round(performance.now() - t0) + ' ms';
          use.removeAttribute('disabled');
          use.addEventListener('click', () => { apply(t, eng); PL.toast('已套用 ' + engineName(eng) + ' 的譯文'); });
        } catch (e) {
          item.classList.add('pl-bad');
          txt.textContent = '無法使用：' + (e.message || e);
        }
      }));
      bCmp.disabled = false;
    });
  }

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
  function syncFrom(side, force) {
    if (!PL.settings.syncScroll || PL.mode !== 'both') return;
    if (!force && Date.now() < lock) return;
    Sync.ensure();
    if (Sync.lt.length < 1) return;

    const L = $('pl-left'), R = $('pl-right');
    const from = side === 'left' ? L : R;
    const to = side === 'left' ? R : L;

    // 放大之後左右也能捲：水平位置按比例同步
    const fw = from.scrollWidth - from.clientWidth, tw = to.scrollWidth - to.clientWidth;
    if (tw > 0) {
      const x = fw > 0 ? from.scrollLeft / fw * tw : 0;
      if (Math.abs(to.scrollLeft - x) >= 2) { lock = Date.now() + 80; to.scrollLeft = x; }
    }
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

  /** 桌面版沒有 Chrome 內建 AI（那是 Chrome 瀏覽器才有的功能） */
  const engineList = () => (globalThis.PLDesktop ? ['google', 'edge', 'gemini'] : ['chrome', 'edge', 'google', 'gemini']);

  function wireBar() {
    const styleBtn = $('pl-style-btn');
    if (styleBtn) styleBtn.addEventListener('click', () => PL.TextStyle && PL.TextStyle.toggle(styleBtn));
    const engine = $('pl-engine');
    engine.appendChild(PL.el('option', { value: 'auto', text: '自動（依序備援）' }));
    engineList().forEach((k) => {
      engine.appendChild(PL.el('option', { value: k, text: globalThis.PL_ENGINE_LABEL[k] }));
    });
    engine.value = PL.settings.forceEngine || 'auto';
    engine.addEventListener('change', () => {
      if (engine.value === 'gemini' && !PL.settings.geminiApiKey) {
        // 還沒有金鑰就選 Gemini：直接打開金鑰視窗
        engine.value = PL.settings.forceEngine || 'auto';
        PL.openGeminiDialog();
        return;
      }
      PL.settings.forceEngine = engine.value === 'auto' ? null : engine.value;
      Q.failures = 0; Q.paused = false;
      PL.refreshGeminiButton();
      PL.toast('引擎切換為：' + (engine.value === 'auto' ? '自動' : globalThis.PL_ENGINE_LABEL[engine.value]));
    });

    $('pl-gemini').addEventListener('click', () => PL.openGeminiDialog());
    PL.refreshGeminiButton();

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
        resetQueue();
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
    $('pl-sidebtn').addEventListener('click', () => PL.toggleSidebar(undefined, 'notes'));
    PL.els.lookupBtn = $('pl-lookupbtn');
    $('pl-lookupbtn').addEventListener('click', () => PL.toggleSidebar(undefined, 'tr'));
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

  /* 重新排版（縮放、改欄寬）之後，讓「原本在畫面某一點的那個位置」還留在同一點：
     用滑鼠滾輪放大時就是游標底下那個字，按按鈕時是畫面中央 */
  let zoomAnchor = null;

  function anchorInfo(pane, ax, ay) {
    const side = pane.id === 'pl-left' ? 'elL' : 'elR';
    const pr = pane.getBoundingClientRect();
    const cy = pr.top + ay;
    let best = null, bd = Infinity;
    for (const p of doc.pages) {
      const el = p[side];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const d = cy < r.top ? r.top - cy : (cy > r.bottom ? cy - r.bottom : 0);
      if (d < bd) { bd = d; best = { p, r }; }
    }
    if (!best) return null;
    return {
      pane, side, ax, ay, page: best.p,
      fx: (pr.left + ax - best.r.left) / best.r.width,
      fy: (cy - best.r.top) / best.r.height
    };
  }

  function restoreAnchor(a) {
    const el = a.page[a.side];
    if (!el) return;
    const pr = a.pane.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    a.pane.scrollTop += (r.top + a.fy * r.height) - (pr.top + a.ay);
    a.pane.scrollLeft += (r.left + a.fx * r.width) - (pr.left + a.ax);
    syncFrom(a.pane.id === 'pl-left' ? 'left' : 'right', true);
  }

  const relayout = PL.debounce(() => {
    if (!doc.pdf) return;
    const L = $('pl-left');
    const a = zoomAnchor || (L.clientWidth ? anchorInfo(L, L.clientWidth / 2, L.clientHeight / 2) : null);
    zoomAnchor = null;
    layoutPages();
    requestAnimationFrame(() => {
      if (a) restoreAnchor(a);
      updateViewport();
    });
  }, 160);

  /** anchor = { pane, x, y }（相對於欄的左上角），沒給就以左欄中央為準 */
  function setZoom(z, anchor) {
    const nz = Math.max(0.4, Math.min(4, z));
    if (Math.abs(nz - doc.zoom) < 0.001) return;
    // 一連串的滾輪事件只在第一下記錄錨點（之後版面還沒重排，記的位置才準）
    if (anchor && !zoomAnchor) zoomAnchor = anchorInfo(anchor.pane, anchor.x, anchor.y);
    doc.zoom = nz;
    $('pl-zoom-label').textContent = Math.round(doc.zoom * 100) + '%';
    relayout();
  }
  PL.setZoom = (z) => setZoom(z);

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
      if (hoverBtn) hoverBtn.classList.remove('pl-show');
    }), { passive: true });

    // 游標停在譯文上：右上角出現「⋯」段落工具（不再用滑鼠移動時一直跳的紫色框）
    const onOver = (e) => {
      if (PL.Overlay && PL.Overlay.tool) return;
      const el = e.target.closest && e.target.closest('[data-pl-b]');
      const b = el ? PL.blocks[Number(el.getAttribute('data-pl-b'))] : null;
      if (b && b.right && el === b.right && b.state === 'done') showHoverBtn(b);
    };
    R.addEventListener('mouseover', onOver);
    [L, R].forEach((pane) => pane.addEventListener('mouseleave', hideHoverBtnSoon));

    /* Ctrl + 滾輪、觸控板的捏合手勢：放大縮小 PDF 頁面（以游標所在位置為中心），
       不是放大整個視窗介面 */
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !doc.pdf) return;
      e.preventDefault();
      const pane = e.target.closest && e.target.closest('#pl-left, #pl-right');
      const p = pane || L;
      const r = p.getBoundingClientRect();
      const f = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.0025)));
      setZoom(doc.zoom * f, { pane: p, x: pane ? e.clientX - r.left : r.width / 2, y: pane ? e.clientY - r.top : r.height / 2 });
    }, { passive: false });

    // Ctrl + = / − / 0：放大、縮小、回到貼齊欄寬
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !doc.pdf) return;
      if (globalThis.PLDesktop) return;            // 桌面版由選單處理，避免放大兩次
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(doc.zoom * 1.2); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(doc.zoom / 1.2); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    }, true);

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
      let lastL = 0, lastR = 0;
      const ro = new ResizeObserver(() => {
        const wl = L.clientWidth, wr = R.clientWidth;
        if (!wl && !wr) return;
        if (!lastL && !lastR) {
          lastL = wl; lastR = wr;
          if (doc.pdf) { layoutPages(); updateViewport(); }
          return;
        }
        // 欄寬真的變了（打開註解側欄、拖分隔線、視窗縮放）→ 頁面重新貼齊欄寬，不然右邊會被切掉
        const changed = Math.abs(wl - lastL) > 24 || Math.abs(wr - lastR) > 24;
        lastL = wl; lastR = wr;
        Sync.markDirty();
        if (changed) relayout(); else updateViewportSoon();
      });
      ro.observe(L);
      ro.observe(R);
    }

    if (PL.Overlay) {
      const mk = (pane) => ({
        pane,
        anchorAt(cx, cy) {
          const el = document.elementFromPoint(cx, cy);
          const pg = el && el.closest ? el.closest('.pdf-page') : null;
          if (pg && pane.contains(pg)) return pg;
          return nearestPageEl(pane, cy);
        },
        anchorEl(key) { return pane.querySelector('.pdf-page[data-page="' + String(key).slice(1) + '"]'); },
        keyOf(el) { return 'p' + el.getAttribute('data-page'); },
        label(key) { return '第 ' + String(key).slice(1) + ' 頁'; }
      });
      PL.Overlay.register('left', mk(L));
      PL.Overlay.register('right', mk(R));
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

  /** 把一頁畫成「原文」與「譯文」兩張圖，含手寫標註 */
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
    if (!p.colored) colorize(p, src, EXPORT_SCALE);

    const dst = document.createElement('canvas');
    dst.width = src.width;
    dst.height = src.height;
    const dctx = dst.getContext('2d', { alpha: false });
    dctx.drawImage(src, 0, 0);

    // 譯文就地覆蓋（跟畫面上同一套：每行蓋同色小方塊、同樣的字級與行距規則）
    for (const b of PL.blocks) {
      if (b.page !== p || !b.translated || b.state === 'skip') continue;
      drawTranslatedBox(dctx, b, EXPORT_SCALE);
    }

    // 手寫標註燒進去（左右兩欄各自的筆跡都畫上，因為錨點都是「這一頁」）
    drawInk(sctx, ink.filter((i) => i.side === 'left' && i.anchor === 'p' + p.num), p, EXPORT_SCALE);
    drawInk(dctx, ink.filter((i) => i.side === 'right' && i.anchor === 'p' + p.num), p, EXPORT_SCALE);

    return { src: src.toDataURL('image/jpeg', 0.9), dst: dst.toDataURL('image/jpeg', 0.9) };
  }

  /* ---- canvas 上的換行：逐字量寬度（每個字只量一次），避頭點 ---- */

  const widthCache = new Map();
  function charW(ctx, font, ch) {
    const k = font + '\u0000' + ch;
    let w = widthCache.get(k);
    if (w === undefined) {
      ctx.font = '100px ' + font;
      w = ctx.measureText(ch).width / 100;
      widthCache.set(k, w);
    }
    return w;
  }

  const NO_START = /[，。、；：！？）」』】〉》,.;:!?)\]}%’”]/;

  function wrapCanvas(ctx, font, text, size, maxW) {
    const lines = [];
    let cur = '', w = 0;
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const cw = charW(ctx, font, ch) * size;
      if (cur && w + cw > maxW && !NO_START.test(ch)) {
        // 英文單字不要從中間切斷
        const m = /[A-Za-z0-9\-]+$/.exec(cur);
        if (m && m[0].length < cur.length && /[A-Za-z0-9]/.test(ch)) {
          lines.push(cur.slice(0, cur.length - m[0].length).replace(/\s+$/, ''));
          cur = m[0];
          w = Array.from(cur).reduce((s, c) => s + charW(ctx, font, c) * size, 0);
        } else {
          lines.push(cur.replace(/\s+$/, ''));
          cur = '';
          w = 0;
          if (ch === ' ') continue;
        }
      }
      cur += ch;
      w += cw;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function drawTranslatedBox(ctx, b, scale) {
    const blk = b.para;
    const box = boxOf(blk, scale);
    ctx.save();
    for (const m of maskRects(blk, scale, null)) {
      ctx.fillStyle = m.bg;
      ctx.fillRect(m.x, m.y, m.w, m.h);
    }
    const font = PL.settings.transFont || '"Noto Serif TC","PingFang TC","Microsoft JhengHei",serif';
    const K = 1.22;
    const tfs = Math.max(MIN_PX * scale / 1.6, targetPx(blk, scale));
    const fits = (fs) => wrapCanvas(ctx, font, b.translated, fs, box.w).length * K * fs <= box.h + 0.5;
    let fs = tfs;
    if (!fits(fs)) {
      let lo = tfs * 0.5, hi = tfs;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      fs = lo;
    }
    const lines = wrapCanvas(ctx, font, b.translated, fs, box.w);
    const n = Math.max(1, lines.length);
    const lh = Math.min(1.85 * fs, Math.max(K * fs, box.h / n));
    if (n * lh > box.h + 1) {
      ctx.fillStyle = blockColors(blk).bg;
      ctx.fillRect(box.x, box.y, box.w, n * lh);
    }
    ctx.fillStyle = blockColors(blk).fg;
    ctx.font = fs + 'px ' + font;
    ctx.textBaseline = 'middle';
    lines.forEach((ln, i) => {
      const x = blk.centered ? box.x + (box.w - ctx.measureText(ln).width) / 2 : box.x;
      ctx.fillText(ln, x, box.y + (i + 0.5) * lh);
    });
    ctx.restore();
  }

  function drawInk(ctx, items, p, scale) {
    for (const it of items) {
      if (it.kind === 'sticky') continue;           // 便利貼列在文末附錄
      if (it.kind === 'text') {
        if (!(it.text || '').trim()) continue;
        const fs = Math.max(8, it.fs * p.w * scale);
        ctx.save();
        ctx.font = '600 ' + fs + 'px system-ui, "Microsoft JhengHei", "PingFang TC", sans-serif';
        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = Math.max(2, fs / 6);
        ctx.fillStyle = it.color;
        String(it.text).split('\n').forEach((ln, k) => {
          const x = it.pos[0] * p.w * scale + 12, y = it.pos[1] * p.h * scale + k * fs * 1.35;
          ctx.strokeText(ln, x, y);
          ctx.fillText(ln, x, y);
        });
        ctx.restore();
        continue;
      }
      if (!it.pts || it.pts.length < 2) continue;
      const pts = it.pts.map((n) => ({ x: n[0] * p.w * scale, y: n[1] * p.h * scale }));
      ctx.save();
      ctx.strokeStyle = it.color;
      ctx.lineWidth = it.width * scale * 0.7;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (it.kind === 'marker') { ctx.globalAlpha = 0.38; ctx.globalCompositeOperation = 'multiply'; ctx.lineCap = 'butt'; }

      if (it.kind === 'pen' || it.kind === 'marker') {
        // 跟畫面上一樣用二次曲線把點接起來，匯出的筆跡才會一樣平滑
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
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
  PL.pdf = { doc, renderPage, updateViewport, openPdf, Q, unitOf, openPanel };

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
          else if (msg.command === 'sidebar') PL.toggleSidebar(undefined, 'notes');
          else if (msg.command === 'lookup') PL.toggleSidebar(undefined, 'tr');
          else if (msg.command === 'retry') PL.retryFailed();
          else if (msg.command === 'export-pdf') doExport();
          else if (msg.command === 'gemini-key') PL.openGeminiDialog();
          else if (msg.command === 'translate-selection') PL.translateSelection();
          else if (msg.command === 'zoom-in') setZoom(doc.zoom * 1.2);
          else if (msg.command === 'zoom-out') setZoom(doc.zoom / 1.2);
          else if (msg.command === 'zoom-reset') setZoom(1);
          return { ok: true };
        case 'pl.settings': {
          const patch = msg.patch || {};
          PL.settings = Object.assign({}, PL.settings, patch);
          // 設定頁改了外觀：馬上套用
          if ('transFont' in patch || 'transColor' in patch || 'transFontScale' in patch) {
            document.documentElement.style.setProperty('--pl-trans-font', PL.settings.transFont);
            if (PL.TextStyle) PL.TextStyle.apply();
            refitAll();
          }
          return { ok: true };
        }
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
    // 桌面版拿得到完整路徑：註解就綁在路徑上，不同資料夾的同名檔案不會混在一起
    const url = (globalThis.PLDesktop && PLDesktop.pathForFile && PLDesktop.pathForFile(file))
      ? 'file:' + PLDesktop.pathForFile(file) : 'file:' + file.name;
    await openPdf(new Uint8Array(buf), url, file.name);
  }
  PL.openPdfFile = openFile;
  /** 桌面版：主程序讀好檔案後直接把內容丟進來 */
  PL.openPdfBytes = (bytes, url, name) => openPdf(bytes, url, name);

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
    if (PL.TextStyle) PL.TextStyle.apply();
    document.documentElement.style.setProperty('--pl-left-w', (PL.settings.splitRatio * 100) + '%');

    wireBar();
    wirePanes();
    wireDrop();
    PL.wireAnnotations();

    const url = fileParam();
    if (!url) {
      showDrop('把 PDF 檔拖進來，或按下面的按鈕選擇。');
      PL.setStatus('等待檔案');
      // 桌面版：雙擊 PDF、從命令列帶進來的檔案，等檢視器準備好才交過來
      if (globalThis.PLDesktop && PLDesktop.viewerReady) PLDesktop.viewerReady();
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
