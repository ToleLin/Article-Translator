/* PaperLens — 檢查新版本（擴充功能的背景程式與桌面版共用）
 *
 * 新版本發佈在 GitHub Releases：版本號改了推上去，自動建置流程就會建一個 vX.Y.Z 發佈，
 * 裡面有 Windows 安裝版、免安裝版、macOS 版，以及擴充功能的更新包（zip）。
 * 這裡只負責「問 GitHub 最新是哪一版」，要不要提醒、怎麼提醒由呼叫的一方決定。
 */
(function (root) {
  'use strict';

  const OWNER = 'ToleLin';
  const REPO = 'Article-Translator';
  const PAGE = 'https://github.com/' + OWNER + '/' + REPO + '/releases/latest';
  const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases/latest';

  const parse = (v) => String(v || '').trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);

  /** a 比 b 新 → 1，一樣 → 0，比較舊 → -1 */
  function compare(a, b) {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) {
      const p = x[i] || 0, q = y[i] || 0;
      if (p !== q) return p > q ? 1 : -1;
    }
    return 0;
  }

  /** 發佈說明裡「這一版更新」那一段的條列（給提醒視窗顯示幾行就好） */
  function highlights(notes, max) {
    const lines = String(notes || '').split(/\r?\n/);
    const out = [];
    let started = false;
    for (const ln of lines) {
      if (/^#{1,3}\s/.test(ln)) {
        if (started) break;
        started = /更新|新功能|改善|修正|what'?s new|changes/i.test(ln);
        continue;
      }
      const m = started && ln.match(/^\s*[-*]\s+(.+)/);
      if (m) out.push(m[1].replace(/\*\*|`/g, '').trim());
      if (out.length >= (max || 5)) break;
    }
    return out;
  }

  async function latest(fetchFn) {
    const f = fetchFn || root.fetch;
    let res;
    try {
      res = await f(API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    } catch (e) {
      throw new Error('連不到 GitHub，請檢查網路');
    }
    if (res.status === 404) throw new Error('找不到公開的發佈版本（專案可能是私人的，或還沒有發佈過）');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 暫時限制查詢次數，請稍後再試');
    if (!res.ok) throw new Error('GitHub 回應 ' + res.status);
    const j = await res.json();
    const assets = {};
    for (const a of j.assets || []) {
      const n = String(a.name || '');
      if (/setup.*\.exe$/i.test(n)) assets.setup = a.browser_download_url;
      else if (/portable.*\.exe$/i.test(n)) assets.portable = a.browser_download_url;
      else if (/mac.*\.dmg$/i.test(n)) assets.mac = a.browser_download_url;
      else if (/extension.*\.zip$/i.test(n)) assets.extension = a.browser_download_url;
    }
    return {
      version: String(j.tag_name || '').replace(/^v/i, ''),
      name: j.name || '',
      url: j.html_url || PAGE,
      notes: String(j.body || ''),
      publishedAt: j.published_at || null,
      assets
    };
  }

  root.PLUpdate = { OWNER, REPO, PAGE, compare, highlights, latest };
})(globalThis);
