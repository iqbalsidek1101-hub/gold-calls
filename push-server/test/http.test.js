'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, request, call, doc, appleSub, ORIGIN, TOKEN, PRIVATE } = require('./helpers');

async function subscribe(ctx, id, categories) {
  const res = await request(ctx, {
    path: '/v1/subscriptions',
    origin: ORIGIN,
    body: { subscription: appleSub(id || 'phone-1'), categories: categories, webhookKey: 'webhook-secret-must-not-stick', key: 'webhook-secret-must-not-stick' }
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.subToken);
  assert.equal(res.text.includes('webhook-secret-must-not-stick'), false);
  return res.json.subToken;
}

test('dispatch auth, origin, and secret leakage', async () => {
  const ctx = await boot();
  try {
    const missing = await request(ctx, { path: '/v1/dispatch', body: doc([call()]) });
    assert.equal(missing.status, 401);
    const wrong = await request(ctx, { path: '/v1/dispatch', token: 'nope', body: doc([call()]) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.text.includes(TOKEN), false);
    assert.equal(wrong.text.includes(PRIVATE), false);
    const inUrl = await request(ctx, { path: '/v1/dispatch?token=' + TOKEN, token: TOKEN, body: doc([call()]) });
    assert.equal(inUrl.status, 400);
    const evilDispatch = await request(ctx, { path: '/v1/dispatch', origin: 'https://evil.example', token: TOKEN, body: doc([call()]) });
    assert.equal(evilDispatch.status, 403);
    const evil = await request(ctx, { path: '/v1/subscriptions', origin: 'https://evil.example', body: { subscription: appleSub('x') } });
    assert.equal(evil.status, 403);
    assert.notEqual(evil.headers['access-control-allow-origin'], '*');
    assert.notEqual(evil.headers['access-control-allow-origin'], 'https://evil.example');
    const config = await request(ctx, { method: 'GET', path: '/v1/config', origin: ORIGIN });
    assert.equal(config.status, 200);
    assert.equal(config.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(config.json.realtime, false);
    assert.equal(config.json.scoreMinutes, 10);
    assert.equal(config.json.scoreWindow, '08:00–21:50 MYT');
    assert.equal(config.json.analysisMinutes, 30);
    assert.ok(config.json.publicKey);
    assert.equal(config.text.includes(PRIVATE), false);
    assert.equal(config.text.includes(TOKEN), false);
    const open = await request(ctx, { method: 'GET', path: '/v1/subscriptions', origin: ORIGIN });
    assert.equal(open.status, 405);
    const dumped = JSON.stringify(ctx.logs);
    assert.equal(dumped.includes(TOKEN), false);
    assert.equal(dumped.includes(PRIVATE), false);
  } finally {
    await ctx.close();
  }
});

test('baseline does not blast history, later diffs are idempotent, subscribe does not replay', async () => {
  const ctx = await boot();
  try {
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'calls.json'), 'utf8'));
    await subscribe(ctx, 'phone-1');
    const first = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: real });
    assert.equal(first.status, 200);
    assert.equal(first.json.baselined, true);
    assert.equal(first.json.events.length, 0);
    assert.equal(first.json.delivered, 0);
    assert.equal(first.json.realtime, false);
    assert.equal(ctx.sent.length, 0);
    const same = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: real });
    assert.equal(same.json.events.length, 0);
    assert.equal(ctx.sent.length, 0);

    const changed = doc([
      call({
        id: 'Z-S099',
        name: 'BTC · Scalping #99',
        status: 'TP',
        r_result: 1.25,
        fill_px: 76200,
        fill_time_myt: '2026-11-07 18:10:00'
      })
    ]);
    const next = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: changed });
    assert.equal(next.status, 200);
    const categories = next.json.events.map((event) => event.category).sort();
    assert.deepEqual(categories, ['entry', 'new_call', 'tp']);
    assert.equal(next.json.delivered, 3);
    assert.equal(ctx.sent.length, 3);
    ctx.sent.forEach((item) => {
      assert.equal(item.payload.url, undefined);
      assert.equal(JSON.stringify(item).includes(PRIVATE), false);
      assert.equal(JSON.stringify(item).includes(TOKEN), false);
    });
    const tp = ctx.sent.find((item) => item.payload.category === 'tp');
    assert.match(tp.payload.body, /\+1\.25R/);
    assert.match(tp.payload.body, /10 minit/);
    assert.doesNotMatch(tp.payload.body, /menang/);
    const entry = ctx.sent.find((item) => item.payload.category === 'entry');
    assert.match(entry.payload.body, /simulasi/);
    assert.match(entry.payload.body, /Bukan order broker/);
    const fresh = ctx.sent.find((item) => item.payload.category === 'new_call');
    assert.match(fresh.payload.body, /30 minit/);
    assert.equal(fresh.payload.name, 'BTC · Scalping #99');

    const before = ctx.sent.length;
    const repeat = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: changed });
    assert.equal(repeat.json.events.length, 0);
    assert.equal(ctx.sent.length, before);

    const state = await ctx.store.read();
    assert.equal(JSON.stringify(state).includes('webhook-secret-must-not-stick'), false);
    const mode = fs.statSync(path.join(ctx.dir, 'state.json')).mode & 0o077;
    assert.equal(mode, 0);
  } finally {
    await ctx.close();
  }
});

