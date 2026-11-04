/* PaperLens — 共用預設值與語言代碼對照表
 * 這支檔案同時被 background(module import)、content script、options、popup 載入，
 * 所以寫成「掛到 globalThis 的傳統腳本」，兩種載入方式都能用。
 */
(function (g) {
  'use strict';

  const DEFAULTS = {
    /* --- 翻譯 --- */
    targetLang: 'zh-Hant',          // 繁體中文
    sourceLang: 'auto',             // auto / en / ja / ...
    engineOrder: ['chrome', 'edge', 'google'], // 依序嘗試，前面失敗自動退到下一個
    autoFallback: true,
    geminiApiKey: '',               // 選用，留空代表不啟用 gemini 引擎
    geminiModel: 'gemini-3.6-flash', // gemini-2.0-flash 已在 2026-06-01 停用，官方建議改用 3.6-flash

    /* --- 行為 --- */
    autoTranslate: true,            // 開啟對照後自動開始翻譯
    autoPdf: false,                 // 開啟 PDF 網址時自動換成 PaperLens 的 PDF 檢視器
    lazyTranslate: true,            // 先翻視窗附近的段落，捲到哪翻到哪
    bgTranslate: true,              // 看得到的翻完之後，在背景把整篇補完（PDF）
    syncScroll: true,
    splitRatio: 0.5,                // 左欄寬度比例
    skipChinese: true,              // 已經是中文的段落不翻
    translateRefs: false,           // PDF 的參考文獻要不要翻（作者名、期刊名翻了反而錯，預設保留原文）

    /* --- 外觀 --- */
    transFont: '"Noto Serif TC", "Source Han Serif TC", "PingFang TC", "Microsoft JhengHei", serif',
    transFontScale: 1.0,
    transColor: 'auto',             // 譯文字色：auto = 跟原文一樣；或 #rrggbb
    transLineHeight: 1.9,
    dimOriginal: false,             // 左欄稍微變淡，讓視線集中在右欄

    /* --- 註解 --- */
    defaultHighlight: 'yellow',
    showSidebar: false,
    sidebarWidth: 320,

    /* --- 匯出 --- */
    exportOrientation: 'landscape', // landscape / portrait
    exportFontSize: 10,             // pt
    exportIncludeNotes: true,
    exportInlineImages: true,       // 把圖片轉成 data URL 內嵌，列印最可靠
    exportLayout: 'pair'            // pair(左右對照) / dst(只要譯文) / src(只要原文)
  };

  /* 不同引擎對「繁體中文」的代碼不一樣，這裡統一轉換 */
  const LANG_MAP = {
    chrome: { 'zh-Hant': 'zh-Hant', 'zh-Hans': 'zh-Hans', 'en': 'en', 'ja': 'ja', 'ko': 'ko' },
    google: { 'zh-Hant': 'zh-TW',   'zh-Hans': 'zh-CN',   'en': 'en', 'ja': 'ja', 'ko': 'ko' },
    edge:   { 'zh-Hant': 'zh-Hant', 'zh-Hans': 'zh-Hans', 'en': 'en', 'ja': 'ja', 'ko': 'ko' },
    gemini: { 'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', 'en': 'English', 'ja': '日本語', 'ko': '한국어' }
  };

  const LANG_LABEL = {
    'zh-Hant': '繁體中文',
    'zh-Hans': '简体中文',
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어'
  };

  const ENGINE_LABEL = {
    chrome: 'Chrome 內建 AI（免費・離線）',
    edge:   'Edge 翻譯（免費・免金鑰）',
    google: 'Google 翻譯（免費・免金鑰）',
    gemini: 'Gemini API（需自備免費金鑰）'
  };

  const HIGHLIGHT_COLORS = {
    yellow: { label: '黃', bg: 'rgba(255, 214, 0, .45)',  line: '#f0b400' },
    green:  { label: '綠', bg: 'rgba(94, 214, 130, .42)', line: '#2f9e56' },
    blue:   { label: '藍', bg: 'rgba(120, 180, 255, .42)', line: '#3b82f6' },
    pink:   { label: '粉', bg: 'rgba(255, 140, 180, .42)', line: '#e0518a' },
    purple: { label: '紫', bg: 'rgba(186, 150, 255, .42)', line: '#8b5cf6' }
  };

  function mapLang(engine, code) {
    const t = LANG_MAP[engine] || {};
    return t[code] || code;
  }

  /* 已經被 Google 停用的模型：使用者以前存過的設定自動換成目前的預設 */
  const RETIRED_GEMINI = /^gemini-(1\.0|1\.5|2\.0)(-|$)|^gemini-pro$/;

  async function loadSettings() {
    const got = await chrome.storage.local.get('settings');
    const s = Object.assign({}, DEFAULTS, got.settings || {});
    if (!s.geminiModel || RETIRED_GEMINI.test(s.geminiModel)) s.geminiModel = DEFAULTS.geminiModel;
    return s;
  }

  async function saveSettings(patch) {
    const cur = await loadSettings();
    const next = Object.assign({}, cur, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  g.PL_DEFAULTS = DEFAULTS;
  g.PL_LANG_MAP = LANG_MAP;
  g.PL_LANG_LABEL = LANG_LABEL;
  g.PL_ENGINE_LABEL = ENGINE_LABEL;
  g.PL_HIGHLIGHTS = HIGHLIGHT_COLORS;
  g.PL_mapLang = mapLang;
  g.PL_loadSettings = loadSettings;
  g.PL_saveSettings = saveSettings;
})(globalThis);
