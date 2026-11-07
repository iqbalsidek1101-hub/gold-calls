'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { safeBootLog } = require('../src/vapid');

const root = path.join(__dirname, '..', '..');

test('UI and docs disclose 10-minute scoring and ~30-minute analysis', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const docs = fs.readFileSync(path.join(root, 'PUSH.md'), 'utf8');
  const cadence = index.slice(index.indexOf('id="pushCadence"'), index.indexOf('id="pushStatus"'));
  assert.match(cadence, /Bukan notifikasi masa nyata/);
  assert.match(cadence, /10 minit/);
  assert.match(cadence, /08:00–21:50 MYT/);
  assert.match(cadence, /30 minit/);
  assert.match(cadence, /simulasi call/);
  assert.match(cadence, /bukan order broker/);
  assert.match(cadence, /lebih daripada 10 minit/);
  const statusLine = cadence.split('\n').find((line) => line.includes('Entry tersentuh, TP'));
  assert.match(statusLine, /10 minit/);
  assert.doesNotMatch(statusLine, /30/);
  const analysisLine = cadence.split('\n').find((line) => line.startsWith('Call baru'));
  assert.match(analysisLine, /30 minit/);
  assert.doesNotMatch(analysisLine, /10 minit/);
  assert.match(index, /charlie-gold-webhook-settings/);
  assert.match(index, /id="refreshBtn"/);
  assert.match(index, /Benarkan notifikasi/);
  assert.match(index, /Hantar ujian/);
  assert.match(index, /id="pref-new_call"/);
  assert.match(index, /id="pref-entry"/);
  assert.match(index, /id="pref-tp"/);
  assert.match(index, /id="pref-sl"/);
  assert.match(index, /Tambah ke Skrin Utama/);
  assert.equal(index.includes('new Notification'), false);
  assert.match(docs, /08:00–21:50 MYT/);
  assert.match(docs, /0,10,20,30,40,50 8-21/);
  assert.match(docs, /CHARLIE_DISPATCH_TOKEN/);
  assert.match(docs, /not live|belum hidup|not deployed|Not deployed/i);
  assert.match(docs, /baseline/i);
  assert.doesNotMatch(docs, /VAPID_PRIVATE_KEY=.+[A-Za-z0-9]{20}/);
});

test('boot log cannot include secrets', () => {
  const log = safeBootLog({
    publicKey: 'pub',
    privateKey: 'SECRET-PRIVATE-KEY',
    subject: 'mailto:a@b.c',
    dispatchToken: 'SECRET-DISPATCH-TOKEN'
  }, '127.0.0.1', 8787);
  const text = JSON.stringify(log);
  assert.equal(text.includes('SECRET'), false);
  assert.equal(log.realtime, false);
  assert.equal(log.configured, true);
});
