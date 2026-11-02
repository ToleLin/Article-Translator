/* 產生一份測試用的「假論文」PDF（不需要任何套件）
 *
 *   node tools/make-test-pdf.js
 *
 * 刻意做成雙欄 + 頁首頁尾 + 中間一塊圖，用來驗證：
 *   - 雙欄偵測（中央空白帶）
 *   - 行併成段落（靠右邊界、行距、縮排）
 *   - 頁首頁尾過濾（跨頁重複、純頁碼、網址）
 *   - 圖片區域偵測（段落之間的大片空白 + 畫布上真的有墨）
 *   - 斷字連接號接回去
 *
 * 字寬表會寫進 PDF 的 /Widths，排版也用同一張表，
 * 所以 pdf.js 量到的行寬會跟實際畫出來的一致 —— 沒有這個，
 * pdf.js 只能用預設字寬，量出來的行寬會比實際寬一大截，分欄就驗不到了。
 */
const fs = require('fs');
const path = require('path');

const W = 595, H = 842;
const COL_L = [45, 288];
const COL_R = [307, 550];

/* ASCII 32–126 的標準 Helvetica 字寬（單位 1/1000 em） */
const WID_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];
const WID_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

const widthOf = (ch, bold) => {
  const c = ch.charCodeAt(0);
  if (c < 32 || c > 126) return 556;
  return (bold ? WID_BOLD : WID_REG)[c - 32];
};

const textWidth = (s, size, bold) => {
  let w = 0;
  for (const ch of s) w += widthOf(ch, bold);
  return w * size / 1000;
};

