// Offline support: the app itself is cached on install; covers and fonts are cached as they're seen.
const VERSION = 'v1.0.0';
const SHELL = `shell-${VERSION}`;
const COVERS = 'covers-v1';
const FONTS = 'fonts-v1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'store.js', 'lookup.js', 'charts.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'vendor/zxing.min.js',
  'fonts/literata-latin-opsz-normal.woff2', 'fonts/literata-latin-opsz-italic.woff2', 'fonts/hanken-grotesk-latin-wght-normal.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, COVERS, FONTS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/seed.csv')) return; // never cache sample data
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
      if (hit) return hit;
      try { return await fetch(req); } catch { return Response.error(); }
    })());
    return;
  }

  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(staleWhileRevalidate(FONTS, req));
    return;
  }

  if (req.destination === 'image') {
    e.respondWith((async () => {
      const cache = await caches.open(COVERS);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch { return Response.error(); }
    })());
  }
  // Book lookups (Open Library, Google Books) go straight to the network.
});

async function staleWhileRevalidate(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}
