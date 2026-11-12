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

  /** Gemini 的錯誤翻成看得懂的中文（金鑰貼錯、沒權限、模型名稱錯、額度用完） */
  function geminiError(status, body) {
    let detail = '';
    try { detail = (JSON.parse(body).error || {}).message || ''; } catch (e) { detail = String(body || '').slice(0, 160); }
    if (/API key not valid|API_KEY_INVALID|API key expired/i.test(body || '')) {
      return 'Gemini 金鑰無效或已過期：請確認有完整複製（通常是 AIza 開頭、約 39 個字）';
    }
    if (status === 403) return 'Gemini 拒絕存取（403）：這把金鑰沒有權限，或這個專案沒有啟用 Gemini API';
    if (status === 404) return 'Gemini 找不到這個模型（404）：請在「✦ Gemini」裡換一個模型';
    if (status === 429) return 'Gemini 免費額度用完或請求太頻繁（429）：稍等一下再試，或換一個模型';
    if (status >= 500) return 'Gemini 伺服器暫時有問題（' + status + '）：稍後再試';
    return 'Gemini 回應 ' + status + (detail ? '：' + detail.slice(0, 160) : '');
  }

  /** 「✦ Gemini」視窗的「測試金鑰」：用這把金鑰實際翻一句 */
  async function geminiTest(apiKey, model, tgt) {
    const t0 = Date.now();
    const out = await geminiTranslate(['The metasurface routes light of different colors to different positions on the chip.'],
      'en', tgt, apiKey, model);
    if (!out || !out[0]) throw new Error('Gemini 沒有回傳譯文');
    return { ms: Date.now() - t0, sample: out[0], model: model || g.PL_DEFAULTS.geminiModel };
  }

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
        const body = await res.text().catch(() => '');
        throw new Error(geminiError(res.status, body));
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
    if (!res.ok) throw new Error(geminiError(res.status, await res.text().catch(() => '')));
    const data = await res.json();
    const out = data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts
      && data.candidates[0].content.parts.map((p) => p.text || '').join('');
    if (!out) throw new Error('Gemini 沒有回傳內容');
    return out;
  }

  /* ══════════ 問 AI：針對選取的段落向 Gemini 提問（可以連續追問） ══════════
     q = { question, passage, around, doc, title, history: [{ role: 'user'|'model', text }], lang }
     第一則使用者訊息前面附上文獻資料（標題、選取的段落、所在段落、全文節錄），之後的追問只送問題。 */

  async function ask(q, s) {
    if (!s.geminiApiKey) throw new Error('需要 Gemini 金鑰：請按工具列的「✦ Gemini」貼上金鑰（Google AI Studio 可以免費申請）');
    const question = String((q && q.question) || '').trim();
    if (!question) throw new Error('請輸入問題');
    const lang = (g.PL_LANG_LABEL && g.PL_LANG_LABEL[q.lang || s.targetLang]) || '繁體中文';
    const model = s.geminiModel || g.PL_DEFAULTS.geminiModel;
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(s.geminiApiKey);

    const sys = '你是協助研究生讀論文的助教。使用者正在讀一篇文獻，會針對其中一段提問。\n'
      + '規則：\n'
      + '1. 一律用' + lang + '回答；專有名詞第一次出現時附上英文原文。\n'
      + '2. 先直接回答問題，再視需要補充；簡潔、講重點，不要開場白、不要重複題目。\n'
      + '3. 以提供的文獻內容為依據。文獻裡沒有寫到的，可以用一般知識補充，但要說明「文中沒有提到」。不確定就說不確定，不要編造數據或引用。\n'
      + '4. 可以用條列；數學式用一般文字寫（例如 β = k0·√(εd·εm/(εd+εm))），不要用 LaTeX。';

    const cut = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
    let ctx = '';
    if (q.title) ctx += '【文獻標題】' + cut(q.title, 300) + '\n\n';
    if (q.passage) ctx += '【使用者選取的文字】\n' + cut(q.passage, 6000) + '\n\n';
    if (q.around && q.around !== q.passage) ctx += '【所在段落（原文）】\n' + cut(q.around, 8000) + '\n\n';
    if (q.doc) ctx += '【全文節錄（背景資料）】\n' + cut(q.doc, 40000) + '\n\n';

    const turns = [];
    for (const h of (q.history || []).slice(-12)) {
      if (!h || !h.text) continue;
      turns.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: cut(h.text, 6000) }] });
    }
    turns.push({ role: 'user', parts: [{ text: question }] });
    // 文獻資料放在第一則使用者訊息的最前面
    const first = turns.find((t) => t.role === 'user');
    if (ctx) first.parts[0].text = ctx + '【問題】\n' + first.parts[0].text;
    while (turns.length && turns[0].role !== 'user') turns.shift();     // Gemini 要求由使用者開頭

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: turns,
        generationConfig: { temperature: 0.4 }
      })
    });
    if (!res.ok) throw new Error(geminiError(res.status, await res.text().catch(() => '')));
    const data = await res.json();
    const cand = data && data.candidates && data.candidates[0];
    const out = cand && cand.content && cand.content.parts
      && cand.content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    if (!out) {
      const why = (data && data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || '';
      throw new Error('Gemini 沒有回答' + (why ? '（' + why + '）' : '') + '，請換個問法再試');
    }
    return { text: out, model };
  }

  /* ══════════ 查字（側邊翻譯）：Google 的字典資料 ══════════
     一次拿到：譯文、音標、各詞性的多個中文意思（附反查的英文）、英英解釋、例句。
     句子也能查（只會有譯文）。被限流時退回另一條端點，只給譯文。 */

  const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');

  async function lookup(text, src, tgt) {
    const q = String(text || '').trim();
    if (!q) throw new Error('請輸入要查的字');
    await pace('google', 300);
    const params = new URLSearchParams({ client: 'gtx', dj: '1', sl: src || 'auto', tl: tgt, hl: 'zh-TW', q });
    let d;
    try {
      const res = await fetch('https://translate.googleapis.com/translate_a/single?' + params
        + '&dt=t&dt=bd&dt=rm&dt=md&dt=ex', { headers: { Accept: 'application/json' } });
      if (res.status === 429) { const e = new Error('Google 暫時限流，請稍後再試'); e.rateLimited = true; throw e; }
      if (!res.ok) throw new Error('Google 查詢回應 ' + res.status);
      d = await res.json();
    } catch (e) {
      // 字典端點不通：至少給譯文
      const t = await googleDictOnce(q, src, tgt);
      return { translation: t, phonetic: '', src: src, dict: [], defs: [], examples: [], engine: 'google' };
    }
    const sentences = (d && d.sentences) || [];
    const translation = sentences.map((x) => x.trans || '').join('').trim();
    const rm = sentences.find((x) => x.src_translit) || {};
    const dict = ((d && d.dict) || []).map((e) => {
      const terms = (e.entry || []).map((x, k) => ({
        word: x.word || '', back: (x.reverse_translation || []).slice(0, 4), k
      })).filter((x) => x.word);
      // Google 的順序常把罕用的單字（筴、猷）排在前面：主要譯文最前、兩個字以上的詞次之，其餘照原順序
      const rank = (x) => (x.word === translation ? 0 : x.word.length < 2 ? 2 : 1);
      terms.sort((a, b) => (rank(a) - rank(b)) || (a.k - b.k));
      return { pos: e.pos || '', terms: terms.slice(0, 8).map((x) => ({ word: x.word, back: x.back })) };
    }).filter((e) => e.terms.length);
    const defs = ((d && d.definitions) || []).map((e) => ({
      pos: e.pos || '',
      items: (e.entry || []).slice(0, 3).map((x) => ({ gloss: x.gloss || '', example: stripTags(x.example) }))
    })).filter((e) => e.items.length);
    const examples = ((d && d.examples && d.examples.example) || []).slice(0, 3).map((x) => stripTags(x.text));
    return { translation, phonetic: rm.src_translit || '', src: (d && d.src) || src, dict, defs, examples, engine: 'google' };
  }

  g.PLRemote = { googleTranslate, edgeTranslate, geminiTranslate, geminiTest, translate, explain, lookup, ask };
})(globalThis);
