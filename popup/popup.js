/* PaperLens — 工具列彈出視窗 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

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

  function say(t) { $('state').textContent = t; }

  async function run(fn, closeAfter) {
    try {
      await fn();
      if (closeAfter) window.close();
    } catch (e) {
      say('⚠ ' + (e.message || e));
    }
  }

  $('toggle').addEventListener('click', () => run(() => send({ type: 'toggle' }), true));
  $('all').addEventListener('click', () => run(() => send({ type: 'command', command: 'translate-all' }), true));
  $('notes').addEventListener('click', () => run(() => send({ type: 'command', command: 'sidebar' }), true));
  $('retry').addEventListener('click', () => run(() => send({ type: 'command', command: 'retry' }), true));
  $('pdf').addEventListener('click', () => run(() => send({ type: 'command', command: 'export-pdf' }), true));
  $('options').addEventListener('click', () => run(() => send({ type: 'openOptions' }), true));

  /* 新版本提醒 */
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  function showUpdate(u) {
    const box = $('upd');
    if (!u || !u.newer) { box.classList.remove('on'); return; }
    $('upd-title').textContent = '有新版本 v' + u.latest + '（目前 v' + u.current + '）';
    const ul = $('upd-list');
    ul.textContent = '';
    for (const t of (u.highlights || []).slice(0, 4)) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    ul.style.display = ul.children.length ? '' : 'none';
    $('upd-dl').onclick = () => chrome.tabs.create({ url: (u.assets && u.assets.extension) || u.url });
    box.classList.add('on');
  }

  $('upd-ext').addEventListener('click', () => run(() => send({ type: 'update.openExtensions' }), true));
  $('upd-check').addEventListener('click', async () => {
    const a = $('upd-check');
    a.textContent = '檢查中…';
    try {
      const u = await send({ type: 'update.check', force: true });
      showUpdate(u);
      a.textContent = u.newer ? '有新版本' : u.error && !u.latest ? '無法檢查' : '已是最新版';
      if (u.error && !u.latest) say('⚠ ' + u.error);
    } catch (e) {
      a.textContent = '無法檢查';
      say('⚠ ' + (e.message || e));
    }
  });
  send({ type: 'update.check' }).then(showUpdate, () => {});

  /* 顯示目前分頁狀態 */
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'pl.state' }).catch(() => null);
      if (res && res.ok && res.data && res.data.active) {
        const d = res.data;
        say('對照中 · 已翻 ' + d.done + '/' + d.blocks + ' 段 · 註解 ' + d.notes + ' 則');
      } else {
        say('尚未在這個分頁啟用');
      }
    } catch (e) { /* 沒注入過就不顯示 */ }
  })();
})();
