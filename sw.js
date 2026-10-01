// Cache only this app's explicit, public, same-origin shell. Never intercept API
// or auth traffic, including cross-origin GETs and same-origin /api requests.
const CACHE_NAME = 'yilan-rental-v2.3.0';
const APP_SHELL = ['./', './index.html', './cloud-config.js', './cloud-sync.js', './sync-engine.js', './manifest.webmanifest', './favicon.svg'];
const SHELL_URLS = new Set(APP_SHELL.map(path => new URL(path, self.registration.scope).href));
const INDEX_URL = new URL('./index.html', self.registration.scope).href;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('yilan-rental-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search || !SHELL_URLS.has(url.href) || request.headers.has('authorization') || request.headers.has('x-family-pin') || request.headers.has('apikey')) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok && response.type !== 'opaque' && !response.redirected) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const index = await caches.match(INDEX_URL);
      if (index) return index;
    }
    return Response.error();
  }));
});
