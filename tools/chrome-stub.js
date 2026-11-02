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
      getManifest: () => ({ version: '0.1.0-test' }),
      onMessage: { addListener: (fn) => listeners.push(fn) },

      sendMessage(msg, cb) {
        (async () => {
          switch (msg && msg.type) {
            case 'ai.detect': return { lang: 'en' };
            case 'ai.probe': return { where: 'testbed', translator: 'unsupported', languageModel: 'unsupported' };
            case 'ai.warm': throw new Error('testbed 沒有內建 AI');
            case 'ai.translate': throw new Error('testbed 沒有內建 AI');
            case 'translate.remote': return { engine: 'testbed', result: msg.texts.map(fakeZh) };
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
