/* 只在 devserver 的 ?testbed=1 模式下注入：
 * 用一組假的 chrome API 讓擴充功能頁面（export.html / pdfview.html）可以在
 * 普通瀏覽器裡跑起來，方便驗證版面與流程，不必每次都重新載入擴充功能。
 */
(function () {
  const store = {};
  const listeners = [];
  let exportPayload = null;

  const fakeZh = (t) => '〔譯〕' + t;

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      id: 'testbed',
      getURL: (p) => '/' + String(p).replace(/^\//, ''),
      getManifest: () => ({ version: '0.2.0-test' }),
      onMessage: { addListener: (fn) => listeners.push(fn) },

      sendMessage(msg, cb) {
        (async () => {
          switch (msg && msg.type) {
            case 'ai.detect': return { lang: 'en' };
            case 'ai.probe': return { where: 'testbed', translator: 'unsupported', languageModel: 'unsupported' };
            case 'ai.warm': throw new Error('testbed 沒有內建 AI');
            case 'ai.translate': throw new Error('testbed 沒有內建 AI');
            case 'translate.remote': return { engine: msg.engine || 'testbed', result: msg.texts.map(fakeZh) };
            case 'ai.ask':
              await new Promise((r) => setTimeout(r, 300));
              return { model: 'testbed', text: '**重點**：這是測試用的假回答（第 ' + ((msg.history || []).length / 2 + 1) + ' 輪）。\n\n- 問題：' + msg.question
                + '\n- 段落長度：' + (msg.passage || '').length + ' 字，全文 ' + (msg.doc || '').length + ' 字\n\n1. 表面電漿極化子 `SPP`\n2. 傳播常數 β = k0·√(εd·εm/(εd+εm))' };
            case 'dict.lookup': return /\s/.test(msg.text.trim())
              ? { translation: fakeZh(msg.text), phonetic: '', dict: [], defs: [], examples: [], engine: 'google' }
              : { translation: '〔查〕' + msg.text, phonetic: 'ˈtest', engine: 'google',
                dict: [{ pos: '名詞', terms: [{ word: '方案', back: ['plan', 'scheme'] }, { word: '構想', back: ['idea', 'scheme'] }] },
                  { pos: '動詞', terms: [{ word: '密謀', back: ['scheme', 'plot'] }] }],
                defs: [{ pos: '名詞', items: [{ gloss: 'a large-scale systematic plan.', example: 'a pension scheme' }] }],
                examples: ['the scheme was approved'] };
            // 「✦ Gemini」的測試金鑰：AIza 開頭的假金鑰就當作可用，其他的回報金鑰無效
            case 'gemini.test':
              if (/^AIza/.test(msg.key || '')) return { ms: 420, sample: '超表面把不同顏色的光導向晶片上的不同位置。', model: msg.model };
              throw new Error('Gemini 金鑰無效或已過期：請確認有完整複製（通常是 AIza 開頭、約 39 個字）');
            case 'ai.explain': return { text: '重點：測試用的假解釋。\n細節：這是 testbed。\n名詞：無', via: 'testbed' };
            case 'image.inline': return {};
            case 'settings.get': return Object.assign({}, globalThis.PL_DEFAULTS);
            case 'settings.set': return Object.assign({}, globalThis.PL_DEFAULTS, msg.patch);
            case 'openOptions': return true;
            case 'export.open':
              exportPayload = msg.payload;
              globalThis.__lastExport = msg.payload;
              fetch('/__export', { method: 'POST', body: JSON.stringify(msg.payload) }).catch(() => {});
              return { tabId: -1 };
            case 'export.take':
              if (exportPayload) return exportPayload;
              return fetch('/tools/.sample-export.json').then((r) => r.json()).catch(() => null);
            default: return null;
          }
        })().then(
          (data) => cb && cb({ ok: true, data }),
          (e) => cb && cb({ ok: false, error: String(e && e.message || e) })
        );
      }
    },

    storage: {
      local: {
        get: (keys) => Promise.resolve(
          keys == null ? Object.assign({}, store)
            : (typeof keys === 'string'
              ? (store[keys] !== undefined ? { [keys]: store[keys] } : {})
              : Object.fromEntries([].concat(keys).filter((k) => store[k] !== undefined).map((k) => [k, store[k]])))
        ),
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
        remove: (keys) => { [].concat(keys).forEach((k) => delete store[k]); return Promise.resolve(); },
        getBytesInUse: () => Promise.resolve(JSON.stringify(store).length)
      },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve() }
    },

    extension: {
      isAllowedFileSchemeAccess: (cb) => cb(false)
    },

    tabs: {
      query: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve()
    }
  };
})();