test('events before subscribe are not replayed, WAIT is ignored, categories filter', async () => {
  const ctx = await boot();
  try {
    const anchor = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc([]) });
    assert.equal(anchor.json.baselined, true);
    const early = await request(ctx, {
      path: '/v1/dispatch',
      token: TOKEN,
      body: doc([call({ status: 'SL', r_result: -1, fill_px: 75500 })])
    });
    assert.equal(early.json.delivered, 0);
    assert.ok(early.json.events.some((event) => event.category === 'sl'));
    assert.equal(ctx.sent.length, 0);
    const token = await subscribe(ctx, 'late-phone', { new_call: false, entry: false, tp: false, sl: true });
    const replay = await request(ctx, {
      path: '/v1/dispatch',
      token: TOKEN,
      body: doc([call({ status: 'SL', r_result: -1, fill_px: 75500 })])
    });
    assert.equal(replay.json.events.length, 0);
    assert.equal(ctx.sent.length, 0);

    const waitOnly = await request(ctx, {
      path: '/v1/dispatch',
      token: TOKEN,
      body: doc([
        call({ status: 'SL', r_result: -1, fill_px: 75500 }),
        call({ id: 'B-W002', type: 'SWING', name: 'BTC · Swing #2', direction: 'WAIT', status: 'WAIT', created_myt: '2026-11-07 18:20:00' })
      ])
    });
    assert.equal(waitOnly.json.events.length, 0);

    const sl = await request(ctx, {
      path: '/v1/dispatch',
      token: TOKEN,
      body: doc([
        call({ status: 'SL', r_result: -1, fill_px: 75500 }),
        call({ id: 'B-W002', type: 'SWING', name: 'BTC · Swing #2', direction: 'WAIT', status: 'WAIT', created_myt: '2026-11-07 18:20:00' }),
        call({ id: 'V-I003', asset: 'FXVOL80', type: 'INTRADAY', name: 'Vol 80 · Intraday #3', direction: 'SELL', status: 'TP', r_result: 2, fill_px: 43150, created_myt: '2026-11-07 18:30:00' }),
        call({ id: 'V-S004', asset: 'FXVOL80', type: 'SCALP', name: 'Vol 80 · Scalping #4', direction: 'SELL', status: 'SL', r_result: -1, fill_px: 43600, created_myt: '2026-11-07 18:40:00' })
      ])
    });
    assert.equal(sl.json.delivered, 1);
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].payload.category, 'sl');
    assert.equal(ctx.sent[0].payload.callId, 'V-S004');
    assert.equal(sl.json.events.some((event) => event.category === 'tp'), true);
    const prefs = await request(ctx, {
      path: '/v1/preferences',
      origin: ORIGIN,
      subToken: token,
      body: { endpoint: appleSub('late-phone').endpoint, categories: { new_call: true, entry: true, tp: true, sl: true } }
    });
    assert.equal(prefs.status, 200);
    assert.equal(prefs.json.categories.tp, true);
    const denied = await request(ctx, {
      path: '/v1/test',
      origin: ORIGIN,
      body: { endpoint: 'https://web.push.apple.com/someone-else' }
    });
    assert.equal(denied.status, 401);
    assert.equal(ctx.sent.length, 1);
    const badHost = await request(ctx, {
      path: '/v1/subscriptions',
      origin: ORIGIN,
      body: { subscription: { endpoint: 'https://evil.example/push', keys: appleSub('z').keys } }
    });
    assert.equal(badHost.status, 400);
  } finally {
    await ctx.close();
  }
});

