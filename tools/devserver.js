/* 開發用的極簡靜態伺服器（只給 tools/testbed.html 測試用，不是擴充功能的一部分）
 * 用法： node tools/devserver.js   → http://localhost:5177/tools/testbed.html
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 5177);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};

const SAMPLE = path.join(ROOT, 'tools', '.sample-export.json');

http.createServer((req, res) => {
  const [rawPath, query] = req.url.split('?');
  let rel = decodeURIComponent(rawPath);

  // 測試台把收集到的匯出內容丟過來，好讓 export.html 可以離線預覽
  if (req.method === 'POST' && rel === '/__export') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.writeFileSync(SAMPLE, Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('saved');
    });
    return;
  }

  if (rel === '/') rel = '/tools/testbed.html';
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + rel); return; }

    // ?testbed=1 → 塞一支假的 chrome API 進去，擴充功能頁面就能在普通瀏覽器裡跑
    const isExtPage = rel === '/export/export.html' || rel === '/pdf/pdfview.html';
    if (isExtPage && /(^|&)testbed=1(&|$)/.test(query || '')) {
      buf = Buffer.from(String(buf).replace('</head>',
        '<script src="/tools/chrome-stub.js"></script></head>'), 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log('PaperLens testbed → http://localhost:' + PORT + '/tools/testbed.html'));