/** 把一段文字依欄寬斷行，最後一行自然會比較短（段落判斷就是靠這個） */
function wrap(text, maxWidth, size, bold) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (cur && textWidth(cand, size, bold) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cand;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

class Content {
  constructor() { this.ops = []; }

  text(str, x, y, size, bold) {
    this.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf 1 0 0 1 '
      + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm (' + esc(str) + ') Tj ET');
  }

  /** 輸出一整段（自動斷行），回傳下一行可用的 y */
  para(str, col, y, size, leading, bold) {
    const lines = wrap(str, col[1] - col[0], size, bold);
    for (const l of lines) {
      this.text(l, col[0], y, size, bold);
      y -= leading;
    }
    return y;
  }

  rect(x, y, w, h, rgb) {
    this.ops.push(rgb.join(' ') + ' rg ' + x + ' ' + y + ' ' + w + ' ' + h + ' re f');
  }

  circle(cx, cy, r, rgb) {
    const k = 0.5523 * r;
    this.ops.push(rgb.join(' ') + ' rg '
      + (cx - r) + ' ' + cy + ' m '
      + (cx - r) + ' ' + (cy + k) + ' ' + (cx - k) + ' ' + (cy + r) + ' ' + cx + ' ' + (cy + r) + ' c '
      + (cx + k) + ' ' + (cy + r) + ' ' + (cx + r) + ' ' + (cy + k) + ' ' + (cx + r) + ' ' + cy + ' c '
      + (cx + r) + ' ' + (cy - k) + ' ' + (cx + k) + ' ' + (cy - r) + ' ' + cx + ' ' + (cy - r) + ' c '
      + (cx - k) + ' ' + (cy - r) + ' ' + (cx - r) + ' ' + (cy - k) + ' ' + (cx - r) + ' ' + cy + ' c f');
  }

  toString() { return this.ops.join('\n'); }
}

const HEADER = 'Tian et al. Journal of Test Optics (2026) 14:94';
const HEADER_R = 'www.example.org/jto';
const SIZE = 9.2, LEAD = 12;

/* ── 第 1 頁 ── */
const p1 = new Content();
p1.text(HEADER, 45, 812, 8);
p1.text(HEADER_R, 430, 812, 8);

let y = p1.para('An achromatic metasurface waveguide for augmented reality displays',
  [45, 550], 770, 17, 21, true);
p1.text('Zhongtao Tian, Xiuling Zhu, Philip A. Surman and Xiao Wei Sun', 45, y - 6, 9);

y = p1.para(
  'Augmented reality displays are emerging as the next generation of interactive platform, '
  + 'providing deeper human-digital interactions and immersive experiences beyond traditional '
  + 'flat-panel displays. Diffractive waveguide is a promising optical combiner technology for '
  + 'AR owing to its potential for the slimmest geometry and the lightest weight overall.',
  COL_L, 700, SIZE, LEAD);

// 圖：留一塊空白，中間畫東西（含一行圖內標籤，用來測試「圖內文字」不會破壞偵測）
p1.rect(COL_L[0] + 4, y - 168, 234, 152, [0.86, 0.90, 0.96]);
p1.rect(COL_L[0] + 20, y - 108, 200, 26, [0.20, 0.22, 0.28]);
for (let i = 0; i < 9; i++) {
  p1.circle(COL_L[0] + 38 + i * 22, y - 95, 7 - Math.abs(i - 4) * 0.9, [0.86, 0.90, 0.96]);
}
p1.text('tapered hole radii', COL_L[0] + 78, y - 140, 8);
y -= 180;

y = p1.para('Figure 1. Schematic of the tapered nanobeam cavity. The hole radius is reduced '
  + 'quadratically toward the centre of the device.', COL_L, y, 8, 10);

p1.para('However, severe chromatic aberration of the diffractive coupler has constrained the '
  + 'widespread adoption of diffractive waveguides in commercial products.',
  COL_L, y - 8, SIZE, LEAD);

let yr = p1.para(
  'Wavelength-dependent light deflection, caused by dispersion in both the in-coupling and '
  + 'the out-coupling processes, results in a limited full-color field of view and nonuniform '
  + 'optical responses in the color and the angular domains. Here we introduce an innovative '
  + 'full-color AR system that overcomes this long-standing challenge of chromatic aberration '
  + 'using inverse-designed metasurface couplers.',
  COL_R, 700, SIZE, LEAD);

p1.para('The optimized metasurface couplers demonstrate true achromatic behavior across the '
  + 'maximum field of view supported by the waveguide, exceeding forty-five degrees in the '
  + 'horizontal direction. Our prototype exhibits superior color accuracy and uniformity.',
  COL_R, yr - 8, SIZE, LEAD);

p1.text('1', 297, 28, 8);

/* ── 第 2 頁 ── */
const p2 = new Content();
p2.text(HEADER, 45, 812, 8);
p2.text(HEADER_R, 430, 812, 8);

p2.text('2. Design and Simulation', 45, 780, 12, true);

let y2 = p2.para('The cavity was designed using three-dimensional finite-difference time-domain '
  + 'simulations performed on a uniform grid. A quadratic taper of the hole radius over twelve '
  + 'periods produces a Gaussian-like field envelope, which suppresses out-of-plane radiation loss.',
  COL_L, 752, SIZE, LEAD);

p2.para('Devices were fabricated on a 220 nm silicon-on-insulator wafer using electron-beam '
  + 'lithography followed by a chlorine-based dry etch and a buffered oxide release step.',
  COL_L, y2 - 8, SIZE, LEAD);

let y2r = p2.para('The measured linewidth of 1.3 pm corresponds to a loaded quality factor of '
  + '1.2 million at a resonant wavelength near 1550 nm, which is the highest value reported '
  + 'for this geometry to date.', COL_R, 752, SIZE, LEAD);

p2.para('Thermal tuning of 0.08 nm per kelvin was observed, consistent with the thermo-optic '
  + 'coefficient of crystalline silicon.', COL_R, y2r - 8, SIZE, LEAD);

p2.text('2', 297, 28, 8);

/* ── 組成 PDF ── */

function fontObj(bold) {
  const widths = (bold ? WID_BOLD : WID_REG).join(' ');
  return '<< /Type /Font /Subtype /Type1 /BaseFont /' + (bold ? 'Helvetica-Bold' : 'Helvetica')
    + ' /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [' + widths + '] >>';
}

function build(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };

  const contentIds = pages.map((c) => {
    const stream = c.toString();
    return add('<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream');
  });

  const fReg = add(fontObj(false));
  const fBold = add(fontObj(true));

  const kidIds = pages.map((_, i) => add('<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ' + W + ' ' + H + ']'
    + ' /Resources << /Font << /F1 ' + fReg + ' 0 R /F2 ' + fBold + ' 0 R >> >>'
    + ' /Contents ' + contentIds[i] + ' 0 R >>'));

  const pagesId = add('<< /Type /Pages /Kids [' + kidIds.map((k) => k + ' 0 R').join(' ')
    + '] /Count ' + kidIds.length + ' >>');
  const catalogId = add('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');

  for (const k of kidIds) {
    objs[k - 1] = objs[k - 1].replace('/Parent 0 0 R', '/Parent ' + pagesId + ' 0 R');
  }

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R >>\n';
  out += 'startxref\n' + xref + '\n%%EOF\n';

  return Buffer.from(out, 'latin1');
}

const file = path.join(__dirname, 'test-paper.pdf');
fs.writeFileSync(file, build([p1, p2]));
console.log('寫入', file, (fs.statSync(file).size / 1024).toFixed(1) + ' KB');
