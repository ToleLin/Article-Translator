/* PaperLens — content script 核心：狀態、工具函式、區塊偵測、翻譯快取 */
(function () {
  'use strict';
  if (globalThis.__PL_LOADED) return;
  globalThis.__PL_LOADED = true;

  const PL = globalThis.PL = {
    active: false,
    settings: null,
    sourceLang: null,
    blocks: [],            // { i, left, right, srcText, atoms, state }
    els: {},               // 各種 UI 元素
    version: '0.1.0'
  };

  /* ══════════ 小工具 ══════════ */

  PL.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  PL.hash = function (s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return s.length.toString(36) + '-' + (h >>> 0).toString(36);
  };

  PL.el = function (tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    if (kids) for (const c of [].concat(kids)) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  };

  PL.send = function (msg) {
    return new Promise((resolve, reject) => {
      let done = false;
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (done) return;
          done = true;
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('背景服務沒有回應'));
          if (!res.ok) return reject(new Error(res.error || '未知錯誤'));
          resolve(res.data);
        });
      } catch (e) {
        if (!done) { done = true; reject(e); }
      }
    });
  };

  let toastTimer = null;
  PL.toast = function (text, ms) {
    let t = PL.els.toast;
    if (!t) {
      t = PL.els.toast = PL.el('div', { id: 'pl-toast', 'data-pl-ui': '1' });
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('pl-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('pl-show'), ms || 2600);
  };

  PL.throttleRaf = function (fn) {
    let pending = false, lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; fn.apply(null, lastArgs); });
    };
  };

  PL.debounce = function (fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  };

  PL.pageKey = function () {
    const u = new URL(location.href);
    u.hash = '';
    // 去掉追蹤參數，讓同一篇論文的註解不會因為來源標記而分裂
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'from']
      .forEach((k) => u.searchParams.delete(k));
    return u.origin + u.pathname + (u.search || '');
  };

  PL.pageTitle = function () {
    const h1 = document.querySelector('h1');
    const t = (h1 && h1.textContent.trim()) || document.title || '';
    return t.replace(/\s+/g, ' ').slice(0, 220);
  };

  /* ══════════ 區塊偵測 ══════════ */

  // 完全不進入的元素
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS',
    'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MAP', 'AREA'
  ]);

  // 公式、程式碼高亮、我們自己的 UI
  const SKIP_CLASS = /(^|\s)(katex|mathjax|MathJax|mjx-\w+|hljs|highlight|prettyprint|linenums|sourceCode|pl-ui)(\s|$|_|-)/;

  /* 視為「區塊」的標籤。BLOCK_TAGS 與 BLOCK_SELECTOR 必須一致 ——
     不一致的話（例如把 <a> 也算區塊）同一段文字會被重複收錄兩次。 */
  const BLOCK_TAGS = new Set([
    'P', 'LI', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'TD', 'TH', 'SUMMARY',
    'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV',
    'ADDRESS', 'LEGEND', 'CENTER'
  ]);

  const BLOCK_SELECTOR = 'p,li,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,figcaption,caption,td,th,summary,'
    + 'div,section,article,aside,header,footer,main,nav,address,legend,center';

  // 內嵌但「可攤平成純文字」的標籤（翻譯時它們的樣式會消失，可接受）
  const TRANSPARENT = new Set(['EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'BIG', 'FONT', 'Q', 'INS', 'DEL', 'SPAN', 'TIME', 'BDI', 'BDO', 'WBR', 'RUBY', 'RT', 'RP']);

  const HAS_LETTER = /\p{L}/u;
  const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

  PL.isSkipped = function (el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute('data-pl-ui') || el.id === 'pl-bar' || el.id === 'pl-side') return true;
    if (el.getAttribute('translate') === 'no') return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls && SKIP_CLASS.test(cls)) return true;
    return false;
  };

  PL.cjkRatio = function (s) {
    const m = s.match(CJK);
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (!letters) return 0;
    return (m ? m.length : 0) / letters;
  };

  /**
   * 找出所有「葉區塊」：本身含有文字、但內部沒有更小的區塊。
   * 這是翻譯的最小單位 —— 整段送翻，語意才完整。
   */
  PL.collectBlocks = function (root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (PL.isSkipped(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let el;
    while ((el = walker.nextNode())) {
      if (!BLOCK_TAGS.has(el.tagName)) continue;
      if (el.querySelector(BLOCK_SELECTOR)) continue;          // 不是葉節點
      if (el.closest('[data-pl-ui]')) continue;

      const text = PL.blockText(el);
      if (text.length < 2 || !HAS_LETTER.test(text)) continue;
      // 只有數字、符號、單一標點的不翻
      if (!/\p{L}{2,}/u.test(text)) continue;

      out.push(el);
    }
    return out;
  };

  /**
   * 標記「不含可翻譯文字、但匯出 PDF 時必須保留」的單元：圖、表、公式、程式碼區。
   * 一定要在複製右欄「之前」做，右欄才會帶著同樣的編號。
   */
  PL.tagMedia = function (root) {
    let k = 0;
    const sel = 'table, figure, picture, img, pre, .katex-display, .MathJax_Display, math';
    root.querySelectorAll(sel).forEach((el) => {
      if (el.closest('[data-pl-b]')) return;      // 已經在某個翻譯段落裡
      if (el.closest('[data-pl-m]')) return;      // 已經被外層單元包住
      if (el.tagName === 'IMG' && el.closest('picture,figure')) return;
      el.setAttribute('data-pl-m', String(k++));
    });
    return k;
  };

  /** 取得區塊的可翻譯文字（跳過公式、程式碼等） */
  PL.blockText = function (el) {
    let s = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) s += node.nodeValue;
      else if (node.nodeType === 1 && !PL.isSkipped(node)) s += PL.blockText(node);
    }
    return s.replace(/\s+/g, ' ').trim();
  };

  /* ══════════ 佔位符：保護連結／上標／公式／圖片 ══════════ */

  const MARK_OPEN = '⟦', MARK_CLOSE = '⟧';
  PL.MARKER_RE = /⟦\s*(\d+)\s*⟧/g;

  // 看起來像文獻引用的連結文字：[12]、(3–5)、1,2
  const CITATION_LIKE = /^[\s\[\(【]*\d+(\s*[,;、–—-]\s*\d+)*[\s\]\)】]*$/;

  /**
   * 這個內嵌元素要「整顆保護起來」還是「攤平成文字一起翻」？
   * 引用標記、上下標、公式、程式碼 → 保護（原樣塞回譯文）
   * 一般連結、粗體斜體 → 攤平（文字會被翻到，代價是譯文那側失去該標籤的樣式）
   */
  function isAtomic(el) {
    if (PL.isSkipped(el)) return true;
    const tag = el.tagName;
    if (tag === 'SUP' || tag === 'SUB' || tag === 'BR' || tag === 'IMG' || tag === 'PICTURE') return true;
    if (TRANSPARENT.has(tag)) return false;
    if (tag === 'A') {
      const t = (el.textContent || '').trim();
      return !t || t.length <= 8 || CITATION_LIKE.test(t);
    }
    return true;
  }

  /**
   * 把區塊拆成「可翻譯字串 + 原子元素陣列」。
   * 原子元素（引用連結、上下標、公式、圖片…）在譯文裡以 ⟦n⟧ 表示，
   * 翻完後會把原本的 DOM 節點原封不動塞回對應位置。
   */
  PL.atomize = function (el) {
    const atoms = [];
    let text = '';

    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          text += child.nodeValue;
        } else if (child.nodeType === 1) {
          if (isAtomic(child)) {
            atoms.push(child.cloneNode(true));
            text += MARK_OPEN + (atoms.length - 1) + MARK_CLOSE;
          } else {
            walk(child);                              // 攤平，讓裡面的文字一起送翻
          }
        }
      }
    })(el);

    text = text.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
    return { text, atoms };
  };

  /** 把譯文（含佔位符）寫回區塊 */
  PL.applyTranslation = function (el, translated, atoms) {
    const frag = document.createDocumentFragment();
    const used = new Set();
    let last = 0, m;

    PL.MARKER_RE.lastIndex = 0;
    while ((m = PL.MARKER_RE.exec(translated))) {
      if (m.index > last) frag.appendChild(document.createTextNode(translated.slice(last, m.index)));
      const k = Number(m[1]);
      if (atoms[k] && !used.has(k)) { frag.appendChild(atoms[k]); used.add(k); }
      last = m.index + m[0].length;
    }
    if (last < translated.length) frag.appendChild(document.createTextNode(translated.slice(last)));

    // 翻譯引擎有時會吃掉佔位符；把遺失的原子補在最後，至少不遺失資訊
    for (let k = 0; k < atoms.length; k++) {
      if (!used.has(k)) {
        const a = atoms[k];
        if (a.tagName === 'BR') continue;
        frag.appendChild(document.createTextNode(' '));
        frag.appendChild(a);
      }
    }

    el.textContent = '';
    el.appendChild(frag);
  };

})();
