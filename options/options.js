/* PaperLens — 設定頁 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ALL_ENGINES = ['chrome', 'edge', 'google', 'gemini'];

  let settings = null;

  /* ══════════ 儲存 ══════════ */

  let savedTimer = null;
  function flash() {
    $('saved').classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1100);
  }

  async function save(patch) {
    settings = await globalThis.PL_saveSettings(patch);
    flash();
    // 讓已經開著的分頁馬上套用外觀變更
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'pl.settings', patch }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  /* ══════════ 引擎順序 ══════════ */

  function renderEngines() {
    const list = $('engineOrder');
    list.textContent = '';

    const enabled = settings.engineOrder.slice();
    const disabled = ALL_ENGINES.filter((e) => !enabled.includes(e));
    const rows = enabled.map((e) => ({ key: e, on: true }))
      .concat(disabled.map((e) => ({ key: e, on: false })));

    rows.forEach((row, i) => {
      const li = document.createElement('li');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = row.on;
      cb.addEventListener('change', () => {
        let next = settings.engineOrder.filter((e) => e !== row.key);
        if (cb.checked) next.push(row.key);
        if (!next.length) { next = ['edge']; }
        settings.engineOrder = next;
        save({ engineOrder: next }).then(renderEngines);
      });
      li.appendChild(cb);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = globalThis.PL_ENGINE_LABEL[row.key];
      li.appendChild(name);

      if (row.key === 'gemini' && !settings.geminiApiKey) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '需填金鑰';
        li.appendChild(tag);
      }

      const up = document.createElement('button');
      up.textContent = '▲';
      up.disabled = !row.on || i === 0;
      up.addEventListener('click', () => move(row.key, -1));
      li.appendChild(up);

      const down = document.createElement('button');
      down.textContent = '▼';
      down.disabled = !row.on || i >= enabled.length - 1;
      down.addEventListener('click', () => move(row.key, 1));
      li.appendChild(down);

      list.appendChild(li);
    });
  }

  function move(key, dir) {
    const arr = settings.engineOrder.slice();
    const i = arr.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    settings.engineOrder = arr;
    save({ engineOrder: arr }).then(renderEngines);
  }

  /* ══════════ 綁定欄位 ══════════ */

  function bindCheck(id) {
    $(id).checked = !!settings[id];
    $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
  }

  function bindSelect(id) {
    $(id).value = settings[id];
    $(id).addEventListener('change', () => save({ [id]: $(id).value }));
  }

  function bindText(id) {
    $(id).value = settings[id] || '';
    $(id).addEventListener('change', () => {
      save({ [id]: $(id).value.trim() }).then(renderEngines);
    });
  }

  function bindRange(id, fmt) {
    const out = $(id + 'Out');
    const el = $(id);
    el.value = settings[id];
    out.textContent = fmt(settings[id]);
    el.addEventListener('input', () => { out.textContent = fmt(el.value); });
    el.addEventListener('change', () => save({ [id]: Number(el.value) }));
  }

  /* ══════════ 引擎測試 ══════════ */

  async function testEngines() {
    const btn = $('testEngines');
    const out = $('testResult');
    btn.disabled = true;
    out.textContent = '測試中…';

    const lines = [];
    const sample = 'We propose a photonic crystal cavity with a measured quality factor of 1.2 million.';

    // Chrome 內建
    try {
      const probe = await send({ type: 'ai.probe', sourceLang: settings.sourceLang, targetLang: settings.targetLang });
      const t = probe.translator;
      const map = {
        available: '可用（模型已就緒）',
        downloadable: '可用（第一次使用會先下載模型，約幾十 MB）',
        downloading: '模型下載中',
        unavailable: '不支援（多半是磁碟空間或硬體不符合內建 AI 的條件）',
        unsupported: '這個 Chrome 沒有這個 API'
      };
      lines.push('Chrome 內建翻譯：' + (map[t] || t)
        + (probe.targetLanguage ? '　代碼 ' + probe.targetLanguage : '')
        + (probe.tried && probe.tried.length ? '　試過 ' + probe.tried.join('、') : ''));
      lines.push('Chrome 內建語言模型：' + (map[probe.languageModel] || probe.languageModel)
        + '（只能輸出英文，AI 解釋會先寫英文再自動翻成中文）');
    } catch (e) {
      lines.push('Chrome 內建：查詢失敗 — ' + (e.message || e));
    }

    // 遠端引擎
    for (const eng of ['edge', 'google'].concat(settings.geminiApiKey ? ['gemini'] : [])) {
      try {
        const t0 = performance.now();
        const r = await send({
          type: 'translate.remote', engine: eng, texts: [sample],
          sourceLang: settings.sourceLang, targetLang: settings.targetLang
        });
        const ms = Math.round(performance.now() - t0);
        lines.push(globalThis.PL_ENGINE_LABEL[eng].split('（')[0] + '：可用（' + ms + 'ms）→ '
          + String(r.result[0]).slice(0, 40) + '…');
      } catch (e) {
        lines.push(globalThis.PL_ENGINE_LABEL[eng].split('（')[0] + '：失敗 — ' + (e.message || e));
      }
    }

    out.textContent = lines.join('\n');
    btn.disabled = false;
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('背景服務沒有回應'));
        if (!res.ok) return reject(new Error(res.error));
        if (res.data == null) return reject(new Error('沒有收到背景服務的回覆（可能被其他分頁攔截）'));
        resolve(res.data);
      });
    });
  }

  /* ══════════ 資料管理 ══════════ */

  async function refreshDataInfo() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all);
    const cache = keys.filter((k) => k.startsWith('tc:')).length;
    const pages = keys.filter((k) => k.startsWith('ann:'));
    let notes = 0;
    pages.forEach((k) => { notes += (all[k].items || []).length; });
    let bytes = 0;
    try { bytes = await chrome.storage.local.getBytesInUse(null); } catch (e) { bytes = 0; }
    $('dataInfo').textContent =
      '翻譯快取 ' + cache + ' 筆　·　註解 ' + notes + ' 則（分布在 ' + pages.length + ' 篇文獻）　·　'
      + '已用 ' + (bytes / 1048576).toFixed(2) + ' MB';
  }

  async function exportNotes() {
    const all = await chrome.storage.local.get(null);
    const pages = Object.keys(all).filter((k) => k.startsWith('ann:'))
      .map((k) => Object.assign({ key: k.slice(4) }, all[k]));
    const blob = new Blob([JSON.stringify({
      app: 'PaperLens', version: 1, exportedAt: new Date().toISOString(), pages
    }, null, 2)], { type: 'application/json' });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'paperlens-notes-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function importNotes(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.pages)) throw new Error('檔案格式不符');
      const patch = {};
      let merged = 0;
      const existing = await chrome.storage.local.get(null);

      for (const page of data.pages) {
        const key = 'ann:' + page.key;
        const cur = existing[key] || { title: page.title, url: page.url, items: [] };
        const ids = new Set((cur.items || []).map((i) => i.id));
        for (const it of (page.items || [])) {
          if (!ids.has(it.id)) { cur.items.push(it); merged++; }
        }
        patch[key] = cur;
      }
      await chrome.storage.local.set(patch);
      $('dataInfo').textContent = '已匯入 ' + merged + ' 則註解。';
      setTimeout(refreshDataInfo, 1500);
    } catch (e) {
      $('dataInfo').textContent = '匯入失敗：' + (e.message || e);
    }
  }

  /* ══════════ 啟動 ══════════ */

  (async function main() {
    settings = await globalThis.PL_loadSettings();
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    bindSelect('targetLang');
    bindSelect('sourceLang');
    bindSelect('transFont');
    bindSelect('defaultHighlight');

    bindCheck('autoFallback');
    bindCheck('skipChinese');
    bindCheck('autoTranslate');
    bindCheck('lazyTranslate');
    bindCheck('bgTranslate');
    bindCheck('syncScroll');
    bindCheck('dimOriginal');
    bindCheck('showSidebar');
    bindCheck('autoPdf');

    bindText('geminiApiKey');
    bindText('geminiModel');

    bindRange('transFontScale', (v) => Math.round(Number(v) * 100) + '%');
    bindRange('transLineHeight', (v) => Number(v).toFixed(2));

    renderEngines();
    refreshDataInfo();

    $('testEngines').addEventListener('click', testEngines);

    $('clearCache').addEventListener('click', async () => {
      const all = await chrome.storage.local.get(null);
      const kill = Object.keys(all).filter((k) => k.startsWith('tc:'));
      if (kill.length) await chrome.storage.local.remove(kill);
      $('dataInfo').textContent = '已清除 ' + kill.length + ' 筆翻譯快取。';
      setTimeout(refreshDataInfo, 1200);
    });

    $('exportNotes').addEventListener('click', exportNotes);
    $('importNotes').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) importNotes(e.target.files[0]);
      e.target.value = '';
    });

    $('clearNotes').addEventListener('click', async () => {
      if (!confirm('確定要刪除「全部文獻」的所有註解嗎？此動作無法復原。\n建議先按「匯出全部註解」備份。')) return;
      const all = await chrome.storage.local.get(null);
      const kill = Object.keys(all).filter((k) => k.startsWith('ann:'));
      if (kill.length) await chrome.storage.local.remove(kill);
      $('dataInfo').textContent = '已刪除 ' + kill.length + ' 篇文獻的註解。';
      setTimeout(refreshDataInfo, 1200);
    });

    // 譯文語言改了要重翻
    $('targetLang').addEventListener('change', async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'pl.settings', patch: { targetLang: $('targetLang').value }, retranslate: true })
          .catch(() => {});
      }
    });
  })();
})();
