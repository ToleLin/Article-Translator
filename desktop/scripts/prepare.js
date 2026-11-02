/* 把擴充功能的網頁檔案複製到 desktop/app/，並在每個 HTML 的 <head> 最前面插入桌面版的 chrome.* 模擬。
 *
 *   node scripts/prepare.js        （npm start / npm run dist 會自動先跑這一步）
 *
 * 桌面版與擴充功能共用同一份程式碼；改了 pdf/、shared/、content/ 之後重新跑這一步就同步了。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DESK = path.join(__dirname, '..');
const ROOT = path.join(DESK, '..');
const OUT = path.join(DESK, 'app');
const DIRS = ['pdf', 'shared', 'content', 'vendor', 'export', 'options', 'icons'];
const PAGES = ['pdf/pdfview.html', 'export/export.html', 'options/options.html'];

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true });

fs.mkdirSync(path.join(OUT, 'desktop'), { recursive: true });
fs.copyFileSync(path.join(DESK, 'shim.js'), path.join(OUT, 'desktop', 'shim.js'));

const icon = path.join(DESK, 'build', 'icon.png');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(OUT, 'icons', 'icon512.png'));

for (const rel of PAGES) {
  const p = path.join(OUT, rel);
  const html = fs.readFileSync(p, 'utf8');
  if (!html.includes('<head>')) throw new Error(rel + ' 找不到 <head>');
  fs.writeFileSync(p, html.replace('<head>', '<head>\n  <script src="/desktop/shim.js"></script>'));
}

// 桌面版的版本號跟擴充功能一致
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
console.log('已準備桌面版網頁檔案 →', path.relative(ROOT, OUT), '（擴充功能版本 ' + manifest.version + '）');
