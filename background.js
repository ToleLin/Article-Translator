/* PaperLens — background service worker
 * 職責：1) 注入 content script  2) 代理需要跨網域的翻譯請求  3) 內建 AI 的 worker 側入口
 */
import './shared/defaults.js';
import './shared/localai.js';
import './shared/remote-engines.js';

const CONTENT_JS = [
  'shared/defaults.js',
  'shared/localai.js',
  'shared/translator.js',
  'content/core.js',
  'content/split.js',
  'content/translate.js',
  'content/annotate.js',
  'content/overlay.js',
  'content/export.js',
  'content/boot.js'
];

/* ════════════════════════════════════════════════════════════
   注入
   ════════════════════════════════════════════════════════════ */

async function ensureInjected(tabId) {
  let loaded = false;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!globalThis.__PL_LOADED
    });
    loaded = !!(r && r.result);
  } catch (e) {
    throw new Error('這個分頁不能注入腳本（chrome://、擴充功能商店、PDF 檢視器等頁面受保護）。');
  }
  if (loaded) return true;

  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/pl.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
  return false;
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('找不到作用中的分頁');
  return tab.id;
}

/* ════════════════════════════════════════════════════════════
   PDF：Chrome 內建的 PDF 檢視器是外掛程式，content script 進不去，
   也讀不到裡面的文字。所以 PDF 一律改用我們自己的 pdf.js 檢視器。
   ════════════════════════════════════════════════════════════ */

const VIEWER = chrome.runtime.getURL('pdf/pdfview.html');

function looksLikePdf(url) {
  if (!url) return false;
  if (url.startsWith(VIEWER)) return false;
  try {
    const u = new URL(url);
    if (!/^(https?|file):$/.test(u.protocol)) return false;
    return /\.pdf$/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function viewerUrlFor(url) {
  return VIEWER + '?file=' + encodeURIComponent(url);
}

async function openInViewer(tabId, url, newTab) {
  const target = viewerUrlFor(url);
  if (newTab) {
    const t = await chrome.tabs.create({ url: target });
    return { tabId: t.id, pdf: true };
  }
  await chrome.tabs.update(tabId, { url: target });
  return { tabId, pdf: true };
}

/* ════════════════════════════════════════════════════════════
   遠端翻譯引擎（都在 background 呼叫，避開網頁的 CORS 限制）
   ════════════════════════════════════════════════════════════ */

/* ---- 分派 + 自動備援 ---- */

async function remoteTranslate({ engine, texts, sourceLang, targetLang, settings }) {
  const s = settings || await PL_loadSettings();
  const order = engine ? [engine] : (s.engineOrder || PL_DEFAULTS.engineOrder);
  const tried = [];
  let lastErr = null;

  for (const eng of order) {
    if (eng === 'chrome') continue;                 // 內建 AI 由呼叫端自己處理
    if (eng === 'gemini' && !s.geminiApiKey) continue;
    const tgt = PL_mapLang(eng, targetLang || s.targetLang);
    const src = (sourceLang && sourceLang !== 'auto') ? PL_mapLang(eng, sourceLang) : 'auto';
    try {
      let result;
      if (eng === 'google') result = await PLRemote.googleTranslate(texts, src, tgt);
      else if (eng === 'edge') result = await PLRemote.edgeTranslate(texts, src, tgt);
      else if (eng === 'gemini') result = await PLRemote.geminiTranslate(texts, src, tgt, s.geminiApiKey, s.geminiModel);
      else continue;

      if (result && result.some((x) => x != null)) return { engine: eng, result };
      lastErr = new Error(eng + ' 沒有回傳任何譯文');
    } catch (e) {
      lastErr = e;
      tried.push(eng + '：' + (e && e.message || e));
      if (!s.autoFallback && engine) break;
    }
  }
  throw new Error(tried.length ? tried.join(' ／ ') : (lastErr ? lastErr.message : '沒有可用的翻譯引擎'));
}

/* ---- 用遠端模型做「AI 解釋」（Chrome 內建不可用時的備援） ---- */

async function remoteExplain(text, context, settings) {
  const s = settings || await PL_loadSettings();
  if (!s.geminiApiKey) {
    throw new Error('這台 Chrome 的內建語言模型無法使用，且尚未設定 Gemini 金鑰。'
      + '可到設定頁貼上 Google AI Studio 的免費金鑰，或改用「翻譯本段」了解內容。');
  }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(s.geminiModel || 'gemini-2.0-flash') + ':generateContent?key=' + encodeURIComponent(s.geminiApiKey);

  let prompt = '你是協助研究生讀論文的助教。用繁體中文說明下面這段文獻在做什麼。\n'
    + '固定三行：「重點：」一句話講主張或動作；「細節：」最多兩句補方法/數據/條件；'
    + '「名詞：」列出專有名詞用「英文(中文)」並各給一句解釋，沒有就寫「無」。\n'
    + '不要開場白，不要重複原文，不要編造。\n\n【片段】\n' + text.slice(0, 6000);
  if (context && context.title) prompt = '【文獻標題】' + context.title + '\n' + prompt;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3 }
    })
  });
  if (!res.ok) throw new Error('Gemini 回應 ' + res.status);
  const data = await res.json();
  const out = data && data.candidates && data.candidates[0]
    && data.candidates[0].content && data.candidates[0].content.parts
    && data.candidates[0].content.parts.map((p) => p.text || '').join('');
  if (!out) throw new Error('Gemini 沒有回傳內容');
  return out;
}

