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

  /* ══════════ 句子切分 ══════════
     內建的是裝置上的小模型，一次餵整段幾百字的學術段落，常常漏句、重複或在中途停住。
     切成幾句一組送（每組不超過 ~350 字），漏翻的情況少很多，也能一句一句先顯示。 */

  const ABBR = /(?:\b(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Ref|Refs|Sec|Secs|Tab|No|Nos|Vol|approx|ca|resp|Dr|Mr|Ms|Prof|St|Jr|Inc|Ltd|Co|Corp|Ch|pp|p|al|Suppl)|\b[A-Z])\.$/;

  AI.splitSentences = function (text) {
    const out = [];
    const re = /[.!?。！？]+["”’)\]]*\s+(?=["“‘(\[]?[A-Z0-9])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      const piece = text.slice(last, end).trim();
      if (ABBR.test(text.slice(Math.max(0, m.index - 12), m.index + 1).trim())) continue;
      if (/\d$/.test(text.slice(0, m.index)) && /^\d/.test(text.slice(end))) continue;   // 1. 5 這種小數
      if (piece) out.push(piece);
      last = end;
    }
    const tail = text.slice(last).trim();
    if (tail) out.push(tail);
    return out.length ? out : [text];
  };

  /** 把句子組成不超過 limit 字的小段 */
  AI.chunk = function (text, limit) {
    limit = limit || 350;
    if (text.length <= limit) return [text];
    const chunks = [];
    let cur = '';
    for (const s of AI.splitSentences(text)) {
      if (cur && cur.length + 1 + s.length > limit) { chunks.push(cur); cur = s; }
      else cur = cur ? cur + ' ' + s : s;
    }
    if (cur) chunks.push(cur);
    return chunks;
  };

  /**
   * opts.onItem(i, text)：每一段一翻好就回報（不用等整批）
   * opts.chunk：先切句再翻
   */
  AI.translateMany = async function (texts, src, tgt, opts) {
    opts = opts || {};
    const t = await AI.getTranslator(src, tgt, opts.onProgress);
    const out = new Array(texts.length).fill(null);
    const cjk = /^(zh|ja|ko)/i.test(tgt);

    // 攤平成「小段」工作，記住每一小段屬於哪一段
    const jobs = [];
    const left = new Array(texts.length).fill(0);
    const parts = texts.map((s, i) => {
      const cs = opts.chunk ? AI.chunk(s, opts.chunk) : [s];
      cs.forEach((c, k) => jobs.push({ i, k, text: c }));
      left[i] = cs.length;
      return new Array(cs.length).fill(null);
    });

    const limit = opts.concurrency || 3;
    let cursor = 0;
    async function worker() {
      while (true) {
        const j = jobs[cursor++];
        if (!j) return;
        let r = null;
        try { r = await t.translate(j.text); } catch (e) { r = null; }
        parts[j.i][j.k] = r;
        if (--left[j.i] === 0) {
          const ps = parts[j.i];
          out[j.i] = ps.some((p) => p == null) ? null : ps.join(cjk ? '' : ' ');
          if (opts.onItem) { try { opts.onItem(j.i, out[j.i]); } catch (e) { /* 呼叫端的問題不影響翻譯 */ } }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
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
