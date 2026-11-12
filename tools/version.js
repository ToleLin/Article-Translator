#!/usr/bin/env node
/* PaperLens — 版本號
 *
 *   node tools/version.js            印出目前版本
 *   node tools/version.js 0.2.2      改成 0.2.2（manifest.json、desktop/package.json、package-lock.json 一起改）
 *   node tools/version.js patch      最後一碼加一（0.2.1 → 0.2.2）
 *   node tools/version.js --check    檢查三個地方的版本一致（自動建置會先跑這個）
 *
 * 版本號改了再推上去，自動建置就會發佈一個新的 vX.Y.Z 到 GitHub Releases（更新包）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = {
  manifest: path.join(ROOT, 'manifest.json'),
  pkg: path.join(ROOT, 'desktop', 'package.json'),
  lock: path.join(ROOT, 'desktop', 'package-lock.json')
};
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function current() {
  const m = read(FILES.manifest).version;
  const p = read(FILES.pkg).version;
  const l = read(FILES.lock);
  return { manifest: m, pkg: p, lock: l.version, lockRoot: l.packages && l.packages[''] && l.packages[''].version };
}

/** 只改 "version" 那一行，保留原本的排版 */
function setIn(file, v, count) {
  let s = fs.readFileSync(file, 'utf8');
  let n = 0;
  s = s.replace(/("version"\s*:\s*")[^"]*(")/g, (all, a, b) => (n++ < count ? a + v + b : all));
  fs.writeFileSync(file, s);
}

const arg = process.argv[2];
const cur = current();

if (!arg) {
  console.log(cur.manifest);
} else if (arg === '--check') {
  const vals = Object.values(cur);
  if (vals.some((v) => v !== cur.manifest)) {
    console.error('版本號不一致：', cur, '\n請執行 node tools/version.js ' + cur.manifest);
    process.exit(1);
  }
  console.log(cur.manifest);
} else {
  let v = arg;
  if (arg === 'patch' || arg === 'minor' || arg === 'major') {
    const [a, b, c] = cur.manifest.split('.').map((x) => parseInt(x, 10) || 0);
    v = arg === 'patch' ? [a, b, c + 1] : arg === 'minor' ? [a, b + 1, 0] : [a + 1, 0, 0];
    v = v.join('.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error('版本號格式要像 0.2.2'); process.exit(1); }
  setIn(FILES.manifest, v, 1);
  setIn(FILES.pkg, v, 1);
  setIn(FILES.lock, v, 2);         // package-lock 最上面兩個 version 是自己的版本
  console.log(cur.manifest + ' → ' + v);
}
