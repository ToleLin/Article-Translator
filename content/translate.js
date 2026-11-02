/* PaperLens — 網頁對照的翻譯流程：抽取、排隊、批次送翻、回填
 * 引擎選擇、快取、備援、逾時都在 shared/translator.js，這裡只管 DOM 這一側。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  const T = globalThis.PLTranslate;

  const BATCH_CHARS = 6000;
  const BATCH_ITEMS = 24;

  let queue = [];                 // 待翻區塊 index
  let queued = new Set();
  let running = false;
  let io = null;
  let consecutiveFailures = 0;
  let noCache = false;            // 整份重翻（換成 Gemini）期間不讀快取

  T.init({
    getSettings: () => PL.settings || globalThis.PL_DEFAULTS,
    onStatus: (t) => PL.setStatus(t),
    onNotice: (t, ms) => PL.toast(t, ms)
  });

  /* ══════════ 準備 ══════════ */

  PL.prepareBlocks = function () {
    for (const b of PL.blocks) {
      const { text, atoms } = PL.atomize(b.right);
      b.srcText = text;
      b.atoms = atoms;
      b.plainText = b.right.textContent.replace(/\s+/g, ' ').trim();

      // 去掉佔位符之後如果沒剩下真正的文字（例如整段只有圖示連結），就不用送翻
      const bare = text.replace(PL.MARKER_RE, ' ').trim();
      PL.MARKER_RE.lastIndex = 0;

      if (!text || !/\p{L}{2,}/u.test(bare)) {
        mark(b, 'skip');
      } else if (PL.settings.skipChinese && PL.cjkRatio(text) > 0.5) {
        mark(b, 'skip');          // 本來就是中文，不用翻
      }
    }
  };

  function mark(b, state) {
    b.state = state;
    if (!b.right) return;
    if (state === 'done') {
      b.right.setAttribute('data-pl-done', '1');
      b.right.removeAttribute('data-pl-state');
    } else if (state === 'skip') {
      b.right.removeAttribute('data-pl-state');
    } else {
      b.right.setAttribute('data-pl-state', state);
    }
  }

  PL.ensureSourceLang = function () {
    const sample = PL.blocks.slice(0, 40).map((b) => b.srcText).filter(Boolean).join(' ');
    return T.ensureSourceLang(sample).then((lang) => { PL.sourceLang = lang; return lang; });
  };

  /* ══════════ 排隊 ══════════ */

  function enqueue(indexes) {
    let added = 0;
    for (const i of indexes) {
      const b = PL.blocks[i];
      if (!b || b.state === 'done' || b.state === 'skip' || queued.has(i)) continue;
      queued.add(i);
      queue.push(i);
      added++;
    }
    if (added) pump();
  }

  PL.translateAll = function () {
    if (!PL.active) return;
    consecutiveFailures = 0;
    T.prewarm();          // 這時通常帶著 user activation，內建模型才准開始下載
    enqueue(PL.blocks.map((b) => b.i));
    if (!queue.length && !running) PL.setStatus('全文都翻好了', 1);
  };

  /** 只翻視窗附近的段落（預設行為，長論文開起來很快） */
  function setupLazy() {
    if (io) io.disconnect();
    if (!PL.settings.lazyTranslate) { PL.translateAll(); return; }

    io = new IntersectionObserver((entries) => {
      const hit = [];
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const i = Number(e.target.getAttribute('data-pl-b'));
        if (!Number.isNaN(i)) hit.push(i);
      }
      if (hit.length) enqueue(hit);
    }, { root: PL.els.right, rootMargin: '1200px 0px', threshold: 0 });

    for (const b of PL.blocks) {
      if (b.state !== 'skip' && b.right) io.observe(b.right);
    }
  }
  PL.setupLazy = setupLazy;

  /** 開啟對照的當下就先把引擎探測跑掉，第一批翻譯才不用等 */
  PL.prewarmEngines = function () {
    PL.ensureSourceLang().then(() => T.prewarm()).catch(() => {});
  };

  PL.onViewportChange = function () { /* IntersectionObserver 已經處理，保留掛鉤 */ };

  /* ══════════ 主迴圈 ══════════ */

  async function pump() {
    if (running) return;
    running = true;

    try {
      await PL.ensureSourceLang();

      while (queue.length) {
        sortQueueByViewport();          // 先翻使用者正在看的

        const batch = [];
        let chars = 0;
        while (queue.length && batch.length < BATCH_ITEMS) {
          const i = queue[0];
          const b = PL.blocks[i];
          if (!b || b.state === 'done' || b.state === 'skip') { queue.shift(); queued.delete(i); continue; }
          if (batch.length && chars + b.srcText.length > BATCH_CHARS) break;
          queue.shift();
          batch.push(b);
          chars += b.srcText.length;
        }
        if (!batch.length) continue;

        batch.forEach((b) => mark(b, 'working'));
        try {
          await translateBatch(batch);
          consecutiveFailures = 0;
        } catch (e) {
          // 單一批次失敗不該讓整篇停住；連續失敗才判定是引擎全掛
          consecutiveFailures++;
          PL.setStatus('這批翻譯失敗：' + (e.message || e));
          if (consecutiveFailures >= 3) {
            PL.toast('連續 3 批翻譯都失敗，先暫停。\n' + (e.message || e)
              + '\n可到設定頁按「測試引擎可用性」看看是哪個環節有問題。', 7000);
            batch.forEach((b) => queued.delete(b.i));
            queue.forEach((i) => queued.delete(i));
            queue = [];
            break;
          }
          await PL.sleep(800 * consecutiveFailures);
        }
        batch.forEach((b) => queued.delete(b.i));
        reportProgress();
      }
      reportProgress(true);
    } catch (e) {
      PL.setStatus('翻譯中止：' + (e.message || e));
      PL.toast('翻譯中止：' + (e.message || e), 5000);
    } finally {
      running = false;
      if (queue.length) setTimeout(pump, 400);
    }
  }

  function sortQueueByViewport() {
    const pane = PL.els.right;
    if (!pane || queue.length < 3) return;
    const paneTop = pane.getBoundingClientRect().top;
    queue.sort((a, b) => dist(a) - dist(b));
    function dist(i) {
      const blk = PL.blocks[i];
      if (!blk || !blk.right || !blk.right.isConnected) return 1e9;
      const rel = blk.right.getBoundingClientRect().top - paneTop;
      return rel >= 0 ? rel : (-rel) * 3;      // 已經捲過去的往後排
    }
  }

  async function translateBatch(batch) {
    const out = await T.translateCached(batch.map((b) => b.srcText), { noCache });
    PL.lastEngine = T.lastEngine;

    const retry = [];
    batch.forEach((b, k) => {
      const t = out[k];
      if (t == null) { mark(b, 'error'); return; }
      if (lostContent(b, t)) retry.push(b);
      else render(b, t);
    });

    // 佔位符被引擎吃掉時，改用「純文字整段翻」；寧可失去連結也不能少內容
    if (retry.length) {
      try {
        const plain = await T.translateCached(retry.map((b) => b.plainText));
        retry.forEach((b, n) => {
          if (plain[n]) renderPlain(b, plain[n]);
          else mark(b, 'error');
        });
      } catch (e) {
        retry.forEach((b) => mark(b, 'error'));
      }
    }
  }

  /** 譯文裡遺失了「帶文字的原子元素」→ 代表有內容被吃掉 */
  function lostContent(b, translated) {
    if (!b.atoms || !b.atoms.length) return false;
    const found = new Set();
    PL.MARKER_RE.lastIndex = 0;
    let m;
    while ((m = PL.MARKER_RE.exec(translated))) found.add(Number(m[1]));
    let lostChars = 0;
    b.atoms.forEach((a, k) => {
      if (found.has(k)) return;
      const t = (a.textContent || '').trim();
      if (t.length > 3) lostChars += t.length;
    });
    return lostChars > Math.max(12, b.srcText.length * 0.08);
  }

  function render(b, translated) {
    const atoms = b.atoms.map((a) => a.cloneNode(true));
    PL.applyTranslation(b.right, translated, atoms);
    b.translated = translated;
    mark(b, 'done');
    afterRender(b);
  }

  function renderPlain(b, translated) {
    b.right.textContent = translated;
    b.translated = translated;
    mark(b, 'done');
    afterRender(b);
  }

  function afterRender(b) {
    if (PL.reapplyAnnotations) PL.reapplyAnnotations(b.i);
    scheduleResync();
  }

  const scheduleResync = PL.debounce(() => { if (PL.Sync) PL.Sync.markDirty(); }, 250);

  function reportProgress(final) {
    const total = PL.blocks.filter((b) => b.state !== 'skip').length || 1;
    const done = PL.blocks.filter((b) => b.state === 'done').length;
    const err = PL.blocks.filter((b) => b.state === 'error').length;
    const engineName = PL.lastEngine
      ? (globalThis.PL_ENGINE_LABEL[PL.lastEngine] || PL.lastEngine).split('（')[0] : '';

    let msg = done + '/' + total;
    if (engineName) msg += ' · ' + engineName;
    if (err) msg += ' · ' + err + ' 段失敗';
    if (final && !queue.length) {
      if (done >= total) { msg = '完成 ' + msg; noCache = false; }
      else if (PL.settings.lazyTranslate) msg = '已翻 ' + msg + '（捲到哪翻到哪）';
      else msg = '暫停 ' + msg;
    }
    PL.setStatus(msg, done / total);
  }

  PL.retryFailed = function () {
    const bad = PL.blocks.filter((b) => b.state === 'error').map((b) => b.i);
    if (!bad.length) { PL.toast('沒有失敗的段落'); return; }
    bad.forEach((i) => { PL.blocks[i].state = 'pending'; });
    enqueue(bad);
  };

  /** 換引擎或換語言後重翻全文；opts.noCache：不要拿快取裡舊引擎的譯文（例如改用 Gemini） */
  PL.retranslateAll = function (opts) {
    queue = []; queued = new Set();
    noCache = !!(opts && opts.noCache);
    for (const b of PL.blocks) {
      if (b.state === 'skip') continue;
      b.right.innerHTML = b.origHTML;
      const { text, atoms } = PL.atomize(b.right);
      b.srcText = text; b.atoms = atoms;
      b.plainText = b.right.textContent.replace(/\s+/g, ' ').trim();
      b.state = 'pending';
      mark(b, 'pending');
    }
    PL.Sync.markDirty();
    setupLazy();
    if (!PL.settings.lazyTranslate) PL.translateAll();
  };
})();
