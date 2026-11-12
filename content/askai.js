/* PaperLens — 側邊「問 AI」
 *
 * 選一段文字，直接問 Gemini：「這段在講什麼？」「為什麼要這樣做？」「這個式子的每個符號是什麼？」
 * 可以連續追問；回答以選取的段落為主，並附上所在段落與全文節錄當背景，所以前後文對得上。
 * 需要 Gemini 金鑰（工具列的「✦ Gemini」）。對話只留在這次開啟的頁面裡，不會存檔；
 * 想留下來的回答按「存成心得」。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  if (!PL || PL.AskAI) return;

  const QUICK = [
    ['白話解釋', '用白話、好懂的方式解釋這段在講什麼。'],
    ['重點整理', '把這段的重點整理成 3 點以內的條列。'],
    ['專有名詞', '列出這段裡的專有名詞與縮寫，各用一句話解釋。'],
    ['為什麼這樣做', '作者為什麼要這樣做？這樣做的目的和好處是什麼？'],
    ['符號與公式', '這段提到的符號、變數、公式各代表什麼？']
  ];
  const DOC_MAX = 40000;

  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  let root = null, els = {};
  let ctx = null;            // { passage, around, info, key }
  let thread = [];           // 目前這一段的對話：{ role: 'user'|'model', text }
  let busy = false, tok = 0;

  /* ══════════ 介面 ══════════ */

  function mount(container) {
    root = container;
    root.innerHTML = ''
      + '<div class="pl-ai-ctx"><div class="pl-ai-ctxh"><span class="pl-ai-ctxt">問的段落</span><span class="pl-spacer"></span>'
      + '<button class="pl-ai-clearctx" title="不指定段落，改問整篇文章">✕</button></div>'
      + '<div class="pl-ai-ctxbody"></div></div>'
      + '<div class="pl-ai-key" hidden>問 AI 需要 Gemini 金鑰（Google AI Studio 可以免費申請）。'
      + '<button class="pl-ai-keybtn">✦ 輸入 Gemini 金鑰</button></div>'
      + '<div class="pl-ai-log"></div>'
      + '<div class="pl-ai-quick"></div>'
      + '<div class="pl-ai-box">'
      + '  <textarea class="pl-ai-in" rows="2" placeholder="問這段任何問題…（Enter 送出、Shift+Enter 換行）"></textarea>'
      + '  <div class="pl-ai-row">'
      + '    <label class="pl-ai-doc" title="把整篇文章的文字一起給 AI 當背景，回答比較能對上前後文（會多用一點額度）"><input type="checkbox"> 參考全文</label>'
      + '    <button class="pl-ai-new" title="清除對話，重新開始">清除對話</button>'
      + '    <span class="pl-spacer"></span>'
      + '    <button class="pl-ai-send">送出</button>'
      + '  </div>'
      + '</div>';
    els = {
      ctxBody: root.querySelector('.pl-ai-ctxbody'), ctxTitle: root.querySelector('.pl-ai-ctxt'),
      clearCtx: root.querySelector('.pl-ai-clearctx'), key: root.querySelector('.pl-ai-key'),
      log: root.querySelector('.pl-ai-log'), quick: root.querySelector('.pl-ai-quick'),
      input: root.querySelector('.pl-ai-in'), send: root.querySelector('.pl-ai-send'),
      doc: root.querySelector('.pl-ai-doc input')
    };
    for (const [label, q] of QUICK) {
      const b = PL.el('button', { class: 'pl-ai-chip', text: label, title: q });
      b.addEventListener('click', () => send(q));
      els.quick.appendChild(b);
    }
    els.doc.checked = !PL.settings || PL.settings.askWithDoc !== false;
    els.doc.addEventListener('change', () => {
      PL.settings.askWithDoc = els.doc.checked;
      globalThis.PL_saveSettings({ askWithDoc: els.doc.checked });
    });
    els.send.addEventListener('click', () => send(els.input.value));
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(els.input.value); }
      e.stopPropagation();
    });
    root.querySelector('.pl-ai-new').addEventListener('click', () => { resetThread(); renderLog(); });
    root.querySelector('.pl-ai-keybtn').addEventListener('click', () => PL.openGeminiDialog && PL.openGeminiDialog());
    els.clearCtx.addEventListener('click', () => setContext(null));
    renderCtx();
    renderLog();
    refreshKey();
  }

  function hasKey() { return !!(PL.settings && PL.settings.geminiApiKey); }
  function refreshKey() { if (els.key) els.key.hidden = hasKey(); }

  function resetThread() { tok++; busy = false; thread = []; if (els.send) els.send.disabled = false; }

  /* ══════════ 問的是哪一段 ══════════ */

  /** info 來自選字（describeSelection）；null = 不指定段落，問整篇 */
  function setContext(info) {
    let next = null;
    if (info) {
      const passage = clean(info.fullText || info.text);
      if (passage) {
        // 所在段落的原文：選的是中文譯文時，AI 也要看得到對應的英文原文
        const idx = info.blocks && info.blocks.length ? info.blocks : (info.block != null ? [info.block] : []);
        const around = clean(idx.map((i) => {
          const b = PL.blocks[i];
          return b ? (b.srcText || (b.left && b.left.textContent) || '') : '';
        }).join('\n'));
        next = { passage, around, info, side: info.side, key: (info.side || '') + ':' + idx.join(',') + ':' + passage };
      }
    }
    if ((next && next.key) === (ctx && ctx.key)) return;
    ctx = next;
    resetThread();             // 換了段落：新的對話（舊的問答留在畫面上當紀錄，但不再送給 AI）
    if (root) {
      renderCtx();
      if (els.log.children.length && !els.log.querySelector('.pl-ai-empty')) {
        els.log.appendChild(PL.el('div', { class: 'pl-ai-div', text: ctx ? '— 換了一段 —' : '— 改問整篇文章 —' }));
        els.log.scrollTop = els.log.scrollHeight;
      }
    }
  }

  function renderCtx() {
    if (!els.ctxBody) return;
    if (ctx) {
      els.ctxTitle.textContent = '問的段落' + (ctx.side === 'right' ? '（譯文，AI 也會看對應的原文）' : '');
      els.ctxBody.textContent = ctx.passage.length > 420 ? ctx.passage.slice(0, 420) + '…' : ctx.passage;
      els.ctxBody.classList.remove('pl-none');
      els.clearCtx.style.display = '';
    } else {
      els.ctxTitle.textContent = '問的段落';
      els.ctxBody.textContent = '還沒有選段落：現在問的是整篇文章。\n在文章裡選一段文字，就會改成問那一段。';
      els.ctxBody.classList.add('pl-none');
      els.clearCtx.style.display = 'none';
    }
  }

  function docText() {
    let out = '';
    for (const b of PL.blocks || []) {
      if (b.para && (b.para.ref || b.para.skip)) continue;        // 參考文獻、頁首頁尾、公式碎片不用給
      const t = clean(b.srcText || (b.left && b.left.textContent));
      if (t.length < 25) continue;
      out += t + '\n';
      if (out.length >= DOC_MAX) break;
    }
    return out.slice(0, DOC_MAX);
  }

  /* ══════════ 對話 ══════════ */

  /** 把 Gemini 回的簡單 Markdown（粗體、條列、標題、`程式`）排成 DOM；一律用 textContent，不吃 HTML */
  function inline(parent, text) {
    const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(PL.el(m[1] != null ? 'b' : 'code', { text: m[1] != null ? m[1] : m[2] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function markdown(text) {
    const box = PL.el('div', { class: 'pl-ai-md' });
    let list = null, kind = '';
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      const head = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (bullet || num) {
        const k = bullet ? 'ul' : 'ol';
        if (!list || kind !== k) { list = PL.el(k); kind = k; box.appendChild(list); }
        const li = PL.el('li');
        inline(li, bullet ? bullet[1] : num[2]);
        list.appendChild(li);
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      const p = PL.el(head ? 'h4' : 'p');
      inline(p, head ? head[1].replace(/\*\*/g, '') : line);
      box.appendChild(p);
    }
    return box;
  }

  function renderLog() {
    if (!els.log) return;
    els.log.textContent = '';
    els.log.appendChild(PL.el('div', {
      class: 'pl-ai-empty',
      text: '選一段文字後按「💬 問 AI」，或直接在下面輸入問題。\n可以連續追問；想留下來的回答按「存成心得」。'
    }));
  }

  function addMsg(role, text, extra) {
    const empty = els.log.querySelector('.pl-ai-empty');
    if (empty) empty.remove();
    const el = PL.el('div', { class: 'pl-ai-msg pl-ai-' + role });
    if (role === 'model') el.appendChild(markdown(text));
    else el.textContent = text;
    if (role === 'model' && !(extra && extra.error)) {
      const bar = PL.el('div', { class: 'pl-ai-act' });
      const copy = PL.el('button', { text: '⧉ 複製' });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); PL.toast('已複製'); } catch (e) { PL.toast('複製失敗'); }
      });
      bar.appendChild(copy);
      const at = ctx;
      if (at && at.info && at.info.range && PL.noteFromSelection) {
        const save = PL.el('button', { text: '✎ 存成心得', title: '把這段標起來，回答存成它的心得' });
        save.addEventListener('click', () => {
          const q = extra && extra.question ? '問：' + extra.question + '\n' : '';
          // 心得是純文字：拿掉 Markdown 的 ** 和 ` 記號
          const plain = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^\s*#{1,6}\s+/gm, '');
          if (PL.noteFromSelection(at.info, '【AI】' + q + plain)) { save.disabled = true; save.textContent = '✓ 已存'; }
        });
        bar.appendChild(save);
      }
      if (extra && extra.model) bar.appendChild(PL.el('span', { class: 'pl-ai-model', text: extra.model }));
      el.appendChild(bar);
    }
    if (extra && extra.error) el.classList.add('pl-ai-err');
    els.log.appendChild(el);
    els.log.scrollTop = els.log.scrollHeight;
    return el;
  }

  async function send(text) {
    const q = String(text || '').trim();
    if (!root || busy) return;
    if (!q) { els.input.focus(); return; }
    refreshKey();
    if (!hasKey()) {
      PL.toast('問 AI 需要 Gemini 金鑰');
      if (PL.openGeminiDialog) PL.openGeminiDialog();
      return;
    }
    if (els.input.value.trim() === q) els.input.value = '';
    busy = true;
    els.send.disabled = true;
    const my = ++tok;
    const history = thread.slice();
    addMsg('user', q);
    const wait = PL.el('div', { class: 'pl-ai-msg pl-ai-model pl-ai-wait', text: 'AI 思考中…' });
    els.log.appendChild(wait);
    els.log.scrollTop = els.log.scrollHeight;
    try {
      const res = await PL.send({
        type: 'ai.ask',
        question: q,
        passage: ctx ? ctx.passage : '',
        around: ctx ? ctx.around : '',
        doc: els.doc.checked || !ctx ? docText() : '',
        title: PL.pageTitle ? PL.pageTitle() : document.title,
        history,
        lang: PL.settings && PL.settings.targetLang
      });
      if (my !== tok) return;            // 中途換了段落或清除了對話
      wait.remove();
      thread.push({ role: 'user', text: q }, { role: 'model', text: res.text });
      addMsg('model', res.text, { model: res.model, question: q });
    } catch (e) {
      if (my !== tok) return;
      wait.remove();
      addMsg('model', '⚠ ' + (e.message || e), { error: true });
      if (!els.input.value.trim()) els.input.value = q;      // 失敗了把問題放回去，改一下可以再送
    } finally {
      if (my === tok) { busy = false; els.send.disabled = false; }
      if (wait.isConnected && my !== tok) wait.remove();
    }
  }

  PL.AskAI = {
    mount,
    setContext,
    send,
    refreshKey,
    focus: () => { refreshKey(); if (els.input) setTimeout(() => els.input.focus(), 30); },
    /** 分頁開著時選了新的文字：改問那一段 */
    fromSelection: (info) => { if (root) setContext(info); }
  };
})();
