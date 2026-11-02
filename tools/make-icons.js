/* 產生擴充功能圖示（不需要任何套件，直接用 Node 內建 zlib 寫 PNG）
 * 用法： node tools/make-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;                       // filter type 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --- 圖示長相：圓角靛藍底，左白右黃兩欄，代表「原文 / 譯文」--- */

function design(size) {
  const S = 3;                                  // 超取樣倍率，讓邊緣平滑
  const R = size * 0.23;
  const m = size * 0.19;                        // 內縮
  const gap = Math.max(size * 0.045, 1);
  const midL = size / 2 - gap / 2;
  const midR = size / 2 + gap / 2;

  function insideRounded(x, y) {
    const r = R;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    const dx = x - cx, dy = y - cy;
    return (dx * dx + dy * dy) <= r * r;
  }

  return function (px, py) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const x = px + (sx + 0.5) / S;
        const y = py + (sy + 0.5) / S;
        let c;
        if (!insideRounded(x, y)) {
          c = [0, 0, 0, 0];
        } else {
          const t = y / size;
          const bg = [
            Math.round(99 + (58 - 99) * t),
            Math.round(91 + (50 - 91) * t),
            Math.round(235 + (201 - 235) * t),
            255
          ];
          const inBand = y > m && y < size - m;
          if (inBand && x > m && x < midL) c = [255, 255, 255, 255];
          else if (inBand && x > midR && x < size - m) c = [255, 208, 92, 255];
          else c = bg;
        }
        acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
      }
    }
    const n = S * S;
    const a = acc[3] / n;
    if (a < 1) return [0, 0, 0, 0];
    return [
      Math.round(acc[0] / acc[3]),
      Math.round(acc[1] / acc[3]),
      Math.round(acc[2] / acc[3]),
      Math.round(a)
    ];
  };
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, png(size, design(size)));
  console.log('寫入', file);
}

// 桌面版（Windows 安裝檔、工作列）需要至少 256px 的圖示
const deskDir = path.join(__dirname, '..', 'desktop', 'build');
fs.mkdirSync(deskDir, { recursive: true });
fs.writeFileSync(path.join(deskDir, 'icon.png'), png(512, design(512)));
console.log('寫入', path.join(deskDir, 'icon.png'));
