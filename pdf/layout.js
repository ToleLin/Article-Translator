/* PaperLens — PDF 版面分析（純計算，不碰 DOM；可以在 Node 裡單獨測試）
 *
 * 輸入：每一頁 pdf.js getTextContent() 的結果與頁面尺寸
 * 輸出：每一頁的「區塊」（段落、標題、圖說、圖內標籤…），每個區塊帶著每一行的外框，
 *       以及閱讀順序與「跨欄／跨頁接續」關係
 *
 *  1. 文字片段 → 左上原點座標、字級、ascent/descent、是否旋轉
 *  2. 依「垂直範圍重疊」聚成列；上下標掛回所屬的那一列
 *  3. 找欄間溝槽：很多列在同一個 x 有大空白，而且右欄起點（或左欄終點）對得很齊。
 *     溝槽只在「真的有這些列」的高度範圍內生效 —— 所以頁首的標題、摘要這種全寬文字
 *     不會因為某個字距剛好落在中線上就被切成兩半
 *  4. 列在溝槽處切成「行」；超大空白（圖內左右兩個標籤、表格欄）也切開
 *  5. 同一欄的行依行距、字級、左右重疊、縮排、短行接成區塊
 *  6. 頁首頁尾、公式、純數字、旋轉文字 → 標記成不翻
 *  7. 閱讀順序；欄尾那段若沒寫完、下一欄開頭又沒縮排 → 串起來當成同一段一起翻
 *
 * 舊版的兩個根本問題就是在這裡修掉的：
 *  - 欄距只有 14pt 的期刊（例如 Light: Science & Applications）會被判成「同一行」，
 *    左右兩欄的句子被交錯拼在一起送翻，譯文當然是亂的
 *  - 同一條基線上的圖內標籤被接成一條橫跨整張圖的長方塊，蓋掉圖片
 */
