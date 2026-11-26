'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diffDocument } = require('../src/events');
const { messageFor } = require('../src/messages');
const { callName, parsePushPayload } = require('../../push-shared');

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
    created_myt: '2026-11-07 10:00:00',
    r_result: null,
    scored_myt: '2026-11-07 18:10:00'
  }, partial || {});
}

function doc(calls) {
  return { generated_myt: '2026-11-07 18:10:00', calls: calls };
}

function apply(snapshot, calls) {
  return diffDocument(snapshot, doc(calls), '2026-11-07T10:10:00.000Z');
}

test('readable names match the app', () => {
  assert.equal(callName({ id: 'B-S002', asset: 'BTCUSD', type: 'SCALP' }), 'BTC · Scalping #2');
  assert.equal(callName({ id: 'V-I003', asset: 'FXVOL80', type: 'INTRADAY' }), 'Vol 80 · Intraday #3');
  assert.equal(callName({ id: 'V-S004', asset: 'FXVOL80', type: 'SCALP' }), 'Vol 80 · Scalping #4');
  assert.equal(callName({ id: '001', asset: 'XAUUSD', type: 'SWING' }), 'Gold · Swing #1');
  assert.equal(callName({ id: '001R', asset: 'XAUUSD', type: 'SWING' }), 'Gold · Swing #1 (refined)');
  assert.equal(callName({ id: 'X', name: 'BTC · Scalping #2' }), 'BTC · Scalping #2');
});

test('baseline of the live calls.json sends nothing and a repeat stays quiet', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'calls.json'), 'utf8'));
  const first = diffDocument(null, real, 't1');
  assert.equal(first.baselinedNow, true);
  assert.equal(first.events.length, 0);
  assert.ok(Object.keys(first.snapshot.calls).length > 5);
  const second = diffDocument(first.snapshot, real, 't2');
  assert.equal(second.events.length, 0);
});

test('new BUY is one call, WAIT is silent, and the same row does not repeat', () => {
  const base = apply(null, [call({ status: 'SL', r_result: -1 })]);
  assert.equal(base.events.length, 0);
  const added = apply(base.snapshot, [
    call({ status: 'SL', r_result: -1 }),
    call({ id: 'V-I003', asset: 'FXVOL80', type: 'INTRADAY', name: 'Vol 80 · Intraday #3', direction: 'SELL', status: 'PENDING', created_myt: '2026-11-07 18:00:00' }),
    call({ id: 'B-W002', asset: 'BTCUSD', type: 'SWING', name: 'BTC · Swing #2', direction: 'WAIT', status: 'WAIT', created_myt: '2026-11-07 18:00:00' })
  ]);
  assert.deepEqual(added.events.map((event) => event.category), ['new_call']);
  assert.equal(added.events[0].name, 'Vol 80 · Intraday #3');
  assert.match(added.events[0].body, /bukan order broker/);
  assert.match(added.events[0].body, /30 minit/);
  assert.doesNotMatch(added.events[0].body, /10 minit/);
  const again = apply(added.snapshot, [
    call({ status: 'SL', r_result: -1, reasoning: 'wording changed only' }),
    call({ id: 'V-I003', asset: 'FXVOL80', type: 'INTRADAY', name: 'Vol 80 · Intraday #3', direction: 'SELL', status: 'PENDING', created_myt: '2026-11-07 18:00:00', reasoning: 'still pending' }),
    call({ id: 'B-W002', asset: 'BTCUSD', type: 'SWING', name: 'BTC · Swing #2', direction: 'WAIT', status: 'WAIT', created_myt: '2026-11-07 18:00:00', reasoning: 'still no fit' })
  ]);
  assert.equal(again.events.length, 0);
});

