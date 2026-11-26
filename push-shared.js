/* Shared by the page, the service worker, and the push server.
   No secrets. Notification URLs are rebuilt from asset/call id, never from a raw link. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CharliePushShared = api;
  if (typeof self !== 'undefined') self.CharliePushShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CATEGORIES = ['new_call', 'entry', 'tp', 'sl'];
  const ASSETS = ['XAUUSD', 'BTCUSD', 'FXVOL80'];
  const TYPES = ['SCALP', 'INTRADAY', 'SWING'];
  const CADENCE = {
    scoreMinutes: 10,
    scoreWindow: '08:00–21:50 MYT',
    analysisMinutes: 30,
    realtime: false
  };

  function callName(c) {
    const given = c && c.name != null ? String(c.name).trim() : '';
    if (given) return given;
    const id = String((c && c.id) || '').trim();
    const up = id.toUpperCase();
    const parsed = up.match(/^(?:([BV])-)?([SIW])?(\d+)(R)?$/);
    const assetCode = String((c && c.asset) || '').toUpperCase();
    const typeCode = String((c && c.type) || '').toUpperCase();
    const assetByCode = { XAUUSD: 'Gold', BTCUSD: 'BTC', BTC: 'BTC', FXVOL80: 'Vol 80' };
    const typeByCode = { SCALP: 'Scalping', INTRADAY: 'Intraday', SWING: 'Swing' };
    let asset = assetByCode[assetCode] || '';
    let type = typeByCode[typeCode] || '';
    let n = null;
    let refined = false;
    if (parsed) {
      n = String(parseInt(parsed[3], 10));
      refined = !!parsed[4];
      if (!asset) asset = parsed[1] === 'B' ? 'BTC' : parsed[1] === 'V' ? 'Vol 80' : 'Gold';
      if (!type) type = parsed[2] === 'S' ? 'Scalping' : parsed[2] === 'I' ? 'Intraday' : 'Swing';
    }
    if (n == null) return id;
    return asset + ' · ' + type + ' #' + n + (refined ? ' (refined)' : '');
  }

  function defaultPrefs() {
    return { new_call: true, entry: true, tp: true, sl: true };
  }

  function normalizePrefs(input) {
    const out = defaultPrefs();
    if (!input || typeof input !== 'object') return out;
    CATEGORIES.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(input, key)) return;
      const value = input[key];
      if (value === true || value === 'true' || value === 1) out[key] = true;
      else if (value === false || value === 'false' || value === 0) out[key] = false;
    });
    return out;
  }

  function clip(value, max) {
    const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
  }

  function safeCallId(value) {
    const id = String(value || '');
    return /^[A-Za-z0-9-]{1,24}$/.test(id) ? id : '';
  }

  function notificationPath(input) {
    const src = input || {};
    const asset = ASSETS.indexOf(String(src.asset || '').toUpperCase()) >= 0
      ? String(src.asset).toUpperCase()
      : '';
    const type = TYPES.indexOf(String(src.type || '').toUpperCase()) >= 0
      ? String(src.type).toUpperCase()
      : '';
    const callId = safeCallId(src.callId);
    const params = new URLSearchParams();
    if (asset) params.set('asset', asset);
    if (callId) params.set('call', callId);
    const query = params.toString();
    const hash = type && callId ? '#/' + type + '/' + encodeURIComponent(callId) : '';
    return './index.html' + (query ? '?' + query : '') + hash;
  }

  function parsePushPayload(raw) {
    const fallback = {
      title: 'Charlie Calls',
      body: 'Notifikasi tak lengkap.',
      url: './index.html',
      tag: 'charlie-safe',
      category: '',
      data: { asset: '', callId: '', type: '', url: './index.html', eventId: '', category: '' }
    };
    let obj = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { return fallback; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fallback;
    const categoryRaw = String(obj.category || '');
    const category = CATEGORIES.indexOf(categoryRaw) >= 0 || categoryRaw === 'test' ? categoryRaw : '';
    const asset = ASSETS.indexOf(String(obj.asset || '').toUpperCase()) >= 0
      ? String(obj.asset).toUpperCase()
      : '';
    const type = TYPES.indexOf(String(obj.type || '').toUpperCase()) >= 0
      ? String(obj.type).toUpperCase()
      : '';
    const callId = safeCallId(obj.callId);
    const eventId = /^[A-Za-z0-9:._|-]{1,160}$/.test(String(obj.eventId || '')) ? String(obj.eventId) : '';
    const title = clip(obj.title, 80) || fallback.title;
    const body = clip(obj.body, 280) || fallback.body;
    const url = notificationPath({ asset: asset, callId: callId, type: type });
    const tag = eventId || (category ? 'charlie-' + category : fallback.tag);
    return {
      title: title,
      body: body,
      url: url,
      tag: tag,
      category: category,
      data: { asset: asset, callId: callId, type: type, url: url, eventId: eventId, category: category }
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    ASSETS: ASSETS,
    TYPES: TYPES,
    CADENCE: CADENCE,
    callName: callName,
    defaultPrefs: defaultPrefs,
    normalizePrefs: normalizePrefs,
    notificationPath: notificationPath,
    parsePushPayload: parsePushPayload
  };
});
