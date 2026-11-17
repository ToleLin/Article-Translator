/* PaperLens 桌面版 — 分頁列 */
(function () {
  'use strict';
  const T = window.PLTabs;
  const host = document.getElementById('tabs');
  let state = { tabs: [], active: null };
  let dragId = null;

  let drawn = '';
  const els = new Map();          // 分頁 id → 畫面上的元素

  function make(t) {
    const el = document.createElement('div');
    el.draggable = true;
    const ico = document.createElement('span');
    ico.className = 'ico';
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = '關閉分頁';
    // 按在 ✕ 上不算「點分頁」：不然會先切換分頁，✕ 反而沒作用
    x.addEventListener('mousedown', (e) => e.stopPropagation());
    x.addEventListener('click', (e) => { e.stopPropagation(); T.close(t.id); });
    el.append(ico, ttl, x);
    el.addEventListener('mousedown', (e) => { if (e.button === 0 && t.id !== state.active) T.activate(t.id); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); T.close(t.id); } });
    // 拖曳換位置
    el.addEventListener('dragstart', (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); });
    el.addEventListener('dragend', () => { dragId = null; clearDrop(); });
    el.addEventListener('dragover', (e) => { if (dragId == null) return; e.preventDefault(); clearDrop(); el.classList.add('drop'); });
    el.addEventListener('drop', (e) => {
      if (dragId == null) return;
      e.preventDefault(); e.stopPropagation();
      T.move(dragId, state.tabs.findIndex((y) => y.id === t.id));
      dragId = null; clearDrop();
    });
    return el;
  }

  /* 只更新有變的地方，元素能沿用就沿用。
     整個清掉重畫的話，滑鼠正按著的那個按鈕會被換成新的，放開時就點不到（✕ 沒反應、分頁拖不動）。 */
  function render() {
    const sig = JSON.stringify(state);
    if (sig === drawn) return;
    drawn = sig;
    const alive = new Set(state.tabs.map((t) => t.id));
    for (const [id, el] of els) if (!alive.has(id)) { el.remove(); els.delete(id); }
    state.tabs.forEach((t, k) => {
      let el = els.get(t.id);
      if (!el) { el = make(t); els.set(t.id, el); }
      el.className = 'tab' + (t.id === state.active ? ' cur' : '');
      el.title = t.path || t.title;
      el.querySelector('.ico').textContent = t.empty ? '＋' : '📄';
      el.querySelector('.ttl').textContent = t.title;
      if (host.children[k] !== el) host.insertBefore(el, host.children[k] || null);
    });
  }
  function clearDrop() { host.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop')); }

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
