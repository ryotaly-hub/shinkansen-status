/* オフラインキャッシュ（アプリ本体のみ）。運行情報フィードは常にネットワークから取得する。 */
const CACHE = 'shinkansen-unko-v6';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/data.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 同一オリジンのGETのみ扱う。フィード（クロスオリジン）はブラウザに任せる＝キャッシュしない。
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // status.json（同一オリジン配信時）は常にネットワークから。
  if (url.pathname.endsWith('/status.json') || url.pathname === '/status.json') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
