/* 開發用靜態伺服器。零依賴，直接 `node tools/serve.mjs`。
   正式部署是 GitHub Pages，這支只在本機開發時用。 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
  '.otf':  'font/otf',
  '.ttf':  'font/ttf',
  '.wasm': 'application/wasm',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url);

  // 擋掉往上跳出專案目錄的路徑
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + url);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // service worker 開發時最怕拿到舊檔
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`BOOK_TRANSLATE dev server → http://localhost:${PORT}`);
});
