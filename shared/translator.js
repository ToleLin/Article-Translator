/* PaperLens — 共用翻譯客戶端
 *
 * 網頁對照（content script）和 PDF 檢視器（擴充功能頁面）都用這一支，
 * 所以快取、引擎順序、自動備援、逾時、Chrome 內建模型暖機只有一份實作。
 *
 * 需要的環境：chrome.runtime（送訊息給 background）、chrome.storage.local（快取）。
 */
(function (g) {
  'use strict';

  const T = {};

  const ENGINE_TIMEOUT = 60000;
  const PROBE_TIMEOUT = 12000;     // 第一次問內建 AI 可能要好幾秒，給短了會誤判成不支援

  let cfg = {
    getSettings: () => (g.PL_DEFAULTS || {}),
    onStatus: function () {},
    onNotice: function () {}
  };

  T.init = function (o) { Object.assign(cfg, o || {}); };

  T.sourceLang = null;
  T.lastEngine = null;

  /* ══════════ 工具 ══════════ */

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return s.length.toString(36) + '-' + (h >>> 0).toString(36);
  }
  T.hash = hash;

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(label + ' 超過 ' + Math.round(ms / 1000) + ' 秒沒有回應')), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      let done = false;
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (done) return;
          done = true;
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('背景服務沒有回應'));
          if (!res.ok) return reject(new Error(res.error || '未知錯誤'));
          resolve(res.data);
        });
      } catch (e) {
        if (!done) { done = true; reject(e); }
      }
    });
  }
  T.send = send;

  /* ══════════ 快取 ══════════ */

  const mem = new Map();
  let pendingWrites = {};
  let flushTimer = null;

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(async () => {
      const batch = pendingWrites;
      pendingWrites = {};
      if (!Object.keys(batch).length) return;
      try { await chrome.storage.local.set(batch); }
      catch (e) { /* 配額滿了就只留記憶體快取 */ }
    }, 1200);
  }

  T.cacheKey = (text, lang) => 'tc:' + lang + ':' + hash(text);

  T.cacheGetMany = async function (texts, lang) {
    const keys = [], need = [];
    const result = new Array(texts.length).fill(undefined);

    texts.forEach((t, i) => {
      const k = T.cacheKey(t, lang);
      if (mem.has(k)) { result[i] = mem.get(k); return; }
      keys.push(k); need.push(i);
    });

    if (keys.length) {
      let got = {};
      try { got = await chrome.storage.local.get(keys); } catch (e) { got = {}; }
      need.forEach((i) => {
        const k = T.cacheKey(texts[i], lang);
        if (got[k] != null) { mem.set(k, got[k]); result[i] = got[k]; }
      });
    }
    return result;
  };

  T.cachePut = function (text, lang, translated) {
    if (!translated) return;
    const k = T.cacheKey(text, lang);
    mem.set(k, translated);
    pendingWrites[k] = translated;
    scheduleFlush();
  };

  /* ══════════ 原文語言 ══════════ */

  T.ensureSourceLang = async function (sampleText) {
    if (T.sourceLang) return T.sourceLang;
    const s = cfg.getSettings();
    if (s.sourceLang && s.sourceLang !== 'auto') {
      T.sourceLang = s.sourceLang;
      return T.sourceLang;
    }
    let lang = null;
    try {
      const r = await withTimeout(send({ type: 'ai.detect', text: (sampleText || '').slice(0, 1200) }), 5000, '語言偵測');
      lang = r && r.lang;
    } catch (e) { /* 偵測不出來就當英文 */ }
    if (!lang && typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
      lang = document.documentElement.lang.split('-')[0];
    }
    T.sourceLang = lang || 'en';
    return T.sourceLang;
  };

  /* ══════════ Chrome 內建翻譯 ══════════ */

  let chromeSide = null;          // 'page' | 'bg' | 'none'
  let chromeState = 'unknown';    // 'ready' | 'warming' | 'unavailable'
  let chromeTarget = null;        // 實際問得通的目標語言代碼
  let probeTries = 0;
  let warmPromise = null;
  let warnedOnce = false;

  function chromeLangs() {
    const s = cfg.getSettings();
    return {
      tgt: chromeTarget || g.PL_mapLang('chrome', s.targetLang),
      src: (T.sourceLang && T.sourceLang !== 'auto') ? T.sourceLang : 'en'
    };
  }

  async function probeChrome() {
    const { src, tgt } = chromeLangs();
    const s = cfg.getSettings();
    const usable = (v) => v === 'available' || v === 'downloadable' || v === 'downloading';
    let timedOut = false;

    const accept = (p, side) => {
      T.chromeProbe = p;
      chromeSide = side;
      chromeTarget = p.targetLanguage || tgt;
      chromeState = (p.translator === 'available') ? 'ready' : 'warming';
    };

    // 先試「本頁面這一側」：使用者按按鈕時帶著 user activation，模型才准開始下載
    try {
      if (g.PLLocalAI && g.PLLocalAI.hasTranslator()) {
        const p = await withTimeout(g.PLLocalAI.probe(src, tgt), PROBE_TIMEOUT, '內建 AI 探測');
        if (usable(p.translator)) { accept(p, 'page'); return; }
      }
    } catch (e) { timedOut = true; }

    try {
      const p = await withTimeout(
        send({ type: 'ai.probe', sourceLang: src, targetCode: tgt, targetLang: s.targetLang }),
        PROBE_TIMEOUT, '內建 AI 探測');
      if (usable(p.translator)) { accept(p, 'bg'); return; }
      T.chromeProbe = p;
    } catch (e) { timedOut = true; }

    /* 逾時不代表不支援 —— 第一次呼叫內建 AI 本來就可能很慢。
       只有「問得到答案但明確說不支援」才永久停用，逾時則留著下次再試。 */
    probeTries++;
    if (timedOut && probeTries < 3) {
      chromeSide = null;
      chromeState = 'unknown';
    } else {
      chromeSide = 'none';
      chromeState = 'unavailable';
    }
  }

  /**
   * 模型還沒下載時 Translator.create() 可能要等好幾分鐘，甚至因為缺少使用者手勢
   * 而永遠不回應。所以下載丟到背景跑，翻譯先走遠端引擎，好了再自動接手。
   */
  function warmChrome() {
    if (chromeState === 'ready' || chromeState === 'unavailable') return warmPromise;
    if (warmPromise) return warmPromise;

    const { src, tgt } = chromeLangs();
    const s = cfg.getSettings();
    cfg.onNotice('Chrome 內建翻譯模型正在背景下載，這段期間先用免費線上引擎。', 4200);

    const job = (chromeSide === 'page')
      ? g.PLLocalAI.getTranslator(src, tgt, (loaded) => {
          cfg.onStatus('內建模型下載中 ' + Math.round((loaded || 0) * 100) + '%');
        })
      : send({ type: 'ai.warm', sourceLang: src, targetCode: tgt, targetLang: s.targetLang });

    warmPromise = job.then(
      () => {
        chromeState = 'ready';
        cfg.onNotice('Chrome 內建翻譯模型已就緒，之後的段落改用離線翻譯。', 3200);
      },
      (e) => {
        chromeState = 'unavailable';
        warmPromise = null;
        if (!warnedOnce) {
          warnedOnce = true;
          cfg.onNotice('Chrome 內建翻譯無法啟用（' + (e.message || e) + '），改用免費線上引擎。', 5000);
        }
      }
    );
    return warmPromise;
  }

  /** 探測只跑一次，而且永遠在背景跑 —— 翻譯不能卡著等它 */
  let probePromise = null;
  function ensureProbe() {
    if (chromeSide !== null) return Promise.resolve();
    if (!probePromise) {
      probePromise = probeChrome()
        .catch(() => {})
        .then(() => { probePromise = null; if (chromeState === 'warming') warmChrome(); });
    }
    return probePromise;
  }

  /** 在使用者剛按下按鈕時呼叫，這時才有權限開始下載模型 */
  T.prewarm = function () {
    if (chromeSide === null) ensureProbe();
    else if (chromeState === 'warming') warmChrome();
  };

  async function chromeTranslate(texts) {
    if (chromeSide === null) {
      ensureProbe();      // 背景探測，這一批先讓給遠端引擎
      throw new Error('內建 AI 還在探測中');
    }
    if (chromeState === 'unavailable') {
      const p = T.chromeProbe;
      throw new Error('內建翻譯不可用'
        + (p && p.tried && p.tried.length ? '（' + p.tried.join('、') + '）' : ''));
    }
    if (chromeState !== 'ready') {
      warmChrome();                     // 不等它，直接讓流程退到下一個引擎
      throw new Error('內建模型尚未就緒');
    }

    const { src, tgt } = chromeLangs();
    const s = cfg.getSettings();
    if (chromeSide === 'page') {
      const result = await withTimeout(
        g.PLLocalAI.translateMany(texts, src, tgt, { concurrency: 3 }),
        ENGINE_TIMEOUT, 'Chrome 內建翻譯');
      return { engine: 'chrome', result };
    }
    return withTimeout(
      send({ type: 'ai.translate', texts, sourceLang: src, targetCode: tgt, targetLang: s.targetLang }),
      ENGINE_TIMEOUT, 'Chrome 內建翻譯');
  }

  /* ══════════ 對外：翻譯一批字串 ══════════ */

  T.engineOrder = function () {
    const s = cfg.getSettings();
    const base = (s.engineOrder && s.engineOrder.length) ? s.engineOrder.slice() : ['chrome', 'edge', 'google'];
    let order;
    if (s.forceEngine) {
      order = s.autoFallback ? [s.forceEngine].concat(base.filter((e) => e !== s.forceEngine)) : [s.forceEngine];
    } else {
      order = base;
    }
    if (!s.geminiApiKey) order = order.filter((e) => e !== 'gemini');
    return order.length ? order : ['edge'];
  };

  T.translate = async function (texts) {
    const s = cfg.getSettings();
    const failed = [];          // 每個引擎為什麼失敗都要留著，出錯時才講得清楚

    for (const eng of T.engineOrder()) {
      try {
        let r;
        if (eng === 'chrome') {
          r = await chromeTranslate(texts);
        } else {
          r = await withTimeout(send({
            type: 'translate.remote',
            engine: eng,
            texts,
            sourceLang: T.sourceLang,
            targetLang: s.targetLang
          }), ENGINE_TIMEOUT, g.PL_ENGINE_LABEL[eng] || eng);
        }
        if (r && r.result && r.result.some((x) => x != null)) {
          T.lastEngine = r.engine;
          return r;
        }
        throw new Error('沒有回傳結果');
      } catch (e) {
        const name = (g.PL_ENGINE_LABEL[eng] || eng).split('（')[0];
        failed.push(name + '：' + (e && e.message || e));
      }
    }
    throw new Error('所有引擎都失敗了 —— ' + failed.join('；'));
  };

  /** 查快取 → 不足的才送翻；回傳與 texts 等長的譯文陣列（失敗的位置是 null） */
  T.translateCached = async function (texts) {
    const lang = cfg.getSettings().targetLang;
    const out = await T.cacheGetMany(texts, lang);

    const need = [], needIdx = [];
    texts.forEach((t, i) => {
      if (out[i] == null) { need.push(t); needIdx.push(i); }
    });
    if (!need.length) return out;

    const res = await T.translate(need);
    needIdx.forEach((i, n) => {
      const t = res.result[n];
      if (t != null && String(t).trim()) {
        out[i] = t;
        T.cachePut(texts[i], lang, t);
      } else {
        out[i] = null;
      }
    });
    return out;
  };

  g.PLTranslate = T;
})(globalThis);
