/* Charlie Gold PWA — cache shell + last calls.json for offline read */
const CACHE = 'charlie-gold-v6';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './calls.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './charts/call_001.png',
  './charts/call_001_refined.png',
  './charts/call_S001.png',
  './charts/call_I001.png',
  './charts/call_B-S001.png',
  './charts/call_B-I001.png',
  './charts/call_B-W001.png',
  './charts/call_V-S001.png',
  './charts/call_V-I001.png',
  './charts/call_V-W001.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
function callsCacheRequest() {
  return new Request(new URL('calls.json', self.registration.scope).href);
}
async function networkFirstCalls(request) {
  const cache = await caches.open(CACHE);
  const key = callsCacheRequest();
  try {
    const res = await fetch(request);
    if (res && res.ok) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key) || await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // don't cache biquote etc.
  if (url.pathname.endsWith('/calls.json')) {
    e.respondWith(networkFirstCalls(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res && res.ok && e.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
