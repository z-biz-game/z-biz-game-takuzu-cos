'use strict';

// 版本号进缓存名：改一次部署就换一个新 cache，activate 里把旧的一次性清掉。
// 若沿用固定名 + cache-first，js/css 会被永久钉在旧版本，出新 HTML 配旧 JS 的鬼状态。
const VERSION = 'takuzu-v1.0.0';
const RUNTIME = `${VERSION}-runtime`;

// 装到桌面/首屏离线打开要用的那几份。少一个文件 addAll 整体失败，所以只列盘上真实存在的。
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/game.css',
  './js/main.js',
  './js/pwa.js',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './assets/img/board-texture.png',
  './assets/img/spark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(RUNTIME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 一律网络优先：联网就取最新的并顺手回填；断网/5xx 才退缓存。
// 导航请求失败时退到缓存里的 index.html，这样飞行模式下已装过的应用还能开。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) =>
          hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
        )
      )
  );
});
