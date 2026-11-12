#!/usr/bin/env node
/* PaperLens — 產生 GitHub Releases 的發佈說明
 *
 *   node tools/release-notes.js 0.2.1 > notes.md
 *
 * 內容 = CHANGELOG.md 裡這一版的段落 + 固定的下載／更新說明。
 * 「### 這一版更新」底下的條列也會顯示在程式內的新版提醒裡，寫給使用者看的話放這裡。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const v = (process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version).replace(/^v/, '');

let section = '';
try {
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const start = log.findIndex((l) => new RegExp('^##\\s+v?' + v.replace(/\./g, '\\.') + '\\b').test(l));
  if (start >= 0) {
    let end = log.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end < 0) end = log.length;
    section = log.slice(start + 1, end).join('\n').trim();
  }
} catch (e) { /* 沒有 CHANGELOG 就只放下載說明 */ }

const body = `${section || '### 這一版更新\n- 錯誤修正與小改善'}

### 下載哪一個？
| 檔案 | 給誰用 |
|---|---|
| \`PaperLens-Setup-${v}.exe\` | **Windows 安裝版（建議）**：之後有新版會自動更新 |
| \`PaperLens-Portable-${v}.exe\` | Windows 免安裝版：放隨身碟也能用，有新版時會提醒你下載 |
| \`PaperLens-mac-arm64-${v}.dmg\` | macOS 版（Apple Silicon：M1／M2／M3／M4…）：有新版時會提醒你下載 |
| \`PaperLens-Extension-${v}.zip\` | Chrome 擴充功能的更新包 |

### 怎麼更新
**Windows 安裝版**：0.2.1 以後的版本會自己更新，不用做任何事。從更舊的版本更新的話，下載 \`PaperLens-Setup-${v}.exe\` 直接執行、覆蓋安裝一次就好。

**Windows 免安裝版**：下載新的 \`PaperLens-Portable-${v}.exe\`，把舊的換掉。

**macOS 版**：下載 \`PaperLens-mac-arm64-${v}.dmg\`，打開後把 PaperLens 拖進「應用程式」（更新時選「取代」）。
第一次開啟若出現「無法打開」或「已損毀」：打開「終端機」貼上 \`xattr -cr /Applications/PaperLens.app\` 按 Enter，再開一次就可以了（程式沒有 Apple 簽章，這一步是告訴 macOS 你信任它）。

**Chrome 擴充功能**：
1. 下載 \`PaperLens-Extension-${v}.zip\`，解壓縮
2. 把裡面的檔案全部複製，貼到原本的 PaperLens 資料夾，選「取代」（資料夾位置不要改）
3. 到 \`chrome://extensions\`，在 PaperLens 上按「重新載入」↻

註解、標註、翻譯快取、設定和 Gemini 金鑰都存在你自己的電腦上，更新不會不見。

> 安裝檔沒有數位簽章，第一次執行 Windows 可能跳出「Windows 已保護您的電腦」，按「其他資訊」→「仍要執行」即可。
`;

process.stdout.write(body);
