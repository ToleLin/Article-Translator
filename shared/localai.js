/* PaperLens — Chrome 內建 AI（Translator / LanguageDetector / LanguageModel）封裝
 *
 * 這些是 Chrome 138+ 內建、免費、模型下載後可離線跑的 API。
 * 兩個要注意的坑：
 *   1. Translator 對「繁體中文」的代碼各版本不一致，要逐個試。
 *   2. LanguageModel（Gemini Nano）目前只能輸出 de/en/es/fr/ja，
 *      叫它輸出中文會被擋，所以「AI 解釋」先讓它用英文寫，再交給翻譯引擎轉中文。
 */
(function (g) {
  'use strict';

  const AI = {};
  const translatorPool = new Map();
  let detectorPromise = null;

  AI.where = (typeof window === 'undefined') ? 'worker' : 'page';

  AI.hasTranslator = () => typeof g.Translator !== 'undefined';
  AI.hasDetector = () => typeof g.LanguageDetector !== 'undefined';
  AI.hasLanguageModel = () => typeof g.LanguageModel !== 'undefined';

  /* ══════════ 語言代碼 ══════════ */

  /** 同一種語言在不同 Chrome 版本可能認不同代碼，逐個試到有反應為止 */
  AI.candidates = function (code) {
    const map = {
      'zh-Hant': ['zh-Hant', 'zh-TW', 'zh-HK', 'zh'],
      'zh-Hans': ['zh-Hans', 'zh-CN', 'zh'],
      'zh-TW': ['zh-Hant', 'zh-TW', 'zh']
    };
    return map[code] || [code];
  };

  /* ══════════ 能力探測 ══════════ */

  /**
   * 回傳 { translator, targetLanguage, detector, languageModel }。
   * translator 的值是 Chrome 給的原字串（available / downloadable / downloading /
   * unavailable），unsupported 代表這個 Chrome 根本沒有這個 API。
   */
  AI.probe = async function (sourceLanguage, targetLanguage) {
    const out = {
      where: AI.where,
      translator: 'unsupported',
      targetLanguage: targetLanguage,
      detector: AI.hasDetector() ? 'unknown' : 'unsupported',
      languageModel: 'unsupported',
      tried: []
    };

    if (AI.hasTranslator()) {
      const src = sourceLanguage || 'en';
      for (const tgt of AI.candidates(targetLanguage || 'zh-Hant')) {
        let v;
        try {
          v = await g.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
        } catch (e) {
          v = 'error:' + (e && e.message || e);
        }
        out.tried.push(tgt + '=' + v);
        if (v === 'available' || v === 'downloadable' || v === 'downloading') {
          out.translator = v;
          out.targetLanguage = tgt;
          break;
        }
        if (out.translator === 'unsupported') out.translator = v;
      }
    }

    if (AI.hasLanguageModel()) {
      try {
        out.languageModel = await g.LanguageModel.availability();
      } catch (e) {
        out.languageModel = 'unsupported';
        out.languageModelError = String(e && e.message || e);
      }
    }
    return out;
  };

  /* ══════════ 語言偵測 ══════════ */

  AI.detect = async function (text) {
    if (!AI.hasDetector()) return null;
    try {
      if (!detectorPromise) {
        detectorPromise = g.LanguageDetector.create().catch((e) => { detectorPromise = null; throw e; });
      }
      const d = await detectorPromise;
      const res = await d.detect(text.slice(0, 800));
      if (!res || !res.length) return null;
      return res[0].confidence > 0.35 ? res[0].detectedLanguage : null;
    } catch (e) {
      return null;
    }
  };

  /* ══════════ 翻譯 ══════════ */

  AI.getTranslator = function (src, tgt, onProgress) {
    const key = src + '>' + tgt;
    if (!translatorPool.has(key)) {
      const p = (async () => {
        const avail = await g.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
        if (avail === 'unavailable') {
          throw new Error('Chrome 內建翻譯不支援 ' + src + ' → ' + tgt
            + '（通常是這台機器不符合內建 AI 的硬體條件，或磁碟空間不足）');
        }
        return g.Translator.create({
          sourceLanguage: src,
          targetLanguage: tgt,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => { if (onProgress) onProgress(e.loaded, e.total); });
          }
        });
      })().catch((e) => { translatorPool.delete(key); throw e; });
      translatorPool.set(key, p);
    }
    return translatorPool.get(key);
  };

  AI.translateMany = async function (texts, src, tgt, opts) {
    opts = opts || {};
    const t = await AI.getTranslator(src, tgt, opts.onProgress);
    const out = new Array(texts.length);
    const limit = opts.concurrency || 3;
    let cursor = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= texts.length) return;
        try { out[i] = await t.translate(texts[i]); }
        catch (e) { out[i] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, texts.length) }, worker));
    return out;
  };

  AI.destroyTranslators = function () {
    for (const p of translatorPool.values()) {
      p.then((t) => { try { t.destroy(); } catch (e) {} }, () => {});
    }
    translatorPool.clear();
  };

  /* ══════════ Gemini Nano：只能輸出英文，所以先寫英文再翻 ══════════ */

  const SYSTEM_PROMPT =
    'You help a graduate student read research papers. Given an excerpt, explain what it is doing. '
    + 'Answer in English, in exactly three labelled lines:\n'
    + 'POINT: one sentence stating the claim or action.\n'
    + 'DETAIL: at most two sentences on the method, data or conditions.\n'
    + 'TERMS: list technical terms with a one-line gloss each, or "none".\n'
    + 'No preamble, no restating the excerpt, no invented facts.';

  AI.explain = async function (text, context) {
    if (!AI.hasLanguageModel()) throw new Error('此 Chrome 沒有內建 LanguageModel（Prompt API）');
    const avail = await g.LanguageModel.availability();
    if (avail === 'unavailable') throw new Error('內建語言模型在這台機器上無法使用');

    // 一定要指定輸出語言，而且只能挑它支援的那幾種
    const opts = {
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    };

    let session;
    try {
      session = await g.LanguageModel.create(opts);
    } catch (e) {
      delete opts.expectedInputs;
      session = await g.LanguageModel.create(opts);
    }

    try {
      let prompt = 'EXCERPT:\n' + text.slice(0, 4000);
      if (context && context.title) prompt = 'PAPER TITLE: ' + context.title + '\n' + prompt;
      if (context && context.around) {
        prompt += '\n\nSURROUNDING TEXT (for understanding only, do not explain it):\n'
          + context.around.slice(0, 1500);
      }
      return await session.prompt(prompt);
    } finally {
      try { session.destroy(); } catch (e) {}
    }
  };

  g.PLLocalAI = AI;
})(globalThis);
