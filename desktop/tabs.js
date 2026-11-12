/* PaperLens 桌面版 — 分頁列 */
(function () {
  'use strict';
  const T = window.PLTabs;
  const host = document.getElementById('tabs');
  let state = { tabs: [], active: null };
  let dragId = null;

  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const MOD = MAC ? '⌘' : 'Ctrl+';
  const els = new Map();          // 分頁 id → 畫面上的元素

  /* 分頁元素是「沿用」的，不是每次整排重畫。
   * 以前每次狀態更新都整排重建：在 ✕ 上按下滑鼠 → 分頁被選取 → 整排重建 → 放開滑鼠時
   * 原本那顆 ✕ 已經不在畫面上，瀏覽器就不會送出 click，結果分頁怎麼按都關不掉（拖曳換位置也會斷掉）。 */
  function make(id) {
    const el = document.createElement('div');
    el.draggable = true;
    const ico = document.createElement('span');
    ico.className = 'ico';
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = '關閉分頁（' + MOD + 'W）';
    x.draggable = false;
    // 按在 ✕ 上不要選取分頁、也不要開始拖曳，單純關閉
    x.addEventListener('mousedown', (e) => e.stopPropagation());
    x.addEventListener('click', (e) => { e.stopPropagation(); T.close(id); });
    el.append(ico, ttl, x);
    el.addEventListener('mousedown', (e) => { if (e.button === 0) T.activate(id); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); T.close(id); } });
    // 拖曳換位置
    el.addEventListener('dragstart', (e) => { dragId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(id)); });
    el.addEventListener('dragend', () => { dragId = null; clearDrop(); });
    el.addEventListener('dragover', (e) => { if (dragId == null) return; e.preventDefault(); clearDrop(); el.classList.add('drop'); });
    el.addEventListener('drop', (e) => {
      if (dragId == null) return;
      e.preventDefault(); e.stopPropagation();
      T.move(dragId, state.tabs.findIndex((t) => t.id === id));
      dragId = null; clearDrop();
    });
    return el;
  }

  function render() {
    const keep = new Set(state.tabs.map((t) => t.id));
    for (const [id, el] of els) if (!keep.has(id)) { el.remove(); els.delete(id); }
    state.tabs.forEach((t, k) => {
      let el = els.get(t.id);
      if (!el) { el = make(t.id); els.set(t.id, el); }
      const cls = 'tab' + (t.id === state.active ? ' cur' : '') + (el.classList.contains('drop') ? ' drop' : '');
      if (el.className !== cls) el.className = cls;
      const tip = t.path || t.title;
      if (el.title !== tip) el.title = tip;
      const ico = t.empty ? '＋' : '📄';
      if (el.children[0].textContent !== ico) el.children[0].textContent = ico;
      if (el.children[1].textContent !== t.title) el.children[1].textContent = t.title;
      if (host.children[k] !== el) host.insertBefore(el, host.children[k] || null);
    });
  }
  function clearDrop() { host.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop')); }

  document.getElementById('new').title = '新分頁（' + MOD + 'N）';
  document.getElementById('new').addEventListener('click', () => T.newTab());
  document.getElementById('rest').addEventListener('dblclick', () => T.newTab());

  // 把 PDF 檔拖到分頁列：開成新分頁
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); document.body.classList.add('dragfile'); } });
  window.addEventListener('dragleave', () => document.body.classList.remove('dragfile'));
  window.addEventListener('drop', (e) => {
    document.body.classList.remove('dragfile');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /\.pdf$/i.test(f.name));
    if (files.length) T.open(files);
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  T.onState((s) => { state = s || state; render(); });
  T.ready();
})();
