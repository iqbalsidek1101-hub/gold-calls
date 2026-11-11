/* Charlie Calls PWA — offline shell, calls.json network-first, Web Push.
   Cache bump drops older shells so push handlers install. */
const CACHE = 'charlie-gold-v9';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './calls.json',
  './push-config.js',
  './push-shared.js',
  './push-client.js',
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

importScripts('push-shared.js');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/calls.json')) {
    event.respondWith(networkFirstCalls(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const net = fetch(event.request).then((res) => {
        if (res && res.ok && event.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener('push', (event) => {
  let raw = {};
  try {
    if (event.data) raw = event.data.json();
  } catch (err) {
    raw = {};
  }
  const parsed = self.CharliePushShared.parsePushPayload(raw);
  event.waitUntil(self.registration.showNotification(parsed.title, {
    body: parsed.body,
    lang: 'ms',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: parsed.tag,
    renotify: false,
    data: parsed.data
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const parsed = self.CharliePushShared.parsePushPayload(event.notification.data || {});
  const absolute = new URL(parsed.url, self.registration.scope).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      let same = false;
      try { same = new URL(client.url).origin === self.location.origin; } catch (err) { same = false; }
      if (!same) continue;
      if (typeof client.navigate === 'function') {
        try { await client.navigate(absolute); } catch (err) { /* focus and message still open the call */ }
      }
      if (typeof client.focus === 'function') await client.focus();
      if (typeof client.postMessage === 'function') {
        client.postMessage({
          type: 'charlie-push-open',
          asset: parsed.data.asset,
          callId: parsed.data.callId,
          callType: parsed.data.type
        });
      }
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(absolute);
  })());
});
