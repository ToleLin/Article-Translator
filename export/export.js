/* PaperLens — 匯出頁：把收集到的對照內容排成可列印的雙欄版面 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let payload = null;
  let settings = null;

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('背景服務沒有回應'));
        if (!res.ok) return reject(new Error(res.error));
        resolve(res.data);
      });
    });
  }

  function status(t) { $('status').textContent = t || ''; }

  /* ══════════ 建立版面 ══════════ */

  function render() {
    $('title').textContent = payload.title || '（未命名文獻）';
    const d = new Date(payload.createdAt || Date.now());
    $('meta').textContent = payload.url + '　·　匯出於 ' + d.toLocaleString('zh-TW')
      + (payload.engine ? '　·　引擎 ' + payload.engine : '');

    const wrap = $('rows');
    wrap.textContent = '';

    for (const row of payload.rows) {
      if (row.empty && row.kind === 'pair') continue;

      const div = document.createElement('div');
      div.className = 'row';
      if (row.heading) div.classList.add('h' + row.heading);
      if (row.kind === 'media') div.dataset.media = '1';
      if (row.chrome) div.dataset.chrome = '1';

      const src = document.createElement('div');
      src.className = 'col src';
      src.innerHTML = row.src;

      const dst = document.createElement('div');
      dst.className = 'col dst';
      dst.innerHTML = row.dst;

      if (row.ink) {
        addInk(src, row.ink.src);
        addInk(dst, row.ink.dst);
      }

      div.append(src, dst);
      wrap.appendChild(div);
    }

    renderNotes();
    applyOptions();
    const skipped = payload.rows.filter((r) => r.chrome).length;
    status(payload.rows.length + ' 個段落' + (skipped ? '（其中 ' + skipped + ' 個是導覽/頁尾）' : ''));
  }

  /**
   * 手寫標註疊在段落上。座標本來就是「相對於段落方框的比例」，
   * 所以用 viewBox 0 0 1 1 + preserveAspectRatio none 直接畫，
   * 線寬再用 non-scaling-stroke 避免被拉扁。
   */
  function addInk(col, items) {
    if (!items || !items.length) return;
    col.style.position = 'relative';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none';

    for (const it of items) {
      if (it.kind === 'text') {
        // 文字方塊：位置是相對於段落方框的比例，字級是相對於段落寬度
        if (!(it.text || '').trim() || !it.pos) continue;
        col.style.containerType = 'inline-size';
        const t = document.createElement('div');
        t.textContent = it.text;
        t.style.cssText = 'position:absolute;white-space:pre-wrap;font-weight:600;line-height:1.35;pointer-events:none;'
          + 'text-shadow:0 0 2px #fff,0 0 2px #fff;font-family:system-ui,"Microsoft JhengHei",sans-serif;'
          + 'left:' + (it.pos[0] * 100) + '%;top:' + (it.pos[1] * 100) + '%;color:' + (it.color || '#ef4444')
          + ';font-size:' + Math.max(0.5, (it.fs || 0.03) * 100) + 'cqw';
        col.appendChild(t);
        continue;
      }
      const pts = it.pts || [];
      if (pts.length < 2) continue;
      const a = pts[0], b = pts[pts.length - 1];
      let el = null;

      if (it.kind === 'pen' || it.kind === 'marker') {
        el = document.createElementNS(NS, 'polyline');
        el.setAttribute('points', pts.map((q) => q[0] + ',' + q[1]).join(' '));
      } else if (it.kind === 'ellipse') {
        el = document.createElementNS(NS, 'ellipse');
        el.setAttribute('cx', (a[0] + b[0]) / 2);
        el.setAttribute('cy', (a[1] + b[1]) / 2);
        el.setAttribute('rx', Math.abs(b[0] - a[0]) / 2);
        el.setAttribute('ry', Math.abs(b[1] - a[1]) / 2);
      } else if (it.kind === 'rect') {
        el = document.createElementNS(NS, 'rect');
        el.setAttribute('x', Math.min(a[0], b[0]));
        el.setAttribute('y', Math.min(a[1], b[1]));
        el.setAttribute('width', Math.abs(b[0] - a[0]));
        el.setAttribute('height', Math.abs(b[1] - a[1]));
      } else if (it.kind === 'arrow') {
        el = document.createElementNS(NS, 'line');
        el.setAttribute('x1', a[0]); el.setAttribute('y1', a[1]);
        el.setAttribute('x2', b[0]); el.setAttribute('y2', b[1]);
      }
      if (!el) continue;

      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', it.color || '#ef4444');
      el.setAttribute('stroke-width', String(it.width || 3));
      el.setAttribute('vector-effect', 'non-scaling-stroke');
      el.setAttribute('stroke-linecap', 'round');
      if (it.kind === 'marker') el.setAttribute('stroke-opacity', '0.35');
      svg.appendChild(el);
    }
    col.appendChild(svg);
  }

  function renderNotes() {
    const list = $('noteslist');
    list.textContent = '';
    const notes = payload.notes || [];
    const stickies = payload.stickies || [];
    if (!notes.length && !stickies.length) { $('notesec').hidden = true; return; }

    for (const n of notes) {
      const li = document.createElement('li');

      const ex = document.createElement('div');
      ex.className = 'ex';
      ex.textContent = '「' + n.exact + '」';
      li.appendChild(ex);

      if (n.note) {
        const nt = document.createElement('div');
        nt.className = 'nt';
        nt.textContent = '心得：' + n.note;
        li.appendChild(nt);
      }
      if (n.ai) {
        const ai = document.createElement('div');
        ai.className = 'ai';
        ai.textContent = n.ai;
        li.appendChild(ai);
      }

      const w = document.createElement('div');
      w.className = 'where';
      w.textContent = (n.side === 'right' ? '譯文' : '原文') + ' · 第 ' + ((n.block | 0) + 1) + ' 段';
      li.appendChild(w);

      list.appendChild(li);
    }

    for (const st of stickies) {
      const li = document.createElement('li');
      const nt = document.createElement('div');
      nt.className = 'nt';
      nt.textContent = '便利貼：' + st.text;
      li.appendChild(nt);
      const w = document.createElement('div');
      w.className = 'where';
      w.textContent = (st.side === 'right' ? '譯文' : '原文') + ' · 第 ' + st.page + ' 頁';
      li.appendChild(w);
      list.appendChild(li);
    }

    $('notesec').hidden = false;
  }

  /* ══════════ 選項 ══════════ */

  function applyOptions() {
    const layout = $('layout').value;
    document.body.classList.toggle('only-dst', layout === 'dst');
    document.body.classList.toggle('only-src', layout === 'src');
    document.body.classList.toggle('no-hl', !$('hlprint').checked);
    document.body.classList.toggle('body-only', $('bodyonly').checked);

    document.documentElement.style.setProperty('--size', $('fontsize').value + 'pt');

    const orient = $('orient').value;
    const rule = orient === 'a3landscape' ? 'A3 landscape' : ('A4 ' + orient);
    $('page-rule').textContent = '@page { size: ' + rule + '; margin: 12mm; }';

    const wide = $('media').value === 'wide' && layout === 'pair';
    document.querySelectorAll('.row[data-media]').forEach((r) => r.classList.toggle('wide', wide));

    $('notesec').hidden = !($('notes').checked
      && ((payload.notes || []).length + (payload.stickies || []).length));

    saveOptions();
  }

  function saveOptions() {
    send({
      type: 'settings.set',
      patch: {
        exportLayout: $('layout').value,
        exportOrientation: $('orient').value,
        exportFontSize: Number($('fontsize').value),
        exportIncludeNotes: $('notes').checked,
        exportInlineImages: $('inline').checked,
        exportMedia: $('media').value,
        exportPrintHighlight: $('hlprint').checked,
        exportBodyOnly: $('bodyonly').checked
      }
    }).catch(() => {});
  }

  function loadOptions() {
    $('layout').value = settings.exportLayout || 'pair';
    $('orient').value = settings.exportOrientation || 'landscape';
    $('fontsize').value = String(settings.exportFontSize || 10.5);
    $('media').value = settings.exportMedia || 'wide';
    $('notes').checked = settings.exportIncludeNotes !== false;
    $('inline').checked = settings.exportInlineImages !== false;
    $('hlprint').checked = settings.exportPrintHighlight !== false;
    $('bodyonly').checked = settings.exportBodyOnly !== false;
  }

  /* ══════════ 圖片內嵌 ══════════ */

  async function inlineImages() {
    const imgs = Array.from(document.querySelectorAll('#rows img'))
      .filter((img) => /^https?:/i.test(img.getAttribute('src') || ''));
    if (!imgs.length) return;

    const urls = Array.from(new Set(imgs.map((i) => i.getAttribute('src'))));
    status('內嵌圖片 0/' + urls.length + '…');

    const map = {};
    const CHUNK = 12;
    for (let i = 0; i < urls.length; i += CHUNK) {
      const part = urls.slice(i, i + CHUNK);
      try {
        Object.assign(map, await send({ type: 'image.inline', urls: part }));
      } catch (e) { /* 這批抓不到就保留原網址 */ }
      status('內嵌圖片 ' + Math.min(i + CHUNK, urls.length) + '/' + urls.length + '…');
    }

    let ok = 0;
    for (const img of imgs) {
      const data = map[img.getAttribute('src')];
      if (data) { img.setAttribute('src', data); ok++; }
    }
    status('圖片就緒（' + ok + '/' + imgs.length + '）');
  }

  /* ══════════ 啟動 ══════════ */

  async function main() {
    status('載入中…');
    try {
      settings = await send({ type: 'settings.get' });
    } catch (e) {
      settings = globalThis.PL_DEFAULTS || {};
    }
    loadOptions();

    try {
      payload = await send({ type: 'export.take' });
    } catch (e) {
      payload = null;
    }

    if (!payload || !payload.rows || !payload.rows.length) {
      $('title').textContent = '沒有可匯出的內容';
      $('meta').textContent = '請回到文獻頁面，先開啟 PaperLens 對照閱讀，再按「匯出 PDF」。';
      status('');
      return;
    }

    render();
    document.title = 'PaperLens — ' + (payload.title || '匯出');

    ['layout', 'orient', 'fontsize', 'media', 'notes', 'hlprint', 'bodyonly'].forEach((id) => {
      $(id).addEventListener('change', applyOptions);
    });
    $('inline').addEventListener('change', () => {
      saveOptions();
      if ($('inline').checked) inlineImages();
    });
    $('print').addEventListener('click', () => window.print());

    // 桌面版：不用經過列印視窗，直接存成 PDF 檔
    if (globalThis.PLDesktop && PLDesktop.savePdf) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = '直接存成 PDF 檔';
      b.addEventListener('click', async () => {
        b.disabled = true;
        status('產生 PDF 中…');
        try {
          const r = await PLDesktop.savePdf({ title: payload.title || 'PaperLens' });
          status(r && r.filePath ? '已存到 ' + r.filePath : '已取消');
        } catch (e) {
          status('存檔失敗：' + (e.message || e));
        }
        b.disabled = false;
      });
      $('print').before(b);
      $('print').textContent = '列印…';
      $('print').classList.remove('primary');
      const hint = document.getElementById('hint');
      if (hint) hint.textContent = '按「直接存成 PDF 檔」就會存下左右對照的 PDF（含螢光筆底色）；要印到紙上再按「列印…」。';
    }

    if ($('inline').checked) await inlineImages();
    else status('就緒');
  }

  main();
})();