test('unconfigured dispatch does not send, and baseline drops that queue', async () => {
  const ctx = await boot({
    sender: {
      configured: false,
      publicKey: '',
      async send() { throw new Error('should not send'); }
    },
    limits: {
      subscribe: { n: 2, windowMs: 60000 },
      test: { n: 5, windowMs: 60000 },
      dispatch: { n: 8, windowMs: 60000 },
      prefs: { n: 10, windowMs: 60000 },
      config: { n: 20, windowMs: 60000 }
    }
  });
  try {
    await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc([]) });
    const queued = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc([call({ status: 'PENDING' })]) });
    assert.equal(queued.status, 503);
    assert.equal(queued.json.error, 'push_not_configured');
    assert.equal(queued.json.pending, 1);
    assert.equal(ctx.sent.length, 0);
    const anchored = await request(ctx, { path: '/v1/baseline', token: TOKEN, body: doc([call({ status: 'PENDING' })]) });
    assert.equal(anchored.json.baselined, true);
    ctx.sender.configured = true;
    ctx.sender.publicKey = 'B'.repeat(87);
    const after = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc([call({ status: 'PENDING' })]) });
    assert.equal(after.status, 200);
    assert.equal(after.json.events.length, 0);
    assert.equal(ctx.sent.length, 0);
  } finally {
    await ctx.close();
  }
});

test('gone endpoints are deleted and a huge jump is refused', async () => {
  const ctx = await boot({
    sender: {
      configured: true,
      publicKey: 'B'.repeat(87),
      async send() {
        const err = new Error('gone');
        err.statusCode = 410;
        throw err;
      }
    }
  });
  try {
    await subscribe(ctx, 'stale');
    await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc([]) });
    const sent = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc([call()]) });
    assert.equal(sent.json.removed, 1);
    const state = await ctx.store.read();
    assert.equal(state.subscriptions['https://web.push.apple.com/stale'], undefined);
    const many = [];
    for (let i = 0; i < 31; i += 1) {
      many.push(call({ id: 'S' + String(i + 1), created_myt: '2026-11-07 19:00:00', name: 'Gold · Scalping #' + (i + 1), asset: 'XAUUSD', type: 'SCALP' }));
    }
    const boom = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: doc(many) });
    assert.equal(boom.status, 409);
    assert.equal(boom.json.error, 'too_many_events');
    const replay = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: Object.assign({ replay: true }, doc(many)) });
    assert.equal(replay.status, 400);
    const foreign = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: { callsUrl: 'https://evil.example/calls.json' } });
    assert.equal(foreign.status, 400);
    assert.equal(ctx.fetched.length, 0);
    const huge = await request(ctx, { path: '/v1/dispatch', token: TOKEN, body: 'x'.repeat(1600000) });
    assert.equal(huge.status, 413);
  } finally {
    await ctx.close();
  }
});

test('subscribe is rate limited and the default categories are all four', async () => {
  const ctx = await boot({
    limits: {
      subscribe: { n: 2, windowMs: 60000 },
      test: { n: 5, windowMs: 60000 },
      dispatch: { n: 20, windowMs: 60000 },
      prefs: { n: 10, windowMs: 60000 },
      config: { n: 20, windowMs: 60000 }
    }
  });
  try {
    const first = await request(ctx, { path: '/v1/subscriptions', origin: ORIGIN, body: { subscription: appleSub('a') } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.categories, { new_call: true, entry: true, tp: true, sl: true });
    const second = await request(ctx, { path: '/v1/subscriptions', origin: ORIGIN, body: { subscription: appleSub('b') } });
    assert.equal(second.status, 200);
    const third = await request(ctx, { path: '/v1/subscriptions', origin: ORIGIN, body: { subscription: appleSub('c') } });
    assert.equal(third.status, 429);
    const noOrigin = await request(ctx, { path: '/v1/subscriptions', body: { subscription: appleSub('d') } });
    assert.equal(noOrigin.status, 403);
  } finally {
    await ctx.close();
  }
});
