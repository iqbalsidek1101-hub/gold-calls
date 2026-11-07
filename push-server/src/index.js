'use strict';

const path = require('path');
const { FileStore } = require('./store');
const { createServer } = require('./server');
const { createWebPushSender, safeBootLog } = require('./vapid');

function loadConfig(env) {
  const origins = String(env.ALLOWED_ORIGINS || 'https://iqbalsidek1101-hub.github.io')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (env.ALLOW_LOCAL_ORIGINS === '1') {
    ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://127.0.0.1:8787', 'http://localhost:8787'].forEach((origin) => {
      if (origins.indexOf(origin) < 0) origins.push(origin);
    });
  }
  const callsUrls = String(env.CALLS_URLS || 'https://iqbalsidek1101-hub.github.io/gold-calls/calls.json')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || '',
    dispatchToken: env.DISPATCH_TOKEN || '',
    origins: origins,
    callsUrls: callsUrls,
    trustProxy: env.TRUST_PROXY === '1',
    maxEvents: Number(env.MAX_EVENTS || 30)
  };
}

function main() {
  const config = loadConfig(process.env);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const store = new FileStore(path.join(dataDir, 'state.json'));
  const sender = createWebPushSender(config);
  const server = createServer({ store: store, sender: sender, config: config });
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  server.listen(port, host, () => {
    console.log(JSON.stringify(safeBootLog(config, host, port)));
  });
}

if (require.main === module) main();

module.exports = { loadConfig, main };
