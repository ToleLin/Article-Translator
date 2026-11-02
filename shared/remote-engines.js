/* PaperLens — 免金鑰的遠端翻譯引擎（只在 background 執行，避開網頁的 CORS 限制）
 *
 * 這些都是公開但非官方的端點，會壞掉、會限流，所以每一家都準備了備援路徑，
 * 而且一律節流 —— 短時間連發是被 429 擋掉的主因。
 */
(function (g) {
  'use strict';

  /* ══════════ 節流 ══════════ */

  const paceAt = {};
  async function pace(key, ms) {
    const wait = (paceAt[key] || 0) + ms - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    paceAt[key] = Date.now();
  }

  /* ══════════ Google（兩條免金鑰路徑） ══════════ */

  async function googleApisOnce(text, src, tgt) {
    await pace('google', 420);
    const url = 'https://translate.googleapis.com/translate_a/single'
      + '?client=gtx&dj=1&dt=t'
      + '&sl=' + encodeURIComponent(src || 'auto')
      + '&tl=' + encodeURIComponent(tgt)
      + '&q=' + encodeURIComponent(text);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) { const e = new Error('Google 暫時限流（429）'); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error('Google 翻譯回應 ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.sentences)) throw new Error('Google 翻譯回傳格式非預期');
    return data.sentences.map((x) => x.trans || '').join('');
  }

  /** Chrome 字典擴充功能用的端點，額度跟上面那條分開算 */
  async function googleDictOnce(text, src, tgt) {
    await pace('googledict', 420);
    const params = new URLSearchParams({ client: 'dict-chrome-ex', sl: src || 'auto', tl: tgt, q: text });
    const res = await fetch('https://clients5.google.com/translate_a/t?' + params);
    if (res.status === 429) { const e = new Error('Google 暫時限流（429）'); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error('Google(dict) 回應 ' + res.status);
    const data = await res.json();
    const flat = [];
    (function walk(v) {
      if (typeof v === 'string') flat.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
    })(data);
    if (!flat.length) throw new Error('Google(dict) 回傳格式非預期');
    return flat.join('');
  }

  async function googleOnce(text, src, tgt) {
    try {
      return await googleApisOnce(text, src, tgt);
    } catch (e) {
      if (!e.rateLimited) throw e;
      await new Promise((r) => setTimeout(r, 1200));
      return googleDictOnce(text, src, tgt);      // 被限流就換另一條路徑
    }
  }

  async function googleTranslate(texts, src, tgt) {
    return batched(texts, {
      maxItems: 24, maxChars: 1500,
      one: (t) => googleOnce(t, src, tgt),
      abortOnBatchError: (e) => !!e.rateLimited     // 整批被限流就別再逐段打
    });
  }

  /* ══════════ 微軟：Edge 免金鑰憑證 → 失效時走 Bing 網頁介面 ══════════ */

  let edgeToken = { jwt: null, exp: 0 };
  let edgeBroken = false;

  async function getEdgeToken() {
    if (edgeToken.jwt && Date.now() < edgeToken.exp) return edgeToken.jwt;
    const res = await fetch('https://edge.microsoft.com/translate/auth');
    if (!res.ok) throw new Error('取得 Edge 憑證失敗（' + res.status + '）');
    const jwt = (await res.text()).trim();
    if (!jwt || jwt.length < 40) throw new Error('Edge 憑證格式非預期');
    let exp = Date.now() + 8 * 60 * 1000;
    try {
      const body = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (body.exp) exp = body.exp * 1000 - 60000;
    } catch (e) { /* 用預設 8 分鐘 */ }
    edgeToken = { jwt, exp };
    return jwt;
  }

  async function edgeViaToken(texts, src, tgt) {
    const out = new Array(texts.length);
    const token = await getEdgeToken();

    for (let i = 0; i < texts.length;) {
      const group = [];
      let len = 0;
      while (i < texts.length && group.length < 40 && len < 9000) {
        group.push({ idx: i, text: texts[i] });
        len += texts[i].length;
        i++;
      }

      const params = new URLSearchParams({ 'api-version': '3.0', to: tgt, textType: 'plain' });
      if (src && src !== 'auto') params.set('from', src);

      await pace('edge', 200);
      const res = await fetch('https://api-edge.cognitive.microsofttranslator.com/translate?' + params, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(group.map((x) => ({ Text: x.text })))
      });
      if (res.status === 401) { edgeToken = { jwt: null, exp: 0 }; throw new Error('Edge 憑證過期'); }
      if (!res.ok) throw new Error('Edge 翻譯回應 ' + res.status);

      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Edge 回傳格式非預期');
      group.forEach((x, k) => {
        const item = data[k];
        out[x.idx] = (item && item.translations && item.translations[0]) ? item.translations[0].text : null;
      });
    }
    return out;
  }

  let bing = { at: 0, token: '', key: '', ig: '', iid: '', n: 0 };

  async function getBingCtx() {
    if (bing.token && Date.now() - bing.at < 8 * 60 * 1000) return bing;
    const res = await fetch('https://www.bing.com/translator', { credentials: 'omit' });
    if (!res.ok) throw new Error('Bing 翻譯頁回應 ' + res.status);
    const html = await res.text();

    const helper = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"/.exec(html);
    const ig = /IG:"([^"]+)"/.exec(html);
    const iid = /data-iid="([^"]+)"/.exec(html);
    if (!helper || !ig) throw new Error('無法從 Bing 取得翻譯憑證');

    bing = {
      at: Date.now(), key: helper[1], token: helper[2],
      ig: ig[1], iid: iid ? iid[1] : 'translator.5028', n: 0
    };
    return bing;
  }

  async function bingOnce(text, src, tgt) {
    const c = await getBingCtx();
    c.n += 1;
    await pace('bing', 220);

    const url = 'https://www.bing.com/ttranslatev3?isVertical=1&&IG=' + c.ig + '&IID=' + c.iid + '.' + c.n;
    const body = new URLSearchParams({
      fromLang: (src && src !== 'auto') ? src : 'auto-detect',
      text: text, to: tgt, token: c.token, key: c.key
    });

    const res = await fetch(url, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) throw new Error('Bing 翻譯回應 ' + res.status);

    const data = await res.json();
    if (data && data.statusCode) { bing.token = ''; throw new Error('Bing 憑證失效（' + data.statusCode + '）'); }
    const t = data && data[0] && data[0].translations && data[0].translations[0];
    if (!t) throw new Error('Bing 回傳格式非預期');
    return t.text;
  }

  function bingTranslate(texts, src, tgt) {
    return batched(texts, { maxItems: 8, maxChars: 3000, concurrency: 2, one: (t) => bingOnce(t, src, tgt) });
  }

  async function edgeTranslate(texts, src, tgt) {
    if (!edgeBroken) {
      try {
        return await edgeViaToken(texts, src, tgt);
      } catch (e) {
        edgeBroken = true;        // 憑證端點掛了就別每批都再試一次
        console.warn('[PaperLens] Edge 憑證失敗，改走 Bing 介面：', e.message);
      }
    }
    return bingTranslate(texts, src, tgt);
  }

  /* ══════════ Gemini（選用，使用者自備 AI Studio 免費金鑰） ══════════ */

  async function geminiTranslate(texts, src, tgt, apiKey, model) {
    if (!apiKey) throw new Error('尚未在設定頁填入 Gemini API 金鑰');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(model || g.PL_DEFAULTS.geminiModel) + ':generateContent?key=' + encodeURIComponent(apiKey);

    const out = new Array(texts.length);
    for (let i = 0; i < texts.length;) {
      const group = [];
      let len = 0;
      while (i < texts.length && group.length < 30 && len < 6000) {
        group.push({ idx: i, text: texts[i] });
        len += texts[i].length;
        i++;
      }

      const instruction =
        '你是學術文獻翻譯員。把 JSON 陣列中每個字串完整翻成' + tgt + '，不可漏句、不可摘要。\n'
        + '規則：(1) 保留學術語氣，專有名詞用該領域慣用譯法；縮寫（如 q-BIC、EUE、SEM、FDTD）保留原文；'
        + '(2) 上下標字元（¹²³、₀₁₂）、數字、單位、引用編號照原樣保留在對應位置；'
        + '(3) 只輸出 JSON 陣列，長度與輸入完全相同；(4) 不要加說明、不要加 markdown 圍欄。\n\n'
        + JSON.stringify(group.map((x) => x.text));

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: instruction }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
        })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error('Gemini 回應 ' + res.status + ' ' + msg.slice(0, 180));
      }
      const data = await res.json();
      const raw = data && data.candidates && data.candidates[0]
        && data.candidates[0].content && data.candidates[0].content.parts
        && data.candidates[0].content.parts.map((x) => x.text || '').join('');
      let arr;
      try {
        arr = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      } catch (e) {
        throw new Error('Gemini 回傳不是合法 JSON');
      }
      if (!Array.isArray(arr) || arr.length !== group.length) throw new Error('Gemini 回傳長度不符');
      group.forEach((x, k) => { out[x.idx] = String(arr[k]); });
    }
    return out;
  }

  /* ══════════ 共用的分批邏輯 ══════════ */

  /** 同時最多跑 n 個 */
  async function parallel(items, n, fn) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const k = cursor++;
        await fn(items[k], k);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  /**
   * 把多段合併成一次請求（換行分隔），回來再拆開。
   *
   * - 拆出來的段數對不上（引擎把兩行併成一行之類）→ 這一組改成逐段送，但三段同時送，不要一段等一段
   * - 請求本身失敗（429、401、網路斷線）→ 直接往上丟，讓呼叫端換下一個引擎；
   *   舊版會對同一個已經壞掉的引擎再逐段重試一輪，白白多等好幾秒
   */
  async function batched(texts, opt) {
    const out = new Array(texts.length).fill(null);
    const SEP = '\n';
    const groups = [];
    let i = 0;

    while (i < texts.length) {
      const group = [];
      let len = 0;
      while (i < texts.length && group.length < opt.maxItems) {
        const t = texts[i];
        if (len && len + t.length > opt.maxChars) break;
        if (t.includes(SEP) && group.length) break;
        group.push({ idx: i, text: t });
        len += t.length + 1;
        i++;
        if (group.length === 1 && group[0].text.includes(SEP)) break;
      }
      if (!group.length) { group.push({ idx: i, text: texts[i] }); i++; }
      groups.push(group);
    }

    let lastErr = null, okCount = 0;
    await parallel(groups, opt.concurrency || 2, async (group) => {
      if (group.length === 1) {
        try { out[group[0].idx] = await opt.one(group[0].text); okCount++; }
        catch (e) { lastErr = e; if (opt.abortOnBatchError && opt.abortOnBatchError(e)) throw e; }
        return;
      }
      const r = await opt.one(group.map((x) => x.text).join(SEP));     // 失敗就整個往上丟
      okCount++;
      const split = String(r).split(/\r?\n/);
      if (split.length === group.length) {
        group.forEach((x, k) => { out[x.idx] = split[k]; });
        return;
      }
      await parallel(group, 3, async (x) => {
        try { out[x.idx] = await opt.one(x.text); }
        catch (e) { lastErr = e; if (opt.abortOnBatchError && opt.abortOnBatchError(e)) throw e; }
      });
    });
    if (!okCount && lastErr) throw lastErr;
    return out;
  }

  /* ══════════ 分派（擴充功能的 background 與桌面版的主程序共用） ══════════ */

  /**
   * msg = { engine, texts, sourceLang, targetLang }；engine 留空就依設定的順序備援。
   * s = 設定（PL_DEFAULTS 合併使用者設定）
   */
  async function translate(msg, s) {
    const order = msg.engine ? [msg.engine] : (s.engineOrder || g.PL_DEFAULTS.engineOrder);
    const tried = [];
    let lastErr = null;

    for (const eng of order) {
      if (eng === 'chrome') continue;                 // 內建 AI 由呼叫端自己處理
      if (eng === 'gemini' && !s.geminiApiKey) continue;
      const tgt = g.PL_mapLang(eng, msg.targetLang || s.targetLang);
      const src = (msg.sourceLang && msg.sourceLang !== 'auto') ? g.PL_mapLang(eng, msg.sourceLang) : 'auto';
      try {
        let result;
        if (eng === 'google') result = await googleTranslate(msg.texts, src, tgt);
        else if (eng === 'edge') result = await edgeTranslate(msg.texts, src, tgt);
        else if (eng === 'gemini') result = await geminiTranslate(msg.texts, src, tgt, s.geminiApiKey, s.geminiModel);
        else continue;

        if (result && result.some((x) => x != null)) return { engine: eng, result };
        lastErr = new Error(eng + ' 沒有回傳任何譯文');
      } catch (e) {
        lastErr = e;
        tried.push(eng + '：' + (e && e.message || e));
        if (!s.autoFallback && msg.engine) break;
      }
    }
    throw new Error(tried.length ? tried.join(' ／ ') : (lastErr ? lastErr.message : '沒有可用的翻譯引擎'));
  }

  /** 用 Gemini 做「AI 解釋」 */
  async function explain(text, context, s) {
    if (!s.geminiApiKey) {
      throw new Error('這台電腦的內建語言模型無法使用，且尚未設定 Gemini 金鑰。'
        + '可到設定頁貼上 Google AI Studio 的免費金鑰，或改用「翻譯本段」了解內容。');
    }
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(s.geminiModel || g.PL_DEFAULTS.geminiModel) + ':generateContent?key=' + encodeURIComponent(s.geminiApiKey);

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

  g.PLRemote = { googleTranslate, edgeTranslate, geminiTranslate, translate, explain };
})(globalThis);
