'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');

function loadWorker() {
  const listeners = {};
  const notifications = [];
  const opened = [];
  const navigated = [];
  const messages = [];
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const box = stores.get(name);
      return {
        async addAll(urls) { urls.forEach((url) => box.set(url, { url: url })); },
        async put(req, res) { box.set(typeof req === 'string' ? req : req.url, res); },
        async match(req) { return box.get(typeof req === 'string' ? req : req.url); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match() { return undefined; }
  };
  const clients = [];
  const worker = {
    location: { origin: 'https://iqbalsidek1101-hub.github.io' },
    registration: {
      scope: 'https://iqbalsidek1101-hub.github.io/gold-calls/',
      showNotification(title, options) {
        notifications.push({ title: title, options: options });
        return Promise.resolve();
      }
    },
    clients: {
      claim() { return Promise.resolve(); },
      async matchAll() { return clients; },
      async openWindow(url) { opened.push(url); return { url: url }; }
    },
    skipWaiting() { worker.skipped = true; },
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  const sandbox = {
    self: worker,
    caches: caches,
    URL: URL,
    URLSearchParams: URLSearchParams,
    Request: Request,
    Response: Response,
    Promise: Promise,
    console: console,
    fetch() { return Promise.reject(new Error('offline')); },
    importScripts(href) {
      vm.runInContext(fs.readFileSync(path.join(root, href), 'utf8'), sandbox);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), sandbox);
  return { listeners, notifications, opened, navigated, messages, stores, worker, clients };
}

async function fire(listener, event) {
  const waits = [];
  event.waitUntil = (job) => { waits.push(job); };
  listener(event);
  await Promise.all(waits);
}

test('service worker cache updates from v8 and keeps push files', async () => {
  const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(source, /const CACHE = 'charlie-gold-v9'/);
  assert.equal(source.includes('charlie-gold-v8'), false);
  assert.match(source, /addEventListener\('push'/);
  assert.match(source, /addEventListener\('notificationclick'/);
  const sw = loadWorker();
  sw.stores.set('charlie-gold-v8', new Map([['old', true]]));
  await fire(sw.listeners.install, {});
  await fire(sw.listeners.activate, {});
  assert.equal(sw.worker.skipped, true);
  assert.equal(sw.stores.has('charlie-gold-v8'), false);
  assert.equal(sw.stores.has('charlie-gold-v9'), true);
  const cached = [...sw.stores.get('charlie-gold-v9').keys()];
  assert.ok(cached.includes('./push-client.js'));
  assert.ok(cached.includes('./push-shared.js'));
  assert.ok(cached.includes('./sw.js') === false);
  let foreign = false;
  await fire(sw.listeners.fetch, {
    request: { url: 'https://biquote.io/api/XAUUSD', method: 'GET' },
    respondWith() { foreign = true; }
  });
  assert.equal(foreign, false);
});

test('push payload is safe and click opens the asset call', async () => {
  const sw = loadWorker();
  await fire(sw.listeners.push, {
    data: {
      json() { throw new Error('bad'); },
      text() { return '<script>alert(1)</script>'; }
    }
  });
  assert.equal(sw.notifications[0].title, 'Charlie Calls');
  assert.match(sw.notifications[0].options.body, /tak lengkap/);
  assert.equal(sw.notifications[0].options.body.includes('<script>'), false);

  const payload = {
    title: 'SL dalam calls.json',
    body: 'BTC · Scalping #2 · status SL.',
    category: 'sl',
    asset: 'BTCUSD',
    callId: 'B-S002',
    type: 'SCALP',
    eventId: 'sl:BTCUSD:B-S002:2026-11-07_10:00:00',
    url: 'https://evil.example/phish'
  };
  await fire(sw.listeners.push, { data: { json() { return payload; } } });
  await fire(sw.listeners.push, { data: { json() { return payload; } } });
  assert.equal(sw.notifications.length, 3);
  assert.equal(sw.notifications[1].options.tag, payload.eventId);
  assert.equal(sw.notifications[2].options.tag, payload.eventId);
  assert.equal(sw.notifications[1].options.data.url.includes('evil'), false);
  assert.match(sw.notifications[1].options.data.url, /asset=BTCUSD/);
  assert.match(sw.notifications[1].options.data.url, /call=B-S002/);

  await fire(sw.listeners.notificationclick, {
    notification: {
      data: sw.notifications[1].options.data,
      close() {}
    }
  });
  assert.equal(sw.opened.length, 1);
  assert.match(sw.opened[0], /^https:\/\/iqbalsidek1101-hub\.github\.io\/gold-calls\/index\.html\?/);
  assert.match(sw.opened[0], /asset=BTCUSD/);
  assert.match(sw.opened[0], /call=B-S002/);
  assert.match(sw.opened[0], /#\/SCALP\/B-S002/);
  assert.equal(sw.opened[0].includes('evil'), false);

  const client = {
    url: 'https://iqbalsidek1101-hub.github.io/gold-calls/index.html',
    async navigate(url) { sw.navigated.push(url); },
    async focus() { client.focused = true; },
    postMessage(msg) { sw.messages.push(msg); }
  };
  sw.clients.push(client);
  sw.opened.length = 0;
  await fire(sw.listeners.notificationclick, {
    notification: { data: sw.notifications[1].options.data, close() {} }
  });
  assert.equal(sw.opened.length, 0);
  assert.equal(client.focused, true);
  assert.match(sw.navigated[0], /call=B-S002/);
  assert.equal(sw.messages[0].type, 'charlie-push-open');
  assert.equal(sw.messages[0].asset, 'BTCUSD');
  assert.equal(sw.messages[0].callId, 'B-S002');
});
