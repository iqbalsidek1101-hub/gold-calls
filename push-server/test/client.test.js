'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const client = require('../../push-client');

test('support states stay honest and do not pretend an in-page alert is push', () => {
  const ready = client.describeSupport({
    secure: true, ios: false, standalone: true, push: true, notification: true,
    permission: 'default', onLine: true, apiBase: 'https://push.example', subscribed: false
  });
  assert.equal(ready.code, 'ready');
  assert.match(ready.text, /Benarkan notifikasi/);
  const offline = client.describeSupport({ onLine: false, apiBase: 'https://push.example', push: true, notification: true });
  assert.equal(offline.code, 'offline');
  assert.match(offline.text, /Tiada notifikasi palsu|tak boleh/);
  const ios = client.describeSupport({ ios: true, standalone: false, push: false, notification: false });
  assert.equal(ios.code, 'ios-install');
  assert.match(ios.text, /Skrin Utama/);
  assert.match(client.IOS_GUIDE, /iOS 16\.4/);
  assert.match(client.IOS_GUIDE, /Tambah ke Skrin Utama/);
  const denied = client.describeSupport({ permission: 'denied', push: true, notification: true, apiBase: 'https://push.example', secure: true });
  assert.equal(denied.code, 'denied');
  assert.match(denied.text, /Tetapan/);
  const missing = client.describeSupport({ push: true, notification: true, secure: true, apiBase: '', onLine: true });
  assert.equal(missing.code, 'no-server');
  assert.match(missing.text, /bukan amaran dalam halaman/);
  const on = client.describeSupport({ push: true, notification: true, secure: true, apiBase: 'https://push.example', subscribed: true, permission: 'granted' });
  assert.equal(on.code, 'on');
  assert.match(on.text, /app ditutup/);
});

test('api base and subscription body never carry secrets', () => {
  const storage = { getItem() { return 'https://user:pass@push.example/secret'; } };
  assert.equal(client.resolveApiBase({ apiBase: 'https://fallback.example' }, storage), '');
  const local = { getItem(key) { return key === client.LS_API ? 'http://127.0.0.1:8787/ignored' : ''; } };
  assert.equal(client.resolveApiBase({ apiBase: '' }, local), 'http://127.0.0.1:8787');
  const empty = { getItem() { return ''; } };
  assert.equal(client.resolveApiBase({ apiBase: 'http://evil.example' }, empty), '');
  const prefs = client.subscriptionBody({
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: 'aa', auth: 'bb' },
    toJSON() { return { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'aa', auth: 'bb' }, extra: 'no' }; }
  }, { sl: false });
  assert.equal(prefs.categories.new_call, true);
  assert.equal(prefs.categories.entry, true);
  assert.equal(prefs.categories.tp, true);
  assert.equal(prefs.categories.sl, false);
  assert.equal(prefs.subscription.extra, undefined);
  assert.equal(JSON.stringify(prefs).includes('webhook'), false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'push-client.js'), 'utf8');
  assert.equal(source.includes('new Notification'), false);
  assert.equal(source.includes('charlie-gold-webhook-settings'), false);
  assert.equal(client.isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }), true);
});

function element(checked) {
  const listeners = {};
  return {
    checked: checked !== false,
    disabled: false,
    textContent: '',
    value: '',
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { if (listeners.click) return listeners.click(); }
  };
}

function mountWith(options) {
  const els = {
    pushStatus: element(),
    pushGuide: element(),
    pushApi: element(),
    pushEnable: element(),
    pushTest: element(),
    pushStop: element(),
    'pref-new_call': element(true),
    'pref-entry': element(true),
    'pref-tp': element(true),
    'pref-sl': element(options && options.sl === false ? false : true)
  };
  const store = new Map();
  const storage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  };
  const calls = { permission: 0, subscribe: 0, test: 0 };
  const bodies = [];
  const nav = {
    userAgent: options && options.ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)' : 'Mozilla/5.0 Chrome',
    platform: options && options.ios ? 'iPhone' : 'Linux',
    maxTouchPoints: options && options.ios ? 5 : 0,
    standalone: !!(options && options.standalone),
    onLine: true,
    secureContext: true,
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          async getSubscription() { return calls.subscribe ? { endpoint: 'https://web.push.apple.com/abc', unsubscribe() { calls.unsubscribed = true; } } : null; },
          async subscribe(opts) {
            calls.subscribe += 1;
            calls.options = opts;
            return { endpoint: 'https://web.push.apple.com/abc', toJSON() { return { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } }; } };
          }
        }
      }),
      addEventListener() {}
    }
  };
  const NotificationAPI = {
    permission: 'default',
    requestPermission() { calls.permission += 1; this.permission = 'granted'; return Promise.resolve('granted'); }
  };
  const ui = client.mount({
    getElementById(id) { return els[id] || null; }
  }, {
    navigator: nav,
    Notification: options && options.ios ? NotificationAPI : NotificationAPI,
    storage: storage,
    config: { apiBase: 'https://push.example' },
    matchMedia() { return { matches: !!(options && options.standalone) }; },
    pushManager: options && options.ios ? false : { ok: true },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/config') {
        return { ok: true, json: async () => ({ ok: true, configured: true, publicKey: 'A'.repeat(80) }) };
      }
      const body = init && init.body ? JSON.parse(init.body) : null;
      bodies.push({ path: path, body: body, headers: init && init.headers });
      if (path === '/v1/test') calls.test += 1;
      return { ok: true, json: async () => ({ ok: true, subToken: 'device-token', categories: body && body.categories }) };
    }
  });
  return { ui: ui, els: els, calls: calls, bodies: bodies, storage: storage };
}

test('permission is a click, defaults are all four, and iOS install blocks the prompt', async () => {
  const desktop = mountWith();
  await desktop.ui.ready;
  assert.equal(desktop.els.pushEnable.disabled, false);
  assert.equal(desktop.els['pref-new_call'].checked, true);
  assert.equal(desktop.els['pref-entry'].checked, true);
  assert.equal(desktop.els['pref-tp'].checked, true);
  assert.equal(desktop.els['pref-sl'].checked, true);
  desktop.els.pushTest.click();
  await desktop.ui.settled();
  assert.match(desktop.els.pushStatus.textContent, /bukan amaran|tempatan|sebenar/);
  assert.equal(desktop.calls.test, 0);
  desktop.els['pref-sl'].checked = false;
  desktop.els.pushEnable.click();
  await desktop.ui.settled();
  assert.equal(desktop.calls.permission, 1);
  assert.equal(desktop.calls.options.userVisibleOnly, true);
  const posted = desktop.bodies.find((item) => item.path === '/v1/subscriptions');
  assert.equal(posted.body.categories.sl, false);
  assert.equal(posted.body.categories.new_call, true);
  assert.equal(posted.body.categories.entry, true);
  assert.equal(posted.body.categories.tp, true);
  assert.equal(posted.headers['X-Charlie-Sub-Token'], undefined);
  assert.equal(JSON.stringify(posted.body).includes('webhook'), false);
  assert.equal(desktop.storage.getItem(client.LS_TOKEN), 'device-token');

  const phone = mountWith({ ios: true, standalone: false });
  await phone.ui.ready;
  assert.equal(phone.els.pushEnable.disabled, true);
  assert.match(phone.els.pushStatus.textContent, /Skrin Utama/);
  phone.els.pushEnable.click();
  await phone.ui.settled();
  assert.equal(phone.calls.permission, 0);
  assert.equal(phone.calls.subscribe, 0);
});