test('entry, TP and SL fire once and use calls.json R only', () => {
  let state = apply(null, [call(), call({ id: 'V-S003', asset: 'FXVOL80', type: 'SCALP', name: 'Vol 80 · Scalping #3', direction: 'SELL' })]).snapshot;
  const filled = apply(state, [call({ status: 'FILLED', fill_px: 76200 }), call({ id: 'V-S003', asset: 'FXVOL80', type: 'SCALP', name: 'Vol 80 · Scalping #3', direction: 'SELL', status: 'PENDING' })]);
  assert.deepEqual(filled.events.map((event) => event.category), ['entry']);
  assert.match(filled.events[0].body, /simulasi call/);
  assert.match(filled.events[0].body, /Bukan order broker/);
  assert.match(filled.events[0].body, /10 minit/);
  assert.match(filled.events[0].body, /08:00–21:50 MYT/);
  assert.doesNotMatch(filled.events[0].body, /30 minit/);
  state = filled.snapshot;
  const closed = apply(state, [
    call({ status: 'TP', r_result: 1.5, fill_px: 76200 }),
    call({ id: 'V-S003', asset: 'FXVOL80', type: 'SCALP', name: 'Vol 80 · Scalping #3', direction: 'SELL', status: 'SL', r_result: -1, fill_px: 43700 })
  ]);
  const byCat = Object.fromEntries(closed.events.map((event) => [event.category + ':' + event.callId, event]));
  assert.equal(byCat['tp:B-S002'].name, 'BTC · Scalping #2');
  assert.match(byCat['tp:B-S002'].body, /\+1\.50R/);
  assert.match(byCat['tp:B-S002'].body, /calls\.json/);
  assert.match(byCat['tp:B-S002'].body, /10 minit/);
  assert.doesNotMatch(byCat['tp:B-S002'].body, /menang/);
  assert.match(byCat['entry:V-S003'].body, /simulasi/);
  assert.match(byCat['sl:V-S003'].body, /-1\.00R/);
  assert.doesNotMatch(byCat['sl:V-S003'].body, /menang/);
  const quiet = apply(closed.snapshot, [
    call({ status: 'TP', r_result: 1.5, fill_px: 76200 }),
    call({ id: 'V-S003', asset: 'FXVOL80', type: 'SCALP', name: 'Vol 80 · Scalping #3', direction: 'SELL', status: 'SL', r_result: -1, fill_px: 43700 })
  ]);
  assert.equal(quiet.events.length, 0);
});

test('a dropped row does not replay when it returns unchanged', () => {
  const first = apply(null, [call({ status: 'TP', r_result: 2 })]);
  const gone = apply(first.snapshot, []);
  assert.equal(gone.events.length, 0);
  const back = apply(gone.snapshot, [call({ status: 'TP', r_result: 2 })]);
  assert.equal(back.events.length, 0);
});

test('TP without a real R does not claim a win', () => {
  const missing = messageFor('tp', call({ status: 'TP', r_result: null, scored_myt: '' }), { generated_myt: '' });
  assert.match(missing.body, /bukan pengesahan menang/);
  assert.doesNotMatch(missing.body, /\+\d/);
  const flat = messageFor('tp', call({ status: 'TP', r_result: 0 }), { generated_myt: '2026-11-07 18:10:00' });
  assert.match(flat.body, /bukan pengesahan menang/i);
  assert.match(flat.body, /0\.00R/);
});

test('payload links are rebuilt and bad JSON stays safe', () => {
  const parsed = parsePushPayload({
    title: 'TP dalam calls.json',
    body: 'BTC · Scalping #2',
    category: 'tp',
    asset: 'BTCUSD',
    callId: 'B-S002',
    type: 'SCALP',
    eventId: 'tp:BTCUSD:B-S002:2026-11-07_10:00:00',
    url: 'https://evil.example/phish'
  });
  assert.equal(parsed.url.includes('evil'), false);
  assert.match(parsed.url, /asset=BTCUSD/);
  assert.match(parsed.url, /call=B-S002/);
  assert.match(parsed.url, /#\/SCALP\/B-S002/);
  const bad = parsePushPayload('{{{');
  assert.equal(bad.title, 'Charlie Calls');
  assert.match(bad.body, /tak lengkap/);
  assert.equal(bad.url.includes('javascript:'), false);
});