(function (g) {
  'use strict';

  const BIG_GAP = 3.0;           // 同一列裡超過 3 個字寬的空白：一定是兩個不同的東西
  const HEAD_BAND = 0.085;       // 頁首區（頁高比例）
  const FOOT_BAND = 0.93;        // 頁尾區

  /* ══════════ 小工具 ══════════ */

  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  function quantile(a, q) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
  }

  /** 以權重取中位數：[[值, 權重], …] */
  function wmedian(pairs) {
    if (!pairs.length) return 0;
    const s = pairs.slice().sort((x, y) => x[0] - y[0]);
    const total = s.reduce((t, p) => t + p[1], 0);
    let acc = 0;
    for (const p of s) { acc += p[1]; if (acc >= total / 2) return p[0]; }
    return s[s.length - 1][0];
  }

  /** 數值裡「彼此相差在 tol 以內」最大的那一群佔多少比例 */
  function modeShare(vals, tol) {
    if (!vals.length) return 0;
    const s = vals.slice().sort((x, y) => x - y);
    let best = 0;
    for (let i = 0, j = 0; i < s.length; i++) {
      while (s[i] - s[j] > 2 * tol) j++;
      best = Math.max(best, i - j + 1);
    }
    return best / s.length;
  }

  function mul(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
    ];
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v !== 0 ? v : d);

  /* ══════════ 上下標 → Unicode ══════════ */

  const SUP = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '−': '⁻', '–': '⁻', '—': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ',
    ',': ',', '*': '*', '†': '†', '‡': '‡'
  };
  const SUB = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
    'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ',
    'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ'
  };

  /** 只有整串都換得過去才換（字母上標像 "th"、"T" 換一半反而更難懂） */
  function convert(str, map) {
    const t = str.replace(/\s+/g, '');
    if (!t) return str;
    let out = '';
    for (const ch of t) {
      if (!map[ch]) return str;
      out += map[ch];
    }
    return out;
  }

  /* ══════════ 1. 文字片段標準化 ══════════ */

  /**
   * 字距拉很開的標題，pdf.js 會在每個字母之間補空白：「O p e n A c c e s s」。
   * 收回成一個字，大小寫交界再切開 →「Open Access」。
   */
  function unspace(str) {
    const t = str.trim();
    if (t.length < 7 || !/^(\S )+\S$/.test(t)) return str;
    return t.replace(/ /g, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /**
   * page = { w, h, vt: viewport.transform（scale 1）, styles, items: pdf.js 的 TextItem[] }
   */
  function normalize(page) {
    const out = [];
    const styles = page.styles || {};
    for (const it of page.items) {
      const str = it.str && unspace(it.str);
      if (!str || !str.trim()) continue;
      const tx = mul(page.vt, it.transform);
      const sx = Math.hypot(tx[0], tx[1]);
      const h = Math.hypot(tx[2], tx[3]);
      if (!(h > 0.5 && h < 300) || !(sx > 0)) continue;

      // 正常的橫排文字：沒有旋轉、沒有鏡像（viewport 會把 y 翻過來，所以 tx[3] < 0）
      const upright = Math.abs(tx[1]) <= 0.08 * sx && Math.abs(tx[2]) <= 0.08 * h && tx[0] > 0 && tx[3] < 0;
      const st = styles[it.fontName] || {};
      const asc = clamp(num(st.ascent, 0.8), 0.55, 1.05);
      const desc = clamp(num(st.descent, -0.2), -0.4, 0);
      const w = Math.abs(it.width || 0);
      const x0 = tx[4], base = tx[5];

      out.push({
        str, x0, x1: x0 + w, base, h,
        top: base - asc * h, bottom: base - desc * h,
        rot: !upright,
        font: it.fontName || '', family: st.fontFamily || '',
        rawTransform: it.transform, wRaw: w,
        sup: false, sub: false
      });
    }
    return out;
  }

  /* ══════════ 2. 列 ══════════ */

  /**
   * 兩個片段的「字身核心」（基線往上 0.7 字高到基線下 0.15）重疊一半以上，就算同一列。
   * 上標的核心會和它所屬那一行重疊、但碰不到上一行，所以自然會掛對地方。
   */
  function buildRows(items) {
    const list = items.filter((i) => !i.rot).sort((a, b) => (a.base - b.base) || (a.x0 - b.x0));
    const rows = [];
    for (const it of list) {
      const c0 = it.base - 0.7 * it.h, c1 = it.base + 0.15 * it.h;
      let best = null, bestOv = 0;
      for (let k = rows.length - 1; k >= 0 && k >= rows.length - 24; k--) {
        const r = rows[k];
        const ov = Math.min(c1, r.c1) - Math.max(c0, r.c0);
        if (ov <= 0) continue;
        const rel = ov / Math.min(c1 - c0, r.c1 - r.c0);
        if (rel > bestOv) { bestOv = rel; best = r; }
      }
      if (best && bestOv >= 0.5) {
        best.items.push(it);
        if (it.h > best.refH * 1.15) { best.c0 = c0; best.c1 = c1; best.refH = it.h; }
      } else {
        rows.push({ c0, c1, refH: it.h, items: [it] });
      }
    }
    const stats = (r) => {
      r.items.sort((a, b) => a.x0 - b.x0);
      r.base = median(r.items.map((i) => i.base));
      r.h = wmedian(r.items.map((i) => [i.h, Math.max(1, i.str.trim().length)]));
    };
    rows.forEach(stats);
    rows.sort((a, b) => a.base - b.base);

    /* 第二輪：抬得特別高的上標（作者後面的 ¹,²）、壓得特別低的下標，
       可能自己成了一列。緊貼著某一列的字、而且明顯比較小，就掛回那一列。 */
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (r.items.length > 12) continue;
      const keep = [];
      for (const it of r.items) {
        const c = it.base - 0.35 * it.h;
        let host = null;
        for (let j = Math.max(0, k - 3); j <= Math.min(rows.length - 1, k + 3); j++) {
          const R = rows[j];
          if (R === r || R.h < 1.18 * it.h) continue;
          if (c < R.base - 1.1 * R.h || c > R.base + 0.5 * R.h) continue;
          const near = R.items.some((o) => o.h >= 1.18 * it.h
            && (Math.abs(it.x0 - o.x1) <= 1.2 * R.h || Math.abs(o.x0 - it.x1) <= 1.2 * R.h));
          if (near) { host = R; break; }
        }
        if (host) host.items.push(it); else keep.push(it);
      }
      r.items = keep;
    }
    const out = rows.filter((r) => r.items.length);
    out.forEach(stats);
    return out.sort((a, b) => a.base - b.base);
  }

  /* ══════════ 3. 欄間溝槽 ══════════ */

  /** 參考文獻、編號清單掛在左邊的編號：「12.」「[12]」「(12)」 */
  const HANG_LABEL = /^\s*[[(]?\d{1,3}[.)\]]?\s*$/;

  function findGutters(rows, W) {
    const gaps = [];
    for (const r of rows) {
      let end = -Infinity, endH = 0, last = null;
      for (const it of r.items) {
        if (end > -Infinity) {
          const gap = it.x0 - end;
          const h = Math.max(endH, it.h);
          const c = (end + it.x0) / 2;
          // 編號跟它後面的文字之間的空白不是欄距（不然參考文獻會被切成「編號一欄、內容一欄」）
          const hanging = last && HANG_LABEL.test(last.str) && last.x1 - last.x0 < 3 * h && gap < 2.2 * h;
          if (!hanging && gap >= 0.45 * h && c > 0.12 * W && c < 0.88 * W) gaps.push({ a: end, b: it.x0, h, y: r.base });
        }
        if (it.x1 > end) { end = it.x1; endH = it.h; last = it; }
      }
    }
    if (gaps.length < 4) return [];

    const N = Math.ceil(W) + 2;
    const cov = new Uint16Array(N);
    for (const gp of gaps) {
      const a = Math.max(0, Math.ceil(gp.a)), b = Math.min(N - 1, Math.floor(gp.b));
      for (let x = a; x <= b; x++) cov[x]++;
    }

    // 候選位置：覆蓋數的每一個高原（同一個高原只取中間那一點）
    const cands = [];
    const lo0 = Math.floor(0.15 * W), hi0 = Math.ceil(0.85 * W);
    for (let x = lo0; x < hi0; x++) {
      if (cov[x] < 4) continue;
      let e = x;
      while (e + 1 < hi0 && cov[e + 1] === cov[x]) e++;
      const left = x > 0 ? cov[x - 1] : 0, right = e + 1 < N ? cov[e + 1] : 0;
      if (cov[x] >= left && cov[x] >= right) cands.push({ x: Math.round((x + e) / 2), v: cov[x] });
      x = e;
    }
    cands.sort((p, q) => q.v - p.v);

    const found = [];
    for (const cand of cands.slice(0, 40)) {
      if (found.length >= 8) break;
      const bx = cand.x;
      if (found.some((gu) => bx >= gu.a - 1 && bx <= gu.b + 1)) continue;   // 同一條溝槽的另一個高原
      const sup = gaps.filter((gp) => gp.a <= bx && gp.b >= bx);
      if (sup.length < 4) continue;

      // 先按高度分群，每一群各自檢查 —— 同一頁上半部是表格、下半部是雙欄內文的情況很常見
      const hAll = median(sup.map((s) => s.h)) || 10;
      const byY = sup.slice().sort((p, q) => p.y - q.y);
      const groups = [];
      for (const s of byY) {
        const last = groups[groups.length - 1];
        if (last && s.y - last[last.length - 1].y <= 4.5 * hAll) last.push(s);
        else groups.push([s]);
      }

      const members = [];
      for (const gs of groups) {
        if (gs.length < (sup.length >= 12 ? 2 : 3)) continue;
        // 真正的欄：右欄每一行都從同一個 x 開始（或左欄齊行、都結束在同一個 x）。
        // 齊行內文字距碰巧排成的「白色河流」不會對得這麼齊，空白也沒那麼寬
        const align = Math.max(modeShare(gs.map((s) => s.b), 1.5), modeShare(gs.map((s) => s.a), 1.5));
        if (align < 0.55) continue;
        const hMed = median(gs.map((s) => s.h)) || hAll;
        if (median(gs.map((s) => s.b - s.a)) < 0.85 * hMed) continue;
        const y0 = gs[0].y, y1 = gs[gs.length - 1].y;
        // 那一段裡「在這裡斷開」的列要比「連續跨過去」的列多
        const cross = rows.filter((r) => r.base >= y0 && r.base <= y1
          && r.items.some((it) => it.x0 < bx - 0.5 && it.x1 > bx + 0.5)).length;
        if (cross > gs.length) continue;
        members.push.apply(members, gs);
      }
      if (members.length < 4) continue;

      // 溝槽 = 這些列「共同沒有字」的那一條：左緣取（去掉離群值的）最大值、右緣取最小值。
      // 用中位數的話，旁邊一張圖的內部空白會把溝槽拉偏
      const a = quantile(members.map((s) => s.a), 0.97);
      const b = quantile(members.map((s) => s.b), 0.03);
      const lo = Math.min(a, b - 0.5), hi = Math.max(b, a + 0.5);
      const gu = { a: lo, b: hi, xc: (lo + hi) / 2, spans: [], support: members.length };
      gu.spans = columnRuns(rows, gu, hAll);
      if (gu.spans.length) found.push(gu);
    }
    // 互相重疊、或靠太近的候選只留證據最多的那條：
    // 左欄段落最後一行很短時，「行尾 → 右欄」的大空白會跟真正的欄距疊在一起，變成一條假的溝槽
    const out = [];
    for (const gu of found.sort((p, q) => q.support - p.support)) {
      if (out.length >= 3) break;
      if (out.some((o) => Math.min(o.b, gu.b) - Math.max(o.a, gu.a) > -1 || Math.abs(o.xc - gu.xc) < 0.08 * W)) continue;
      out.push(gu);
    }
    return out.sort((p, q) => p.xc - q.xc);
  }

  /**
   * 這條溝槽在哪些高度範圍成立。
   * 很多期刊左右兩欄的基線並沒有對齊（左欄 101、113、125…，右欄 106、118、130…），
   * 那些列裡只有一欄的字，不會在溝槽處留下空白 —— 所以不能只看「有空白的列」。
   * 改成逐列分類：橫跨溝槽／兩邊都有字／只有左欄（寫到溝槽邊）／只有右欄（從溝槽邊開始），
   * 沒有被「橫跨」的列打斷、而且左右兩欄都出現過的一段，就是雙欄區。
   */
  function columnRuns(rows, gu, hMed) {
    const runs = [];
    let cur = null;
    const close = () => {
      if (cur && (cur.split >= 2 || (cur.left >= 2 && cur.right >= 2) || (cur.split >= 1 && cur.left + cur.right >= 3))) {
        runs.push([cur.y0 - 1.0 * cur.h, cur.last + 0.5 * cur.h]);
      }
      cur = null;
    };
    for (const r of rows) {
      const its = r.items;
      if (its.some((it) => it.x0 < gu.xc - 0.5 && it.x1 > gu.xc + 0.5)) { close(); continue; }
      let L = -Infinity, R = Infinity;
      for (const it of its) {
        if (it.x1 <= gu.xc + 0.5) L = Math.max(L, it.x1);
        else R = Math.min(R, it.x0);
      }
      if (cur && r.base - cur.last > 4.5 * Math.max(hMed, r.h)) close();
      if (!cur) cur = { y0: r.base, last: r.base, h: r.h, split: 0, left: 0, right: 0 };
      cur.last = r.base;
      cur.h = Math.max(cur.h, r.h);
      if (L > -Infinity && R < Infinity) cur.split++;
      else if (L > -Infinity) { if (L >= gu.a - 2.5 * r.h) cur.left++; }
      else if (R <= gu.b + 1.5 * r.h) cur.right++;
    }
    close();
    return runs;
  }

  const inSpans = (gu, y) => gu.spans.some((s) => y >= s[0] && y <= s[1]);

  /* ══════════ 4. 行（列切開後的片段） ══════════ */

  function splitRow(r, gutters) {
    const frags = [];
    let cur = null, end = -Infinity, endH = 0, curMax = 0;
    for (const it of r.items) {
      if (cur) {
        const gap = it.x0 - end;
        const h = Math.max(endH, it.h);
        let cut = gap > BIG_GAP * h;
        // 有一段距離、字級又差很多：圖的座標軸標籤剛好跟圖說排在同一列
        // （比的是這一行的主要字級，不是前一個上下標）
        const big = Math.max(curMax, it.h);
        if (!cut && gap > 0.8 * big && Math.abs(curMax - it.h) > 0.2 * big) cut = true;
        if (!cut && gap > 0.3 * h) {
          for (const gu of gutters) {
            if (!inSpans(gu, r.base)) continue;
            if (end <= gu.xc + 1 && it.x0 >= gu.xc - 1 && gap >= Math.max(0.6 * h, 0.45 * (gu.b - gu.a))) {
              cut = true;
              break;
            }
          }
        }
        if (cut) { frags.push(cur); cur = null; end = -Infinity; curMax = 0; }
      }
      if (!cur) cur = [];
      cur.push(it);
      curMax = Math.max(curMax, it.h);
      if (it.x1 > end) { end = it.x1; endH = it.h; }
    }
    if (cur) frags.push(cur);
    return frags.map(makeLine);
  }

  function makeLine(items) {
    const h = wmedian(items.map((i) => [i.h, Math.max(1, i.str.trim().length)]));
    const mains = items.filter((i) => Math.abs(i.h - h) <= 0.12 * h);
    const base = median((mains.length ? mains : items).map((i) => i.base));
    for (const i of items) {
      i.sup = i.sub = false;
      if (i.h <= 0.86 * h && mains.length) {
        const dy = i.base - base;
        if (dy < -0.12 * h) i.sup = true;
        else if (dy > 0.06 * h) i.sub = true;
      }
    }
    let x0 = Infinity, x1 = -Infinity, top = Infinity, bottom = -Infinity;
    for (const i of items) {
      x0 = Math.min(x0, i.x0); x1 = Math.max(x1, i.x1);
      top = Math.min(top, i.top); bottom = Math.max(bottom, i.bottom);
    }
    return { items, x0, x1, top, bottom, base, h, text: joinItems(items, h) };
  }

  function joinItems(items, h) {
    let s = '', prevEnd = null, prevScript = false;
    for (const it of items) {
      let t = it.str;
      if (it.sup) t = convert(t, SUP);
      else if (it.sub) t = convert(t, SUB);
      if (prevEnd !== null && !/\s$/.test(s) && !/^\s/.test(t)) {
        const gap = it.x0 - prevEnd;
        const script = it.sup || it.sub;
        if (script) {
          // 上下標緊貼前一個字
          if (prevScript && gap > 0.15 * h) s += ' ';
        } else if (prevScript) {
          if (gap > 0.08 * h && !/^[,.;:)\]]/.test(t)) s += ' ';
        } else if (gap > 0.11 * h || (gap > 0.05 * h && /[a-z]$/.test(s) && /^[A-Z]/.test(t))) {
          s += ' ';
        }
      }
      s += t;
      prevEnd = prevEnd === null ? it.x1 : Math.max(prevEnd, it.x1);
      prevScript = it.sup || it.sub;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /** 欄號：-1 = 全寬（橫跨溝槽、或不在任何雙欄範圍內）；0,1,… = 由左到右第幾欄 */
  function assignColumn(line, gutters) {
    let col = 0, any = false;
    for (const gu of gutters) {
      if (!inSpans(gu, line.base)) continue;
      any = true;
      if (line.x0 < gu.a - 1 && line.x1 > gu.b + 1) return -1;
      if (line.x0 >= gu.xc) col++;
    }
    return any ? col : -1;
  }

  /* ══════════ 5. 區塊 ══════════ */

  const LIST_RE = /^(\(?\d{1,3}[.)]\s|\[\d{1,3}\]\s?|[•·▪◦‣∙●○■□➢►]\s?|[–—-]\s|\(?[a-z]\)\s|\(?[ivx]{1,4}\)\s)/;

  function isCentered(L, f, h) {
    return Math.abs((L.x0 + L.x1) / 2 - (f.x0 + f.x1) / 2) <= 1.2 * h && Math.abs(L.x0 - f.x0) > 0.6 * h;
  }

  const WORDY = /\p{L}{3,}/u;

  function canJoin(B, f, bodyH) {
    const L = B.lines[B.lines.length - 1];
    const h = Math.max(L.h, f.h);
    if (Math.abs(L.h - f.h) > 0.1 * h) return false;
    // 圖內的小字：「~33%」「R Y G」這種只有數字或單一字母的行，不要跟上下的標籤接在一起
    // （參考文獻的最後一行「016005 (2024).」例外：上面是一條編號開頭的清單項目、這行對齊懸掛縮排）
    const listCont = LIST_RE.test(B.lines[0].text) && !LIST_RE.test(f.text) && f.x0 > B.lines[0].x0 + 0.6 * h;
    if (h < 0.9 * bodyH && !listCont && (!WORDY.test(L.text) || !WORDY.test(f.text))) return false;
    const d = f.base - L.base;
    if (d < 0.5 * h) return false;
    if (B.lines.length >= 2) {
      if (d > B.pitch * 1.3 + 0.6 || d < B.pitch * 0.7 - 0.6) return false;
    } else if (d > 1.75 * h) {
      return false;
    }
    const ov = Math.min(B.x1, f.x1) - Math.max(B.x0, f.x0);
    return ov >= 0.5 * Math.min(B.x1 - B.x0, f.x1 - f.x0);
  }

  /** 即使幾何上接得起來，遇到這些情況也要另起一段 */
  function breaks(B, f) {
    const L = B.lines[B.lines.length - 1];
    const h = Math.max(L.h, f.h);
    const tol = 0.6 * h;

    if (LIST_RE.test(f.text) && f.x0 <= B.lines[0].x0 + tol) return true;   // 新的清單項目

    if (B.lines.length === 1) {
      const dx = f.x0 - L.x0;
      if (dx < -tol) {                           // 第一行縮排、第二行回到欄邊：正常段落
        if (-dx > 4.5 * h && !isCentered(L, f, h)) return true;
        if (isCentered(L, f, h) && Math.abs(L.x1 - f.x1) > tol) B.centered = true;
      } else if (dx > tol) {                     // 第二行往右縮：懸掛縮排的清單或置中
        if (isCentered(L, f, h)) B.centered = true;
        else if (!(LIST_RE.test(L.text) && dx <= 6 * h)) return true;
      }
    } else {
      const body = B.lines[1].x0;
      if (Math.abs(f.x0 - body) > tol && !(B.centered && isCentered(L, f, h))) return true;
    }

    // 上一行明顯沒寫到底 → 那是段尾或標題
    if (!B.centered && L.x1 < f.x1 - Math.max(3 * h, 0.2 * (f.x1 - f.x0))) return true;
    return false;
  }

  function addLine(B, f) {
    B.lines.push(f);
    B.x0 = Math.min(B.x0, f.x0); B.x1 = Math.max(B.x1, f.x1);
    B.top = Math.min(B.top, f.top); B.bottom = Math.max(B.bottom, f.bottom);
    const d = [];
    for (let i = 1; i < B.lines.length; i++) d.push(B.lines[i].base - B.lines[i - 1].base);
    B.pitch = median(d);
  }

  function buildBlocks(lines, bodyH) {
    const byCol = new Map();
    for (const f of lines) {
      if (!byCol.has(f.col)) byCol.set(f.col, []);
      byCol.get(f.col).push(f);
    }
    const blocks = [];
    for (const [col, list] of byCol) {
      list.sort((a, b) => (a.base - b.base) || (a.x0 - b.x0));
      let open = [];
      for (const f of list) {
        open = open.filter((B) => f.base - B.lines[B.lines.length - 1].base <= 3 * f.h + 2);
        let best = null, bestD = Infinity;
        for (const B of open) {
          if (!canJoin(B, f, bodyH)) continue;
          const d = f.base - B.lines[B.lines.length - 1].base;
          if (d < bestD) { bestD = d; best = B; }
        }
        if (best && !breaks(best, f)) {
          addLine(best, f);
        } else {
          const B = { col, lines: [f], x0: f.x0, x1: f.x1, top: f.top, bottom: f.bottom, pitch: 0, centered: false };
          open.push(B);
          blocks.push(B);
        }
      }
    }
    return blocks;
  }

  /** 只看水平填滿率：段落每一行都寫到接近全寬；行距再大（雙倍行距的手稿）也不影響 */
  function isSparse(B) {
    const w = Math.max(1, B.x1 - B.x0);
    const ws = B.lines.map((l) => l.x1 - l.x0);
    const fill = ws.reduce((s, v) => s + v, 0) / (ws.length * w);
    return median(ws.slice(0, -1)) < 0.6 * w || fill < 0.62;
  }

  /* ══════════ 斷字還原 ══════════ */

  const TOKEN_RE = /[A-Za-z][A-Za-z-]*[A-Za-z]|[A-Za-z]/g;

  /** 全文用過的字（行首的小寫碎片、行尾帶連字號的半個字不算） */
  function buildVocab(pages) {
    const vocab = new Set();
    for (const p of pages) {
      for (const l of p.lines) {
        const toks = l.text.match(TOKEN_RE) || [];
        toks.forEach((t, k) => {
          if (k === toks.length - 1 && /[-‐‑]\s*$/.test(l.text)) return;
          if (k === 0 && /^[a-z]/.test(t)) return;
          const low = t.toLowerCase();
          vocab.add(low);
          if (low.includes('-')) low.split('-').forEach((x) => x && vocab.add(x));
        });
      }
    }
    return vocab;
  }

  /** 行尾「xxx-」接下一行開頭：該接成一個字，還是本來就是複合字？ */
  function joinPieces(a, b, vocab) {
    if (!a) return b;
    if (!b) return a;
    const m = /([A-Za-z]+)[-‐‑]$/.exec(a);
    const n = /^([a-z][A-Za-z]*)/.exec(b);
    if (m && n) {
      const first = m[1], second = n[1];
      const joined = (first + second).toLowerCase();
      let keep;
      if (vocab && vocab.has(joined)) keep = false;
      else if (vocab && vocab.has((first + '-' + second).toLowerCase())) keep = true;
      else if (vocab && first.length > 1 && second.length > 2
        && vocab.has(first.toLowerCase()) && vocab.has(second.toLowerCase())) keep = true;
      else keep = false;
      return keep ? a + b : a.slice(0, -1) + b;
    }
    if (/[‐‑]$/.test(a)) return a.slice(0, -1) + b;
    return a + ' ' + b;
  }

  /* ══════════ 6. 不翻的東西 ══════════ */

  const MATH_WORDS = new Set(['sin', 'cos', 'tan', 'exp', 'log', 'max', 'min', 'lim', 'sup', 'inf',
    'det', 'arg', 'mod', 'var', 'cov', 'diag', 'tanh', 'sinh', 'cosh', 'softmax', 'argmax', 'argmin', 'mat']);

  function looksLikeMath(text) {
    const t = text.replace(/\s+/g, '');
    if (!t) return true;
    if (t.length <= 4 && !/[a-z]/.test(t)) return true;               // QKT、SiO、R G B 這類記號
    const words = (text.match(/[A-Za-z]{3,}/g) || []).filter((w) => !MATH_WORDS.has(w.toLowerCase()));
    if (!words.length) return true;
    if (/[=≈≤≥∑∫√∂∇]/.test(text) && words.length <= 2) return true;   // 行間公式
    const letters = (t.match(/\p{L}/gu) || []).length;
    return letters / t.length < 0.45 && words.length < 3;
  }

  const headKey = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

  function isRunningJunk(t) {
    const s = t.trim();
    return /^[ivxlcdm]+$/i.test(s)
      || /^[\d\s|/–—.:-]+$/.test(s)
      || /^(page|p\.)\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(s)
      || /^(https?:\/\/|www\.)\S+$/i.test(s)
      || /^(doi:|https?:\/\/doi\.org)/i.test(s)
      || /^arxiv:/i.test(s);
  }

  /* ══════════ 7. 閱讀順序與跨欄接續 ══════════ */

  function readingOrder(blocks) {
    const S = blocks.filter((b) => b.col < 0).sort((a, b) => a.top - b.top);
    let C = blocks.filter((b) => b.col >= 0);
    const out = [];
    for (let k = 0; k <= S.length; k++) {
      const limit = k < S.length ? S[k].top : Infinity;
      const band = C.filter((b) => b.top < limit);
      C = C.filter((b) => b.top >= limit);
      band.sort((a, b) => (a.col - b.col) || (a.top - b.top) || (a.x0 - b.x0));
      band.forEach((b) => { b.band = k; });
      out.push.apply(out, band);
      if (k < S.length) { S[k].band = k; out.push(S[k]); }
    }
    return out;
  }

  const ENDS_SENTENCE = /[.!?。！？:：;；]["”’)\]]*$/;

  /* ══════════ 參考文獻 ══════════
     標成 b.ref，檢視器預設不翻：作者名、期刊名翻了反而錯，而且中文常常塞不下、跟下一條疊在一起。
     認法：「References」標題之後長得像引用的段落；或同一頁至少 3 條「編號＋作者＋年份」的條目。 */

  const REF_HEAD = /^(references?|reference list|bibliography|literature cited|works cited|cited literature|參考文獻|参考文献|引用文獻)$/i;
  const REF_END = /^(appendix|appendices|supplementary|supporting information|acknowledg|author contributions|data availability|conflicts? of interest|competing interests|funding|附錄)/i;
  const NUM_LABEL = /^\s*[[(]?\d{1,3}[.)\]]?\s+\S/;
  const YEAR = /(?:^|[^\d])(1[89]\d{2}|20\d{2})[a-z]?(?:[^\d]|$)/;
  // Zhong, H. Z.／K. He,／et al.／Smith J,
  const AUTHOR = /\p{Lu}[\p{L}'’-]+,\s+(?:\p{Lu}\.\s?-?\s?){1,3}|(?:^|[\s,])(?:\p{Lu}\.\s?-?){1,3}\s?\p{Lu}[\p{L}'’-]+[,.]|\bet al\b|\p{Lu}[\p{L}'’-]+\s\p{Lu}{1,3},/u;
  const looksCitation = (t) => YEAR.test(t) && AUTHOR.test(t);
  // 已經在參考文獻區裡：寫全名的格式（Jimmy Lei Ba, Jamie Ryan Kiros, and …. 2016.）也算
  const NAME_FIRST = /^\s*(?:[[(]?\d{1,3}[.)\]]?\s+)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:\p{Lu}[\p{L}'’.-]*|van|von|de|der|da|di|del|la|le))*,/u;
  const NAME = "\\p{Lu}[\\p{L}'’.-]*(?:\\s+\\p{Lu}[\\p{L}'’.-]*){0,4}";
  const TWO_AUTHORS = new RegExp('^\\s*' + NAME + '\\s+(?:and|&)\\s+\\p{Lu}', 'u');          // Rie Kubota Ando and Tong Zhang.
  const ONE_AUTHOR = new RegExp('^\\s*' + NAME + '\\.\\s+(?:\\(?(?:1[89]|20)\\d{2}|\\p{Lu})', 'u');   // Wilson L Taylor. 1953.
  const looksCitationLoose = (t) => looksCitation(t) || (YEAR.test(t)
    && (NAME_FIRST.test(t) || NUM_LABEL.test(t) || TWO_AUTHORS.test(t) || ONE_AUTHOR.test(t)));
  // 附錄標題：「A. Object Detection Baselines」「A.1 Illustration of …」
  const APPENDIX_HEAD = /^[A-H](?:\.\d+)*\.?\s+\p{Lu}/u;

  function markReferences(pages) {
    let inRefs = false, lastRef = false;
    for (const pg of pages) {
      const numbered = [];
      for (const b of pg.blocks) {
        if (b.skip === 'running') continue;
        if (b.skip) continue;
        const t = b.text.trim();
        const bare = t.replace(/^[\dIVX]+\.?\s+/, '').replace(/[:：]$/, '');
        if (t.length < 40 && REF_HEAD.test(bare)) { inRefs = true; lastRef = false; continue; }
        if (t.length < 60 && (REF_END.test(bare) || (inRefs && APPENDIX_HEAD.test(t) && !YEAR.test(t)))) { inRefs = false; continue; }
        if (NUM_LABEL.test(t) && looksCitation(t)) numbered.push(b);
        // 小寫開頭、緊接在一條參考文獻後面：換欄／換頁接著寫的那一條的後半
        if (inRefs && (looksCitationLoose(t) || (b.prev && b.prev.ref) || (lastRef && /^[a-z(]/.test(t)))) b.ref = true;
        lastRef = !!b.ref;
      }
      if (numbered.length >= 3) numbered.forEach((b) => { b.ref = true; });
      // 跨欄、跨頁接著寫的同一條：一起算
      for (const b of pg.blocks) if (b.ref && b.next) b.next.ref = true;
    }
  }

  /* ══════════ 主流程 ══════════ */

  /**
   * pages: [{ num, w, h, vt, styles, items }]
   * opts.columns: 'auto' | '1' | '2'
   */
  function analyze(pages, opts) {
    opts = opts || {};
    const mode = opts.columns || 'auto';

    const work = pages.map((p) => {
      const items = normalize(p);
      const rows = buildRows(items);
      let gutters = mode === '1' ? [] : findGutters(rows, p.w);
      if (mode === '2' && !gutters.length) {
        // 使用者說是雙欄、但沒有足夠證據：就照頁面正中央切，整頁都算
        gutters = [{ a: p.w / 2 - 4, b: p.w / 2 + 4, xc: p.w / 2, spans: [[-1e9, 1e9]], support: 0 }];
      }
      if (mode === '2' && gutters.length > 1) {
        gutters = [gutters.reduce((x, y) => (Math.abs(x.xc - p.w / 2) < Math.abs(y.xc - p.w / 2) ? x : y))];
      }
      const lines = [];
      for (const r of rows) {
        for (const l of splitRow(r, gutters)) {
          l.col = assignColumn(l, gutters);
          lines.push(l);
        }
      }
      return { page: p, items, rows, gutters, lines };
    });

    // 全文的內文字級（以字數加權）
    const sizes = [];
    work.forEach((w) => w.lines.forEach((l) => sizes.push([Math.round(l.h * 10) / 10, l.text.length])));
    const bodyH = wmedian(sizes) || 10;
    const vocab = buildVocab(work);

    /* 頁首頁尾要在「行」這一層就挑掉：期刊名那一行常常跟正下方的 DOI 行距很近，
       等接成段落再判斷就認不出來了 */
    const heads = new Map();
    const inBand = (l, p) => l.bottom < p.h * HEAD_BAND || l.top > p.h * FOOT_BAND;
    for (const w of work) {
      const seen = new Set();
      for (const l of w.lines) {
        if (!inBand(l, w.page)) continue;
        const k = headKey(l.text);
        if (seen.has(k)) continue;
        seen.add(k);
        heads.set(k, (heads.get(k) || 0) + 1);
      }
    }

    const out = work.map((w) => {
      const p = w.page;
      const running = [], rest = [];
      for (const l of w.lines) {
        const junk = inBand(l, p) && (isRunningJunk(l.text)
          || (work.length > 1 && (heads.get(headKey(l.text)) || 0) >= 2 && l.text.length < 200));
        (junk ? running : rest).push(l);
      }
      const blocks = [];
      for (const B of buildBlocks(rest, bodyH)) {
        // 表格的一欄、圖例：一堆長短差很多的短行，硬接成段落只會翻成一團。拆回一行一塊
        if (B.lines.length >= 3 && isSparse(B)) {
          for (const l of B.lines) blocks.push({ col: B.col, lines: [l], x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom, pitch: 0 });
        } else {
          blocks.push(B);
        }
      }
      for (const l of running) {
        blocks.push({ col: l.col, lines: [l], x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom, pitch: 0, running: true });
      }
      for (const b of blocks) {
        b.text = '';
        for (const l of b.lines) b.text = joinPieces(b.text, l.text, vocab);
        b.text = b.text.replace(/\s+/g, ' ').trim();
        b.h = wmedian(b.lines.map((l) => [l.h, Math.max(1, l.text.length)]));
        b.skip = b.running ? 'running'
          : !/\p{L}{2,}/u.test(b.text) ? 'empty'
            : looksLikeMath(b.text) ? 'math' : null;
      }
      return { num: p.num, w: p.w, h: p.h, gutters: w.gutters, blocks, items: w.items };
    });

    // 閱讀順序、種類
    const CAPTION = /^(fig\.?|figure|table|tab\.|scheme|圖|表)\s*[\dSIVX]+[a-z]?(\s*[.:|]|\s+[A-Z])/i;
    for (const pg of out) {
      pg.blocks = readingOrder(pg.blocks);
      for (const b of pg.blocks) {
        const long = b.lines.length >= 2 || (b.x1 - b.x0) > 18 * b.h;
        const bodySize = Math.abs(b.h - bodyH) <= 0.08 * bodyH;
        b.kind = b.skip ? 'skip'
          : (CAPTION.test(b.text) && (!bodySize || /^\S+\s*[\dSIVX]+[a-z]?\s*[.:|]/i.test(b.text))) ? 'caption'
            // 內文字級、小寫開頭的短行：上一欄沒寫完的那段的尾巴，不是標題
            : (bodySize && (long || /^[a-z(]/.test(b.text))) ? 'body'
              : (b.lines.length === 1 && (b.x1 - b.x0) < 10 * b.h) ? 'label' : 'other';
      }
      // 每一欄的左右邊界（拿來判斷「這一行有沒有寫到底」）
      const edges = new Map();
      for (const b of pg.blocks) {
        if (b.kind !== 'body') continue;
        if (!edges.has(b.col)) edges.set(b.col, { x0: [], x1: [] });
        b.lines.forEach((l) => { edges.get(b.col).x0.push(l.x0); edges.get(b.col).x1.push(l.x1); });
      }
      pg.colEdges = {};
      for (const [c, e] of edges) pg.colEdges[c] = { left: quantile(e.x0, 0.1), right: quantile(e.x1, 0.9) };
    }

    /* 跨欄、跨頁接續：欄尾那段沒寫完、下一欄（頁）開頭又沒縮排，就是同一段話。
       分開送翻的話，半句「unique merits of no zeroth-order background」會被翻成一句
       莫名其妙的中文；串起來一起翻，再按比例切回兩個方塊。 */
    const linkable = (A, pa, B, pb, strict) => {
      if (!A || !B || A === B || A.kind !== 'body' || B.kind !== 'body') return false;
      if (A.next || B.prev) return false;
      if (Math.abs(A.h - B.h) > 0.08 * A.h) return false;
      if (ENDS_SENTENCE.test(A.text)) return false;
      if (strict && !/[-‐‑,]$|[a-z0-9⁰-⁹)]$/.test(A.text)) return false;
      const ea = pa.colEdges[A.col], eb = pb.colEdges[B.col];
      const lastA = A.lines[A.lines.length - 1], firstB = B.lines[0];
      if (ea && lastA.x1 < ea.right - 2.2 * A.h) return false;
      if (eb && firstB.x0 > eb.left + 0.5 * B.h) return false;
      if (LIST_RE.test(firstB.text)) return false;
      return true;
    };
    const link = (A, B) => { A.next = B; B.prev = A; };
    // 中間只隔著圖說、圖內小標籤可以跳過；隔著標題（字級 ≥ 內文的單行）就不行
    const isHeading = (b) => b.kind !== 'body' && b.kind !== 'caption' && b.kind !== 'skip'
      && b.lines.length <= 2 && b.h >= 0.97 * bodyH;
    const firstBody = (list) => {
      for (const b of list) {
        if (b.kind === 'body') return b;
        if (isHeading(b)) return null;
      }
      return null;
    };
    const lastBody = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].kind === 'body') return list[i];
        if (isHeading(list[i])) return null;
      }
      return null;
    };

    for (let pi = 0; pi < out.length; pi++) {
      const pg = out[pi];

      // 同一欄裡上下緊鄰、下一塊小寫開頭：被圖示或排版切斷的同一段（例如授權文字繞過 CC 圖示）
      for (let i = 1; i < pg.blocks.length; i++) {
        const A = pg.blocks[i - 1], B = pg.blocks[i];
        const prose = (b) => b.kind === 'body' || b.kind === 'other' || b.kind === 'caption';
        if (A.col !== B.col || !prose(A) || !prose(B) || B.kind === 'caption') continue;
        if (A.next || B.prev || ENDS_SENTENCE.test(A.text) || !/^[a-z]/.test(B.text)) continue;
        if (Math.abs(A.h - B.h) > 0.08 * A.h) continue;
        if (B.top - A.bottom > 1.5 * A.h || B.top < A.top) continue;
        link(A, B);
      }

      const bands = new Map();
      for (const b of pg.blocks) {
        if (b.col < 0) continue;
        const k = b.band + ':' + b.col;
        if (!bands.has(k)) bands.set(k, []);
        bands.get(k).push(b);
      }
      for (const [k, list] of bands) {
        const [band, col] = k.split(':').map(Number);
        const nextCol = bands.get(band + ':' + (col + 1));
        if (!nextCol) continue;
        const A = lastBody(list), B = firstBody(nextCol);
        if (linkable(A, pg, B, pg, false)) link(A, B);
      }

      const nxt = out[pi + 1];
      if (nxt) {
        const A = lastBody(pg.blocks.filter((b) => b.kind !== 'skip'));
        const B = firstBody(nxt.blocks.filter((b) => b.kind !== 'skip'));
        if (linkable(A, pg, B, nxt, true)) link(A, B);
      }
    }

    markReferences(out);
    return { pages: out, bodyH, vocab };
  }

  /** 把串在一起的區塊合成一個翻譯單位的原文 */
  function unitText(head, vocab) {
    let s = '';
    for (let b = head; b; b = b.next) s = joinPieces(s, b.text, vocab);
    return s;
  }

  /**
   * 一整段譯文按原文長度比例切回各個區塊，切點盡量落在標點後面。
   */
  function splitTranslation(text, weights) {
    if (weights.length <= 1) return [text];
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const out = [];
    let start = 0;
    let acc = 0;
    for (let k = 0; k < weights.length - 1; k++) {
      acc += weights[k];
      const ideal = Math.round(text.length * acc / total);
      const win = Math.max(6, Math.round(text.length * 0.12));
      let best = -1, bestScore = -Infinity;
      for (let i = Math.max(start + 1, ideal - win); i <= Math.min(text.length - 1, ideal + win); i++) {
        const prev = text[i - 1], ch = text[i];
        let score = -Math.abs(i - ideal) / win;
        if (/[。！？；]/.test(prev)) score += 3;
        else if (/[，、：,;:]/.test(prev)) score += 2;
        else if (prev === ' ') score += 1.2;
        else if (/[㐀-鿿]/.test(prev) && /[㐀-鿿]/.test(ch)) score += 0.5;
        else if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(ch)) score -= 5;   // 別切在英文字或數字中間
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) best = Math.min(text.length, Math.max(start, ideal));
      out.push(text.slice(start, best).trim());
      start = best;
    }
    out.push(text.slice(start).trim());
    return out;
  }

  g.PLLayout = {
    analyze, unitText, splitTranslation, joinPieces,
    // 給測試用
    _: { normalize, buildRows, findGutters, splitRow, buildBlocks, convert, SUP, SUB, looksLikeMath, modeShare }
  };
})(globalThis);
