#!/usr/bin/env node
/* PaperLens — 打包擴充功能的更新包（zip）
 *
 *   node tools/pack-extension.js        → dist/PaperLens-Extension-<版本>.zip
 *
 * 跟 tools/build.ps1 放一樣的檔案，差別是這支 Windows／Mac／Linux 都能跑（自動建置用這支）。
 * 檔名用 UTF-8 標記，Windows 檔案總管解壓縮「使用說明書.md」也不會變亂碼。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ITEMS = ['manifest.json', 'background.js', 'shared', 'content', 'export', 'options', 'popup', 'pdf', 'vendor', 'icons',
  '使用說明書.md', 'README.md', 'CHANGELOG.md'];
const SKIP = ['.map', '.sample-export.json', '.DS_Store', 'Thumbs.db'];

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const outDir = path.join(ROOT, 'dist');
const out = path.join(outDir, 'PaperLens-Extension-' + version + '.zip');

function walk(rel, list) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('找不到 ' + rel);
  const st = fs.statSync(abs);
  if (st.isFile()) {
    if (!SKIP.some((s) => rel.endsWith(s))) list.push(rel.split(path.sep).join('/'));
    return list;
  }
  for (const name of fs.readdirSync(abs).sort()) {
    if (name.startsWith('.')) continue;
    walk(path.join(rel, name), list);
  }
  return list;
}

const crc32 = zlib.crc32 || ((buf) => {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
});

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

const files = ITEMS.reduce((l, it) => walk(it, l), []);
const now = dosTime(new Date());
const chunks = [];
const central = [];
let offset = 0;

for (const rel of files) {
  const data = fs.readFileSync(path.join(ROOT, rel));
  const name = Buffer.from(rel, 'utf8');
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const crc = crc32(data) >>> 0;

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);                 // 解壓需要的版本
  lh.writeUInt16LE(0x0800, 6);             // 檔名是 UTF-8
  lh.writeUInt16LE(stored ? 0 : 8, 8);
  lh.writeUInt16LE(now.time, 10);
  lh.writeUInt16LE(now.date, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(stored ? 0 : 8, 10);
  ch.writeUInt16LE(now.time, 12);
  ch.writeUInt16LE(now.date, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  // 30 extra、32 comment、34 disk、36 內部屬性、38 外部屬性都是 0
  ch.writeUInt32LE(offset, 42);
  central.push(ch, name);

  offset += lh.length + name.length + body.length;
}

const cdSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, Buffer.concat([...chunks, ...central, end]));
console.log('完成：' + path.relative(ROOT, out) + '（' + files.length + ' 個檔案，'
  + Math.round(fs.statSync(out).size / 1024) + ' KB）');
