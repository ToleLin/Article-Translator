/* PaperLens — 側邊「查字・翻譯」
 *
 * 側欄的一個分頁：自己打字、貼上，或在文章裡選字，就在這裡顯示譯文，不會動到文章。
 *  - 單字、短詞：查字典（詞性、多個意思、音標、英英解釋、例句），可以聽發音
 *  - 句子：照使用者設定的引擎順序翻譯
 *  - 中文 → 英文也可以（自動判斷，或手動選方向）
 *  - 查過的字記在「最近查過」，可以加星號收藏、匯出成 Excel 打得開的 CSV
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  if (!PL || PL.Lookup) return;

  const HIST_KEY = 'lookupHistory';
  const HIST_MAX = 300;
  const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

  const hasCJK = (t) => CJK.test(t);
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  /** 單字或短詞（查字典）；再長就當句子翻 */
  function isShort(t) {
    t = clean(t);
    if (!t) return false;
    if (hasCJK(t)) return t.replace(/[\s\p{P}]/gu, '').length <= 8;
    return t.split(' ').length <= 4 && t.length <= 60;
  }

  let root = null, els = {}, history = [], starOnly = false;
  let tok = 0, current = null;
  const cache = new Map();

  /* ══════════ 介面 ══════════ */

  function mount(container) {
    root = container;
    root.innerHTML = ''
      + '<div class="pl-lk-box">'
      + '  <textarea class="pl-lk-in" rows="2" placeholder="輸入或貼上要查的字、詞、句子&#10;（Enter 查詢、Shift+Enter 換行）"></textarea>'
      + '  <div class="pl-lk-row">'
      + '    <select class="pl-lk-dir" title="翻譯方向">'
      + '      <option value="auto">自動判斷</option><option value="fwd">英 → 中</option><option value="rev">中 → 英</option>'
      + '    </select>'
      + '    <label class="pl-lk-auto" title="這個分頁開著時，在文章裡選字就自動在這裡查"><input type="checkbox"> 選字就查</label>'
      + '    <span class="pl-spacer"></span>'
      + '    <button class="pl-lk-go">查詢</button>'
      + '  </div>'
      + '</div>'
      + '<div class="pl-lk-res"><div class="pl-lk-tip">在文章裡選一個字，或在上面輸入，就會在這裡顯示意思。<br>不會翻譯整段、也不會改到文章。</div></div>'
      + '<div class="pl-lk-hhead"><span>最近查過 <span class="pl-lk-n"></span></span><span class="pl-spacer"></span>'
      + '  <button class="pl-lk-staronly" title="只看加了星號的字">★ 收藏</button>'
      + '  <button class="pl-lk-export" title="匯出成 CSV（Excel 打得開）">匯出</button>'
      + '  <button class="pl-lk-clear" title="清除查詢紀錄（收藏的會留著）">清除</button></div>'
      + '<div class="pl-lk-hist"></div>';
    els = {
      input: root.querySelector('.pl-lk-in'), dir: root.querySelector('.pl-lk-dir'),
      auto: root.querySelector('.pl-lk-auto input'), go: root.querySelector('.pl-lk-go'),
      res: root.querySelector('.pl-lk-res'), hist: root.querySelector('.pl-lk-hist'),
      n: root.querySelector('.pl-lk-n'), starOnly: root.querySelector('.pl-lk-staronly')
    };
    els.auto.checked = !PL.settings || PL.settings.lookupOnSelect !== false;
    els.auto.addEventListener('change', () => {
      PL.settings.lookupOnSelect = els.auto.checked;
      globalThis.PL_saveSettings({ lookupOnSelect: els.auto.checked });
    });
    els.go.addEventListener('click', () => lookup(els.input.value));
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); lookup(els.input.value); }
      e.stopPropagation();               // 不要觸發標註工具的快捷鍵
    });
    els.dir.addEventListener('change', () => { if (current) lookup(current.q, { force: true }); });
    els.starOnly.addEventListener('click', () => {
      starOnly = !starOnly;
      els.starOnly.classList.toggle('pl-on', starOnly);
      renderHistory();
    });
    root.querySelector('.pl-lk-export').addEventListener('click', exportCsv);
    root.querySelector('.pl-lk-clear').addEventListener('click', () => {
      mutate(() => { history = history.filter((h) => h.star); })
        .then(() => PL.toast(history.length ? '已清除（收藏的字留著）' : '已清除查詢紀錄'));
    });
    loadHistory();
  }

  function focusInput() {
    if (!els.input) return;
    loadHistory();                    // 別的分頁可能剛查過字：打開時重新讀一次
    setTimeout(() => { els.input.focus(); els.input.select(); }, 30);
  }

  /* ══════════ 查詢 ══════════ */

  function direction(q) {
    const v = els.dir ? els.dir.value : 'auto';
    const rev = v === 'rev' || (v === 'auto' && hasCJK(q));
    const tgt = (PL.settings && PL.settings.targetLang) || 'zh-Hant';
    if (rev) return { from: /^zh|^ja|^ko/i.test(tgt) ? tgt : 'auto', to: 'en', rev: true };
    const src = globalThis.PLTranslate && PLTranslate.sourceLang && PLTranslate.sourceLang !== 'auto' ? PLTranslate.sourceLang : 'auto';
    return { from: src, to: tgt, rev: false };
  }

  async function run(q, dir) {
    const key = dir.from + '>' + dir.to + ':' + q;
    if (cache.has(key)) return cache.get(key);
    const t0 = performance.now();
    let r = null, err = null;
    if (isShort(q)) {
      try { r = await PL.send({ type: 'dict.lookup', text: q, sourceLang: dir.from, targetLang: dir.to }); }
      catch (e) { err = e; }
    }
    if (!r || !r.translation) {
      // 句子（或字典查不到）：用一般翻譯，照使用者設定的引擎順序
      try {
        let t, eng;
        if (!dir.rev && globalThis.PLTranslate) {
          // 文章的原文語言還沒判斷過：只在這一次查詢用這句話猜，不要記下來（不然會影響之後整篇的翻譯）
          const T = PLTranslate, had = T.sourceLang;
          if (!had) T.sourceLang = (T.guessLang && T.guessLang(q)) || null;
          let res;
          try { res = await T.translate([q]); }
          finally { if (!had) T.sourceLang = had; }
          t = res.result[0];
          eng = res.engine;
        } else {
          const res = await PL.send({ type: 'translate.remote', texts: [q], sourceLang: dir.from, targetLang: dir.to });
          t = res && res.result && res.result[0];
          eng = res && res.engine;
        }
        if (t && String(t).trim()) r = { translation: String(t).trim(), dict: [], defs: [], examples: [], engine: eng };
      } catch (e) { err = err || e; }
    }
    if (!r || !r.translation) throw err || new Error('查不到，請換個寫法或稍後再試');
    r.ms = Math.round(performance.now() - t0);
    cache.set(key, r);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return r;
  }

  async function lookup(text, opts) {
    opts = opts || {};
    const q = clean(text);
    if (!root) return;
    if (!q) { els.input.focus(); return; }
    if (q.length > 3000) { PL.toast('太長了，請分段查詢（3000 字以內）'); return; }
    if (els.input.value.trim() !== q) els.input.value = q;
    const my = ++tok;
    const dir = direction(q);
    current = { q, dir };
    els.res.innerHTML = '';
    els.res.appendChild(PL.el('div', { class: 'pl-lk-wait', text: '查詢中…' }));
    let r;
    try {
      r = await run(q, dir);
    } catch (e) {
      if (my !== tok) return;
      current = null;                 // 失敗了：再選一次同樣的字要能重查
      els.res.innerHTML = '';
      els.res.appendChild(PL.el('div', { class: 'pl-lk-err', text: '⚠ ' + (e.message || e) }));
      return;
    }
    if (my !== tok) return;          // 已經查了別的字
    current.r = r;
    renderResult(q, dir, r);
    remember(q, r.translation);
  }

  /* ══════════ 結果 ══════════ */

  function speak(text, lang) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = 0.92;
      speechSynthesis.speak(u);
    } catch (e) { PL.toast('這台電腦不支援朗讀'); }
  }

  function engineName(k) {
    return ((globalThis.PL_ENGINE_LABEL && globalThis.PL_ENGINE_LABEL[k]) || k || '').split('（')[0];
  }

  function renderResult(q, dir, r) {
    const card = PL.el('div', { class: 'pl-lk-card' });

    const head = PL.el('div', { class: 'pl-lk-q' });
    head.appendChild(PL.el('b', { text: q.length > 80 ? q.slice(0, 80) + '…' : q }));
    if (r.phonetic && isShort(q) && !hasCJK(q)) head.appendChild(PL.el('span', { class: 'pl-lk-ph', text: '/' + r.phonetic + '/', title: '/' + r.phonetic + '/' }));
    if (typeof speechSynthesis !== 'undefined') {
      const say = PL.el('button', { class: 'pl-lk-ico', text: '🔊', title: '朗讀原文' });
      say.addEventListener('click', () => speak(q, hasCJK(q) ? 'zh-TW' : 'en-US'));
      head.appendChild(say);
    }
    head.appendChild(PL.el('span', { class: 'pl-spacer' }));
    const star = PL.el('button', { class: 'pl-lk-ico pl-lk-star', text: '☆', title: '加入收藏' });
    const isStar = () => !!(history.find((h) => h.q.toLowerCase() === q.toLowerCase()) || {}).star;
    const paintStar = () => { const on = isStar(); star.textContent = on ? '★' : '☆'; star.classList.toggle('pl-on', on); };
    star.addEventListener('click', () => { toggleStar(q).then(paintStar); });
    head.appendChild(star);
    const copy = PL.el('button', { class: 'pl-lk-ico', text: '⧉', title: '複製譯文' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.translation); PL.toast('已複製'); } catch (e) { PL.toast('複製失敗'); }
    });
    head.appendChild(copy);
    card.appendChild(head);

    const main = PL.el('div', { class: 'pl-lk-main' + (dir.rev ? ' pl-lk-en' : ''), text: r.translation });
    card.appendChild(main);
    if (dir.rev && typeof speechSynthesis !== 'undefined' && isShort(r.translation)) {
      const say2 = PL.el('button', { class: 'pl-lk-ico', text: '🔊', title: '朗讀英文' });
      say2.addEventListener('click', () => speak(r.translation, 'en-US'));
      main.appendChild(say2);
    }

    // 各詞性的意思
    if (r.dict && r.dict.length) {
      const box = PL.el('div', { class: 'pl-lk-dict' });
      for (const d of r.dict) {
        const row = PL.el('div', { class: 'pl-lk-pos' });
        row.appendChild(PL.el('span', { class: 'pl-lk-tag', text: d.pos || '—' }));
        const terms = PL.el('span', { class: 'pl-lk-terms' });
        d.terms.forEach((t, k) => {
          if (k) terms.appendChild(document.createTextNode('、'));
          const w = PL.el('span', { class: 'pl-lk-term', text: t.word, title: t.back && t.back.length ? '也可以是：' + t.back.join(', ') : '' });
          // 點一下：反查這個詞
          w.addEventListener('click', () => lookup(t.word));
          terms.appendChild(w);
        });
        row.appendChild(terms);
        box.appendChild(row);
      }
      card.appendChild(box);
    }

    if (r.defs && r.defs.length) {
      const box = PL.el('div', { class: 'pl-lk-defs' });
      box.appendChild(PL.el('div', { class: 'pl-lk-sub', text: '英英解釋' }));
      for (const d of r.defs) {
        for (const it of d.items) {
          const row = PL.el('div', { class: 'pl-lk-def' });
          row.appendChild(PL.el('span', { class: 'pl-lk-tag', text: d.pos || '—' }));
          row.appendChild(PL.el('span', { text: it.gloss }));
          if (it.example) row.appendChild(PL.el('div', { class: 'pl-lk-ex', text: '例：' + it.example }));
          box.appendChild(row);
        }
      }
      card.appendChild(box);
    }

    if (r.examples && r.examples.length) {
      const box = PL.el('div', { class: 'pl-lk-defs' });
      box.appendChild(PL.el('div', { class: 'pl-lk-sub', text: '例句' }));
      r.examples.forEach((x) => box.appendChild(PL.el('div', { class: 'pl-lk-ex', text: x })));
      card.appendChild(box);
    }

    card.appendChild(PL.el('div', {
      class: 'pl-lk-meta',
      text: (dir.rev ? '中 → 英' : '→ 中文') + ' · ' + engineName(r.engine) + ' · ' + (r.ms || 0) + ' ms'
    }));

    els.res.innerHTML = '';
    els.res.appendChild(card);
    paintStar();
  }

  /* ══════════ 查詢紀錄、收藏 ══════════ */

  async function readStored() {
    try {
      const got = await chrome.storage.local.get(HIST_KEY);
      return Array.isArray(got[HIST_KEY]) ? got[HIST_KEY] : [];
    } catch (e) { return []; }
  }

  async function loadHistory() {
    history = await readStored();
    renderHistory();
  }

  /* 每個分頁、每個視窗各有一份這個面板。要改紀錄時先重新讀一次存檔再改、再寫回去，
     不然在這個分頁查一個字，會把另一個分頁剛加的字和星號蓋掉。排隊做，免得自己跟自己搶。 */
  let histChain = Promise.resolve();
  function mutate(fn) {
    histChain = histChain.then(async () => {
      history = await readStored();
      fn();
      // 超過上限：收藏的全部留著，其餘只留最新的
      let plain = 0;
      history = history.filter((h) => h.star || ++plain <= HIST_MAX);
      try { await chrome.storage.local.set({ [HIST_KEY]: history }); } catch (e) { /* ignore */ }
      renderHistory();
    }).catch(() => {});
    return histChain;
  }

  function remember(q, t) {
    return mutate(() => {
      const i = history.findIndex((h) => h.q.toLowerCase() === q.toLowerCase());
      const star = i >= 0 ? history[i].star : false;
      if (i >= 0) history.splice(i, 1);
      history.unshift({ q, t: String(t || '').slice(0, 300), at: Date.now(), star });
    });
  }

  function toggleStar(q) {
    return mutate(() => {
      const h = history.find((x) => x.q.toLowerCase() === q.toLowerCase());
      if (!h) return;
      h.star = !h.star;
      PL.toast(h.star ? '已加入收藏' : '已取消收藏');
    });
  }

  function renderHistory() {
    if (!els.hist) return;
    const list = starOnly ? history.filter((h) => h.star) : history;
    els.n.textContent = '（' + list.length + '）';
    els.hist.textContent = '';
    if (!list.length) {
      els.hist.appendChild(PL.el('div', { class: 'pl-lk-empty', text: starOnly ? '還沒有收藏的字。查完按 ☆ 就會加進來。' : '還沒有查過的字。' }));
      return;
    }
    for (const h of list.slice(0, 120)) {
      const row = PL.el('div', { class: 'pl-lk-item' + (h.star ? ' pl-star' : '') });
      row.appendChild(PL.el('span', { class: 'pl-lk-hq', text: h.q }));
      row.appendChild(PL.el('span', { class: 'pl-lk-ht', text: h.t }));
      const st = PL.el('button', { class: 'pl-lk-ico', text: h.star ? '★' : '☆', title: h.star ? '取消收藏' : '加入收藏' });
      st.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStar(h.q).then(() => {
          if (current && current.r && current.q.toLowerCase() === h.q.toLowerCase()) renderResult(current.q, current.dir, current.r);
        });
      });
      row.appendChild(st);
      row.addEventListener('click', () => lookup(h.q));
      els.hist.appendChild(row);
    }
  }

  function exportCsv() {
    const list = starOnly ? history.filter((h) => h.star) : history;
    if (!list.length) { PL.toast('沒有可以匯出的字'); return; }
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['字詞', '翻譯', '收藏', '查詢時間']].concat(list.map((h) => [
      h.q, h.t, h.star ? '★' : '', new Date(h.at).toLocaleString('zh-TW', { hour12: false })
    ]));
    // 開頭加 BOM，Excel 才認得是 UTF-8（不然中文會變亂碼）
    const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const a = PL.el('a', {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
      // 檔名用英數字：有些瀏覽器遇到中文檔名會改成「download」
      download: 'PaperLens-words-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv'
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ══════════ 對外 ══════════ */

  PL.Lookup = {
    mount,
    lookup,
    isShort,
    focus: focusInput,
    /** 分頁開著、而且勾了「選字就查」 */
    wantsSelection: () => !!(root && els.auto && els.auto.checked && PL.sideTab && PL.sideTab() === 'tr'),
    fromSelection: (text) => {
      const q = clean(text);
      if (!q || q.length > 1200 || (current && current.q === q)) return;
      lookup(q);
    }
  };
})();