/* ---- 圖片轉 data URL（匯出 PDF 時內嵌，避免防盜連導致列印缺圖） ---- */

async function fetchImageAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('圖片 ' + res.status);
  const blob = await res.blob();
  if (blob.size > 6 * 1024 * 1024) throw new Error('圖片過大');
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('圖片讀取失敗'));
    fr.readAsDataURL(blob);
  });
}

/* ════════════════════════════════════════════════════════════
   訊息路由
   ════════════════════════════════════════════════════════════ */

const handlers = {
  async 'ai.probe'(msg) {
    const s = await PL_loadSettings();
    return PLLocalAI.probe(
      msg.sourceLang && msg.sourceLang !== 'auto' ? msg.sourceLang : 'en',
      msg.targetCode || PL_mapLang('chrome', msg.targetLang || s.targetLang)
    );
  },

  async 'ai.translate'(msg) {
    const s = await PL_loadSettings();
    const src = msg.sourceLang && msg.sourceLang !== 'auto' ? PL_mapLang('chrome', msg.sourceLang) : 'en';
    const tgt = msg.targetCode || PL_mapLang('chrome', msg.targetLang || s.targetLang);
    const result = await PLLocalAI.translateMany(msg.texts, src, tgt, { concurrency: 3, chunk: 350 });
    return { engine: 'chrome', result };
  },

  async 'ai.warm'(msg) {
    const s = await PL_loadSettings();
    const src = msg.sourceLang && msg.sourceLang !== 'auto' ? PL_mapLang('chrome', msg.sourceLang) : 'en';
    const tgt = msg.targetCode || PL_mapLang('chrome', msg.targetLang || s.targetLang);
    await PLLocalAI.getTranslator(src, tgt);
    return { ready: true };
  },

  async 'ai.detect'(msg) {
    return { lang: await PLLocalAI.detect(msg.text || '') };
  },

  async 'ai.explain'(msg) {
    const s = await PL_loadSettings();

    // 有 Gemini 金鑰就直接請它用目標語言回答，品質最好
    if (s.geminiApiKey) {
      try { return { text: await remoteExplain(msg.text, msg.context, s), via: 'gemini' }; }
      catch (e) { /* 掉到內建模型 */ }
    }

    if (PLLocalAI.hasLanguageModel()) {
      // Gemini Nano 只能輸出 de/en/es/fr/ja，所以先讓它寫英文，再交給翻譯引擎轉成目標語言
      const en = await PLLocalAI.explain(msg.text, msg.context);
      const target = msg.targetLang || s.targetLang;
      if (/^en/i.test(target)) return { text: en, via: 'chrome' };

      try {
        const lines = en.split(/\r?\n/).filter((x) => x.trim());
        const r = await remoteTranslate({ texts: lines, sourceLang: 'en', targetLang: target, settings: s });
        const zh = (r.result || []).filter(Boolean).join('\n');
        if (zh) return { text: zh, via: 'chrome+' + r.engine };
      } catch (e) { /* 翻不動就給英文原文 */ }

      return { text: en + '\n\n（Chrome 內建模型只能輸出英文，而目前所有翻譯引擎都不通，所以這裡先給英文。）', via: 'chrome' };
    }

    return { text: await remoteExplain(msg.text, msg.context, s), via: 'gemini' };
  },

  async 'translate.remote'(msg) {
    return remoteTranslate(msg);
  },

  async 'settings.get'() {
    return PL_loadSettings();
  },

  async 'settings.set'(msg) {
    return PL_saveSettings(msg.patch || {});
  },

  async 'image.inline'(msg) {
    const out = {};
    const urls = (msg.urls || []).slice(0, 200);
    await Promise.all(urls.map(async (u) => {
      try { out[u] = await fetchImageAsDataUrl(u); }
      catch (e) { out[u] = null; }
    }));
    return out;
  },

  async 'export.open'(msg) {
    await chrome.storage.session.set({ exportPayload: msg.payload });
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('export/export.html') });
    return { tabId: tab.id };
  },

  async 'export.take'() {
    const got = await chrome.storage.session.get('exportPayload');
    return got.exportPayload || null;
  },

  async 'toggle'(msg) {
    const tabId = msg.tabId || await activeTabId();
    const tab = await chrome.tabs.get(tabId);

    if (looksLikePdf(tab.url)) return openInViewer(tabId, tab.url);
    if (tab.url && tab.url.startsWith(VIEWER)) {
      return { pdf: true, note: '已經在 PaperLens 的 PDF 檢視器裡了' };
    }

    const already = await ensureInjected(tabId);
    if (already) return chrome.tabs.sendMessage(tabId, { type: 'pl.toggle' });
    return chrome.tabs.sendMessage(tabId, { type: 'pl.activate' });
  },

  async 'command'(msg) {
    const tabId = msg.tabId || await activeTabId();
    const tab = await chrome.tabs.get(tabId);

    // PDF 分頁：先切到我們的檢視器，其餘指令在那邊自己處理
    if (looksLikePdf(tab.url)) return openInViewer(tabId, tab.url);
    if (tab.url && tab.url.startsWith(VIEWER)) {
      return chrome.tabs.sendMessage(tabId, { type: 'pl.command', command: msg.command });
    }

    await ensureInjected(tabId);
    return chrome.tabs.sendMessage(tabId, { type: 'pl.command', command: msg.command });
  },

  async 'pdf.open'(msg) {
    const tabId = msg.tabId || await activeTabId();
    const tab = await chrome.tabs.get(tabId);
    if (looksLikePdf(tab.url)) return openInViewer(tabId, tab.url, !!msg.newTab);
    return openInViewer(tabId, '', true);       // 沒有網址就開空的檢視器讓使用者拖檔進去
  },

  async 'openOptions'() {
    await chrome.runtime.openOptionsPage();
    return true;
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender)).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String(err && err.message || err) })
  );
  return true;      // 保持通道開著，等待非同步回覆
});

