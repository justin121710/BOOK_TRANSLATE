/* Service worker。
 * 只快取 App 殼（HTML / CSS / JS）讓離線時打得開。
 * 字型與 CDN 相依走 runtime cache；API 請求一律不碰。 */

const VERSION = 'v1';
const SHELL = 'shell-' + VERSION;
const RUNTIME = 'runtime-' + VERSION;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './src/main.js',
  './src/ui/router.js',
  './src/ui/toast.js',
  './src/ui/dialog.js',
  './src/ui/cropper.js',
  './src/ui/icons.js',
  './src/ui/boxeditor.js',
  './src/ocr/pagenum.js',
  './src/input/pages.js',
  './src/input/pdfin.js',
  './src/ocr/index.js',
  './src/ocr/parse.js',
  './src/ocr/native.js',
  './src/pdf/export.js',
  './src/pdf/figures.js',
  './src/render/rules.js',
  './src/render/layout.js',
  './src/render/canvas.js',
  './src/translate/index.js',
  './src/translate/prompt.js',
  './src/translate/glossary.js',
  './src/preprocess/warp.js',
  './src/preprocess/enhance.js',
  './src/state/db.js',
  './src/state/settings.js',
  './src/api/vision.js',
  './src/api/claude.js',
  './src/api/gemini.js',
  './src/pdf/fonts.js',
  './src/views/home.js',
  './src/views/project.js',
  './src/views/page.js',
  './src/views/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      // addAll 只要有一個檔案失敗就整批失敗，開發期間很容易踩到
      .then(c => Promise.allSettled(SHELL_FILES.map(f => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API 呼叫絕對不進快取：回應含金鑰授權結果，而且一定要即時
  if (url.hostname === 'api.anthropic.com' || url.hostname === 'vision.googleapis.com') return;

  // 同源：網路優先，離線才回快取。開發時才不會一直拿到舊檔。
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // CDN 相依（esm.sh、jsdelivr、字型）：快取優先，這些都是不可變的版本化網址
  if (/(^|\.)(jsdelivr\.net|esm\.sh)$/.test(url.hostname)) {
    e.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      }))
    );
  }
});
