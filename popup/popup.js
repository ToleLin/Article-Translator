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
