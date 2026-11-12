/* PaperLens — 譯文外觀：字體、字色、字級（工具列的「Aa」）
 *
 * 網頁對照與 PDF 檢視器共用。改了馬上套用、自動存起來，下次開啟還是一樣。
 * 字色只套在「淺色底」的段落上：藍底白字的橫幅、深色圖說維持原本的配色，才不會變成深色字看不到。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  if (!PL || PL.TextStyle) return;

  const FONTS = [
    { v: '"Noto Serif TC", "Source Han Serif TC", "PingFang TC", "Microsoft JhengHei", serif', label: '明體' },
    { v: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif', label: '黑體' },
    { v: '"Microsoft JhengHei", sans-serif', label: '正黑體' },
    { v: '"DFKai-SB", "BiauKai", "Kaiti TC", "STKaiti", "KaiTi", serif', label: '楷體' }
  ];
  const INHERIT = { v: 'inherit', label: '原網站' };

  const COLORS = [
    { v: 'auto', label: '跟原文一樣' },
    { v: '#111827', label: '黑' },
    { v: '#4b5563', label: '灰' },
    { v: '#1d4ed8', label: '藍' },
    { v: '#047857', label: '綠' },
    { v: '#92400e', label: '咖啡' },
    { v: '#b91c1c', label: '紅' },
    { v: '#6d28d9', label: '紫' }
  ];

  const S = () => PL.settings || {};

  function apply() {
    const s = S(), root = document.documentElement;
    if (s.transFont) root.style.setProperty('--pl-trans-font', s.transFont);
    const c = s.transColor && s.transColor !== 'auto' ? s.transColor : null;
    if (c) {
      root.style.setProperty('--pl-trans-color', c);
      root.setAttribute('data-pl-color', '1');
    } else {
      root.style.removeProperty('--pl-trans-color');
      root.removeAttribute('data-pl-color');
    }
  }

  let saveTimer = null, pending = {};
  function set(patch, refit) {
    Object.assign(PL.settings, patch);
    Object.assign(pending, patch);
    apply();
    if (PL.applyLook) PL.applyLook();                 // 網頁對照：字級、字體
    if (refit && PL.refitTranslations) PL.refitTranslations();   // PDF：字寬變了要重新量
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const p = pending;
      pending = {};
      try { globalThis.PL_saveSettings(p); } catch (e) { /* ignore */ }
    }, 300);
    render();
  }

  let pop = null, anchorBtn = null;

  function build() {
    pop = PL.el('div', { id: 'pl-style', 'data-pl-ui': '1' });
    pop.innerHTML = ''
      + '<header><b>譯文外觀</b><span class="pl-spacer"></span><button class="pl-x" data-act="close" title="關閉">✕</button></header>'
      + '<div class="pl-st-sec"><div class="pl-st-h">字體</div><div class="pl-st-fonts"></div></div>'
      + '<div class="pl-st-sec"><div class="pl-st-h">字色</div><div class="pl-st-colors"></div>'
      + '<p class="pl-st-hint">深色底的標題、圖說會維持原本的顏色</p></div>'
      + '<div class="pl-st-sec"><div class="pl-st-h">字級 <output class="pl-st-size"></output></div>'
      + '<div class="pl-st-row"><button data-act="smaller" title="小一點">A−</button>'
      + '<input type="range" min="0.8" max="1.5" step="0.05" class="pl-st-range">'
      + '<button data-act="bigger" title="大一點">A＋</button></div></div>'
      + '<div class="pl-st-preview">預覽：超表面把不同顏色的光導向不同的位置。</div>'
      + '<div class="pl-st-row"><span class="pl-spacer"></span><button data-act="reset">恢復預設</button></div>';
    document.documentElement.appendChild(pop);

    const fonts = pop.querySelector('.pl-st-fonts');
    for (const f of FONTS.concat(PL.isPdf ? [] : [INHERIT])) {
      const b = PL.el('button', { class: 'pl-st-font', 'data-v': f.v, text: f.label });
      b.style.fontFamily = f.v === 'inherit' ? '' : f.v;
      b.addEventListener('click', () => set({ transFont: f.v }, true));
      fonts.appendChild(b);
    }

    const colors = pop.querySelector('.pl-st-colors');
    for (const c of COLORS) {
      const b = PL.el('button', { class: 'pl-st-color' + (c.v === 'auto' ? ' pl-auto' : ''), 'data-v': c.v, title: c.label });
      if (c.v === 'auto') b.textContent = '跟原文';
      else b.style.background = c.v;
      b.addEventListener('click', () => set({ transColor: c.v }));
      colors.appendChild(b);
    }
    // 自訂顏色
    const pick = PL.el('label', { class: 'pl-st-color pl-custom', title: '自訂顏色' });
    const input = PL.el('input', { type: 'color' });
    input.addEventListener('input', () => set({ transColor: input.value }));
    pick.append(input);
    colors.appendChild(pick);

    const range = pop.querySelector('.pl-st-range');
    range.addEventListener('input', () => set({ transFontScale: Number(range.value) }, true));

    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('[data-act]');
      if (!a) return;
      const act = a.getAttribute('data-act');
      const sc = Number(S().transFontScale || 1);
      if (act === 'close') close();
      else if (act === 'smaller') set({ transFontScale: Math.max(0.8, Math.round((sc - 0.05) * 100) / 100) }, true);
      else if (act === 'bigger') set({ transFontScale: Math.min(1.5, Math.round((sc + 0.05) * 100) / 100) }, true);
      else if (act === 'reset') {
        const D = globalThis.PL_DEFAULTS || {};
        set({ transFont: D.transFont, transColor: 'auto', transFontScale: 1 }, true);
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (pop.classList.contains('pl-show') && !pop.contains(e.target) && e.target !== anchorBtn) close();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
  }

  function render() {
    if (!pop) return;
    const s = S();
    pop.querySelectorAll('.pl-st-font').forEach((b) => b.classList.toggle('pl-cur', b.getAttribute('data-v') === s.transFont));
    const col = s.transColor || 'auto';
    let matched = false;
    pop.querySelectorAll('.pl-st-color[data-v]').forEach((b) => {
      const on = b.getAttribute('data-v') === col;
      matched = matched || on;
      b.classList.toggle('pl-cur', on);
    });
    const custom = pop.querySelector('.pl-custom');
    custom.classList.toggle('pl-cur', !matched);
    const input = custom.querySelector('input');
    if (!matched && /^#[0-9a-f]{6}$/i.test(col)) input.value = col;
    const sc = Number(s.transFontScale || 1);
    pop.querySelector('.pl-st-range').value = String(sc);
    pop.querySelector('.pl-st-size').textContent = Math.round(sc * 100) + '%';
    const pv = pop.querySelector('.pl-st-preview');
    pv.style.fontFamily = s.transFont && s.transFont !== 'inherit' ? s.transFont : '';
    pv.style.color = col !== 'auto' ? col : '';
    pv.style.fontSize = Math.round(15 * sc) + 'px';
  }

  function open(btn) {
    if (!pop) build();
    anchorBtn = btn || null;
    render();
    pop.classList.add('pl-show');
    const r = btn ? btn.getBoundingClientRect() : { left: window.innerWidth / 2 - 150, bottom: 60 };
    const w = pop.offsetWidth || 300;
    pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + (r.width || 0) / 2 - w / 2)) + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    if (btn) btn.classList.add('pl-on');
  }

  function close() {
    if (!pop) return;
    pop.classList.remove('pl-show');
    if (anchorBtn) anchorBtn.classList.remove('pl-on');
  }

  function toggle(btn) {
    if (pop && pop.classList.contains('pl-show')) close(); else open(btn);
  }

  /** 工具列上的「Aa」按鈕 */
  function makeButton() {
    const b = PL.el('button', { class: 'pl-style-btn', text: 'Aa', title: '譯文外觀：字體、字色、字級' });
    b.addEventListener('click', () => toggle(b));
    return b;
  }

  PL.TextStyle = { apply, open, close, toggle, makeButton, COLORS, FONTS };
})();
