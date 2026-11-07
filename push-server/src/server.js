'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const shared = require('../../push-shared');
const { diffDocument, extractDocument, dedupe, MAX_EVENTS } = require('./events');
const { messageFor } = require('./messages');

const PUSH_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
  'wns.windows.com'
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function endpointAllowed(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (err) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix));
}

function validKeys(keys) {
  if (!keys || typeof keys !== 'object') return false;
  const p256 = String(keys.p256dh || '');
  const auth = String(keys.auth || '');
  const shape = /^[A-Za-z0-9_=-]+$/;
  return shape.test(p256) && p256.length >= 80 && p256.length <= 120 && shape.test(auth) && auth.length >= 16 && auth.length <= 40;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function makeLimiter(limit, windowMs) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

function defaultLimits() {
  return {
    subscribe: { n: 20, windowMs: 10 * 60 * 1000 },
    test: { n: 5, windowMs: 10 * 60 * 1000 },
    dispatch: { n: 30, windowMs: 10 * 60 * 1000 },
    prefs: { n: 60, windowMs: 10 * 60 * 1000 },
    config: { n: 120, windowMs: 60 * 1000 }
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        const err = new Error('too_large');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) {
        const bad = new Error('bad_json');
        bad.statusCode = 400;
        reject(bad);
      }
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function pruneSent(sent) {
  const entries = Object.entries(sent || {});
  if (entries.length <= 1000) return sent || {};
  return Object.fromEntries(entries.slice(-1000));
}

function publicEvent(event) {
  return {
    id: event.id,
    category: event.category,
    asset: event.asset,
    callId: event.callId,
    name: event.name
  };
}

function pushPayload(event) {
  return {
    v: 1,
    eventId: event.id,
    category: event.category,
    title: event.title,
    body: event.body,
    asset: event.asset || '',
    callId: event.callId || '',
    type: event.type || '',
    name: event.name || ''
  };
}

function cadenceFields() {
  return {
    realtime: false,
    scoreMinutes: shared.CADENCE.scoreMinutes,
    scoreWindow: shared.CADENCE.scoreWindow,
    analysisMinutes: shared.CADENCE.analysisMinutes
  };
}

function createServer(options) {
  const store = options.store;
  const sender = options.sender;
  const config = options.config;
  const log = options.log || function () {};
  const limits = Object.assign(defaultLimits(), options.limits || {});
  const allow = {
    subscribe: makeLimiter(limits.subscribe.n, limits.subscribe.windowMs),
    test: makeLimiter(limits.test.n, limits.test.windowMs),
    dispatch: makeLimiter(limits.dispatch.n, limits.dispatch.windowMs),
    prefs: makeLimiter(limits.prefs.n, limits.prefs.windowMs),
    config: makeLimiter(limits.config.n, limits.config.windowMs)
  };
  const origins = new Set(config.origins || []);
  const maxEvents = config.maxEvents || MAX_EVENTS;
  const callsUrls = new Set(config.callsUrls || []);
  const fetchImpl = config.fetchImpl || defaultFetch;
  let gate = Promise.resolve();
  function enqueue(fn) {
    const run = gate.then(fn, fn);
    gate = run.then(() => {}, () => {});
    return run;
  }

  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return { ok: false, origin: '' };
    if (!origins.has(origin)) return { ok: false, origin: origin };
    return { ok: true, origin: origin };
  }

  function writeJson(res, status, body, origin) {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(payload);
  }

  function logSafe(fields) {
    log({
      route: fields.route || '',
      status: fields.status || 0,
      events: fields.events || 0,
      delivered: fields.delivered || 0,
      removed: fields.removed || 0
    });
  }

  async function loadDocument(body) {
    if (body && body.replay === true) {
      const err = new Error('replay_disabled');
      err.statusCode = 400;
      throw err;
    }
    const inline = extractDocument(body);
    if (inline) return inline;
    if (body && typeof body.callsUrl === 'string') {
      if (!callsUrls.has(body.callsUrl)) {
        const err = new Error('calls_url_rejected');
        err.statusCode = 400;
        throw err;
      }
      const text = await fetchImpl(body.callsUrl);
      const parsed = JSON.parse(text);
      const doc = extractDocument(parsed) || parsed;
      if (!doc || typeof doc !== 'object') {
        const err = new Error('bad_calls');
        err.statusCode = 400;
        throw err;
      }
      return doc;
    }
    const err = new Error('bad_calls');
    err.statusCode = 400;
    throw err;
  }

  async function fanout(events) {
    const state = await store.read();
    const subs = Object.values(state.subscriptions || {});
    let delivered = 0;
    const removed = [];
    const failed = new Set();
    if (!subs.length) return { delivered: 0, removed: removed, failed: failed, skipped: events.length };
    for (const event of events) {
      let eventFailed = false;
      let attempted = false;
      for (const sub of subs) {
        if (removed.indexOf(sub.endpoint) >= 0) continue;
        if (!sub.categories || sub.categories[event.category] !== true) continue;
        attempted = true;
        try {
          await sender.send(sub, pushPayload(event));
          delivered += 1;
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) removed.push(sub.endpoint);
          else eventFailed = true;
        }
      }
      if (eventFailed || !attempted && subs.some((sub) => sub.categories && sub.categories[event.category] === true)) {
        failed.add(event.id);
      }
    }
    return { delivered: delivered, removed: removed, failed: failed, skipped: 0 };
  }

  async function acceptDocument(doc, mode) {
    const nowIso = new Date().toISOString();
    let toSend = [];
    let baselinedNow = false;
    await store.update((state) => {
      const result = diffDocument(state.snapshot, doc, nowIso);
      if (mode === 'baseline' || result.baselinedNow) {
        state.snapshot = result.snapshot;
        state.snapshot.pending = [];
        state.snapshot.sent = pruneSent(state.snapshot.sent);
        baselinedNow = true;
        toSend = [];
        return state;
      }
      const sent = state.snapshot.sent || {};
      const pending = dedupe([].concat(state.snapshot.pending || [], result.events)).filter((event) => !sent[event.id]);
      if (pending.length > maxEvents) {
        const err = new Error('too_many_events');
        err.statusCode = 409;
        throw err;
      }
      state.snapshot = result.snapshot;
      state.snapshot.pending = pending;
      state.snapshot.sent = pruneSent(sent);
      toSend = pending;
      return state;
    });
    return { baselinedNow: baselinedNow, toSend: toSend };
  }

  async function finishDelivery(toSend, removed, failed) {
    await store.update((state) => {
      toSend.forEach((event) => {
        if (failed.has(event.id)) return;
        state.snapshot.sent[event.id] = new Date().toISOString();
      });
      state.snapshot.sent = pruneSent(state.snapshot.sent);
      state.snapshot.pending = (state.snapshot.pending || []).filter((event) => failed.has(event.id));
      removed.forEach((endpoint) => { delete state.subscriptions[endpoint]; });
      return state;
    });
  }

  function findSub(state, endpoint, token) {
    const sub = state.subscriptions && state.subscriptions[endpoint];
    if (!sub || !token) return null;
    if (!safeEqual(sub.subTokenHash, sha256(token))) return null;
    return sub;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    if (url.searchParams.has('token') || url.searchParams.has('key') || url.searchParams.has('authorization') || url.searchParams.has('dispatch')) {
      writeJson(res, 400, { ok: false, error: 'token_in_url' });
      logSafe({ route: route, status: 400 });
      return;
    }
    const cors = originOk(req);
    if (req.method === 'OPTIONS') {
      if (!cors.ok) {
        writeJson(res, 403, { ok: false, error: 'origin' });
        return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': cors.origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Charlie-Sub-Token',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin'
      });
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && route === '/v1/health') {
        const body = { ok: true, configured: !!sender.configured, realtime: false };
        writeJson(res, 200, body, cors.ok ? cors.origin : '');
        logSafe({ route: route, status: 200 });
        return;
      }
      if (req.method === 'GET' && route === '/v1/config') {
        if (!cors.ok) {
          writeJson(res, 403, { ok: false, error: 'origin' });
          logSafe({ route: route, status: 403 });
          return;
        }
        if (!allow.config(clientIp(req, config.trustProxy))) {
          writeJson(res, 429, { ok: false, error: 'rate_limit' }, cors.origin);
          return;
        }
        writeJson(res, 200, {
          ok: true,
          configured: !!sender.configured,
          publicKey: sender.configured ? sender.publicKey : null,
          categories: shared.CATEGORIES,
          realtime: false,
          scoreMinutes: shared.CADENCE.scoreMinutes,
          scoreWindow: shared.CADENCE.scoreWindow,
          analysisMinutes: shared.CADENCE.analysisMinutes
        }, cors.origin);
        logSafe({ route: route, status: 200 });
        return;
      }

      const browserRoute = route === '/v1/subscriptions' || route === '/v1/preferences' || route === '/v1/unsubscribe' || route === '/v1/test';
      if (browserRoute) {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method' }, cors.ok ? cors.origin : '');
          return;
        }
        if (!cors.ok) {
          writeJson(res, 403, { ok: false, error: 'origin' });
          logSafe({ route: route, status: 403 });
          return;
        }
      }

      if (req.method === 'POST' && route === '/v1/subscriptions') {
        const ip = clientIp(req, config.trustProxy);
        if (!allow.subscribe(ip)) {
          writeJson(res, 429, { ok: false, error: 'rate_limit' }, cors.origin);
          return;
        }
        const body = await readBody(req, 20000);
        const sub = body.subscription || {};
        if (!endpointAllowed(sub.endpoint) || !validKeys(sub.keys)) {
          writeJson(res, 400, { ok: false, error: 'bad_subscription' }, cors.origin);
          logSafe({ route: route, status: 400 });
          return;
        }
        const token = crypto.randomBytes(32).toString('hex');
        const categories = shared.normalizePrefs(body.categories);
        let limited = false;
        await store.update((state) => {
          const existing = state.subscriptions[sub.endpoint];
          const count = Object.keys(state.subscriptions).length;
          if (!existing && count >= (config.maxSubscriptions || 20)) {
            limited = true;
            return state;
          }
          state.subscriptions[sub.endpoint] = {
            endpoint: sub.endpoint,
            expirationTime: sub.expirationTime || null,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            categories: categories,
            subTokenHash: sha256(token),
            createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          return state;
        });
        if (limited) {
          writeJson(res, 429, { ok: false, error: 'subscription_limit' }, cors.origin);
          return;
        }
        writeJson(res, 200, { ok: true, subToken: token, categories: categories }, cors.origin);
        logSafe({ route: route, status: 200 });
        return;
      }

      if (req.method === 'POST' && (route === '/v1/preferences' || route === '/v1/unsubscribe' || route === '/v1/test')) {
        const ip = clientIp(req, config.trustProxy);
        const bucket = route === '/v1/test' ? 'test' : 'prefs';
        const body = await readBody(req, 20000);
        const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : '';
        const token = String(req.headers['x-charlie-sub-token'] || '');
        if (!allow[bucket](sha256(endpoint || ip).slice(0, 16))) {
          writeJson(res, 429, { ok: false, error: 'rate_limit' }, cors.origin);
          return;
        }
        const state = await store.read();
        const sub = findSub(state, endpoint, token);
        if (!sub) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' }, cors.origin);
          logSafe({ route: route, status: 401 });
          return;
        }
        if (route === '/v1/unsubscribe') {
          await store.update((current) => {
            delete current.subscriptions[endpoint];
            return current;
          });
          writeJson(res, 200, { ok: true }, cors.origin);
          logSafe({ route: route, status: 200 });
          return;
        }
        if (route === '/v1/preferences') {
          const categories = shared.normalizePrefs(body.categories);
          await store.update((current) => {
            if (current.subscriptions[endpoint]) current.subscriptions[endpoint].categories = categories;
            return current;
          });
          writeJson(res, 200, { ok: true, categories: categories }, cors.origin);
          logSafe({ route: route, status: 200 });
          return;
        }
        if (!sender.configured) {
          writeJson(res, 503, { ok: false, error: 'push_not_configured', realtime: false }, cors.origin);
          logSafe({ route: route, status: 503 });
          return;
        }
        const testEvent = {
          id: 'test:' + sha256(endpoint).slice(0, 12) + ':' + Date.now(),
          category: 'test',
          asset: '',
          callId: '',
          type: '',
          name: 'Charlie Calls',
          title: messageFor('test').title,
          body: messageFor('test').body
        };
        try {
          await sender.send(sub, pushPayload(testEvent));
        } catch (err) {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            await store.update((current) => {
              delete current.subscriptions[endpoint];
              return current;
            });
          }
          writeJson(res, 502, { ok: false, error: 'push_failed' }, cors.origin);
          logSafe({ route: route, status: 502 });
          return;
        }
        writeJson(res, 200, { ok: true, realtime: false }, cors.origin);
        logSafe({ route: route, status: 200, delivered: 1 });
        return;
      }

      if (route === '/v1/dispatch' || route === '/v1/baseline') {
        await enqueue(() => dispatchAuthorized(req, res, route, cors));
        return;
      }

      writeJson(res, 404, { ok: false, error: 'not_found' }, cors.ok ? cors.origin : '');
      logSafe({ route: route, status: 404 });
    } catch (err) {
      const status = err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      const code = status === 413 ? 'too_large' : status === 400 ? (err.message || 'bad_request') : 'error';
      writeJson(res, status, { ok: false, error: code }, cors.ok ? cors.origin : '');
      logSafe({ route: route, status: status });
    }
  }

  async function dispatchAuthorized(req, res, route, cors) {
    try {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method' });
          return;
        }
        if (req.headers.origin && !cors.ok) {
          writeJson(res, 403, { ok: false, error: 'origin' });
          logSafe({ route: route, status: 403 });
          return;
        }
        const header = String(req.headers.authorization || '');
        const match = header.match(/^Bearer\s+(.+)$/);
        const presented = match ? match[1].trim() : '';
        if (!config.dispatchToken) {
          writeJson(res, 503, { ok: false, error: 'push_not_configured' });
          logSafe({ route: route, status: 503 });
          return;
        }
        if (!presented || !safeEqual(presented, config.dispatchToken)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' });
          logSafe({ route: route, status: 401 });
          return;
        }
        if (!allow.dispatch(clientIp(req, config.trustProxy))) {
          writeJson(res, 429, { ok: false, error: 'rate_limit' });
          return;
        }
        const body = await readBody(req, 1500000);
        const doc = await loadDocument(body);
        let accepted;
        try {
          accepted = await acceptDocument(doc, route === '/v1/baseline' ? 'baseline' : 'dispatch');
        } catch (err) {
          if (err && err.statusCode === 409) {
            writeJson(res, 409, { ok: false, error: 'too_many_events', realtime: false });
            logSafe({ route: route, status: 409 });
            return;
          }
          throw err;
        }
        if (accepted.baselinedNow || route === '/v1/baseline') {
          const snap = await store.read();
          writeJson(res, 200, Object.assign({
            ok: true,
            baselined: true,
            events: [],
            delivered: 0,
            removed: 0,
            pending: 0,
            stamp: snap.snapshot.stamp || null,
            note: 'Sejarah direkod tanpa hantar. Langganan baru tak akan terima call lama.'
          }, cadenceFields()));
          logSafe({ route: route, status: 200 });
          return;
        }
        if (accepted.toSend.length && !sender.configured) {
          writeJson(res, 503, Object.assign({
            ok: false,
            error: 'push_not_configured',
            pending: accepted.toSend.length,
            events: accepted.toSend.map(publicEvent)
          }, cadenceFields()));
          logSafe({ route: route, status: 503, events: accepted.toSend.length });
          return;
        }
        const result = await fanout(accepted.toSend);
        await finishDelivery(accepted.toSend, result.removed, result.failed);
        const pendingLeft = result.failed.size;
        writeJson(res, 200, Object.assign({
          ok: true,
          baselined: false,
          events: accepted.toSend.map(publicEvent),
          delivered: result.delivered,
          removed: result.removed.length,
          pending: pendingLeft,
          stamp: doc.generated_myt || doc.last_updated || null
        }, cadenceFields()));
        logSafe({ route: route, status: 200, events: accepted.toSend.length, delivered: result.delivered, removed: result.removed.length });
    } catch (err) {
      const status = err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      const code = status === 413 ? 'too_large' : status === 400 ? (err.message || 'bad_request') : 'error';
      writeJson(res, status, { ok: false, error: code }, cors.ok ? cors.origin : '');
      logSafe({ route: route, status: status });
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) writeJson(res, 500, { ok: false, error: 'error' });
    });
  });
}

function defaultFetch(target) {
  const lib = target.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method: 'GET', timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(Object.assign(new Error('redirect_rejected'), { statusCode: 400 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(Object.assign(new Error('fetch_failed'), { statusCode: 502 }));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1500000) {
          req.destroy();
          reject(Object.assign(new Error('too_large'), { statusCode: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('timeout'), { statusCode: 504 }));
    });
    req.end();
  });
}

module.exports = {
  createServer,
  endpointAllowed,
  sha256,
  safeEqual,
  defaultLimits
};