/* ---- 快捷鍵 ---- */

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const tabId = await activeTabId();
    if (command === 'toggle-split') {
      await handlers['toggle']({ tabId });
    } else {
      await handlers['command']({ tabId, command });
    }
  } catch (e) {
    console.warn('[PaperLens]', e);
  }
});

/* ---- 右鍵選單 ---- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pl-toggle',
      title: 'PaperLens：開啟／關閉對照閱讀',
      contexts: ['page', 'selection']
    });
    chrome.contextMenus.create({
      id: 'pl-highlight',
      title: 'PaperLens：螢光標記這段',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'pl-explain',
      title: 'PaperLens：AI 解釋這段',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'pl-pdf',
      title: 'PaperLens：用對照模式開啟這個 PDF',
      contexts: ['link', 'page'],
      targetUrlPatterns: ['*://*/*.pdf', '*://*/*.PDF', 'file://*/*.pdf', 'file://*/*.PDF']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  try {
    if (info.menuItemId === 'pl-toggle') await handlers['toggle']({ tabId: tab.id });
    if (info.menuItemId === 'pl-highlight') await handlers['command']({ tabId: tab.id, command: 'highlight-selection' });
    if (info.menuItemId === 'pl-explain') await handlers['command']({ tabId: tab.id, command: 'explain-selection' });
    if (info.menuItemId === 'pl-pdf') {
      const url = info.linkUrl || info.pageUrl || tab.url;
      if (looksLikePdf(url)) await openInViewer(tab.id, url, !!info.linkUrl);
    }
  } catch (e) {
    console.warn('[PaperLens]', e);
  }
});

/* ---- 選項開啟時，PDF 分頁自動換成我們的檢視器 ---- */

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || !looksLikePdf(tab.url)) return;
  try {
    const s = await PL_loadSettings();
    if (!s.autoPdf) return;
    await openInViewer(tabId, tab.url);
  } catch (e) { /* ignore */ }
});
