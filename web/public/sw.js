/**
 * Mziya Service Worker — Offline Support
 * Caches the app shell so it works even without internet.
 * P2P network reconnects automatically when back online.
 */

const CACHE_NAME = 'mziya-v2';
// Only cache files that actually exist at these paths.
// Vite bundles JS into hashed filenames — those are handled by network-first strategy below.
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Cache-first for shell, network-first for everything else
  if (SHELL_FILES.some(f => event.request.url.endsWith(f))) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  } else {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});
