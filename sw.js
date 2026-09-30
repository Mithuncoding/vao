const VERSION = 'ab7f03c10c';
const SHELL = `vao-shell-${VERSION}`;
const MEDIA = 'vao-media';
const ASSETS = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'data/bank.json', 'data/library.json', 'data/notes.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vao-shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/media/')) {
    // question images: cache-first, kept across app updates
    e.respondWith(caches.open(MEDIA).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(caches.open(SHELL).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      if (req.mode === 'navigate') return cache.match('index.html');
      throw err;
    }
  }));
});
