// TalkToFriend service worker — cache app shell for offline landing page.
// NOTE: WebRTC calls require active internet, so we don't cache those paths.

const CACHE_NAME = 'ttf-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app-index.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache:
  // - Same-origin API / Socket.IO paths
  // - Non-GET requests
  // - WebSocket upgrades
  // - Room page (always fetch fresh, uses live signaling)
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/metrics') ||
    url.pathname.startsWith('/healthz') ||
    url.pathname.startsWith('/room.html')
  ) {
    return;
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        // Only cache successful same-origin responses
        if (resp.ok && url.origin === location.origin) {
          const cloned = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return resp;
      }).catch(() => caches.match('/'));
    })
  );
});
