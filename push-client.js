/* Opt-in Web Push for the installed PWA. Permission only from the button.
   Does not read the webhook secret and does not show a local stand-in notification. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CharliePush = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LS_PREFS = 'charlie-gold-push-prefs';
  const LS_API = 'charlie-gold-push-api';
  const LS_TOKEN = 'charlie-gold-push-sub-token';
  const IOS_GUIDE = 'iPhone (iOS 16.4+): buka dalam Safari → Kongsi → Tambah ke Skrin Utama. Lepas tu buka Charlie Calls dari ikon, bukan dari tab Safari. Push latar iPhone hanya hidup untuk app skrin utama. Tekan Benarkan notifikasi dan pilih Allow.';
  const OTHER_GUIDE = 'Android dan desktop: Chrome, Edge atau Firefox boleh tekan Benarkan notifikasi terus. iPhone mesti dipasang ke Skrin Utama dulu.';

  function shared() {
    if (typeof CharliePushShared !== 'undefined') return CharliePushShared;
    return require('./push-shared.js');
  }

  function describeSupport(env) {
    const e = Object.assign({
      secure: true,
      ios: false,
      standalone: false,
      push: true,
      notification: true,
      permission: 'default',
      onLine: true,
      apiBase: '',
      subscribed: false,
      serverConfigured: true
    }, env || {});
    const guide = e.ios ? IOS_GUIDE : OTHER_GUIDE;
    if (e.ios && !e.standalone) {
      return { code: 'ios-install', guide: guide, text: 'iPhone: push latar hanya untuk app Skrin Utama (iOS 16.4+). Tambah ke Skrin Utama, kemudian buka dari ikon. Tab Safari tak boleh pasang push ni.' };
    }
    if (!e.push || !e.notification) {
      return { code: 'unsupported', guide: guide, text: 'Pelayar ni tak sokong Web Push. Cuba Chrome, Edge atau Firefox. iPhone: Safari, Tambah ke Skrin Utama, iOS 16.4+.' };
    }
    if (!e.secure) {
      return { code: 'insecure', guide: guide, text: 'Push perlukan HTTPS. Halaman ni tak cipta notifikasi palsu.' };
    }
    if (e.permission === 'denied') {
      return { code: 'denied', guide: guide, text: 'Kebenaran ditolak. iPhone: Tetapan → Notifikasi → Charlie Calls → Benarkan. Android atau desktop: tetapan tapak dalam pelayar.' };
    }
    if (!e.apiBase) {
      return { code: 'no-server', guide: guide, text: 'Server push belum diset. Notifikasi latar belakang belum hidup. Ni bukan amaran dalam halaman.' };
    }
    if (e.subscribed && !e.onLine) {
      return { code: 'on-offline', guide: guide, text: 'Dah dilanggan pada telefon ni. Tiada internet sekarang, jadi ujian dan pilihan tak boleh dihantar. Halaman ni tetap tak cipta notifikasi sendiri.' };
    }
    if (!e.onLine) {
      return { code: 'offline', guide: guide, text: 'Tiada internet. Langganan push tak boleh dibuat sekarang. Tiada notifikasi palsu.' };
    }
    if (e.serverConfigured === false) {
      return { code: 'server-off', guide: guide, text: 'Server push belum sedia (kunci belum dipasang di server). Tiada notifikasi dihantar.' };
    }
    if (e.subscribed) {
      return { code: 'on', guide: guide, text: 'Dah dilanggan. Server hantar push bila calls.json berubah, walaupun app ditutup. Bukan semata-mata sebab tab terbuka.' };
    }
    return { code: 'ready', guide: guide, text: 'Sedia. Tekan Benarkan notifikasi untuk minta kebenaran. Tanpa butang tu, tiada langganan.' };
  }

  function resolveApiBase(config, storage) {
    const fromStore = storage ? String(storage.getItem(LS_API) || '').trim() : '';
    const raw = fromStore || (config && config.apiBase ? String(config.apiBase).trim() : '');
    if (!raw) return '';
    let url;
    try { url = new URL(raw); } catch (e) { return ''; }
    if (url.username || url.password) return '';
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.origin;
    return '';
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  function publicSubscription(subscription) {
    const json = subscription && typeof subscription.toJSON === 'function' ? subscription.toJSON() : (subscription || {});
    const keys = json.keys || {};
    return {
      endpoint: json.endpoint,
      expirationTime: json.expirationTime || null,
      keys: { p256dh: keys.p256dh, auth: keys.auth }
    };
  }

  function subscriptionBody(subscription, prefs) {
    return {
      subscription: publicSubscription(subscription),
      categories: shared().normalizePrefs(prefs)
    };
  }

  function isIos(nav) {
    const ua = String((nav && nav.userAgent) || '');
    const platform = String((nav && nav.platform) || '');
    const touch = nav && nav.maxTouchPoints ? nav.maxTouchPoints : 0;
    return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touch > 1);
  }

  function isStandalone(nav, matchMedia) {
    if (nav && nav.standalone === true) return true;
    if (typeof matchMedia !== 'function') return false;
    return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
  }

  function readEnv(nav, notification, config, storage, extra) {
    const apiBase = resolveApiBase(config, storage);
    return Object.assign({
      secure: !!(nav && nav.secureContext !== false && (apiBase ? true : (typeof location === 'undefined' || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'))),
      ios: isIos(nav),
      standalone: isStandalone(nav, extra && extra.matchMedia),
      push: !!(nav && nav.serviceWorker && extra && extra.pushManager),
      notification: !!notification,
      permission: notification ? notification.permission : 'default',
      onLine: nav ? nav.onLine !== false : true,
      apiBase: apiBase,
      subscribed: !!(extra && extra.subscribed),
      serverConfigured: extra && extra.serverConfigured === false ? false : true
    }, extra || {});
  }

  function mount(doc, deps) {
    deps = deps || {};
    const $ = (id) => doc.getElementById(id);
    const nav = deps.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const NotificationAPI = deps.Notification || (typeof Notification !== 'undefined' ? Notification : null);
    const fetchFn = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    const storage = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const config = deps.config || (typeof CHARLIE_PUSH_CONFIG !== 'undefined' ? CHARLIE_PUSH_CONFIG : {});
    const matchMedia = deps.matchMedia || (typeof window !== 'undefined' ? window.matchMedia.bind(window) : null);
    const statusEl = $('pushStatus');
    const guideEl = $('pushGuide');
    const apiInput = $('pushApi');
    const enableBtn = $('pushEnable');
    const testBtn = $('pushTest');
    const stopBtn = $('pushStop');
    if (!statusEl || !enableBtn) return { refresh: function () {} };

    const state = { subscribed: false, serverConfigured: true, subscription: null };

    function boxes() {
      const prefs = shared().defaultPrefs();
      shared().CATEGORIES.forEach((key) => {
        const box = $('pref-' + key);
        if (box) prefs[key] = !!box.checked;
      });
      return prefs;
    }

    function applyStoredPrefs() {
      if (!storage) return;
      let saved = null;
      try { saved = JSON.parse(storage.getItem(LS_PREFS) || 'null'); } catch (e) { saved = null; }
      if (!saved) return;
      const prefs = shared().normalizePrefs(saved);
      shared().CATEGORIES.forEach((key) => {
        const box = $('pref-' + key);
        if (box) box.checked = prefs[key];
      });
    }

    function savePrefs() {
      if (storage) storage.setItem(LS_PREFS, JSON.stringify(boxes()));
    }

    function paint(extra) {
      const env = readEnv(nav, NotificationAPI, config, storage, {
        matchMedia: matchMedia,
        pushManager: !!(nav && nav.serviceWorker && (deps.pushManager || (extra && extra.pushManager) || true)),
        subscribed: state.subscribed,
        serverConfigured: state.serverConfigured
      });
      if (deps.pushManager === false) env.push = false;
      if (nav && nav.serviceWorker && deps.pushManager == null) {
        env.push = typeof PushManager !== 'undefined' || !!deps.assumePush;
      }
      const view = describeSupport(env);
      statusEl.textContent = view.text;
      if (guideEl) guideEl.textContent = view.guide;
      enableBtn.disabled = view.code === 'unsupported' || view.code === 'ios-install' || view.code === 'insecure' || view.code === 'denied' || view.code === 'offline' || view.code === 'no-server';
      enableBtn.textContent = state.subscribed ? 'Kemaskini langganan' : 'Benarkan notifikasi';
      if (testBtn) testBtn.disabled = view.code !== 'on';
      if (stopBtn) stopBtn.disabled = !state.subscribed && view.code !== 'on' && view.code !== 'on-offline';
      return view;
    }

    async function currentSub() {
      if (!nav || !nav.serviceWorker) return null;
      const reg = await nav.serviceWorker.ready;
      if (!reg.pushManager) return null;
      return reg.pushManager.getSubscription();
    }

    async function refresh() {
      try { state.subscription = await currentSub(); } catch (e) { state.subscription = null; }
      state.subscribed = !!state.subscription;
      const base = resolveApiBase(config, storage);
      if (base && fetchFn && nav && nav.onLine !== false) {
        try {
          const res = await fetchFn(base + '/v1/config', { cache: 'no-store' });
          const body = await res.json();
          state.serverConfigured = !(body && body.configured === false);
        } catch (e) { /* keep last known */ }
      }
      paint();
    }

    async function postJson(path, payload, token) {
      const base = resolveApiBase(config, storage);
      if (!base) throw new Error('no-server');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Charlie-Sub-Token'] = token;
      const res = await fetchFn(base + path, {
        method: 'POST',
        cache: 'no-store',
        headers: headers,
        body: JSON.stringify(payload)
      });
      let body = {};
      try { body = await res.json(); } catch (e) { body = {}; }
      if (!res.ok) {
        const err = new Error(body.error || ('http-' + res.status));
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    }

    async function onEnable() {
      const view = paint();
      if (enableBtn.disabled) return view;
      if (!NotificationAPI) return paint();
      let perm = NotificationAPI.permission;
      if (perm !== 'granted') perm = await NotificationAPI.requestPermission();
      if (perm !== 'granted') {
        statusEl.textContent = describeSupport({ permission: 'denied', apiBase: resolveApiBase(config, storage), push: true, notification: true }).text;
        return;
      }
      try {
        const base = resolveApiBase(config, storage);
        const cfgRes = await fetchFn(base + '/v1/config', { cache: 'no-store' });
        const cfg = await cfgRes.json();
        if (!cfgRes.ok || !cfg.publicKey) {
          state.serverConfigured = false;
          paint();
          return;
        }
        state.serverConfigured = cfg.configured !== false;
        const reg = await nav.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub = existing || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.publicKey)
        });
        savePrefs();
        const saved = await postJson('/v1/subscriptions', subscriptionBody(sub, boxes()));
        if (saved.subToken && storage) storage.setItem(LS_TOKEN, saved.subToken);
        state.subscription = sub;
        state.subscribed = true;
        paint();
      } catch (e) {
        statusEl.textContent = 'Tak dapat daftar push (' + (e && e.message ? e.message : 'ralat') + '). Tiada notifikasi palsu dibuat.';
      }
    }

    async function onTest() {
      if (!state.subscribed) {
        statusEl.textContent = 'Ujian perlukan langganan push sebenar. Halaman ni tak papar amaran tempatan.';
        return;
      }
      const token = storage ? storage.getItem(LS_TOKEN) : '';
      try {
        const sub = state.subscription || await currentSub();
        await postJson('/v1/test', { endpoint: sub && sub.endpoint }, token);
        statusEl.textContent = 'Ujian dihantar ke push server. Kalau tak sampai, server atau kebenaran telefon belum hidup. Ni bukan amaran dalam halaman.';
      } catch (e) {
        statusEl.textContent = 'Ujian tak dihantar (' + (e && e.message ? e.message : 'ralat') + '). Tiada notifikasi tempatan.';
      }
    }

    async function onStop() {
      const token = storage ? storage.getItem(LS_TOKEN) : '';
      const sub = state.subscription || await currentSub().catch(() => null);
      if (sub && token) {
        try { await postJson('/v1/unsubscribe', { endpoint: sub.endpoint }, token); } catch (e) { /* still drop local */ }
      }
      if (sub && sub.unsubscribe) {
        try { await sub.unsubscribe(); } catch (e) { /* already gone */ }
      }
      if (storage) storage.removeItem(LS_TOKEN);
      state.subscription = null;
      state.subscribed = false;
      statusEl.textContent = 'Langganan dibuang dari telefon ni. Server buang rekod bila permintaan sampai. Tiada notifikasi palsu.';
      paint();
    }

    async function onPrefChange() {
      savePrefs();
      if (!state.subscribed) return;
      const token = storage ? storage.getItem(LS_TOKEN) : '';
      const sub = state.subscription || await currentSub().catch(() => null);
      if (!sub || !token) return;
      try {
        await postJson('/v1/preferences', { endpoint: sub.endpoint, categories: boxes() }, token);
        statusEl.textContent = 'Pilihan kategori disimpan di telefon dan server.';
      } catch (e) {
        statusEl.textContent = 'Pilihan disimpan di telefon. Server tak dikemaskini (' + (e && e.message ? e.message : 'ralat') + ').';
      }
    }

    let lastAction = Promise.resolve();
    function track(work) {
      lastAction = Promise.resolve(work).then(() => {}, () => {});
      return lastAction;
    }
    applyStoredPrefs();
    if (apiInput) {
      const stored = storage ? String(storage.getItem(LS_API) || '') : '';
      apiInput.value = stored || (config && config.apiBase) || '';
      apiInput.addEventListener('change', () => {
        if (!storage) return;
        const value = apiInput.value.trim();
        if (!value) storage.removeItem(LS_API);
        else storage.setItem(LS_API, value);
        paint();
      });
    }
    enableBtn.addEventListener('click', () => { track(onEnable()); });
    if (testBtn) testBtn.addEventListener('click', () => { track(onTest()); });
    if (stopBtn) stopBtn.addEventListener('click', () => { track(onStop()); });
    shared().CATEGORIES.forEach((key) => {
      const box = $('pref-' + key);
      if (box) box.addEventListener('change', () => { onPrefChange(); });
    });
    paint();
    const ready = refresh();
    return {
      refresh: refresh,
      paint: paint,
      ready: ready,
      settled: function () { return lastAction; }
    };
  }

  return {
    LS_PREFS: LS_PREFS,
    LS_API: LS_API,
    LS_TOKEN: LS_TOKEN,
    IOS_GUIDE: IOS_GUIDE,
    describeSupport: describeSupport,
    resolveApiBase: resolveApiBase,
    urlBase64ToUint8Array: urlBase64ToUint8Array,
    publicSubscription: publicSubscription,
    subscriptionBody: subscriptionBody,
    isIos: isIos,
    mount: mount,
    readEnv: readEnv
  };
});
