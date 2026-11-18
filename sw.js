// Offline support. The app files are served from the cache and refreshed in the background,
// so a deploy shows up the next time the app opens. Covers are cached the first time they load
// and kept, so shelves look right offline. Book data is cached by the app itself (api.js).
// Bump VERSION when files change together so they update as one set.
const VERSION = 'shelf-life-v1';
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
    e.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh.catch(() => cache.match('./index.html'));
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

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_COVERS))) await cache.delete(k);
}
