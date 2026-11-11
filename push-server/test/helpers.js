'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { FileStore } = require('../src/store');

const ORIGIN = 'https://iqbalsidek1101-hub.github.io';
const TOKEN = 'dispatch-token-test-value';
const PRIVATE = 'private-key-should-never-leak';
const PUBLIC = 'B'.repeat(87);

function subscriptionKeys() {
  return { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) };
}

function appleSub(id) {
  return { endpoint: 'https://web.push.apple.com/' + id, expirationTime: null, keys: subscriptionKeys() };
}

async function boot(extra) {
  extra = extra || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charlie-push-'));
  const store = new FileStore(path.join(dir, 'state.json'));
  const sent = [];
  const logs = [];
  const fetched = [];
  const sender = Object.assign({
    configured: true,
    publicKey: PUBLIC,
    async send(subscription, payload) {
      sent.push({ endpoint: subscription.endpoint, payload: payload });
    }
  }, extra.sender || {});
  const server = createServer({
    store: store,
    sender: sender,
    log: (msg) => logs.push(msg),
    limits: extra.limits,
    config: Object.assign({
      origins: [ORIGIN],
      dispatchToken: TOKEN,
      privateKey: PRIVATE,
      publicKey: PUBLIC,
      trustProxy: false,
      maxEvents: 30,
      maxSubscriptions: extra.maxSubscriptions || 20,
      callsUrls: ['https://iqbalsidek1101-hub.github.io/gold-calls/calls.json'],
      fetchImpl: async (url) => {
        fetched.push(url);
        if (extra.fetchImpl) return extra.fetchImpl(url);
        throw new Error('unexpected fetch');
      }
    }, extra.config || {})
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server: server,
    store: store,
    sent: sent,
    logs: logs,
    fetched: fetched,
    sender: sender,
    port: server.address().port,
    dir: dir,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function request(ctx, options) {
  const body = options.body == null ? null : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  const headers = Object.assign({}, options.headers || {});
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = body.length;
  } else if (body) {
    headers['Content-Length'] = body.length;
  }
  if (options.origin) headers.Origin = options.origin;
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  if (options.subToken) headers['X-Charlie-Sub-Token'] = options.subToken;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: ctx.port,
      method: options.method || 'POST',
      path: options.path,
      headers: headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
      });
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function call(partial) {
  return Object.assign({
    id: 'B-S002',
    asset: 'BTCUSD',
    type: 'SCALP',
    name: 'BTC · Scalping #2',
    direction: 'BUY',
    status: 'PENDING',
    entry_lo: 76000,
    entry_hi: 76200,
    sl: 75500,
    tp: 77000,
    created_myt: '2026-11-07 10:00:00',
    r_result: null,
    scored_myt: '2026-11-07 18:00:00'
  }, partial || {});
}

function doc(calls, stamp) {
  return { generated_myt: stamp || '2026-11-07 18:00:00', last_updated: stamp || '2026-11-07 18:00:00', calls: calls };
}

module.exports = {
  ORIGIN: ORIGIN,
  TOKEN: TOKEN,
  PRIVATE: PRIVATE,
  PUBLIC: PUBLIC,
  boot: boot,
  request: request,
  call: call,
  doc: doc,
  appleSub: appleSub
};
