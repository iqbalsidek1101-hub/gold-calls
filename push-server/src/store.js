'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { emptySnapshot } = require('./events');

function emptyState() {
  return { version: 1, snapshot: emptySnapshot(), subscriptions: {} };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  state.version = 1;
  if (raw.snapshot && typeof raw.snapshot === 'object') {
    state.snapshot = Object.assign(emptySnapshot(), raw.snapshot);
    if (!state.snapshot.calls || typeof state.snapshot.calls !== 'object') state.snapshot.calls = {};
    if (!state.snapshot.sent || typeof state.snapshot.sent !== 'object') state.snapshot.sent = {};
    if (!Array.isArray(state.snapshot.pending)) state.snapshot.pending = [];
  }
  if (raw.subscriptions && typeof raw.subscriptions === 'object') state.subscriptions = raw.subscriptions;
  return state;
}

class FileStore {
  constructor(file) {
    this.file = file;
    this.chain = Promise.resolve();
  }

  async read() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState();
      throw err;
    }
  }

  async write(state) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
    try { await fsp.chmod(this.file, 0o600); } catch (err) { /* platform may ignore */ }
  }

  update(fn) {
    const run = this.chain.then(async () => {
      const current = await this.read();
      const next = await fn(current);
      await this.write(next);
      return next;
    });
    this.chain = run.then(() => {}, () => {});
    return run;
  }
}

module.exports = { FileStore, emptyState, normalizeState };
