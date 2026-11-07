'use strict';

const { notificationPath, callName } = require('../../push-shared');
const { messageFor } = require('./messages');

const MAX_EVENTS = 30;

function normStatus(value) {
  const status = String(value || 'PENDING').trim().toUpperCase();
  if (status === 'NOT FILLED') return 'NOTFILLED';
  return status;
}

function normDir(value) {
  return String(value || '').trim().toUpperCase();
}

function isWait(call) {
  return normDir(call.direction) === 'WAIT' || normStatus(call.status) === 'WAIT';
}

function isReplaced(call) {
  return normStatus(call.status) === 'REPLACED';
}

function isActionable(call) {
  if (isWait(call) || isReplaced(call)) return false;
  const dir = normDir(call.direction);
  return dir === 'BUY' || dir === 'SELL';
}

function hasFill(call) {
  if (!isActionable(call)) return false;
  const status = normStatus(call.status);
  if (status === 'FILLED' || status === 'TP' || status === 'SL') return true;
  if (call.fill_px != null && call.fill_px !== '' && Number.isFinite(Number(call.fill_px))) return true;
  const when = call.fill_time_myt || call.fill_time_server;
  return !!(when && String(when).trim() && String(when).trim() !== 'null');
}

function asCall(raw, assetHint) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9-]{1,24}$/.test(id)) return null;
  const asset = String(raw.asset || assetHint || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(asset)) return null;
  return Object.assign({}, raw, { id: id, asset: asset });
}

function flattenCalls(doc) {
  const out = [];
  const seen = new Set();
  const push = (raw, assetHint) => {
    const call = asCall(raw, assetHint);
    if (!call) return;
    const key = call.asset + '|' + call.id + '|' + String(call.created_myt || '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(call);
  };
  if (doc && doc.by_asset && typeof doc.by_asset === 'object') {
    Object.entries(doc.by_asset).forEach(([asset, bag]) => {
      const list = bag && Array.isArray(bag.calls) ? bag.calls : [];
      list.forEach((call) => push(call, asset));
    });
  }
  if (doc && Array.isArray(doc.calls)) doc.calls.forEach((call) => push(call));
  return out;
}

function identity(call) {
  return call.asset + '|' + call.id + '|' + String(call.created_myt || '');
}

function eventId(category, call) {
  const created = String(call.created_myt || '').replace(/\s+/g, '_');
  return [category, call.asset, call.id, created].join(':');
}

function snapshotCall(call) {
  return {
    status: normStatus(call.status),
    direction: normDir(call.direction),
    filled: hasFill(call),
    actionable: isActionable(call),
    created_myt: String(call.created_myt || '')
  };
}

function emptySnapshot() {
  return {
    baselined: false,
    baselinedAt: null,
    updatedAt: null,
    calls: {},
    sent: {},
    pending: [],
    stamp: null
  };
}

function makeEvent(category, call, doc) {
  const named = Object.assign({}, call, { name: call.name || callName(call) });
  const msg = messageFor(category, named, doc);
  const type = String(named.type || '').toUpperCase();
  return {
    id: eventId(category, named),
    category: category,
    asset: named.asset,
    callId: named.id,
    type: type,
    name: named.name,
    title: msg.title,
    body: msg.body,
    url: notificationPath({ asset: named.asset, callId: named.id, type: type })
  };
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  events.forEach((event) => {
    if (!event || seen.has(event.id)) return;
    seen.add(event.id);
    out.push(event);
  });
  return out;
}

function collectTransitions(before, call, doc) {
  const events = [];
  const actionable = isActionable(call);
  const filled = hasFill(call);
  const status = normStatus(call.status);
  if (!before) {
    if (actionable) events.push(makeEvent('new_call', call, doc));
    if (filled) events.push(makeEvent('entry', call, doc));
    if (status === 'TP') events.push(makeEvent('tp', call, doc));
    if (status === 'SL') events.push(makeEvent('sl', call, doc));
    return events;
  }
  if (!before.actionable && actionable) events.push(makeEvent('new_call', call, doc));
  if (!before.filled && filled) events.push(makeEvent('entry', call, doc));
  if (before.status !== 'TP' && status === 'TP') events.push(makeEvent('tp', call, doc));
  if (before.status !== 'SL' && status === 'SL') events.push(makeEvent('sl', call, doc));
  return events;
}

function diffDocument(snapshot, doc, nowIso) {
  const prev = snapshot && snapshot.baselined ? snapshot : null;
  const calls = flattenCalls(doc);
  const events = [];
  if (prev) {
    calls.forEach((call) => {
      collectTransitions(prev.calls[identity(call)], call, doc).forEach((event) => events.push(event));
    });
  }
  const nextCalls = {};
  if (prev && prev.calls) {
    Object.keys(prev.calls).forEach((key) => { nextCalls[key] = prev.calls[key]; });
  }
  calls.forEach((call) => { nextCalls[identity(call)] = snapshotCall(call); });
  const sent = Object.assign({}, prev && prev.sent ? prev.sent : {});
  const fresh = dedupe(events).filter((event) => !sent[event.id]);
  return {
    baselinedNow: !prev,
    events: fresh,
    snapshot: {
      baselined: true,
      baselinedAt: prev && prev.baselinedAt ? prev.baselinedAt : nowIso,
      updatedAt: nowIso,
      calls: nextCalls,
      sent: sent,
      pending: prev && Array.isArray(prev.pending) ? prev.pending.slice() : [],
      stamp: doc && (doc.generated_myt || doc.last_updated) ? String(doc.generated_myt || doc.last_updated) : null
    }
  };
}

function extractDocument(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.calls && !Array.isArray(body.calls) && typeof body.calls === 'object' && (body.calls.by_asset || Array.isArray(body.calls.calls))) {
    return body.calls;
  }
  if (body.by_asset || Array.isArray(body.calls)) return body;
  return null;
}

module.exports = {
  MAX_EVENTS,
  normStatus,
  isActionable,
  hasFill,
  flattenCalls,
  emptySnapshot,
  diffDocument,
  extractDocument,
  dedupe
};
