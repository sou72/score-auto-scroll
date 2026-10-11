// 更新版を配るときは、この版番号を上げる。
const VERSION = 'v1';
const CACHE = `score-auto-scroll-${VERSION}`;

const CORE = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/importer.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

// skipWaiting / clients.claim は呼ばない。
// 新しい版は、アプリを閉じて開き直したときに切り替わる（新旧のファイルが混ざらない）。
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const pdfFiles = await (await fetch('lib/pdfjs/files.json', { cache: 'no-cache' })).json();
    await cache.addAll([...CORE, 'lib/pdfjs/files.json', ...pdfFiles]);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  event.respondWith((async () => {
    // この版のキャッシュだけを見る（他の版のファイルを混ぜない）
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await cache.match('index.html');
      if (index) return index;
    }
    return fetch(req);
  })());
});
