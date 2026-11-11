/* PaperLens 桌面版 — 分頁列 */
(function () {
  'use strict';
  const T = window.PLTabs;
  const host = document.getElementById('tabs');
  let state = { tabs: [], active: null };
  let dragId = null;

  function render() {
    host.textContent = '';
    state.tabs.forEach((t, k) => {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === state.active ? ' cur' : '');
      el.draggable = true;
      el.title = t.path || t.title;
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = t.empty ? '＋' : '📄';
      const ttl = document.createElement('span');
      ttl.className = 'ttl';
      ttl.textContent = t.title;
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '✕';
      x.title = '關閉分頁（Ctrl+W）';
      x.addEventListener('click', (e) => { e.stopPropagation(); T.close(t.id); });
      el.append(ico, ttl, x);
      el.addEventListener('mousedown', (e) => { if (e.button === 0) T.activate(t.id); });
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); T.close(t.id); } });
      // 拖曳換位置
      el.addEventListener('dragstart', (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); });
      el.addEventListener('dragend', () => { dragId = null; clearDrop(); });
      el.addEventListener('dragover', (e) => { if (dragId == null) return; e.preventDefault(); clearDrop(); el.classList.add('drop'); });
      el.addEventListener('drop', (e) => { if (dragId == null) return; e.preventDefault(); e.stopPropagation(); T.move(dragId, k); dragId = null; clearDrop(); });
      host.appendChild(el);
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
