/* PaperLens — Gemini 金鑰入口
 *
 * 工具列上獨立的「✦ Gemini」按鈕：貼上 Gemini API 金鑰 → 選模型 → 測試 → 儲存，
 * 之後翻譯就優先用 Gemini（失敗時自動改用其他引擎）。不用再去翻設定頁。
 * PDF 檢視器、網頁對照、桌面版共用這一支。
 */
(function () {
  'use strict';
  const PL = globalThis.PL;
  if (!PL) return;

  // 2026 年仍在服務的模型（見 Google 的 Gemini deprecations 頁面）
  const MODELS = [
    ['gemini-3.6-flash', 'gemini-3.6-flash（建議）'],
    ['gemini-3.8-flash', 'gemini-3.8-flash（最新）'],
    ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite（最快、最省額度）'],
    ['gemini-2.5-flash', 'gemini-2.5-flash（以前用過的帳號才能用）']
  ];
  const KEY_RE = /^AIza[0-9A-Za-z_-]{30,}$/;

  let dlg = null;
  let forceSave = false;

  const $ = (sel) => dlg.querySelector(sel);

  /** 目前是不是「優先用 Gemini」 */
  PL.geminiActive = function () {
    const s = PL.settings || {};
    if (!s.geminiApiKey) return false;
    if (s.forceEngine) return s.forceEngine === 'gemini';
    const order = (s.engineOrder || []).filter((e) => !(globalThis.PLDesktop && e === 'chrome'));
    return order[0] === 'gemini';
  };

  PL.refreshGeminiButton = function () {
    const on = PL.geminiActive();
    document.querySelectorAll('[data-pl-gemini-btn]').forEach((b) => {
      b.classList.toggle('pl-on', on);
      b.textContent = on ? '✦ Gemini 翻譯中' : '✦ Gemini';
      b.title = on ? '目前優先用 Gemini 翻譯（點一下可以換金鑰、換模型或關掉）'
        : '有 Gemini API 金鑰嗎？點這裡貼上，就能改用 Gemini 翻譯';
    });
  };

  /** 網頁對照的工具列用：做一顆按鈕 */
  PL.makeGeminiButton = function () {
    const b = PL.el('button', { 'data-pl-gemini-btn': '1', text: '✦ Gemini' });
    b.addEventListener('click', () => PL.openGeminiDialog());
    setTimeout(PL.refreshGeminiButton, 0);
    return b;
  };

  PL.openGeminiDialog = function () {
    if (!dlg) build();
    fill();
    dlg.classList.add('pl-show');
    setTimeout(() => { const k = $('#pl-gem-key'); if (!k.value) k.focus(); }, 30);
  };

  function close() {
    if (dlg) dlg.classList.remove('pl-show');
  }

  function msg(text, kind) {
    const m = $('#pl-gem-msg');
    m.textContent = text || '';
    m.className = kind ? 'pl-gem-' + kind : '';
  }

  function currentModel() {
    const v = $('#pl-gem-model').value;
    if (v !== 'custom') return v;
    return $('#pl-gem-custom').value.trim() || MODELS[0][0];
  }

  function build() {
    dlg = PL.el('div', { id: 'pl-gem', 'data-pl-ui': '1', role: 'dialog', 'aria-modal': 'true', 'aria-label': '使用 Gemini 翻譯' });
    const card = PL.el('div', { class: 'pl-gem-card' });
    card.innerHTML = ''
      + '<header><b>✦ 使用 Gemini 翻譯</b><span class="pl-spacer"></span>'
      + '<button class="pl-x" data-act="close" type="button" title="關閉（Esc）">✕</button></header>'
      + '<p class="pl-gem-intro">有 Google Gemini 的 API 金鑰的話，貼在下面就能改用 Gemini 翻譯 —— 學術名詞、長句都最準確。'
      + '金鑰只存在這台電腦，不會傳給其他人。</p>'
      + '<p class="pl-gem-how">還沒有金鑰？到 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>'
      + ' 用 Google 帳號登入 →「Create API key」→ 複製，免費。</p>'
      + '<div class="pl-gem-row"><span>API 金鑰</span>'
      + '<input id="pl-gem-key" type="password" autocomplete="off" spellcheck="false" placeholder="貼上 AIza 開頭的一長串字">'
      + '<button data-act="show" type="button">顯示</button></div>'
      + '<div class="pl-gem-row"><span>模型</span><select id="pl-gem-model"></select></div>'
      + '<div class="pl-gem-row pl-gem-customrow" hidden><span>模型名稱</span>'
      + '<input id="pl-gem-custom" type="text" spellcheck="false" placeholder="例如 gemini-3.6-flash"></div>'
      + '<label class="pl-gem-chk"><input id="pl-gem-use" type="checkbox"> 翻譯優先用 Gemini（Gemini 失敗時自動改用其他引擎）</label>'
      + '<div class="pl-gem-testrow"><button data-act="test" type="button">測試金鑰</button><span id="pl-gem-msg"></span></div>'
      + '<footer><button data-act="remove" class="pl-danger" type="button">移除金鑰</button><span class="pl-spacer"></span>'
      + '<button data-act="close" type="button">取消</button>'
      + '<button data-act="save" class="pl-primary" type="button">儲存並使用</button></footer>'
      + '<div class="pl-gem-after" hidden><p>已經改用 Gemini。已經翻好的段落，要不要也用 Gemini 重新翻一次？</p>'
      + '<div class="pl-gem-row2"><button data-act="redo" class="pl-primary" type="button">用 Gemini 重新翻譯整份</button>'
      + '<button data-act="keep" type="button">保留現有譯文，之後的段落再用 Gemini</button></div></div>';
    dlg.appendChild(card);
    document.documentElement.appendChild(dlg);

    const sel = $('#pl-gem-model');
    MODELS.forEach(([v, t]) => sel.appendChild(PL.el('option', { value: v, text: t })));
    sel.appendChild(PL.el('option', { value: 'custom', text: '自訂…' }));
    sel.addEventListener('change', () => { $('.pl-gem-customrow').hidden = sel.value !== 'custom'; });

    $('#pl-gem-key').addEventListener('input', () => { forceSave = false; $('[data-act="save"]').textContent = '儲存並使用'; msg(''); });

    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) { close(); return; }        // 點外面的灰色區域
      const act = e.target.closest && e.target.closest('[data-act]');
      if (!act) return;
      const a = act.getAttribute('data-act');
      if (a === 'close') close();
      else if (a === 'show') {
        const k = $('#pl-gem-key');
        k.type = k.type === 'password' ? 'text' : 'password';
        act.textContent = k.type === 'password' ? '顯示' : '隱藏';
      }
      else if (a === 'test') test();
      else if (a === 'save') save();
      else if (a === 'remove') remove();
      else if (a === 'redo') { close(); if (PL.retranslateAll) PL.retranslateAll({ noCache: true }); PL.toast('正在用 Gemini 重新翻譯整份…', 3000); }
      else if (a === 'keep') { close(); PL.toast('已改用 Gemini；接下來翻的段落都會用 Gemini', 3000); }
    });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter' && e.target.id === 'pl-gem-key') save();
    });
  }

  function fill() {
    const s = PL.settings || {};
    forceSave = false;
    $('#pl-gem-key').value = s.geminiApiKey || '';
    $('#pl-gem-key').type = 'password';
    $('[data-act="show"]').textContent = '顯示';
    const model = s.geminiModel || MODELS[0][0];
    const known = MODELS.some(([v]) => v === model);
    $('#pl-gem-model').value = known ? model : 'custom';
    $('#pl-gem-custom').value = known ? '' : model;
    $('.pl-gem-customrow').hidden = known;
    $('#pl-gem-use').checked = s.geminiApiKey ? PL.geminiActive() : true;
    $('[data-act="remove"]').hidden = !s.geminiApiKey;
    $('[data-act="save"]').textContent = '儲存並使用';
    $('.pl-gem-after').hidden = true;
    $('footer').hidden = false;
    msg(s.geminiApiKey ? '已經有儲存的金鑰（模型 ' + model + '）' : '');
  }

  async function test() {
    const key = $('#pl-gem-key').value.trim();
    if (!key) { msg('請先貼上金鑰', 'bad'); return false; }
    const btn = $('[data-act="test"]');
    btn.disabled = true;
    msg('測試中…（會用 Gemini 翻一句範例）');
    try {
      const r = await PL.send({ type: 'gemini.test', key, model: currentModel(), targetLang: (PL.settings || {}).targetLang });
      msg('✓ 可以用（' + (r.ms / 1000).toFixed(1) + ' 秒）：「' + String(r.sample || '').slice(0, 60) + '」', 'ok');
      return true;
    } catch (e) {
      msg('✗ ' + (e.message || e), 'bad');
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  async function save() {
    const key = $('#pl-gem-key').value.trim();
    if (!key) { msg('請先貼上金鑰；不想用 Gemini 的話可以按「取消」', 'bad'); return; }
    if (!forceSave) {
      if (!KEY_RE.test(key)) {
        msg('這看起來不像 Gemini 金鑰（通常是 AIza 開頭、約 39 個字）。確定沒貼錯的話，再按一次「仍要儲存」', 'bad');
        forceSave = true;
        $('[data-act="save"]').textContent = '仍要儲存';
        return;
      }
      const ok = await test();
      if (!ok) {
        forceSave = true;
        $('[data-act="save"]').textContent = '仍要儲存';
        return;
      }
    }

    const use = $('#pl-gem-use').checked;
    const model = currentModel();
    const base = ((PL.settings && PL.settings.engineOrder) || globalThis.PL_DEFAULTS.engineOrder).filter((e) => e !== 'gemini');
    const order = use ? ['gemini'].concat(base) : base.concat(['gemini']);
    const patch = { geminiApiKey: key, geminiModel: model, engineOrder: order };
    Object.assign(PL.settings, patch);
    if (use) PL.settings.forceEngine = null;        // 改回「自動」，Gemini 排第一、失敗時換下一個
    else if (PL.settings.forceEngine === 'gemini') PL.settings.forceEngine = null;
    try { await globalThis.PL_saveSettings(patch); }
    catch (e) { msg('儲存失敗：' + (e.message || e), 'bad'); return; }

    const sel = document.getElementById('pl-engine');
    if (sel && !PL.settings.forceEngine) sel.value = 'auto';
    PL.refreshGeminiButton();
    $('[data-act="remove"]').hidden = false;

    const translated = (PL.blocks || []).some((b) => b.state === 'done');
    if (use && translated && PL.retranslateAll) {
      $('footer').hidden = true;
      $('.pl-gem-after').hidden = false;
      msg('✓ 已儲存', 'ok');
    } else {
      close();
      PL.toast(use ? '已改用 Gemini 翻譯（' + model + '）' : '已儲存 Gemini 金鑰', 3000);
    }
  }

  async function remove() {
    if (!confirm('要移除 Gemini 金鑰嗎？之後翻譯會改回其他引擎。')) return;
    const order = ((PL.settings && PL.settings.engineOrder) || []).filter((e) => e !== 'gemini');
    const patch = { geminiApiKey: '', engineOrder: order.length ? order : globalThis.PL_DEFAULTS.engineOrder.slice() };
    Object.assign(PL.settings, patch);
    if (PL.settings.forceEngine === 'gemini') PL.settings.forceEngine = null;
    await globalThis.PL_saveSettings(patch);
    const sel = document.getElementById('pl-engine');
    if (sel && !PL.settings.forceEngine) sel.value = 'auto';
    PL.refreshGeminiButton();
    fill();
    msg('已移除金鑰，翻譯改回其他引擎', 'ok');
  }
})();
