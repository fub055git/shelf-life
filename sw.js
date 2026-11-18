// Offline support. The app files are served from the cache. When the app is opened, the whole set of
// app files is downloaded again in the background and swapped in only if every file arrived, so a
// deploy shows up on the next open and the modules (app.js, core.js, api.js, sync.js) always come
// from the same version. Covers are cached the first time they load and kept, so shelves look right
// offline. Book data is cached by the app itself (api.js).
const VERSION = 'shelf-life-v2';
const COVERS = 'shelf-life-covers';
const APP = ['./', './index.html', './style.css', './app.js', './core.js', './api.js', './sync.js', './manifest.json', './icons/icon.svg', './icons/apple-touch-icon.png', './icons/icon-192.png', './vendor/zxing.min.js'];
const MAX_COVERS = 1500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== COVERS).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (req.mode === 'navigate') e.waitUntil(refreshApp());
    e.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); } catch (err) {
        if (req.mode === 'navigate') return cache.match('./index.html');
        throw err;
      }
    }));
    return;
  }

  if (url.host === 'covers.openlibrary.org') {
    e.respondWith(caches.open(COVERS).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Only keep real images: Open Library answers missing covers with a tiny placeholder
      if (res.ok && res.type === 'cors' && Number(res.headers.get('content-length') || 2000) > 1000) {
        cache.put(req, res.clone());
        e.waitUntil(trim(cache));
      }
      return res;
    }));
  }
});

// Fetch every app file fresh; only when all of them succeed, write them into the cache together.
// At most once a minute, so moving around the app doesn't re-download it.
let lastRefresh = 0;
async function refreshApp() {
  if (Date.now() - lastRefresh < 60000) return;
  lastRefresh = Date.now();
  try {
    const responses = await Promise.all(APP.map(async u => {
      const res = await fetch(new Request(u, { cache: 'no-cache' }));
      if (!res.ok) throw new Error(u);
      return [u, res];
    }));
    const cache = await caches.open(VERSION);
    await Promise.all(responses.map(([u, res]) => cache.put(u, res)));
  } catch {} // offline or a file missing mid-deploy: keep the old set
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_COVERS))) await cache.delete(k);
}
